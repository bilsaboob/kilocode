import { afterEach, expect, spyOn } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { KiloAuth } from "@/kilocode/auth/authority"
import { KiloCompactionBudget as Budget } from "@/kilocode/session/compaction-budget"
import { KiloCompactionState } from "@/kilocode/session/compaction-state"
import { KiloSessionIdentity as Identity } from "@/kilocode/session/identity"
import { ModelID, ProviderID } from "@/provider/schema"
import { Server } from "@/server/server"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { MessageTable, PartTable } from "@/session/session.sql"
import { Database, and, eq, inArray } from "@/storage/db"
import { SyncEvent } from "@/sync"
import { EventTable, EventSequenceTable } from "@/sync/event.sql"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffectShared } from "../../lib/effect"

const it = testEffectShared(
  Layer.mergeAll(
    Session.defaultLayer,
    Auth.defaultLayer,
    SyncEvent.defaultLayer,
    Bus.layer,
    CrossSpawnSpawner.defaultLayer,
  ),
)
const provider = ProviderID.make("opencode-identity-fixture")
const model = { providerID: provider, modelID: ModelID.make("fixture") }
const options = {
  config: {
    enabled_providers: [provider],
    compaction: { auto: true, threshold_percent: 70 },
    command: { identity: { template: "Identity test $ARGUMENTS" } },
    provider: {
      [provider]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Identity fixture",
        options: { baseURL: "http://127.0.0.1:9/never" },
        models: {
          fixture: { name: "fixture", limit: { context: 128000, output: 1000 } },
          other: { name: "other", limit: { context: 64000, output: 1000 } },
        },
      },
    },
  },
}
afterEach(disposeAllInstances)

function fixture() {
  return Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const sessions = yield* Session.Service
    const auth = yield* Auth.Service
    const policy = process.env.ZEN_KILO_CONTEXT_POLICY
    process.env.ZEN_KILO_CONTEXT_POLICY = JSON.stringify({
      version: 1,
      window: "maximum-supported",
      automaticPercent: 70,
      admissionPercent: 90,
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (policy === undefined) delete process.env.ZEN_KILO_CONTEXT_POLICY
        else process.env.ZEN_KILO_CONTEXT_POLICY = policy
      }),
    )
    yield* auth.set(provider, { type: "api", key: "identity-private-A" })
    yield* Effect.addFinalizer(() => auth.remove(provider).pipe(Effect.orDie))
    const calls: string[] = []
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (input: Parameters<typeof fetch>[0]) => {
              const url = input instanceof Request ? input.url : String(input)
              // The full HTTP graph starts unrelated catalog/index bootstrap.
              // Deny these exact probes locally; never download or dispatch inference.
              if (
                url === "https://models.dev/api.json" ||
                url === "https://api.kilo.ai/api/openrouter/models" ||
                url === "https://api.apertis.ai/v1/models" ||
                url.startsWith("https://github.com/BurntSushi/ripgrep/releases/download/")
              )
                return new Response("Disabled in isolated identity tests", { status: 503 })
              calls.push(url)
              throw new Error("Identity admission must not dispatch provider/catalog requests")
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        ),
      ),
      (spy) =>
        Effect.sync(() => {
          spy.mockRestore()
          expect(calls).toEqual([])
        }),
    )
    const request = (path: string, method: string, body?: unknown) =>
      Effect.promise(() =>
        Promise.resolve(
          Server.Default().app.request(path, {
            method,
            headers: { "content-type": "application/json", "x-kilo-directory": directory },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        ),
      )
    const send = (sessionID: SessionID, body: object, route = "message") =>
      request(`/session/${sessionID}/${route}`, "POST", body)
    const draft = (messageID = MessageID.ascending(), partID = PartID.ascending()) => ({
      messageID,
      model,
      noReply: true,
      system: "Original system input",
      parts: [{ type: "text" as const, id: partID, text: "Original task" }],
    })
    const admit = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const input = draft()
        const response = yield* send(sessionID, input)
        expect(response.status).toBe(200)
        return yield* MessageV2.get({ sessionID, messageID: input.messageID })
      })
    return { sessions, auth, request, send, draft, admit }
  })
}

