import { expect, spyOn } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2 } from "@opencode-ai/core/event"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import * as AuthCatalog from "../../src/kilocode/auth/catalog"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(AppFileSystem.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.live("auth environment metadata reads the authoritative local file without initializing a catalog service", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const file = path.join(dir, "models.json")
    yield* Effect.promise(() =>
      Bun.write(
        file,
        JSON.stringify({
          openrouter: { id: "openrouter", env: ["OPENROUTER_API_KEY"] },
          azure: { id: "azure", env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] },
          mismatch: { id: "other", env: ["OTHER_KEY"] },
          malformed: { id: "malformed", env: ["NOT AN ENV NAME"] },
        }),
      ),
    )
    const saved = Flag.KILO_MODELS_PATH
    Flag.KILO_MODELS_PATH = file
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Flag.KILO_MODELS_PATH = saved
      }),
    )
    let calls = 0
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async () => {
              calls++
              throw new Error("Local metadata must not use the network")
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        ),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    )
    const env = yield* Effect.promise(() =>
      Promise.all(["openrouter", "azure", "mismatch", "malformed", "missing"].map((id) => AuthCatalog.environment(id))),
    )
    expect(env).toEqual([
      ["OPENROUTER_API_KEY"],
      ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
      undefined,
      undefined,
      undefined,
    ])
    expect(calls).toBe(0)
  }),
)

it.live("catalog construction is passive while first active get starts one scoped refresh", () =>
  Effect.gen(function* () {
    const saved = { disabled: Flag.KILO_DISABLE_MODELS_FETCH, url: Flag.KILO_MODELS_URL }
    Flag.KILO_DISABLE_MODELS_FETCH = false
    Flag.KILO_MODELS_URL = `https://catalog-${crypto.randomUUID()}.invalid`
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Flag.KILO_DISABLE_MODELS_FETCH = saved.disabled
        Flag.KILO_MODELS_URL = saved.url
      }),
    )
    const refreshed = Promise.withResolvers<void>()
    const calls: string[] = []
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        calls.push(request.url)
        return HttpClientResponse.fromWeb(request, Response.json({}))
      }),
    )
    yield* Effect.gen(function* () {
      const catalog = yield* ModelsDev.Service
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.sync((event) =>
        Effect.sync(() => {
          if (event.type === ModelsDev.Event.Refreshed.type) refreshed.resolve()
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      expect(calls).toEqual([])
      yield* catalog.get()
      yield* awaitWithTimeout(
        Effect.promise(() => refreshed.promise),
        "active catalog refresh did not complete",
      )
      yield* catalog.get()
      expect(calls).toEqual([`${Flag.KILO_MODELS_URL}/api.json`])
    }).pipe(
      Effect.provide(
        ModelsDev.layer.pipe(
          Layer.provideMerge(EventV2.defaultLayer),
          Layer.provide(Layer.mergeAll(AppFileSystem.defaultLayer, Layer.succeed(HttpClient.HttpClient, http))),
        ),
      ),
    )
  }),
)
