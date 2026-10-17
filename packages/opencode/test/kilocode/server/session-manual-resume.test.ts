import { afterEach, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Auth } from "@/auth"
import { InstanceState } from "@/effect/instance-state"
import { KiloCompactionBudget as Budget } from "@/kilocode/session/compaction-budget"
import { KiloCompactionState } from "@/kilocode/session/compaction-state"
import { KiloSessionRecovery as Recovery } from "@/kilocode/session/recovery"
import { ModelID, ProviderID } from "@/provider/schema"
import { Server } from "@/server/server"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { disposeAllInstances, provideTmpdirInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Auth.defaultLayer, CrossSpawnSpawner.defaultLayer))
const provider = ProviderID.make("manual-fixture")
const ref = { providerID: provider, modelID: ModelID.make("fixture") }
afterEach(disposeAllInstances)

function fixture<A, E, R>(
  body: (value: {
    sessions: Session.Interface
    auth: Auth.Interface
    directory: string
    request: (path: string, method: string, data?: unknown) => Effect.Effect<Response>
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    let calls = 0
    const fake = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            calls++
            return new Response("Unexpected model call", { status: 500, headers: { "retry-after-ms": "0" } })
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const value = yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const auth = yield* Auth.Service
          const { directory } = yield* InstanceState.context
          yield* Effect.addFinalizer(() => auth.remove(provider).pipe(Effect.orDie))
          const request = (path: string, method: string, data?: unknown) =>
            Effect.promise(() =>
              Promise.resolve(
                Server.Default().app.request(path, {
                  method,
                  headers: { "content-type": "application/json", "x-kilo-directory": directory },
                  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
                }),
              ),
            )
          return yield* body({ sessions, auth, directory, request })
        }),
      {
        config: {
          snapshot: false,
          enabled_providers: [provider],
          model: `${provider}/${ref.modelID}`,
          provider: {
            [provider]: {
              name: "Manual recovery fixture",
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `${fake.url.origin}/v1` },
              models: { [ref.modelID]: { name: "fixture", limit: { context: 100_000, output: 4_096 } } },
            },
          },
        },
      },
    )
    expect(calls).toBe(0)
    return value
  })
}

function seed(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  return Effect.gen(function* () {
    const chat = yield* f.sessions.create({})
    yield* Effect.addFinalizer(() => Effect.sync(() => Recovery.reset(chat.id)))
    const historical = MessageID.ascending()
    const current = MessageID.ascending()
    for (const id of [historical, current]) {
      yield* f.auth.set(provider, { type: "api", key: id === current ? "fixture-current-B" : "fixture-historical-A" })
      const response = yield* f.request(`/session/${chat.id}/message`, "POST", {
        messageID: id,
        noReply: true,
        agent: "build",
        model: ref,
        variant: id === current ? "current-variant" : "historical-variant",
        parts: [
          { type: "text", text: id === current ? "The actual current task" : "The older task with a larger allowance" },
        ],
      })
      expect(response.status).toBe(200)
      yield* Effect.promise(() => response.text())
    }
    const old = { sessionID: chat.id, messageID: historical }
    const receipt = (yield* MessageV2.get(old)).parts.find(Budget.internal)!
    if (receipt.type !== "text") throw new Error("Missing historical receipt")
    yield* f.sessions.updatePart({
      ...receipt,
      metadata: { kilo_compaction_budget: { ...Budget.inspect(old)!, limits: Budget.bounds } },
    })
    const input = { sessionID: chat.id, messageID: current }
    yield* Budget.run(
      input,
      Effect.gen(function* () {
        const hook = yield* Budget.dispatcher
        hook!.model()
        hook!.transport()
      }),
    )
    const original = yield* MessageV2.get(input)
    if (original.info.role !== "user") throw new Error("Missing current user")
    const text = original.parts.find((part) => part.type === "text" && !part.ignored)!
    if (text.type !== "text") throw new Error("Missing current text")
    return { chat, input, old, original, text, budget: Budget.inspect(input)!, high: Budget.inspect(old)! }
  })
}