it.instance(
  "HTTP cannot move a globally owned user or rebind its authority, model, policy or parts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const a = yield* f.sessions.create({})
      const b = yield* f.sessions.create({})
      const before = yield* f.admit(a.id)
      if (before.info.role !== "user") throw new Error("Expected user")
      expect(before.info.authAuthority).toBeDefined()
      expect(before.info.contextPolicy).toBeDefined()
      expect(Object.isFrozen(before.info.authAuthority)).toBe(true)
      yield* f.auth.set(provider, { type: "api", key: "identity-private-B" })
      const next = yield* f.admit(b.id)
      if (next.info.role !== "user") throw new Error("Expected user")
      expect(next.info.authAuthority?.authority).not.toBe(before.info.authAuthority?.authority)

      const input = { ...f.draft(before.info.id), model: { ...model, modelID: "other" }, sessionID: a.id }
      const original = structuredClone(input)
      for (const route of ["message", "prompt_async", "command", "init", "shell"]) {
        const body =
          route === "command"
            ? { messageID: before.info.id, command: "identity", arguments: "changed", model: `${provider}/other` }
            : route === "init"
              ? { messageID: before.info.id, providerID: provider, modelID: "other" }
              : route === "shell"
                ? { messageID: before.info.id, agent: "code", command: "must-not-run" }
                : input
        expect((yield* f.send(b.id, body, route)).status).toBe(400)
        expect(yield* MessageV2.get({ sessionID: a.id, messageID: before.info.id })).toEqual(before)
        expect(
          Exit.isFailure(yield* MessageV2.get({ sessionID: b.id, messageID: before.info.id }).pipe(Effect.exit)),
        ).toBe(true)
      }
      expect(input).toEqual(original)
      const replay = yield* f.send(a.id, { ...input, model })
      expect(replay.status).toBe(200)
      expect(yield* Effect.promise(() => replay.json())).toEqual(before)
      expect(yield* MessageV2.get({ sessionID: a.id, messageID: before.info.id })).toEqual(before)
      expect(JSON.stringify(before)).not.toContain("identity-private-")
    }),
  options,
  30_000,
)

it.instance(
  "new HTTP prompts cannot overwrite protected receipts by reusing a public part ID",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const a = yield* f.sessions.create({})
      const b = yield* f.sessions.create({})
      const root = yield* f.admit(a.id)
      const owner = { sessionID: a.id, messageID: root.info.id }
      yield* Budget.run(
        owner,
        Effect.gen(function* () {
          const dispatcher = yield* Budget.dispatcher
          dispatcher!.model()
          dispatcher!.transport()
        }),
      )
      const ledger = Budget.inspect(owner)
      const receipt = (yield* MessageV2.get(owner)).parts.find(Budget.internal)!
      // A legitimate internal recovery link, distinct from public prompt metadata.
      const child = yield* f.sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: a.id,
        role: "user",
        agent: "code",
        model,
        time: { created: Date.now() },
      })
      const link = yield* f.sessions.updatePart({
        id: PartID.ascending(),
        messageID: child.id,
        sessionID: a.id,
        type: "text",
        text: "",
        ignored: true,
        metadata: { kilo_compaction_root: root.info.id },
      })
      for (const protectedPart of [receipt, link]) {
        for (const sessionID of [a.id, b.id]) {
          for (const route of ["message", "prompt_async", "command"]) {
            const input = f.draft(MessageID.ascending(), protectedPart.id)
            const body =
              route === "command"
                ? {
                    messageID: input.messageID,
                    command: "identity",
                    arguments: "",
                    model: `${provider}/fixture`,
                    parts: [
                      { type: "file", id: protectedPart.id, mime: "text/plain", url: "data:text/plain,not-read" },
                    ],
                  }
                : input
            expect((yield* f.send(sessionID, body, route)).status).toBe(400)
            expect(
              Exit.isFailure(yield* MessageV2.get({ sessionID, messageID: input.messageID }).pipe(Effect.exit)),
            ).toBe(true)
            expect(
              yield* f.sessions.getPart({
                sessionID: a.id,
                messageID: protectedPart.messageID,
                partID: protectedPart.id,
              }),
            ).toEqual(protectedPart)
            expect(Budget.inspect(owner)).toEqual(ledger)
          }
        }
      }
    }),
  options,
  30_000,
)

