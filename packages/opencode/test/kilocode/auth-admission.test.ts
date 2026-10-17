import { expect, spyOn } from "bun:test"
import { ConfigProvider, Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import path from "node:path"
import { clearModesCache } from "@kilocode/kilo-gateway"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { Bus } from "../../src/bus"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { KiloAuth } from "../../src/kilocode/auth/authority"
import { AuthStore } from "../../src/kilocode/auth/store"
import { AuthSource } from "../../src/kilocode/auth/source"
import { AuthRequest } from "../../src/kilocode/auth/request"
import { AuthOutcome } from "../../src/kilocode/auth/outcome"
import { KilocodeConfig } from "../../src/kilocode/config/config"
import { Server } from "../../src/server/server"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { Flag } from "@opencode-ai/core/flag/flag"
import { KiloRuntime } from "../../src/kilocode/runtime/control"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { Ripgrep } from "../../src/file/ripgrep"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

function restore(spy: { mockRestore(): void; mockImplementation(fn: typeof globalThis.fetch): unknown }) {
  spy.mockRestore()
  // Effect's shared Fetch reference can outlive a fixture. Keep retained spies forwarding to the current transport.
  spy.mockImplementation(
    Object.assign((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init), {
      preconnect: globalThis.fetch.preconnect,
    }),
  )
}

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    Auth.defaultLayer,
    Bus.defaultLayer,
    Env.defaultLayer,
    Provider.defaultLayer,
    Config.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

it.live("admission persists readonly primary and secondary authority; reconnect never rebinds it", () =>
  Effect.gen(function* () {
    const a = ProviderID.make("opencode-auth-admit-a")
    const b = ProviderID.make("opencode-auth-admit-b")
    const modelID = ModelID.make("fixture")
    const dir = yield* tmpdirScoped({
      config: {
        enabled_providers: [a, b],
        provider: Object.fromEntries(
          [a, b].map((id) => [
            id,
            {
              npm: "@ai-sdk/openai-compatible",
              name: "fixture",
              options: { baseURL: "http://127.0.0.1:9/never" },
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
        yield* auth.set(a, { type: "api", key: "private-A" })
        yield* auth.set(b, { type: "api", key: "private-B" })
        yield* Effect.addFinalizer(() => Effect.all([auth.remove(a), auth.remove(b)]).pipe(Effect.orDie))
        const session = yield* sessions.create({})
        const network: string[] = []
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            spyOn(globalThis, "fetch").mockImplementation(
              Object.assign(
                async (input: RequestInfo | URL) => {
                  const url = new URL(input instanceof Request ? input.url : input)
                  if (url.pathname === "/api/gateway/embedding-models")
                    return Response.json({ defaultModel: "", models: [], aliases: {} })
                  network.push(url.pathname)
                  throw new Error("Admission must not dispatch a provider request")
                },
                { preconnect: globalThis.fetch.preconnect },
              ),
            ),
          ),
          (spy) => Effect.sync(() => restore(spy)),
        )
        const input = {
          sessionID: session.id,
          model: { providerID: a, modelID },
          noReply: true,
          parts: [{ type: "text" as const, text: "fixture" }],
        }
        const first = yield* prompts.prompt(input)
        if (first.info.role !== "user") throw new Error("Expected admitted user")
        expect(Object.isFrozen(first.info.authAuthority)).toBe(true)
        expect(Object.isFrozen(first.info.authAuthorities)).toBe(true)
        const stored = yield* MessageV2.get({ sessionID: session.id, messageID: first.info.id })
        expect(stored.info).toMatchObject({
          authAuthority: first.info.authAuthority,
          authAuthorities: first.info.authAuthorities,
        })
        expect(JSON.stringify(stored)).not.toContain("private-A")
        expect(JSON.stringify(stored)).not.toContain("private-B")
        const secondary = KiloAuth.selected(first.info, { providerID: b, modelID })
        expect(secondary?.providerID).toBe(b)
        yield* auth.set(b, { type: "api", key: "private-B-replaced" })
        const blocked = yield* KiloAuth.check(secondary, { providerID: b, modelID }).pipe(Effect.exit)
        expect(blocked._tag).toBe("Failure")
        yield* auth.set(a, { type: "api", key: "private-A-replaced" })
        const replay = yield* prompts.prompt({ ...input, messageID: first.info.id })
        expect(replay.info).toMatchObject({ authAuthority: first.info.authAuthority })
        const next = yield* prompts.prompt(input)
        if (next.info.role !== "user") throw new Error("Expected admitted user")
        expect(next.info.authAuthority?.authority).not.toBe(first.info.authAuthority?.authority)
        expect(network).toEqual([])
      }),
    )
  }),
)

it.live("readiness HTTP GET is passive and reports runtime-safe nonsecret local observations", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({
      config: { provider: { openai: { options: { apiKey: "configured-private-key" } } } },
    })
    const requests: string[] = []
    let warm = false
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (input: RequestInfo | URL) => {
              const url = new URL(input instanceof Request ? input.url : input)
              if (!warm && url.pathname === "/api/gateway/embedding-models")
                return Response.json({ defaultModel: "", models: [], aliases: {} })
              if (warm) requests.push(url.pathname)
              throw new Error("Passive readiness must not call providers, catalogs or refresh endpoints")
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        ),
      ),
      (spy) => Effect.sync(() => restore(spy)),
    )
    const response = yield* Effect.promise(async () =>
      Server.Default().app.request(`/config?directory=${encodeURIComponent(dir)}`),
    )
    expect(response.status).toBe(200)
    warm = true
    const readiness = yield* Effect.promise(async () =>
      Server.Default().app.request(
        `/provider/openai/auth/readiness?directory=${encodeURIComponent(dir)}&modelID=fixture`,
      ),
    )
    expect(readiness.status).toBe(200)
    const body = yield* Effect.promise(() => readiness.json())
    expect(body).toMatchObject({
      providerID: "openai",
      modelID: "fixture",
      state: "ready",
      source: "config",
      validation: "local",
      disruption: "none",
      runtimeID: KiloRuntime.info.id,
    })
    expect(body.observedAt).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain("configured-private-key")
    expect(requests).toEqual([])
  }),
)

