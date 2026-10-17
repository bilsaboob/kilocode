import { afterEach, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { KiloCompactionBudget as Budget } from "@/kilocode/session/compaction-budget"
import { KiloSessionRecovery } from "@/kilocode/session/recovery"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Server } from "@/server/server"
import { ModelID, ProviderID } from "@/provider/schema"
import { InstanceState } from "@/effect/instance-state"
import { disposeAllInstances, provideTmpdirInstance, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { testProviderConfig } from "../../lib/test-provider"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))
const model = { providerID: ProviderID.make("budget-fixture"), modelID: ModelID.make("not-a-live-model") }
afterEach(disposeAllInstances)

function request(directory: string, path: string, method: string, body?: unknown) {
  return Effect.promise(() =>
    Promise.resolve(
      Server.Default().app.request(path, {
        method,
        headers: { "content-type": "application/json", "x-kilo-directory": directory },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  )
}

it.instance(
  "public synchronous and asynchronous prompts cannot forge internal compaction receipts",
  () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { directory } = yield* TestInstance
      const chat = yield* session.create({})
      for (const path of ["message", "prompt_async"]) {
        const id = MessageID.ascending()
        for (const metadata of [
          {
            kilo_compaction_budget: {
              version: 1,
              root: id,
              limits: Budget.bounds,
              requests: 0,
              milliseconds: 0,
              active: null,
              reservations: [],
            },
          },
          { kilo_compaction_root: id },
          { kilo_compaction_followup: id },
        ]) {
          const response = yield* request(directory, `/session/${chat.id}/${path}`, "POST", {
            messageID: id,
            noReply: true,
            model,
            parts: [{ type: "text", text: "", ignored: true, metadata }],
          })
          expect(response.status).toBe(400)
          expect(Exit.isFailure(yield* MessageV2.get({ sessionID: chat.id, messageID: id }).pipe(Effect.exit))).toBe(
            true,
          )
        }
      }
    }),
  30_000,
)

it.instance(
  "public part replacement deletion and message cascade cannot reset frozen spending",
  () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { directory } = yield* TestInstance
      const chat = yield* session.create({})
      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: chat.id,
        role: "user",
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      const text = yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: user.id,
        type: "text",
        text: "Original task",
      })
      const input = { sessionID: chat.id, messageID: user.id }
      yield* Budget.admit(input)
      yield* Budget.run(
        input,
        Effect.gen(function* () {
          const hook = yield* Budget.dispatcher
          hook!.model()
          hook!.transport()
        }),
      )
      const before = Budget.inspect(input)!
      const receipt = (yield* MessageV2.get(input)).parts.find(Budget.internal)!
      const path = `/session/${chat.id}/message/${user.id}`
      for (const replacement of [
        { ...receipt, metadata: { kilo_compaction_budget: { ...before, limits: Budget.bounds } } },
        { ...receipt, metadata: { kilo_compaction_budget: { ...before, requests: 0, reservations: [] } } },
        { ...receipt, metadata: {} },
        { ...receipt, id: PartID.ascending() },
      ]) {
        expect((yield* request(directory, `${path}/part/${replacement.id}`, "PATCH", replacement)).status).toBe(400)
        expect(Budget.inspect(input)).toEqual(before)
      }
      expect((yield* request(directory, `${path}/part/${receipt.id}`, "DELETE")).status).toBe(400)
      expect((yield* request(directory, path, "DELETE")).status).toBe(400)
      expect(Budget.inspect(input)).toEqual(before)
      const replay = yield* request(directory, `/session/${chat.id}/message`, "POST", {
        messageID: user.id,
        noReply: true,
        model,
        parts: [{ type: "text", text: "Original task" }],
      })
      expect(replay.status).toBe(200)
      yield* Effect.promise(() => replay.text())
      expect(yield* Budget.admit(input)).toEqual(before)
      expect(
        (yield* request(directory, `${path}/part/${text.id}`, "PATCH", {
          ...text,
          text: "Explicit ordinary part edit",
        })).status,
      ).toBe(200)
      expect((yield* request(directory, `${path}/part/${text.id}`, "DELETE")).status).toBe(200)
      expect(Budget.inspect(input)).toEqual(before)
    }),
  30_000,
)

