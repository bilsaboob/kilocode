import type { PluginInput } from "@kilocode/plugin"
import { createKiloClient } from "@kilocode/sdk"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { registerDisposer } from "../../src/effect/instance-registry"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { InstanceLayer } from "../../src/project/instance-layer"
import { InstanceStore } from "../../src/project/instance-store"
import { Server } from "../../src/server/server"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

const it = testEffectShared(Layer.mergeAll(Auth.defaultLayer, InstanceLayer.layer, CrossSpawnSpawner.defaultLayer))

it.live(
  "Codex token renewal preserves workspaces while explicit auth changes still dispose them",
  () =>
    Effect.gen(function* () {
      const content = process.env.KILO_AUTH_CONTENT
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          delete process.env.KILO_AUTH_CONTENT
        }),
        () =>
          Effect.sync(() => {
            if (content === undefined) {
              delete process.env.KILO_AUTH_CONTENT
              return
            }
            process.env.KILO_AUTH_CONTENT = content
          }),
      )
      const auth = yield* Auth.Service
      const store = yield* InstanceStore.Service
      const previous = yield* auth.get("openai")
      yield* Effect.acquireRelease(
        auth.set(
          "openai",
          new Auth.Oauth({ type: "oauth", refresh: "expired-refresh", access: "expired", expires: 0 }),
        ),
        () => (previous ? auth.set("openai", previous) : auth.remove("openai")).pipe(Effect.orDie),
      )
      const requests: string[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              const url = new URL(request.url)
              requests.push(url.pathname)
              if (url.pathname === "/oauth/token")
                return Response.json({
                  id_token: "",
                  access_token: "renewed-access",
                  refresh_token: "renewed-refresh",
                  expires_in: 3600,
                })
              expect(request.headers.get("authorization")).toBe("Bearer renewed-access")
              return Response.json({ ok: true })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const directories = [yield* tmpdirScoped(), yield* tmpdirScoped()]
      const contexts = yield* Effect.forEach(directories, (directory) =>
        Effect.acquireRelease(store.load({ directory }), (context) => store.dispose(context)),
      )
      const aborted = new AbortController()
      const disposed: string[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer(async (directory) => {
            if (!directories.includes(directory)) return
            disposed.push(directory)
            aborted.abort()
          }),
        ),
        (off) => Effect.sync(off),
      )
      const app = Server.Default().app
      const input: PluginInput = {
        client: createKiloClient({
          baseUrl: "http://kilo.test",
          fetch: Object.assign(
            async (request: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(request, init)),
            { preconnect: fetch.preconnect },
          ),
        }),
        project: contexts[0].project,
        directory: contexts[0].directory,
        worktree: contexts[0].worktree,
        experimental_workspace: {
          register() {
            throw new Error("Unexpected workspace registration")
          },
        },
        serverUrl: new URL("http://kilo.test"),
        $: Bun.$,
      }
      const plugin = yield* Effect.promise(() =>
        CodexAuthPlugin(input, {
          issuer: server.url.origin,
          codexApiEndpoint: new URL("/responses", server.url).href,
        }),
      )
      const loaded = yield* Effect.promise(() =>
        plugin.auth!.loader!(async () => (await Effect.runPromise(auth.get("openai")))!, {
          id: "openai",
          name: "OpenAI",
          source: "api",
          env: [],
          options: {},
          models: {},
        }),
      )
      const response = yield* Effect.promise(() =>
        loaded.fetch(new URL("/v1/responses", server.url), { signal: aborted.signal }),
      )
      if (!(response instanceof Response)) throw new Error("Missing Codex response")
      expect(response.status).toBe(200)
      expect(requests).toEqual(["/oauth/token", "/responses"])
      expect(disposed).toEqual([])
      expect(aborted.signal.aborted).toBe(false)
      expect(yield* auth.get("openai")).toMatchObject({ access: "renewed-access", refresh: "renewed-refresh" })
      for (const context of contexts) expect(yield* store.load({ directory: context.directory })).toBe(context)

      const changed = yield* Effect.promise(async () =>
        app.request("/auth/openai", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "api", key: "explicit-account-change" }),
        }),
      )
      expect(changed.status).toBe(200)
      expect(disposed.toSorted()).toEqual(directories.toSorted())
      expect(aborted.signal.aborted).toBe(true)
      disposed.length = 0
      for (const directory of directories) yield* store.load({ directory })
      const removed = yield* Effect.promise(async () => app.request("/auth/openai", { method: "DELETE" }))
      expect(removed.status).toBe(200)
      expect(disposed.toSorted()).toEqual(directories.toSorted())
      expect(yield* auth.get("openai")).toBeUndefined()
    }),
  30_000,
)