for (const source of ["file", "env"] as const) {
  it.live(`static Kilo OAuth-shaped ${source} token is locally ready without invented renewal`, () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ config: {} })
      const auth = yield* Auth.Service
      const credential = {
        type: "oauth" as const,
        access: "static-fixture-token",
        refresh: "",
        expires: 0,
        accountId: "fixture-org",
      }
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          delete process.env.KILO_AUTH_CONTENT
          if (source === "file") yield* auth.remove("kilo").pipe(Effect.orDie)
        }),
      )
      let requests = 0
      let warm = false
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
              async (input: RequestInfo | URL) => {
                const url = new URL(input instanceof Request ? input.url : input)
                if (!warm && url.pathname === "/api/gateway/embedding-models")
                  return Response.json({ defaultModel: "", models: [], aliases: {} })
                if (warm) requests++
                throw new Error("Static readiness must not renew credentials")
              },
              { preconnect: globalThis.fetch.preconnect },
            ),
          ),
        ),
        (spy) => Effect.sync(() => restore(spy)),
      )
      const configured = yield* Effect.promise(async () =>
        Server.Default().app.request(`/config?directory=${encodeURIComponent(dir)}`),
      )
      expect(configured.status).toBe(200)
      warm = true
      if (source === "file") yield* auth.set("kilo", credential)
      else process.env.KILO_AUTH_CONTENT = JSON.stringify({ kilo: credential })
      const response = yield* Effect.promise(async () =>
        Server.Default().app.request(`/provider/kilo/auth/readiness?directory=${encodeURIComponent(dir)}`),
      )
      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body).toMatchObject({ state: "ready", source, reason: "local-valid", action: "none", validation: "local" })
      expect(JSON.stringify(body)).not.toContain("static-fixture-token")
      expect(requests).toBe(0)
    }),
  )
}