it.live(
  "public recovery anchors cannot select a different root or grant a fresh quota",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const fake = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
              calls++
              return new Response("Unexpected model dispatch", { status: 500, headers: { "retry-after-ms": "0" } })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const { directory } = yield* InstanceState.context
            const chat = yield* sessions.create({})
            yield* Effect.addFinalizer(() => Effect.sync(() => KiloSessionRecovery.reset(chat.id)))
            const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
            const decoy = MessageID.ascending()
            const original = MessageID.ascending()
            for (const id of [decoy, original]) {
              const response = yield* request(directory, `/session/${chat.id}/message`, "POST", {
                messageID: id,
                noReply: true,
                agent: "build",
                model: ref,
                variant: "fixture-variant",
                parts: [
                  { type: "text", text: id === original ? "The actual pending task" : "An earlier independent task" },
                ],
              })
              expect(response.status).toBe(200)
              yield* Effect.promise(() => response.text())
            }
            const input = { sessionID: chat.id, messageID: original }
            yield* Budget.run(
              input,
              Effect.gen(function* () {
                const hook = yield* Budget.dispatcher
                hook!.model()
                hook!.transport()
              }),
            )
            const before = Budget.inspect(input)!
            const saved = yield* MessageV2.get(input)
            const text = saved.parts.find((part) => part.type === "text" && !part.ignored)!
            const changed = yield* request(
              directory,
              `/session/${chat.id}/message/${original}/part/${text.id}`,
              "PATCH",
              {
                ...text,
                synthetic: true,
                metadata: { session_resume: true, auto_resume: true, anchor_user_message_id: decoy },
              },
            )
            expect(changed.status).toBe(200)
            yield* Effect.promise(() => changed.text())
            const failure: MessageV2.Assistant = {
              id: MessageID.ascending(),
              sessionID: chat.id,
              parentID: original,
              role: "assistant",
              agent: "build",
              mode: "build",
              modelID: ref.modelID,
              providerID: ref.providerID,
              path: { cwd: directory, root: directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now(), completed: Date.now() },
              finish: "error",
              error: new MessageV2.APIError({
                message: "Fixture transient failure",
                isRetryable: true,
                statusCode: 503,
              }).toObject(),
            }
            yield* sessions.updateMessage(failure)
            const decision = KiloSessionRecovery.finish({
              sessionID: chat.id,
              message: failure,
              messages: yield* sessions.messages({ sessionID: chat.id }),
            })
            if (decision?.action !== "resume") throw new Error("Missing recovery decision")
            const id = MessageID.ascending()
            const response = yield* request(directory, `/session/${chat.id}/message`, "POST", {
              messageID: id,
              noReply: true,
              agent: "build",
              parts: [
                {
                  type: "text",
                  text: "resume",
                  synthetic: true,
                  metadata: {
                    session_resume: true,
                    resume_kind: "automatic",
                    auto_resume: true,
                    recovery_token: decision.token,
                    anchor_user_message_id: decoy,
                  },
                },
              ],
            })
            expect(response.status).toBe(200)
            yield* Effect.promise(() => response.text())
            expect(Budget.inspect({ ...input, messageID: id })).toEqual(before)
            expect(Budget.inspect({ ...input, messageID: decoy })?.requests).toBe(0)
            const source = yield* MessageV2.get(input)
            const resumed = yield* MessageV2.get({ ...input, messageID: id })
            if (source.info.role !== "user" || resumed.info.role !== "user") throw new Error("Missing user records")
            expect(resumed.info.model).toEqual(source.info.model)
            expect(resumed.info.authAuthority).toEqual(source.info.authAuthority)
            expect(resumed.info.authAuthorities).toEqual(source.info.authAuthorities)
            expect(
              resumed.parts.some(
                (part) => part.type === "text" && part.ignored && part.metadata?.kilo_compaction_root === original,
              ),
            ).toBe(true)
            expect(calls).toBe(0)
          }),
        { config: { ...testProviderConfig(`${fake.url.origin}/v1`), snapshot: false } },
      )
    }),
  30_000,
)

