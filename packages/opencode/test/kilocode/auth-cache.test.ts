import { expect } from "bun:test"
import { Cause, Context, Effect, Exit, Fiber, Layer, Schema } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { createKiloClient } from "@kilocode/sdk"
import type { PluginInput } from "@kilocode/plugin"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { XaiAuthPlugin } from "../../src/plugin/xai"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceState } from "../../src/effect/instance-state"
import { KiloAuth } from "../../src/kilocode/auth/authority"
import { AuthRequest } from "../../src/kilocode/auth/request"
import { CodexModels } from "../../src/kilocode/provider/codex-models"
import { provideInstance, requireInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Call = { path: string; authorization: string | null; body?: { model?: string } }
class Fixture extends Context.Service<
  Fixture,
  { url: URL; calls: Call[]; catalog: Record<string, ModelsDev.Provider> }
>()("@test/AuthCache") {}

const fixture = Layer.effect(
  Fixture,
  Effect.gen(function* () {
    const calls: Call[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url)
            expect(request.headers.get(AuthRequest.header)).toBeNull()
            const authorization = request.headers.get("authorization")
            const body = request.method === "POST" ? ((await request.json()) as { model?: string }) : undefined
            calls.push({ path: url.pathname, authorization, body })
            if (url.pathname === "/backend-api/codex/models")
              return Response.json({
                models: [
                  {
                    slug: "gpt-5.6-sol",
                    context_window: 272000,
                    max_context_window: authorization === "Bearer oauth-B" ? 480000 : 872000,
                    effective_context_window_percent: 95,
                    supports_reasoning_summaries: true,
                    support_verbosity: true,
                    default_reasoning_level: "high",
                    supported_reasoning_levels: [{ effort: "high", description: "fixture" }],
                    default_verbosity: "low",
                    prefer_websockets: false,
                    parallel_tool_calls: true,
                    base_instructions: "Never import authenticated catalog instructions",
                  },
                ],
              })
            if (url.pathname.endsWith("/responses"))
              return Response.json({
                id: "resp-fixture",
                object: "response",
                created_at: 1,
                model: body?.model,
                status: "completed",
                output: [
                  {
                    id: "msg-fixture",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "ok", annotations: [] }],
                  },
                ],
                usage: {
                  input_tokens: 2,
                  output_tokens: 1,
                  total_tokens: 3,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                },
              })
            if (url.pathname.endsWith("/chat/completions"))
              return Response.json({
                id: "chat-fixture",
                object: "chat.completion",
                created: 1,
                model: body?.model,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
              })
            return new Response("Unexpected fixture request", { status: 500 })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const model = (id: string): ModelsDev.Model => ({
      id,
      name: id,
      family: "fixture",
      release_date: "2026-01-01",
      attachment: true,
      reasoning: true,
      temperature: false,
      tool_call: true,
      cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 1 },
      limit: { context: 1050000, input: 922000, output: 128000 },
      modalities: { input: ["text", "image"], output: ["text"] },
    })
    const catalog: Record<string, ModelsDev.Provider> = {
      openai: {
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: new URL("/openai/v1", server.url).href,
        models: { "gpt-5.2": model("gpt-5.2"), "gpt-5.6-sol": model("gpt-5.6-sol") },
      },
      xai: {
        id: "xai",
        name: "xAI",
        env: ["XAI_API_KEY"],
        npm: "@ai-sdk/xai",
        api: new URL("/xai/v1", server.url).href,
        models: { "grok-4": model("grok-4") },
      },
      "cache-other": {
        id: "cache-other",
        name: "Other",
        env: ["CACHE_OTHER_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: new URL("/other/v1", server.url).href,
        models: { fixture: model("fixture") },
      },
    }
    return { url: server.url, calls, catalog }
  }),
)