it.instance(
  "duplicate draft IDs fail before admission; same-owner streaming and path ownership remain distinct",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const chat = yield* f.sessions.create({})
      const source = yield* f.admit(chat.id)
      for (const route of ["message", "prompt_async"]) {
        const input = f.draft()
        input.parts.push({ ...input.parts[0], text: "duplicate" })
        expect((yield* f.send(chat.id, input, route)).status).toBe(400)
        expect(
          Exit.isFailure(yield* MessageV2.get({ sessionID: chat.id, messageID: input.messageID }).pipe(Effect.exit)),
        ).toBe(true)
      }
      const assistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        sessionID: chat.id,
        role: "assistant",
        parentID: source.info.id,
        time: { created: Date.now() },
        agent: "code",
        mode: "code",
        modelID: model.modelID,
        providerID: provider,
        path: { cwd: "fixture", root: "fixture" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      yield* f.sessions.updateMessage(assistant)
      const part = yield* f.sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: assistant.id,
        type: "text",
        text: "first",
      })
      yield* f.sessions.updatePartDelta({
        sessionID: chat.id,
        messageID: assistant.id,
        partID: part.id,
        field: "text",
        delta: " second",
      })
      yield* f.sessions.updatePart({ ...part, text: "first second" })
      yield* f.sessions.updateMessage({
        ...assistant,
        finish: "stop",
        time: { ...assistant.time, completed: Date.now() },
      })
      expect((yield* MessageV2.get({ sessionID: chat.id, messageID: assistant.id })).parts[0]).toMatchObject({
        text: "first second",
      })
      const path = `/session/${chat.id}/message/${assistant.id}/part/${part.id}`
      expect((yield* f.request(path, "PATCH", { ...part, text: "explicit edit" })).status).toBe(200)
      const retained = yield* MessageV2.get({ sessionID: chat.id, messageID: assistant.id })
      expect((yield* f.send(chat.id, f.draft(assistant.id))).status).toBe(400)
      expect(yield* MessageV2.get({ sessionID: chat.id, messageID: assistant.id })).toEqual(retained)
      expect((yield* f.request(path, "PATCH", { ...part, messageID: source.info.id })).status).toBe(400)
      const wrong = `/session/${chat.id}/message/${source.info.id}/part/${part.id}`
      expect((yield* f.request(wrong, "PATCH", { ...part, messageID: source.info.id })).status).toBe(400)
      expect((yield* f.request(wrong, "DELETE")).status).toBe(400)
      expect(yield* MessageV2.get({ sessionID: chat.id, messageID: assistant.id })).toEqual(retained)
    }),
  options,
  30_000,
)