for (const mode of [
  "unchanged",
  "auto metadata",
  "manual metadata",
  "synthetic",
  "ignored",
  "resume text",
  "empty text",
  "deleted text",
] as const) {
  it.live(
    `manual Resume uses protected current provenance after ${mode}`,
    () =>
      fixture((f) =>
        Effect.gen(function* () {
          const v = yield* seed(f)
          expect(v.high.limits.requests).toBe(1000)
          expect(v.budget.limits).toEqual(Budget.defaults)
          expect(v.budget.requests).toBe(1)
          const path = `/session/${v.chat.id}/message/${v.input.messageID}/part/${v.text.id}`
          if (mode !== "unchanged") {
            const part = {
              ...v.text,
              ...(mode === "auto metadata" ? { metadata: { session_resume: true, auto_resume: true } } : {}),
              ...(mode === "manual metadata" ? { metadata: { session_resume: true, resume_kind: "manual" } } : {}),
              ...(mode === "synthetic" ? { synthetic: true } : {}),
              ...(mode === "ignored" ? { ignored: true } : {}),
              ...(mode === "resume text" ? { text: "resume" } : {}),
              ...(mode === "empty text" ? { text: "  " } : {}),
            }
            const edited = yield* f.request(
              path,
              mode === "deleted text" ? "DELETE" : "PATCH",
              mode === "deleted text" ? undefined : part,
            )
            expect(edited.status).toBe(200)
            yield* Effect.promise(() => edited.text())
          }
          const before = yield* MessageV2.get(v.input)
          for (const shipped of [true, false]) {
            const id = MessageID.ascending()
            const response = yield* f.request(`/session/${v.chat.id}/message`, "POST", {
              messageID: id,
              noReply: true,
              parts: [
                {
                  type: "text",
                  text: shipped ? "resume where you were interrupted" : "resume",
                  ...(shipped ? { metadata: { session_resume: true, resume_kind: "manual" } } : {}),
                },
              ],
            })
            expect(response.status).toBe(200)
            yield* Effect.promise(() => response.text())
            const resumed = yield* MessageV2.get({ ...v.input, messageID: id })
            if (resumed.info.role !== "user" || v.original.info.role !== "user")
              throw new Error("Missing admitted user")
            expect(resumed.info.model).toEqual(v.original.info.model)
            expect(resumed.info.authAuthority).toEqual(v.original.info.authAuthority)
            expect(resumed.info.authAuthorities).toEqual(v.original.info.authAuthorities)
            expect(Budget.inspect({ ...v.input, messageID: id })).toEqual(v.budget)
            expect(
              resumed.parts.some(
                (part) => part.type === "text" && part.metadata?.kilo_compaction_root === v.input.messageID,
              ),
            ).toBe(true)
          }
          expect(yield* MessageV2.get(v.input)).toEqual(before)
          expect(Budget.inspect(v.input)).toEqual(v.budget)
          expect(Budget.inspect(v.old)).toEqual(v.high)
        }),
      ),
    30_000,
  )
}