// Only the catalog data is injected. Provider, Plugin, Auth, Config, Env, and SDK transports are real.
const catalog = Layer.effect(
  ModelsDev.Service,
  Effect.map(Fixture, (f) =>
    ModelsDev.Service.of({
      get: () => Effect.succeed(f.catalog),
      refresh: () => Effect.die(new Error("Remote catalog refresh is forbidden in this fixture")),
    }),
  ),
).pipe(Layer.provideMerge(fixture))
const flags = RuntimeFlags.layer({ disableDefaultPlugins: true, pure: true })
const plugins = Plugin.layer.pipe(Layer.provide(Layer.mergeAll(Bus.defaultLayer, Config.defaultLayer, flags)))
const deps = Layer.mergeAll(
  catalog,
  plugins,
  flags,
  Bus.defaultLayer,
  AppFileSystem.defaultLayer,
  Auth.defaultLayer,
  Config.defaultLayer,
  Env.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(Provider.layer.pipe(Layer.provideMerge(deps)))
const allowed = ["openai", "xai", "cache-other"]

const setup = Effect.gen(function* () {
  const ctx = yield* requireInstance
  const f = yield* Fixture
  const auth = yield* Auth.Service
  const env = yield* Env.Service
  yield* env.remove("OPENAI_API_KEY")
  yield* env.remove("XAI_API_KEY")
  yield* env.set("CACHE_OTHER_KEY", "other-key")
  for (const id of ["openai", "xai"]) {
    yield* auth.remove(id)
    yield* Effect.addFinalizer(() => auth.remove(id).pipe(Effect.orDie))
  }
  const input: PluginInput = {
    client: createKiloClient({
      baseUrl: f.url.origin,
      fetch: Object.assign(
        async () => {
          throw new Error("Interactive auth is forbidden")
        },
        { preconnect: fetch.preconnect },
      ),
    }),
    project: ctx.project,
    directory: ctx.directory,
    worktree: ctx.worktree,
    serverUrl: f.url,
    $: Bun.$,
    experimental_workspace: {
      register() {
        throw new Error("Unexpected workspace registration")
      },
    },
  }
  const hooks = yield* Plugin.Service.use((service) => service.list())
  hooks.push(
    yield* Effect.promise(() =>
      CodexAuthPlugin(input, {
        issuer: f.url.origin,
        codexApiEndpoint: new URL("/backend-api/codex/responses", f.url).href,
      }),
    ),
  )
  hooks.push(yield* Effect.promise(() => XaiAuthPlugin(input, { tokenUrl: new URL("/oauth/token", f.url).href })))
  const health = { disposed: 0 }
  const scope = yield* InstanceState.make(() =>
    Effect.acquireRelease(
      Effect.sync(() => ({})),
      () =>
        Effect.sync(() => {
          health.disposed++
        }),
    ),
  )
  const healthy = yield* InstanceState.get(scope)
  return { f, auth, hooks, health, scope, healthy, provider: yield* Provider.Service }
})

const dispatch = Effect.fnUntraced(function* (model: Provider.Model) {
  const provider = yield* Provider.Service
  const expected = yield* KiloAuth.capture({ providerID: model.providerID, modelID: model.id })
  const guard = yield* Effect.acquireRelease(
    KiloAuth.request({ snapshot: expected, model, sessionID: "cache-fixture", messageID: "cache-fixture" }),
    (guard) => Effect.sync(() => guard.close()),
  )
  const language = yield* provider.getLanguage(model)
  const result = yield* Effect.promise(() =>
    language.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
      headers: { [AuthRequest.header]: guard.id },
      abortSignal: guard.signal,
    }),
  )
  expect(result.content.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["ok"])
  return language
}, Effect.scoped)

