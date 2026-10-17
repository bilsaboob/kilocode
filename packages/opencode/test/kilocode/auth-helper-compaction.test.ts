import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionCompaction } from "../../src/session/compaction"
import { KiloAuth } from "../../src/kilocode/auth/authority"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    SessionCompaction.defaultLayer,
    Session.defaultLayer,
    Auth.defaultLayer,
    Provider.defaultLayer,
    Config.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

for (const replaced of [false, true]) {
  it.live(
    `real configured cross-provider compaction ${replaced ? "rejects a queued replacement" : "uses its pre-admitted helper account"}`,
    () =>
      Effect.gen(function* () {
        const a = ProviderID.make(`opencode-compaction-primary-${replaced}`)
        const b = ProviderID.make(`opencode-compaction-helper-${replaced}`)
        const mid = ModelID.make("fixture")
        const calls: string[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            await request.json()
            calls.push(request.headers.get("authorization") ?? "")
            const text =
              "## Goal\nContinue the isolated fixture.\n## Instructions\nKeep the admitted provider and task boundaries.\n## Accomplished\nInspected fixture input.\n## Next Steps\nFinish the fixture verification.\n## Relevant Files\nNo files changed."
            const base = { id: "chatcmpl-compaction", object: "chat.completion.chunk", created: 1, model: "fixture" }
            return new Response(
              `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.stop(true)
          }),
        )
        const dir = yield* tmpdirScoped({
          config: {
            enabled_providers: [a, b],
            small_model: `${b}/fixture`,
            agent: { compaction: { model: `${b}/fixture` } },
            compaction: { auto: false, tail_turns: 0, prune: false, reserved: 0 },
            provider: Object.fromEntries(
              [a, b].map((id) => [
                id,
                {
                  npm: "@ai-sdk/openai-compatible",
                  name: "fixture",
                  options: { baseURL: new URL("/v1", server.url).href },
                  models: { fixture: { name: "fixture", limit: { context: 128000, output: 1000 } } },
                },
              ]),
            ),
          },
        })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const sessions = yield* Session.Service
            const prompts = yield* SessionPrompt.Service
            const compaction = yield* SessionCompaction.Service
            yield* auth.set(a, { type: "api", key: "primary-A" })
            yield* auth.set(b, { type: "api", key: "helper-B" })
            yield* Effect.addFinalizer(() => Effect.all([auth.remove(a), auth.remove(b)]).pipe(Effect.orDie))
            const session = yield* sessions.create({})
            const admitted = yield* prompts.prompt({
              sessionID: session.id,
              noReply: true,
              model: { providerID: a, modelID: mid },
              parts: [
                {
                  type: "text",
                  text: "Preserve this original user intent and produce a compact continuation summary.",
                },
              ],
            })
            if (admitted.info.role !== "user") throw new Error("Expected admitted user")
            const bound = KiloAuth.selected(admitted.info, { providerID: b, modelID: mid })
            expect(bound?.providerID).toBe(b)
            yield* compaction.create({
              sessionID: session.id,
              agent: "build",
              model: { providerID: a, modelID: mid },
              auto: false,
            })
            if (replaced) yield* auth.set(b, { type: "api", key: "helper-C" })
            const messages = yield* sessions.messages({ sessionID: session.id })
            const pending = messages.findLast(
              (message) => message.info.role === "user" && message.parts.some((part) => part.type === "compaction"),
            )
            if (!pending || pending.info.role !== "user") throw new Error("Missing compaction marker")
            expect(KiloAuth.selected(pending.info, { providerID: b, modelID: mid })?.authority).toBe(bound?.authority)
            const result = yield* compaction.process({
              sessionID: session.id,
              parentID: pending.info.id,
              messages,
              auto: false,
            })
            if (replaced) {
              expect(result).toBe("stop")
              expect(calls).toEqual([])
            } else {
              expect(result).toBe("continue")
              expect(calls).toEqual(["Bearer helper-B"])
            }
          }),
        )
      }),
  )
}