for (const mode of [
  "missing",
  "malformed",
  "ambiguous",
  "unsettled",
  "unadmitted latest",
  "staged latest",
  "missing authority",
  "missing catalog",
  "replacement credentials",
] as const) {
  it.live(
    `manual Resume cannot fall back to historical allowance for ${mode} current provenance`,
    () =>
      fixture((f) =>
        Effect.gen(function* () {
          const v = yield* seed(f)
          const receipt = v.original.parts.find(Budget.internal)!
          if (receipt.type !== "text") throw new Error("Missing current receipt")
          if (mode === "missing") yield* f.sessions.removePart({ ...v.input, partID: receipt.id })
          if (mode === "malformed")
            yield* f.sessions.updatePart({
              ...receipt,
              metadata: { kilo_compaction_budget: { ...v.budget, root: v.old.messageID } },
            })
          if (mode === "ambiguous") yield* f.sessions.updatePart({ ...receipt, id: PartID.ascending() })
          if (mode === "unsettled")
            yield* f.sessions.updatePart({
              ...receipt,
              metadata: {
                kilo_compaction_budget: {
                  ...v.budget,
                  reservations: v.budget.reservations.map((item) => ({ ...item, status: "reserved" })),
                },
              },
            })
          if (mode === "unadmitted latest") {
            if (v.original.info.role !== "user") throw new Error("Missing current user")
            const pending = yield* f.sessions.updateMessage({ ...v.original.info, id: MessageID.ascending() })
            yield* f.sessions.updatePart({
              id: PartID.ascending(),
              sessionID: v.chat.id,
              messageID: pending.id,
              type: "text",
              text: "Unadmitted pending input",
            })
          }
          if (mode === "staged latest") {
            if (v.original.info.role !== "user") throw new Error("Missing current user")
            const target = yield* f.sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: v.chat.id,
              parentID: v.input.messageID,
              role: "assistant",
              agent: "compaction",
              mode: "compaction",
              summary: true,
              modelID: ref.modelID,
              providerID: ref.providerID,
              path: { cwd: f.directory, root: f.directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now() },
            })
            yield* KiloCompactionState.publish({
              session: f.sessions,
              message: { ...v.original.info, id: MessageID.ascending() },
              target: target.id,
            })
          }
          if (mode === "missing authority" || mode === "missing catalog") {
            if (v.original.info.role !== "user") throw new Error("Missing current user")
            yield* f.sessions.updateMessage({
              ...v.original.info,
              ...(mode === "missing authority" ? { authAuthority: undefined } : { authAuthorities: undefined }),
            })
          }
          if (mode === "replacement credentials") {
            const edited = yield* f.request(
              `/session/${v.chat.id}/message/${v.input.messageID}/part/${v.text.id}`,
              "PATCH",
              { ...v.text, metadata: { session_resume: true, auto_resume: true } },
            )
            expect(edited.status).toBe(200)
            yield* Effect.promise(() => edited.text())
            yield* f.auth.set(provider, { type: "api", key: "fixture-replacement-C" })
          }
          // Invalid manual ancestry must fail before existing dangling-row repair runs.
          yield* f.sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: v.chat.id,
            parentID: v.input.messageID,
            role: "assistant",
            agent: "build",
            mode: "build",
            modelID: ref.modelID,
            providerID: ref.providerID,
            path: { cwd: f.directory, root: f.directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          const before = yield* f.sessions.messages({ sessionID: v.chat.id })
          const id = MessageID.ascending()
          const response = yield* f.request(`/session/${v.chat.id}/message`, "POST", {
            messageID: id,
            noReply: true,
            parts: [
              {
                type: "text",
                text: "resume where you were interrupted",
                metadata: { session_resume: true, resume_kind: "manual" },
              },
            ],
          })
          expect(response.status).toBeGreaterThanOrEqual(400)
          yield* Effect.promise(() => response.text())
          expect(Exit.isFailure(yield* MessageV2.get({ sessionID: v.chat.id, messageID: id }).pipe(Effect.exit))).toBe(
            true,
          )
          expect(yield* f.sessions.messages({ sessionID: v.chat.id })).toEqual(before)
          expect(Budget.inspect(v.old)).toEqual(v.high)
        }),
      ),
    30_000,
  )
}

it.live(
  "manual Resume with no protected current admission cannot invent a new quota",
  () =>
    fixture((f) =>
      Effect.gen(function* () {
        const chat = yield* f.sessions.create({})
        const id = MessageID.ascending()
        const before = yield* f.sessions.messages({ sessionID: chat.id })
        const response = yield* f.request(`/session/${chat.id}/message`, "POST", {
          messageID: id,
          noReply: true,
          parts: [{ type: "text", text: "resume", metadata: { session_resume: true, resume_kind: "manual" } }],
        })
        expect(response.status).toBeGreaterThanOrEqual(400)
        yield* Effect.promise(() => response.text())
        expect(yield* f.sessions.messages({ sessionID: chat.id })).toEqual(before)
        expect(Exit.isFailure(yield* MessageV2.get({ sessionID: chat.id, messageID: id }).pipe(Effect.exit))).toBe(true)
      }),
    ),
  30_000,
)