for (const provider of ["openrouter", "azure"] as const) {
  it.live(`passive readiness uses authoritative local ${provider} env metadata without provider initialization`, () =>
    Effect.gen(function* () {
      const values =
        provider === "openrouter"
          ? { OPENROUTER_API_KEY: "router-fixture-secret" }
          : { AZURE_RESOURCE_NAME: "fixture-resource", AZURE_API_KEY: "azure-fixture-secret" }
      for (const [name, value] of Object.entries(values)) process.env[name] = value
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const name of Object.keys(values)) delete process.env[name]
        }),
      )
      const dir = yield* tmpdirScoped({ config: {} })
      let requests = 0
      let warm = false
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
              async (input: RequestInfo | URL) => {
                const url = new URL(input instanceof Request ? input.url : input)
                if (!warm && url.pathname === "/api/gateway/embedding-models")
                  return Response.json({ defaultModel: "", models: [], aliases: {} })
                if (warm) requests++
                throw new Error("Metadata inspection must be local-only")
              },
              { preconnect: globalThis.fetch.preconnect },
            ),
          ),
        ),
        (spy) => Effect.sync(() => restore(spy)),
      )
      const configured = yield* Effect.promise(async () =>
        Server.Default().app.request(`/config?directory=${encodeURIComponent(dir)}`),
      )
      expect(configured.status).toBe(200)
      warm = true
      const response = yield* Effect.promise(async () =>
        Server.Default().app.request(`/provider/${provider}/auth/readiness?directory=${encodeURIComponent(dir)}`),
      )
      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body.source).toBe("env")
      expect(body.reason).not.toBe("no-credentials")
      if (provider === "openrouter") expect(body).toMatchObject({ state: "ready", reason: "local-valid" })
      else expect(body).toMatchObject({ state: "unknown", reason: "external-owner" })
      expect(JSON.stringify(body)).not.toContain("fixture-secret")
      expect(requests).toBe(0)
    }),
  )
}