it.live(
  "malformed noReply recovery cannot adopt a higher historical allowance and shipped Resume remains valid",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const fake = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
              calls++
              return new Response("Unexpected model request", { status: 500, headers: { "retry-after-ms": "0" } })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const { directory } = yield* InstanceState.context
            const chat = yield* sessions.create({})
            const other = yield* sessions.create({})
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                KiloSessionRecovery.reset(chat.id)
                KiloSessionRecovery.reset(other.id)
              }),
            )
            const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
            const put = Effect.fn(function* (
              sessionID: typeof chat.id,
              text: string,
              metadata?: Record<string, unknown>,
            ) {
              const id = MessageID.ascending()
              const response = yield* request(directory, `/session/${sessionID}/message`, "POST", {
                messageID: id,
                noReply: true,
                agent: "build",
                model: ref,
                parts: [{ type: "text", text, ...(metadata ? { metadata } : {}) }],
              })
              expect(response.status).toBe(200)
              yield* Effect.promise(() => response.text())
              return id
            })
            const historical = yield* put(chat.id, "Earlier task admitted under a larger allowance")
            const original = yield* put(chat.id, "The current task under the startup allowance")
            const foreign = yield* put(other.id, "A task in a different session")
            const old = { sessionID: chat.id, messageID: historical }
            const receipt = (yield* MessageV2.get(old)).parts.find(Budget.internal)!
            if (receipt.type !== "text") throw new Error("Missing historical receipt")
            // Trusted fixture setup represents a valid ledger frozen by an earlier startup policy.
            yield* sessions.updatePart({
              ...receipt,
              metadata: { kilo_compaction_budget: { ...Budget.inspect(old)!, limits: Budget.bounds } },
            })
            const high = Budget.inspect(old)!
            expect(high.limits.requests).toBeGreaterThan(Budget.settings().requests)
            expect(high.limits.milliseconds).toBeGreaterThan(Budget.settings().milliseconds)
            const input = { sessionID: chat.id, messageID: original }
            yield* Budget.run(
              input,
              Effect.gen(function* () {
                const hook = yield* Budget.dispatcher
                hook!.model()
                hook!.transport()
              }),
            )
            const current = Budget.inspect(input)!
            const failed: MessageV2.Assistant = {
              id: MessageID.ascending(),
              sessionID: other.id,
              parentID: foreign,
              role: "assistant",
              agent: "build",
              mode: "build",
              modelID: ref.modelID,
              providerID: ref.providerID,
              path: { cwd: directory, root: directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now(), completed: Date.now() },
              finish: "error",
              error: new MessageV2.APIError({
                message: "Fixture temporary failure",
                isRetryable: true,
                statusCode: 503,
              }).toObject(),
            }
            yield* sessions.updateMessage(failed)
            const wrong = KiloSessionRecovery.finish({
              sessionID: other.id,
              message: failed,
              messages: yield* sessions.messages({ sessionID: other.id }),
            })
            if (wrong?.action !== "resume") throw new Error("Missing foreign fixture token")
            const cases: Record<string, unknown>[] = [
              { auto_resume: true, anchor_user_message_id: historical },
              { auto_resume: true },
              { auto_resume: true, anchor_user_message_id: foreign },
              ...[null, 17, "", "not-a-message"].map((anchor_user_message_id) => ({
                auto_resume: true,
                anchor_user_message_id,
              })),
              ...[null, "1", 0, -1, 1.5].map((recovery_token) => ({
                auto_resume: true,
                recovery_token,
                anchor_user_message_id: historical,
              })),
              { session_resume: true, resume_kind: "automatic", anchor_user_message_id: historical },
              { auto_resume: true, recovery_token: wrong.token, anchor_user_message_id: foreign },
              { auto_resume: true, recovery_token: wrong.token, anchor_user_message_id: 42 },
              { session_resume: true, resume_kind: "manual", anchor_user_message_id: 42 },
              { anchor_user_message_id: historical },
            ]
            for (const path of ["message", "prompt_async"])
              for (const metadata of cases) {
                const id = MessageID.ascending()
                const response = yield* request(directory, `/session/${chat.id}/${path}`, "POST", {
                  messageID: id,
                  noReply: true,
                  model: ref,
                  parts: [{ type: "text", text: "An ordinary new prompt", metadata }],
                })
                expect(response.status).toBe(400)
                yield* Effect.promise(() => response.text())
                expect(Exit.isFailure(yield* MessageV2.get({ ...input, messageID: id }).pipe(Effect.exit))).toBe(true)
                expect(Budget.inspect(old)).toEqual(high)
                expect(Budget.inspect(input)).toEqual(current)
              }
            for (const anchor of [historical, foreign]) {
              const manual = yield* put(chat.id, "resume where you were interrupted", {
                session_resume: true,
                resume_kind: "manual",
                anchor_user_message_id: anchor,
                interrupted_assistant_message_id: failed.id,
                recovery_token: wrong.token,
              })
              expect(Budget.inspect({ ...input, messageID: manual })).toEqual(current)
              const canonical = (yield* MessageV2.get({ ...input, messageID: manual })).parts.find(
                (part) => part.type === "text" && !part.ignored,
              )
              expect(canonical?.type === "text" && canonical.metadata?.anchor_user_message_id).toBe(original)
              expect(canonical?.type === "text" && canonical.metadata?.interrupted_assistant_message_id).toBeUndefined()
            }
            const bare = yield* put(chat.id, "resume")
            expect(Budget.inspect({ ...input, messageID: bare })).toEqual(current)
            const failure: MessageV2.Assistant = {
              ...failed,
              id: MessageID.ascending(),
              sessionID: chat.id,
              parentID: original,
            }
            yield* sessions.updateMessage(failure)
            for (const explicit of [false, true]) {
              const decision = KiloSessionRecovery.finish({
                sessionID: chat.id,
                message: failure,
                messages: yield* sessions.messages({ sessionID: chat.id }),
              })
              if (decision?.action !== "resume") throw new Error("Missing actual recovery token")
              const id = yield* put(chat.id, "Continue the interrupted task", {
                session_resume: true,
                resume_kind: "automatic",
                recovery_token: decision.token,
                ...(explicit ? { auto_resume: true } : {}),
                anchor_user_message_id: historical,
              })
              expect(Budget.inspect({ ...input, messageID: id })).toEqual(current)
            }
            expect(Budget.inspect(old)).toEqual(high)
            expect(calls).toBe(0)
          }),
        { config: { ...testProviderConfig(`${fake.url.origin}/v1`), snapshot: false } },
      )
    }),
  30_000,
)