for (const id of ["openai", "xai"] as const) {
  for (const kind of ["api", "oauth"] as const) {
    it.instance(
      `absent ${id} activates after ${kind} login without disposing its instance or another SDK`,
      () =>
        Effect.gen(function* () {
          const t = yield* setup
          const pid = ProviderID.make(id)
          const mid = ModelID.make(id === "openai" ? "gpt-5.2" : "grok-4")
          const raw = Provider.fromModelsDevProvider(t.f.catalog[id]).models[mid]
          expect(Object.hasOwn(raw, "recommendedIndex")).toBe(true)
          expect(raw.recommendedIndex).toBeUndefined()
          expect(() => Schema.decodeUnknownSync(Provider.Model)(raw)).toThrow("recommendedIndex")
          expect((yield* t.provider.list())[pid]).toBeUndefined()
          const other = yield* t.provider.getModel(ProviderID.make("cache-other"), ModelID.make("fixture"))
          const language = yield* dispatch(other)
          const credential = (suffix: string) =>
            kind === "api"
              ? new Auth.Api({ type: "api", key: `api-${suffix}` })
              : new Auth.Oauth({
                  type: "oauth",
                  access: `oauth-${suffix}`,
                  refresh: `refresh-${suffix}`,
                  accountId: `account-${suffix}`,
                  expires: Date.now() + 3600000,
                })
          yield* t.auth.set(id, credential("A"))
          if (kind === "api") expect((yield* t.provider.getModel(pid, mid)).id).toBe(mid)
          expect((yield* t.provider.list())[pid]).toBeDefined()
          const model = yield* t.provider.getModel(pid, mid)
          Schema.decodeUnknownSync(Provider.Model)(model)
          expect(Object.hasOwn(model, "recommendedIndex")).toBe(false)
          const first = yield* dispatch(model)
          expect(t.f.calls.at(-1)?.authorization).toBe(`Bearer ${kind}-A`)
          yield* t.auth.set(id, credential("B"))
          const reloaded = yield* t.provider.getModel(pid, mid)
          Schema.decodeUnknownSync(Provider.Model)(reloaded)
          expect(Object.hasOwn(reloaded, "recommendedIndex")).toBe(false)
          const second = yield* dispatch(reloaded)
          expect(second).not.toBe(first)
          expect(t.f.calls.at(-1)?.authorization).toBe(`Bearer ${kind}-B`)
          expect(yield* t.provider.getLanguage(other)).toBe(language)
          expect(yield* InstanceState.get(t.scope)).toBe(t.healthy)
          expect(t.health.disposed).toBe(0)
          expect(t.f.calls.some((call) => /dispose|oauth|\/models$/.test(call.path))).toBe(false)
          yield* t.auth.remove(id)
          expect((yield* t.provider.list())[pid]).toBeUndefined()
          expect(yield* t.provider.getLanguage(other)).toBe(language)
        }),
      { config: { enabled_providers: allowed } },
    )
  }
}

