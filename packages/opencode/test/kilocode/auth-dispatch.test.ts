import { expect } from "bun:test"
import { Cause, Effect, Fiber, Layer, Stream } from "effect"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { LLM } from "../../src/session/llm"
import { Auth } from "../../src/auth"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { KiloAuth } from "../../src/kilocode/auth/authority"
import { AuthRequest } from "../../src/kilocode/auth/request"
import { Server } from "../../src/server/server"
import { testEffect } from "../lib/effect"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import type { MessageV2 } from "../../src/session/message-v2"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

function stream(model: string, content: string) {
  const base = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model }
  return (
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`
  )
}

const deps = Layer.mergeAll(
  Auth.defaultLayer,
  Provider.defaultLayer,
  Config.defaultLayer,
  Plugin.defaultLayer,
  Agent.defaultLayer,
  Session.defaultLayer,
  AppFileSystem.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer)),
)

for (const native of [false, true]) {
  const flags = Layer.effect(
    RuntimeFlags.Service,
    Effect.map(RuntimeFlags.Service, (flags) => ({ ...flags, experimentalNativeLlm: native })),
  ).pipe(Layer.provide(RuntimeFlags.defaultLayer))
  const it = testEffect(LLM.layer.pipe(Layer.provideMerge(deps), Layer.provideMerge(flags)))
  it.live(`${native ? "native" : "SDK"} dispatch fences fresh replacement and rebuilds cached API credentials`, () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as { model: string }
          expect(request.headers.get(AuthRequest.header)).toBeNull()
          calls.push(request.headers.get("authorization") ?? "")
          return new Response(stream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } })
        },
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.stop(true)
        }),
      )
      const id = ProviderID.make(`opencode-auth-${native ? "native" : "sdk"}`)
      const modelID = ModelID.make("fixture")
      const dir = yield* tmpdirScoped({
        config: {
          enabled_providers: [id],
          provider: {
            [id]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Auth fixture",
              options: { baseURL: new URL("/v1", server.url).href },
              models: { fixture: { name: "Fixture", limit: { context: 128000, output: 1000 } } },
            },
          },
        },
      })
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          const provider = yield* Provider.Service
          const sessions = yield* Session.Service
          const llm = yield* LLM.Service
          const agents = yield* Agent.Service
          yield* auth.set(id, { type: "api", key: "fixture-A" })
          yield* Effect.addFinalizer(() => auth.remove(id).pipe(Effect.orDie))
          const session = yield* sessions.create({})
          const model = yield* provider.getModel(id, modelID)
          const agent = (yield* agents.get("build"))!
          const authority = yield* KiloAuth.capture({ providerID: id, modelID })
          const user: MessageV2.User = {
            id: MessageID.ascending(),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: id, modelID },
            authAuthority: authority,
          }
          const input: LLM.StreamInput = {
            user,
            sessionID: session.id,
            model,
            agent,
            permission: [],
            system: [],
            tools: {},
            messages: [{ role: "user", content: "fixture" }],
          }
          yield* llm.stream(input).pipe(Stream.runDrain)
          expect(calls).toEqual(["Bearer fixture-A"])
          yield* auth.set(id, { type: "api", key: "fixture-B" })
          const stale = yield* llm.stream(input).pipe(Stream.runDrain, Effect.exit)
          expect(stale._tag).toBe("Failure")
          if (stale._tag === "Failure") expect(Cause.squash(stale.cause)).toMatchObject({ reason: "authority-changed" })
          expect(calls).toHaveLength(1)
          const next = yield* KiloAuth.capture({ providerID: id, modelID })
          yield* llm
            .stream({ ...input, user: { ...user, id: MessageID.ascending(), authAuthority: next } })
            .pipe(Stream.runDrain)
          expect(calls).toEqual(["Bearer fixture-A", "Bearer fixture-B"])
        }),
      )
    }),
  )

  it.live(
    `${native ? "native" : "SDK"} configured helper provider is admitted before enqueue and a queued replacement is rejected`,
    () =>
      Effect.gen(function* () {
        const calls: string[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const body = (await request.json()) as { model: string }
            calls.push(request.headers.get("authorization") ?? "")
            return new Response(stream(body.model, "helper"), { headers: { "content-type": "text/event-stream" } })
          },
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.stop(true)
          }),
        )
        const a = ProviderID.make(`opencode-auth-primary-${native}`)
        const b = ProviderID.make(`opencode-auth-helper-${native}`)
        const mid = ModelID.make("fixture")
        const dir = yield* tmpdirScoped({
          config: {
            enabled_providers: [a, b],
            small_model: `${b}/fixture`,
            agent: { compaction: { model: `${b}/fixture` } },
            provider: Object.fromEntries(
              [a, b].map((id) => [
                id,
                {
                  npm: "@ai-sdk/openai-compatible",
                  name: "helper fixture",
                  options: { baseURL: new URL("/v1", server.url).href },
                  models: { fixture: { name: "Fixture", limit: { context: 128000, output: 1000 } } },
                },
              ]),
            ),
          },
        })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const provider = yield* Provider.Service
            const agent = (yield* Agent.Service.use((service) => service.get("build")))!
            const session = yield* Session.Service.use((service) => service.create({}))
            const llm = yield* LLM.Service
            yield* auth.set(a, { type: "api", key: "primary-A" })
            yield* auth.set(b, { type: "api", key: "helper-B" })
            yield* Effect.addFinalizer(() => Effect.all([auth.remove(a), auth.remove(b)]).pipe(Effect.orDie))
            const admitted = yield* KiloAuth.admit({ providerID: a, modelID: mid })
            const user: MessageV2.User = {
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: a, modelID: mid },
              authAuthority: admitted.authority,
              authAuthorities: admitted.authorities,
            }
            const model = yield* provider.getSmallModel(a)
            expect(model?.providerID).toBe(b)
            if (!model) throw new Error("Missing configured helper model")
            const helper = KiloAuth.selected(user, model)
            expect(helper?.providerID).toBe(b)
            expect(helper?.authority).not.toBe(user.authAuthority?.authority)
            const input: LLM.StreamInput = {
              user,
              sessionID: session.id,
              model,
              agent,
              permission: [],
              system: [],
              tools: {},
              small: true,
              messages: [{ role: "user", content: "compact fixture" }],
            }
            yield* llm.stream(input).pipe(Stream.runDrain)
            expect(calls).toEqual(["Bearer helper-B"])
            yield* auth.set(b, { type: "api", key: "helper-C" })
            const blocked = yield* llm.stream(input).pipe(Stream.runDrain, Effect.exit)
            expect(blocked._tag).toBe("Failure")
            if (blocked._tag === "Failure")
              expect(Cause.squash(blocked.cause)).toMatchObject({ reason: "authority-changed", providerID: b })
            expect(calls).toEqual(["Bearer helper-B"])
            expect(KiloAuth.selected(user, model)?.authority).toBe(helper?.authority)
          }),
        )
      }),
  )
}

const it = testEffect(LLM.defaultLayer.pipe(Layer.provideMerge(deps)))
it.live("auth DELETE leaves another workspace/config source and same-workspace provider stream running", () =>
  Effect.gen(function* () {
    const received = Promise.withResolvers<void>()
    const finish = new Map<string, () => void>()
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string }
        const key = request.headers.get("authorization") ?? ""
        expect(request.headers.get(AuthRequest.header)).toBeNull()
        const encoder = new TextEncoder()
        let closed = false
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(": admitted\n\n"))
              finish.set(key, () => {
                if (closed) return
                closed = true
                controller.enqueue(encoder.encode(stream(body.model, "finished")))
                controller.close()
              })
              if (++requests === 3) received.resolve()
            },
            cancel() {
              closed = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.stop(true)
      }),
    )
    const a = ProviderID.make("opencode-auth-scoped-a")
    const b = ProviderID.make("opencode-auth-scoped-b")
    const config = (key?: string): Config.Info => ({
      enabled_providers: [a, b],
      provider: Object.fromEntries(
        [a, b].map((id) => [
          id,
          {
            npm: "@ai-sdk/openai-compatible",
            name: "fixture",
            options: { baseURL: new URL("/v1", server.url).href, ...(key && id === a && { apiKey: key }) },
            models: { fixture: { name: "Fixture", limit: { context: 128000, output: 1000 } } },
          },
        ]),
      ),
    })
    const one = yield* tmpdirScoped({ config: config() })
    const two = yield* tmpdirScoped({ config: config("config-B") })
    const auth = yield* Auth.Service
    yield* auth.set(a, { type: "api", key: "file-A" })
    yield* auth.set(b, { type: "api", key: "file-C" })
    yield* Effect.addFinalizer(() => Effect.all([auth.remove(a), auth.remove(b)]).pipe(Effect.orDie))
    const launch = (dir: string, id: ProviderID) =>
      provideInstance(dir)(
        Effect.gen(function* () {
          const session = yield* Session.Service.use((s) => s.create({}))
          const model = yield* Provider.Service.use((s) => s.getModel(id, ModelID.make("fixture")))
          const agent = (yield* Agent.Service.use((s) => s.get("build")))!
          const authority = yield* KiloAuth.capture({ providerID: id, modelID: model.id })
          const user: MessageV2.User = {
            id: MessageID.ascending(),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: id, modelID: model.id },
            authAuthority: authority,
          }
          return yield* LLM.Service.use((llm) =>
            llm
              .stream({
                user,
                sessionID: session.id,
                model,
                agent,
                permission: [],
                system: [],
                tools: {},
                messages: [{ role: "user", content: "fixture" }],
              })
              .pipe(Stream.runDrain),
          )
        }),
      ).pipe(Effect.exit, Effect.forkChild)
    const first = yield* launch(one, a)
    const second = yield* launch(two, a)
    const third = yield* launch(one, b)
    yield* Effect.promise(() => received.promise)
    const response = yield* Effect.promise(async () =>
      Server.Default().app.request(`/auth/${a}?directory=${encodeURIComponent(one)}`, { method: "DELETE" }),
    )
    expect(response.status).toBe(200)
    const failed = yield* Fiber.join(first)
    expect(failed._tag).toBe("Failure")
    if (failed._tag === "Failure") expect(Cause.squash(failed.cause)).toMatchObject({ reason: "authority-changed" })
    finish.get("Bearer config-B")!()
    finish.get("Bearer file-C")!()
    expect((yield* Fiber.join(second))._tag).toBe("Success")
    expect((yield* Fiber.join(third))._tag).toBe("Success")
    expect(requests).toBe(3)
  }),
)