for (const collision of ["same-session message", "cross-session message", "part"] as const) {
  it.instance(
    `concurrent HTTP ${collision} collisions have one winner without changing its input or ownership`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const a = yield* f.sessions.create({})
        const b = collision === "same-session message" ? a : yield* f.sessions.create({})
        const left = f.draft()
        const right = f.draft(
          collision === "part" ? MessageID.ascending() : left.messageID,
          collision === "part" ? left.parts[0].id : PartID.ascending(),
        )
        right.parts[0].text = "Other task"
        const inputs = structuredClone([left, right])
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        let count = 0
        const check = KiloAuth.check
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            spyOn(KiloAuth, "check").mockImplementation((...args) =>
              check(...args).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    count++
                    if (count === 2) yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                  }),
                ),
              ),
            ),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
        const pending = yield* Effect.all([f.send(a.id, left), f.send(b.id, right)], { concurrency: "unbounded" }).pipe(
          Effect.forkChild,
        )
        yield* awaitWithTimeout(Deferred.await(entered), "both requests did not reach checked admission", "10 seconds")
        yield* Deferred.succeed(release, undefined)
        const responses = yield* Fiber.join(pending)
        expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 400])
        const winner =
          responses[0].status === 200 ? { sessionID: a.id, input: left } : { sessionID: b.id, input: right }
        const stored = yield* MessageV2.get({ sessionID: winner.sessionID, messageID: winner.input.messageID })
        expect(stored.parts.find((part) => part.id === winner.input.parts[0].id)).toMatchObject({
          messageID: winner.input.messageID,
          sessionID: winner.sessionID,
          text: winner.input.parts[0].text,
        })
        expect([left, right]).toEqual(inputs)
        const before = structuredClone(stored)
        expect((yield* f.send(winner.sessionID, winner.input)).status).toBe(200)
        expect(yield* MessageV2.get({ sessionID: winner.sessionID, messageID: winner.input.messageID })).toEqual(before)
      }),
    options,
    30_000,
  )
}

it.instance(
  "projector ownership checks abort rows and accepted event journals atomically, including cleanup",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const sync = yield* SyncEvent.Service
      const a = yield* f.sessions.create({})
      const b = yield* f.sessions.create({})
      const source = yield* f.admit(a.id)
      const other = yield* f.admit(b.id)
      const part = source.parts.find((part) => part.type === "text" && !part.ignored)!
      const rows = () =>
        Database.use((db) => ({
          messages: db.select().from(MessageTable).all(),
          parts: db.select().from(PartTable).all(),
          events: db.select().from(EventTable).all(),
          sequences: db.select().from(EventSequenceTable).all(),
        }))
      const before = rows()
      // Direct sync writes deliberately bypass all service/HTTP preflights.
      const denied = [
        sync.run(MessageV2.Event.Updated, { sessionID: b.id, info: { ...source.info, sessionID: b.id } }),
        sync.run(MessageV2.Event.Updated, { sessionID: b.id, info: source.info }),
        sync.run(MessageV2.Event.PartUpdated, {
          sessionID: b.id,
          part: { ...part, sessionID: b.id, messageID: other.info.id },
          time: Date.now(),
        }),
        sync.run(MessageV2.Event.PartUpdated, {
          sessionID: b.id,
          part: { ...part, id: PartID.ascending(), sessionID: b.id },
          time: Date.now(),
        }),
        sync.run(MessageV2.Event.Removed, { sessionID: b.id, messageID: source.info.id }),
        sync.run(MessageV2.Event.PartRemoved, { sessionID: a.id, messageID: MessageID.ascending(), partID: part.id }),
        Identity.create(source.info, (info) => sync.run(MessageV2.Event.Updated, { sessionID: a.id, info })),
      ]
      for (const work of denied) {
        const result = yield* work.pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(Identity.Conflict)
        expect(rows()).toEqual(before)
      }
      for (const chats of [
        [a, b],
        [a, a],
      ]) {
        const id = MessageID.ascending()
        for (const chat of chats) Identity.prompt({ sessionID: chat.id, messageID: id })
        const results = yield* Effect.all(
          chats.map((chat) =>
            Identity.create({ ...source.info, id, sessionID: chat.id }, (info) =>
              sync.run(MessageV2.Event.Updated, { sessionID: chat.id, info }),
            ).pipe(Effect.exit),
          ),
          { concurrency: "unbounded" },
        )
        expect(results.filter(Exit.isSuccess)).toHaveLength(1)
        expect(results.filter(Exit.isFailure)).toHaveLength(1)
        expect(Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, id)).all())).toHaveLength(
          1,
        )
      }
      expect(yield* MessageV2.get({ sessionID: a.id, messageID: source.info.id })).toEqual(source)
    }),
  options,
  30_000,
)