for (const source of ["file", "env"] as const) {
  it.live(`cold readiness with a static ${source} organization token never fetches or rotates credentials`, () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ config: {} })
      const auth = yield* Auth.Service
      const credential = {
        type: "oauth" as const,
        access: "static-cold-token",
        refresh: "",
        expires: 0,
        accountId: "fixture-org",
      }
      yield* auth.set("kilo", credential)
      const snapshot = yield* Effect.promise(() => AuthStore.disk.snapshot("kilo"))
      const files = [snapshot.store, path.join(path.dirname(snapshot.store), "auth.revisions.json")]
      const before = yield* Effect.promise(() => Promise.all(files.map((file) => Bun.file(file).text())))
      const saved = process.env.KILO_AUTH_CONTENT
      if (source === "env") process.env.KILO_AUTH_CONTENT = JSON.stringify({ kilo: credential })
      clearModesCache()
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (saved === undefined) delete process.env.KILO_AUTH_CONTENT
          else process.env.KILO_AUTH_CONTENT = saved
          clearModesCache()
          yield* auth.remove("kilo").pipe(Effect.orDie)
        }),
      )
      const requests: string[] = []
      const scopes: Array<string | undefined> = []
      const load = KilocodeConfig.loadOrganizationModes
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(KilocodeConfig, "loadOrganizationModes").mockImplementation((auth, scope) => {
            scopes.push(scope)
            return load(auth, scope)
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      const phase = { active: false }
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
              async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(input, init)
                const url = new URL(request.url)
                requests.push(url.pathname)
                if (!phase.active)
                  throw new Error("A passive GET must not fetch organization/catalog metadata or rotate credentials")
                if (url.pathname === "/api/gateway/embedding-models")
                  return Response.json({ defaultModel: "", models: [], aliases: {} })
                if (url.pathname !== "/api/organizations/fixture-org/modes")
                  throw new Error(`Unexpected active initialization request: ${url.pathname}`)
                expect(request.headers.get("authorization")).toBe("Bearer static-cold-token")
                return Response.json({
                  modes: [
                    {
                      id: "cold-fixture",
                      organization_id: "fixture-org",
                      slug: "cold-fixture",
                      name: "Cold fixture",
                      created_by: "fixture",
                      created_at: "2026-01-01T00:00:00Z",
                      updated_at: "2026-01-01T00:00:00Z",
                      config: { roleDefinition: "Organization fixture", groups: ["read"] },
                    },
                  ],
                })
              },
              { preconnect: globalThis.fetch.preconnect },
            ),
          ),
        ),
        (spy) => Effect.sync(() => restore(spy)),
      )
      // File discovery is unrelated to readiness and must not download a native binary in this offline fixture.
      const scanner = yield* Effect.acquireRelease(
        Effect.promise(async () =>
          spyOn(await AppRuntime.runPromise(Ripgrep.Service), "files").mockReturnValue(Stream.empty),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      // Keep the production memo map, but dispose this fixture's instance before restoring auth/fetch state.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          AppRuntime.runPromise(
            InstanceStore.Service.use((store) =>
              store.peek(dir).pipe(Effect.flatMap((ctx) => (ctx ? store.dispose(ctx) : Effect.void))),
            ),
          ),
        ),
      )
      const request = (url: string) => Server.Default().app.request(url)
      for (const query of ["", "&modelID=fixture"]) {
        const response = yield* Effect.promise(async () =>
          request(`/provider/kilo/auth/readiness?directory=${encodeURIComponent(dir)}${query}`),
        )
        expect(response.status).toBe(200)
        const body = yield* Effect.promise(() => response.json())
        expect(body).toMatchObject({
          providerID: "kilo",
          state: "unknown",
          source: "unknown",
          reason: "unverifiable",
          validation: "local",
          disruption: "none",
          runtimeID: KiloRuntime.info.id,
        })
        expect(body.modelID).toBe(query ? "fixture" : null)
        expect(body.observedAt).toBeGreaterThan(0)
        expect(body.reason).not.toBe("refresh-needed")
        expect(JSON.stringify(body)).not.toContain(credential.access)
      }
      expect(requests).toEqual([])
      expect(scanner).not.toHaveBeenCalled()
      expect(yield* Effect.promise(() => Promise.all(files.map((file) => Bun.file(file).text())))).toEqual(before)

      // Passive observation must not cache a half-initialized instance that skips the later active bootstrap.
      phase.active = true
      const initialized = yield* Effect.promise(async () => request(`/config?directory=${encodeURIComponent(dir)}`))
      expect(initialized.status).toBe(200)
      const config = yield* Effect.promise(() => initialized.json())
      expect(config.agent["cold-fixture"].prompt).toBe("Organization fixture")
      expect(
        yield* Effect.promise(() => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.peek(dir)))),
      ).toBeDefined()
      const repeated = yield* Effect.promise(async () => request(`/config?directory=${encodeURIComponent(dir)}`))
      expect(repeated.status).toBe(200)
      expect((yield* Effect.promise(() => repeated.json())).agent["cold-fixture"].prompt).toBe("Organization fixture")
      expect(requests).toContain("/api/organizations/fixture-org/modes")
      expect(new Set(scopes)).toEqual(new Set([scopes[0]]))
      expect(requests.filter((url) => url === "/api/organizations/fixture-org/modes")).toHaveLength(1)
      expect(
        requests.filter(
          (url) => !["/api/organizations/fixture-org/modes", "/api/gateway/embedding-models"].includes(url),
        ),
      ).toEqual([])
      const count = requests.length
      phase.active = false
      const warm = yield* Effect.promise(async () =>
        request(`/provider/kilo/auth/readiness?directory=${encodeURIComponent(dir)}`),
      )
      expect(warm.status).toBe(200)
      expect(yield* Effect.promise(() => warm.json())).toMatchObject({
        state: "ready",
        source,
        reason: "local-valid",
        validation: "local",
      })
      expect(requests).toHaveLength(count)
    }),
  )
}

it.live("passive environment reads preserve warm overrides without initializing a cold directory", () =>
  Effect.gen(function* () {
    const env = yield* Env.Service
    const a = yield* tmpdirScoped({ config: {} })
    const b = yield* tmpdirScoped({ config: {} })
    const name = "KILO_TEST_PASSIVE_ENV"
    const saved = process.env[name]
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (saved === undefined) delete process.env[name]
        else process.env[name] = saved
      }),
    )
    process.env[name] = "process-A"
    yield* provideInstance(a)(env.set(name, "workspace"))
    expect((yield* env.all(AppFileSystem.resolve(a)))[name]).toBe("workspace")
    expect((yield* env.all(AppFileSystem.resolve(b)))[name]).toBe("process-A")
    process.env[name] = "process-B"
    expect((yield* env.all(AppFileSystem.resolve(b)))[name]).toBe("process-B")
    expect((yield* env.all(AppFileSystem.resolve(a)))[name]).toBe("workspace")
  }),
)