it.instance(
  "cached OpenAI API models retain normalized defaults, metadata, aliases and configured overrides",
  () =>
    Effect.gen(function* () {
      const t = yield* setup
      const hint = () => "fixture"
      const ready = {
        status: "ready" as const,
        context: 272000,
        maximum: 872000,
        effectivePercent: 95,
        source: "fixture",
        revision: "fixture",
      }
      const capability = CodexModels.bind(CodexModels.unavailable("fixture"), async () => ready)
      t.hooks.push({
        provider: {
          id: "openai",
          models: async (provider) => ({
            ...provider.models,
            "gpt-5.2": {
              ...provider.models["gpt-5.2"],
              codex: capability,
              recommendedIndex: 3,
              terminalBench: { overallScore: 0.9, avgAttemptCostUsd: 0.1 },
              isFree: false,
              mayTrainOnYourPrompts: false,
              hasUserByokAvailable: true,
              prompt: "codex",
              ai_sdk_provider: "openai",
              options: { reasoningEffort: "medium", textVerbosity: "low", hint },
            },
          }),
        },
      })
      yield* t.auth.set("openai", new Auth.Api({ type: "api", key: "api-A" }))
      const pid = ProviderID.make("openai")
      const mid = ModelID.make("alias")
      const model = yield* t.provider.getModel(pid, mid)
      expect(model).toMatchObject({
        name: "Configured",
        api: { id: "gpt-5.2", npm: "@ai-sdk/openai" },
        recommendedIndex: 3,
        terminalBench: { overallScore: 0.9, avgAttemptCostUsd: 0.1 },
        isFree: false,
        mayTrainOnYourPrompts: false,
        hasUserByokAvailable: true,
        prompt: "codex",
        ai_sdk_provider: "openai",
        limit: { context: 600000, input: 500000, output: 90000 },
        headers: { "x-cache-fixture": "configured" },
        options: { reasoningEffort: "high", textVerbosity: "low" },
        capabilities: { input: { text: true, image: true }, output: { text: true, image: false }, toolcall: true },
      })
      expect(model.variants?.disabled).toBeUndefined()
      expect(model.variants?.custom).toEqual({ reasoningEffort: "low" })
      expect(model.options.hint).toBe(hint)
      expect(yield* Effect.promise(() => CodexModels.resolve(model.codex!, model.api.id))).toEqual(ready)
      const first = yield* dispatch(model)
      expect((yield* t.provider.list())[pid].models["gpt-5.2"]).toBeUndefined()
      yield* t.auth.set("openai", new Auth.Api({ type: "api", key: "api-B" }))
      const next = yield* t.provider.getModel(pid, mid)
      expect(next).toEqual(model)
      expect(next.options.hint).toBe(hint)
      expect(yield* Effect.promise(() => CodexModels.resolve(next.codex!, next.api.id))).toEqual(ready)
      expect(yield* dispatch(next)).not.toBe(first)
      expect(t.f.calls.at(-1)?.authorization).toBe("Bearer api-B")
    }),
  {
    config: {
      enabled_providers: allowed,
      provider: {
        openai: {
          whitelist: ["alias"],
          models: {
            alias: {
              id: "gpt-5.2",
              name: "Configured",
              limit: { context: 600000, input: 500000, output: 90000 },
              headers: { "x-cache-fixture": "configured" },
              options: { reasoningEffort: "high" },
              variants: { disabled: { disabled: true }, custom: { reasoningEffort: "low" } },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "an independent configured workspace retains its SDK when file auth changes",
  () =>
    Effect.gen(function* () {
      const t = yield* setup
      const other = yield* tmpdirScoped({
        config: { enabled_providers: allowed, provider: { openai: { options: { apiKey: "configured-key" } } } },
      })
      const pid = ProviderID.make("openai")
      const mid = ModelID.make("gpt-5.2")
      const language = yield* provideInstance(other)(
        Effect.gen(function* () {
          return yield* dispatch(yield* t.provider.getModel(pid, mid))
        }),
      )
      yield* t.auth.set("openai", new Auth.Api({ type: "api", key: "file-key" }))
      yield* dispatch(yield* t.provider.getModel(pid, mid))
      yield* provideInstance(other)(
        Effect.gen(function* () {
          yield* t.provider.list()
          expect(yield* dispatch(yield* t.provider.getModel(pid, mid))).toBe(language)
          expect(t.f.calls.at(-1)?.authorization).toBe("Bearer configured-key")
        }),
      )
    }),
  { config: { enabled_providers: allowed } },
)

it.instance(
  "cached OAuth reload preserves authenticated limits, discovery hints and loader binding",
  () =>
    Effect.gen(function* () {
      const saved = {
        KILO_APP_NAME: process.env.KILO_APP_NAME,
        ZEN_KILO_CONTEXT_POLICY: process.env.ZEN_KILO_CONTEXT_POLICY,
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.KILO_APP_NAME = "zen"
          process.env.ZEN_KILO_CONTEXT_POLICY = JSON.stringify({
            version: 1,
            window: "maximum-supported",
            automaticPercent: 85,
            admissionPercent: 95,
          })
        }),
        () =>
          Effect.sync(() => {
            for (const [key, value] of Object.entries(saved)) {
              if (value === undefined) delete process.env[key]
              else process.env[key] = value
            }
          }),
      )
      const t = yield* setup
      const credential = (suffix: string) =>
        new Auth.Oauth({
          type: "oauth",
          access: `oauth-${suffix}`,
          refresh: `refresh-${suffix}`,
          accountId: `account-${suffix}`,
          expires: Date.now() + 3600000,
        })
      yield* t.auth.set("openai", credential("A"))
      const pid = ProviderID.make("openai")
      const mid = ModelID.make("gpt-5.6-sol")
      const model = yield* t.provider.getModel(pid, mid)
      expect(model.limit).toEqual({ context: 1050000, input: 922000, output: 128000 })
      expect(model.codex).toMatchObject({
        status: "ready",
        context: 272000,
        maximum: 872000,
        effectivePercent: 95,
        source: "codex-catalog@0.162.0",
      })
      expect(model.prompt).toBeUndefined()
      const capability = model.codex!
      expect(yield* Effect.promise(() => CodexModels.resolve(capability, model.api.id))).toEqual(capability)
      expect(t.f.calls.filter((call) => call.path.endsWith("/models"))).toHaveLength(1)
      yield* t.auth.set("openai", credential("B"))
      const next = yield* t.provider.getModel(pid, mid)
      expect(next.codex?.binding).not.toBe(capability.binding)
      expect((yield* Effect.promise(() => CodexModels.resolve(capability, model.api.id))).status).toBe("unavailable")
      expect(yield* Effect.promise(() => CodexModels.resolve(next.codex!, next.api.id))).toMatchObject({
        status: "ready",
        maximum: 480000,
      })
      expect(t.f.calls.filter((call) => call.path.endsWith("/models")).map((call) => call.authorization)).toEqual([
        "Bearer oauth-A",
        "Bearer oauth-B",
      ])
    }),
  { config: { enabled_providers: allowed } },
)

it.instance(
  "reload still rejects invalid model metadata instead of weakening Model validation",
  () =>
    Effect.gen(function* () {
      const t = yield* setup
      t.hooks.push({
        provider: {
          id: "openai",
          models: async (provider) => ({
            ...provider.models,
            "gpt-5.2": { ...provider.models["gpt-5.2"], recommendedIndex: Number.NaN },
          }),
        },
      })
      yield* t.auth.set("openai", new Auth.Api({ type: "api", key: "api-A" }))
      const result = yield* t.provider.getModel(ProviderID.make("openai"), ModelID.make("gpt-5.2")).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("recommendedIndex")
      expect(t.f.calls).toEqual([])
    }),
  { config: { enabled_providers: allowed } },
)

it.instance(
  "a delayed old SDK initialization cannot repopulate the replacement provider cache",
  () =>
    Effect.gen(function* () {
      const t = yield* setup
      const ctx = yield* requireInstance
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const key = `auth-cache-${crypto.randomUUID()}`
      Reflect.set(globalThis, key, { ready: entered.resolve, wait: release.promise })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          release.resolve()
          Reflect.deleteProperty(globalThis, key)
        }),
      )
      const file = path.join(ctx.directory, "auth-cache-sdk.mjs")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          [
            `import { createOpenAI } from ${JSON.stringify(import.meta.resolve("@ai-sdk/openai"))};`,
            `globalThis[${JSON.stringify(key)}].ready();`,
            `await globalThis[${JSON.stringify(key)}].wait;`,
            "export { createOpenAI as createFixture };",
          ].join("\n"),
        ),
      )
      t.hooks.push({
        provider: {
          id: "openai",
          models: async (provider, context) => ({
            ...provider.models,
            "gpt-5.2": {
              ...provider.models["gpt-5.2"],
              api: {
                ...provider.models["gpt-5.2"].api,
                npm:
                  context.auth?.type === "api" && context.auth.key === "api-A"
                    ? pathToFileURL(file).href
                    : "@ai-sdk/openai",
              },
            },
          }),
        },
      })
      const pid = ProviderID.make("openai")
      const mid = ModelID.make("gpt-5.2")
      yield* t.auth.set("openai", new Auth.Api({ type: "api", key: "api-A" }))
      const old = yield* t.provider.getModel(pid, mid)
      const pending = yield* t.provider.getLanguage(old).pipe(Effect.exit, Effect.forkChild)
      yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("5 seconds"))
      yield* t.auth.set("openai", new Auth.Api({ type: "api", key: "api-B" }))
      const model = yield* t.provider.getModel(pid, mid)
      const current = yield* t.provider.getLanguage(model)
      release.resolve()
      expect((yield* Fiber.join(pending))._tag).toBe("Failure")
      expect(yield* t.provider.getLanguage(model)).toBe(current)
      expect(yield* dispatch(model)).toBe(current)
      expect(t.f.calls.map((call) => call.authorization)).toEqual(["Bearer api-B"])
      expect(t.health.disposed).toBe(0)
    }),
  { config: { enabled_providers: allowed } },
)