it.instance(
  "async racing admissions publish a conflict, not a second accepted message update",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const bus = yield* Bus.Service
      const a = yield* f.sessions.create({})
      const b = yield* f.sessions.create({})
      const left = f.draft()
      const right = f.draft(left.messageID)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const failed = yield* Deferred.make<void>()
      const errors: unknown[] = []
      const events = yield* bus.subscribe(Session.Event.Error)
      yield* Stream.runForEach(events, (event) => {
        if (event.properties.sessionID !== a.id && event.properties.sessionID !== b.id) return Effect.void
        errors.push(event.properties.error)
        return Deferred.succeed(failed, undefined)
      }).pipe(Effect.forkChild)
      let count = 0
      const check = KiloAuth.check
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(KiloAuth, "check").mockImplementation((...args) =>
            check(...args).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  count++
                  if (count === 2) yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                }),
              ),
            ),
          ),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      const responses = yield* Effect.all([f.send(a.id, left, "prompt_async"), f.send(b.id, right, "prompt_async")], {
        concurrency: "unbounded",
      })
      expect(responses.map((response) => response.status)).toEqual([204, 204])
      yield* awaitWithTimeout(Deferred.await(entered), "async requests did not reach admission", "10 seconds")
      yield* Deferred.succeed(release, undefined)
      yield* awaitWithTimeout(Deferred.await(failed), "async identity failure was not published", "10 seconds")
      const winner = yield* pollWithTimeout(
        Effect.sync(() => {
          const row = Database.use((db) =>
            db.select().from(MessageTable).where(eq(MessageTable.id, left.messageID)).get(),
          )
          if (!row || !Budget.inspect({ sessionID: row.session_id, messageID: row.id })) return undefined
          return row
        }),
        "successful async admission did not finish",
      )
      expect(errors).toHaveLength(1)
      expect(JSON.stringify(errors)).toContain("SessionIdentityConflict")
      const accepted = Database.use((db) =>
        db
          .select()
          .from(EventTable)
          .where(
            and(
              inArray(EventTable.aggregate_id, [a.id, b.id]),
              eq(
                EventTable.type,
                SyncEvent.versionedType(MessageV2.Event.Updated.type, MessageV2.Event.Updated.version),
              ),
            ),
          )
          .all(),
      )
      expect(accepted).toHaveLength(1)
      expect(accepted[0].aggregate_id).toBe(winner.session_id)
      const message = yield* MessageV2.get({ sessionID: winner.session_id, messageID: left.messageID })
      expect(message.parts.filter((part) => part.type === "text" && !part.ignored)).toHaveLength(1)
    }),
  options,
  30_000,
)

it.instance(
  "rejected followup publication cannot roll back another message with the same ID",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const a = yield* f.sessions.create({})
      const b = yield* f.sessions.create({})
      const source = yield* f.admit(a.id)
      if (source.info.role !== "user") throw new Error("Expected user")
      const assistant = yield* f.sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: a.id,
        parentID: source.info.id,
        role: "assistant",
        agent: "code",
        mode: "code",
        modelID: model.modelID,
        providerID: provider,
        path: { cwd: "fixture", root: "fixture" },
        time: { created: Date.now() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const part = yield* f.sessions.updatePart({
        id: PartID.ascending(),
        sessionID: a.id,
        messageID: assistant.id,
        type: "text",
        text: "Existing answer",
      })
      for (const sessionID of [a.id, b.id]) {
        for (const id of [source.info.id, assistant.id]) {
          const before = yield* MessageV2.get({ sessionID: a.id, messageID: id })
          const result = yield* KiloCompactionState.publish({
            session: f.sessions,
            message: { ...source.info, id, sessionID },
            target: assistant.id,
          }).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          expect(yield* MessageV2.get({ sessionID: a.id, messageID: id })).toEqual(before)
          expect(yield* f.sessions.getPart({ sessionID: a.id, messageID: assistant.id, partID: part.id })).toEqual(part)
        }
      }
    }),
  options,
  30_000,
)
