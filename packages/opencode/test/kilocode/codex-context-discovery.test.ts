import type { PluginInput } from "@kilocode/plugin"
import { createKiloClient } from "@kilocode/sdk"
import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Auth } from "../../src/auth"
import { CodexModels } from "../../src/kilocode/provider/codex-models"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { Provider } from "../../src/provider/provider"
import { ModelID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { requireInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

const it = testEffectShared(Auth.defaultLayer)

for (const mode of ["legacy", "profile", "refresh", "api"] as const) {
  it.instance(
    `Codex model discovery respects the ${mode} authentication/profile boundary`,
    () =>
      Effect.gen(function* () {
        const saved = {
          ZEN_KILO_CONTEXT_POLICY: process.env.ZEN_KILO_CONTEXT_POLICY,
          KILO_AUTH_CONTENT: process.env.KILO_AUTH_CONTENT,
          KILO_APP_NAME: process.env.KILO_APP_NAME,
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            delete process.env.KILO_AUTH_CONTENT
            delete process.env.ZEN_KILO_CONTEXT_POLICY
            process.env.KILO_APP_NAME = "zen"
            if (mode !== "legacy") {
              process.env.ZEN_KILO_CONTEXT_POLICY = JSON.stringify({
                version: 1,
                window: "maximum-supported",
                automaticPercent: 85,
                admissionPercent: 95,
              })
            }
          }),
          () =>
            Effect.sync(() => {
              for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) {
                  delete process.env[key]
                  continue
                }
                process.env[key] = value
              }
            }),
        )
        const store = yield* Auth.Service
        const prior = yield* store.get("openai")
        const auth =
          mode === "api"
            ? new Auth.Api({ type: "api", key: "test-api-key" })
            : new Auth.Oauth({
                type: "oauth",
                access: "test-access",
                refresh: "test-refresh",
                expires: mode === "refresh" ? 0 : Date.now() + 3600000,
                accountId: "test-account",
              })
        yield* Effect.acquireRelease(store.set("openai", auth), () =>
          (prior ? store.set("openai", prior) : store.remove("openai")).pipe(Effect.orDie),
        )
        const requests: Array<{ path: string; method: string; authorization: string | null }> = []
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                const url = new URL(request.url)
                requests.push({
                  path: url.pathname,
                  method: request.method,
                  authorization: request.headers.get("Authorization"),
                })
                if (url.pathname === "/oauth/token") {
                  return Response.json({
                    id_token: "",
                    access_token: "renewed-access",
                    refresh_token: "renewed-refresh",
                    expires_in: 3600,
                  })
                }
                if (url.pathname === "/backend-api/codex/models") {
                  return Response.json({
                    models: [
                      {
                        slug: "gpt-5.6-sol",
                        context_window: 272000,
                        max_context_window: 872000,
                        effective_context_window_percent: 95,
                        base_instructions: "Do not import this text",
                      },
                      {
                        slug: "gpt-5.5",
                        context_window: 272000,
                        max_context_window: 272000,
                        effective_context_window_percent: 95,
                      },
                    ],
                  })
                }
                return new Response("Unexpected request", { status: 500 })
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        const ctx = yield* requireInstance
        const input: PluginInput = {
          client: createKiloClient({
            baseUrl: server.url.origin,
            fetch: Object.assign(
              async () => {
                throw new Error("Discovery must not call interactive auth APIs")
              },
              { preconnect: fetch.preconnect },
            ),
          }),
          project: ctx.project,
          directory: ctx.directory,
          worktree: ctx.worktree,
          experimental_workspace: {
            register() {
              throw new Error("Unexpected workspace registration")
            },
          },
          serverUrl: server.url,
          $: Bun.$,
        }
        const plugin = yield* Effect.promise(() =>
          CodexAuthPlugin(input, {
            issuer: server.url.origin,
            codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).href,
          }),
        )
        const newer = ProviderTest.model({
          id: ModelID.make("gpt-5.6-sol"),
          api: { id: "gpt-5.6-sol", url: server.url.origin, npm: "@ai-sdk/openai" },
          limit: { context: 1050000, input: 922000, output: 128000 },
        })
        const older = ProviderTest.model({
          id: ModelID.make("gpt-5.5"),
          api: { id: "gpt-5.5", url: server.url.origin, npm: "@ai-sdk/openai" },
          limit: { context: 1050000, input: 922000, output: 128000 },
        })
        const provider = ProviderTest.info({ models: { [newer.id]: newer, [older.id]: older } })
        const models = yield* Effect.promise(() => plugin.provider!.models!(provider, { auth }))
        const selected = Schema.decodeUnknownSync(Provider.Model)(models["gpt-5.6-sol"])
        const legacy = Schema.decodeUnknownSync(Provider.Model)(models["gpt-5.5"])
        expect(selected.limit).toEqual(newer.limit)
        expect(selected.prompt).toBeUndefined()
        expect(legacy.limit.context).toBe(mode === "api" ? 1050000 : 400000)
        expect(requests.some((request) => request.path.endsWith("/responses"))).toBe(false)
        expect(requests.filter((request) => request.path === "/oauth/token")).toHaveLength(mode === "refresh" ? 1 : 0)
        if (mode === "legacy" || mode === "api") {
          expect(selected.codex).toBeUndefined()
          expect(requests).toEqual([])
          return
        }
        expect(selected.codex).toMatchObject({ status: "ready", context: 272000, maximum: 872000 })
        expect(legacy.codex).toMatchObject({ status: "ready", maximum: 272000 })
        const capability = selected.codex
        if (!capability) throw new Error("Missing discovered capability")
        expect(yield* Effect.promise(() => CodexModels.resolve(capability, selected.api.id))).toEqual(capability)
        expect(requests.filter((request) => request.method === "GET")).toEqual([
          {
            path: "/backend-api/codex/models",
            method: "GET",
            authorization: `Bearer ${mode === "refresh" ? "renewed-access" : "test-access"}`,
          },
        ])
        if (mode === "profile") {
          yield* store.set(
            "openai",
            new Auth.Oauth({
              type: "oauth",
              access: "replacement",
              refresh: "replacement",
              expires: Date.now() + 3600000,
              accountId: "replacement",
            }),
          )
          expect((yield* Effect.promise(() => CodexModels.resolve(capability, selected.api.id))).status).toBe(
            "unavailable",
          )
        }
      }),
    { config: { compaction: { auto: true, threshold_percent: mode === "legacy" ? 65 : 85 } } },
  )
}