it.instance("durable ambiguous exchange overrides an earlier local refreshing observation", () =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async () => {
              throw new Error("Readiness must not dispatch a network request")
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        ),
      ),
      (spy) => Effect.sync(() => restore(spy)),
    )
    yield* (yield* Config.Service).get()
    const auth = yield* Auth.Service
    yield* auth.set("openai", { type: "oauth", access: "uncertain-access", refresh: "uncertain-refresh", expires: 0 })
    yield* Effect.addFinalizer(() => auth.remove("openai").pipe(Effect.orDie))
    const selected = yield* Effect.promise(() =>
      AuthSource.select({
        provider: { id: ProviderID.make("openai"), env: ["OPENAI_API_KEY"], options: {}, source: "api" },
        cfg: {},
        env: {},
        store: AuthStore.disk,
      }),
    )
    const snapshot = yield* Effect.promise(() => AuthStore.disk.snapshot("openai"))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pending = yield* Effect.sync(() =>
      AuthStore.disk
        .exchange(snapshot, async () => {
          entered.resolve()
          await release.promise
          throw new AuthOutcome.Failure("exchange-uncertain", "openai")
        })
        .catch((error: unknown) => error),
    )
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        release.resolve()
        await pending
      }),
    )
    yield* Effect.promise(() => entered.promise)
    const guard = yield* KiloAuth.request({
      snapshot: selected.snapshot,
      model: { providerID: "openai", id: "fixture" },
      sessionID: "ses_fixture",
      messageID: "msg_fixture",
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => guard.close()))
    yield* Effect.promise(() =>
      guard.fetch(
        AuthRequest.delegate(async () => Response.json({})),
        "http://127.0.0.1:9/unused",
      ),
    )
    expect(yield* KiloAuth.readiness("openai", "fixture")).toMatchObject({ state: "refreshing" })
    release.resolve()
    expect(yield* Effect.promise(() => pending)).toMatchObject({ reason: "exchange-uncertain" })
    const readiness = yield* KiloAuth.readiness("openai", "fixture")
    expect(readiness).toMatchObject({
      state: "unknown",
      source: "file",
      reason: "exchange-uncertain",
      action: "sign-in",
      validation: "local",
    })
    expect(JSON.stringify(readiness)).not.toContain("uncertain-access")
    expect(JSON.stringify(readiness)).not.toContain("uncertain-refresh")
  }),
)

it.live("cold passive readiness retains authorization without starting catalog fetch even when enabled", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ config: {} })
    let requests = 0
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async () => {
              requests++
              throw new Error("Cold readiness must not initialize remote services")
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        ),
      ),
      (spy) => Effect.sync(() => restore(spy)),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const saved = Flag.KILO_DISABLE_MODELS_FETCH
        Flag.KILO_DISABLE_MODELS_FETCH = false
        return saved
      }),
      (saved) =>
        Effect.sync(() => {
          Flag.KILO_DISABLE_MODELS_FETCH = saved
        }),
    )
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiApp.routes.pipe(
            Layer.provide(
              Layer.mergeAll(
                ConfigProvider.layer(ConfigProvider.fromUnknown({ KILO_SERVER_PASSWORD: "fixture-password" })),
                Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch),
              ),
            ),
          ),
          { disableLogger: true },
        ),
      ),
      (server) => Effect.promise(() => server.dispose()),
    )
    const url = `http://localhost/provider/kilo/auth/readiness?directory=${encodeURIComponent(dir)}`
    // The assembled route layer supplies its services but exposes opaque request requirements.
    const context = Context.empty() as Context.Context<unknown>
    const unauthorized = yield* Effect.promise(() => server.handler(new Request(url), context))
    expect(unauthorized.status).toBe(401)
    const authorized = yield* Effect.promise(() =>
      server.handler(
        new Request(url, {
          headers: { authorization: ServerAuth.header({ username: "kilo", password: "fixture-password" })! },
        }),
        context,
      ),
    )
    expect(authorized.status).toBe(200)
    expect(yield* Effect.promise(() => authorized.json())).toMatchObject({
      state: "unknown",
      reason: "unverifiable",
      validation: "local",
    })
    expect(requests).toBe(0)
  }),
)
