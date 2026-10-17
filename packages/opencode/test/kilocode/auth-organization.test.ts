import { expect, spyOn } from "bun:test"
import { Effect, Fiber, Layer, Option } from "effect"
import { HttpClient } from "effect/unstable/http"
import path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Npm } from "@opencode-ai/core/npm"
import { clearModesCache, fetchOrganizationModes } from "@kilocode/kilo-gateway"
import { Account } from "../../src/account/account"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { InstanceState } from "../../src/effect/instance-state"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { AuthAttempt } from "../../src/kilocode/auth/attempt"
import { AuthStore } from "../../src/kilocode/auth/store"
import * as mutation from "../../src/kilocode/auth/mutations"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { TestInstance, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const installs: string[] = []
const config = Config.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AppFileSystem.defaultLayer,
      EffectFlock.defaultLayer,
      Git.defaultLayer,
      Auth.defaultLayer,
      Env.defaultLayer,
      Layer.mock(Account.Service)({ active: () => Effect.succeed(Option.none()) }),
      Layer.mock(Npm.Service)({ install: (dir) => Effect.sync(() => void installs.push(dir)) }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`Unexpected config request: ${request.url}`)),
      ),
    ),
  ),
)
const it = testEffect(
  Agent.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        config,
        Auth.defaultLayer,
        CrossSpawnSpawner.defaultLayer,
        RuntimeFlags.layer({ pure: true, disableDefaultPlugins: true }),
        Layer.mock(Plugin.Service)({}),
        Layer.mock(Provider.Service)({}),
        Layer.mock(Skill.Service)({ dirs: () => Effect.succeed([]) }),
      ),
    ),
  ),
)

const credential = (org: string, access = `token-${org}`): Auth.Oauth => ({
  type: "oauth",
  access,
  refresh: "fixture-refresh",
  expires: 0,
  accountId: org,
})
const body = (org: string, token: string) => ({
  modes: [`org-${org}`, "legacy", "explicit", "code"].map((slug) => ({
    id: `${org}-${slug}`,
    organization_id: org,
    slug,
    name: `${org} ${slug}`,
    created_by: "fixture",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    config: { roleDefinition: `${org}/${token}`, groups: ["read"] },
  })),
})

const setup = Effect.gen(function* () {
  clearModesCache()
  installs.length = 0
  const calls: Array<{ org: string; token: string }> = []
  const blocked = new Map<string, { entered: () => void; wait: Promise<void> }>()
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            const url = new URL(request.url)
            const match = /^\/api\/organizations\/([^/]+)\/modes$/.exec(url.pathname)
            if (!match) throw new Error(`Unexpected network request: ${url.pathname}`)
            const org = decodeURIComponent(match[1])
            const token = request.headers.get("authorization")!.replace("Bearer ", "")
            calls.push({ org, token })
            const gate = blocked.get(org)
            gate?.entered()
            await gate?.wait
            return Response.json(body(org, token))
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      ),
    ),
    (spy) => Effect.sync(() => spy.mockRestore()),
  )
  const auth = yield* Auth.Service
  yield* auth.remove("kilo")
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      delete process.env.KILO_AUTH_CONTENT
      yield* auth.remove("kilo").pipe(Effect.orDie)
      yield* auth.remove("org-unrelated").pipe(Effect.orDie)
      clearModesCache()
    }),
  )
  const health = { disposed: 0 }
  const state = yield* InstanceState.make(() =>
    Effect.acquireRelease(
      Effect.sync(() => ({})),
      () => Effect.sync(() => void health.disposed++),
    ),
  )
  const healthy = yield* InstanceState.get(state)
  return { auth, config: yield* Config.Service, agent: yield* Agent.Service, calls, blocked, health, state, healthy }
})

it.instance(
  "existing Config and Agent project login, organization A->B and logout without reloading healthy state",
  () =>
    Effect.gen(function* () {
      const t = yield* setup
      const dir = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir.directory, ".kilocodemodes"),
          JSON.stringify({
            customModes: [{ slug: "legacy", name: "Legacy", roleDefinition: "legacy-local", groups: ["edit"] }],
          }),
        ),
      )
      const baseline = yield* t.config.get()
      expect(baseline.agent?.legacy.prompt).toBe("legacy-local")
      const code = yield* t.agent.get("code")
      const count = installs.length
      yield* t.auth.set("kilo", credential("A"))
      const a = yield* t.config.get()
      expect(a.agent?.["org-A"].prompt).toBe("A/token-A")
      expect(a.agent?.legacy.prompt).toBe("A/token-A")
      expect(a.agent?.explicit.prompt).toBe("explicit-local")
      expect((yield* t.agent.get("code")).prompt).toBe("A/token-A")
      expect((yield* t.agent.list()).map((agent) => agent.name)).toContain("org-A")

      yield* t.auth.set("org-unrelated", { type: "api", key: "unrelated" })
      expect(yield* t.config.get()).toBe(a)
      expect(t.calls).toHaveLength(1)
      const stored = yield* t.auth.get("kilo")
      if (stored?.type !== "oauth") throw new Error("Expected fixture OAuth")
      yield* Effect.promise(() => mutation.organization(stored, "B"))
      const b = yield* t.config.get()
      expect(b.agent?.["org-A"]).toBeUndefined()
      expect(b.agent?.["org-B"].prompt).toBe("B/token-A")
      expect((yield* t.agent.get("code")).prompt).toBe("B/token-A")
      expect((yield* t.agent.list()).map((agent) => agent.name)).not.toContain("org-A")
      expect(a.agent?.legacy.prompt).toBe("A/token-A")

      yield* t.auth.remove("kilo")
      const loggedOut = yield* t.config.get()
      expect(loggedOut.agent?.["org-A"]).toBeUndefined()
      expect(loggedOut.agent?.["org-B"]).toBeUndefined()
      expect(loggedOut.agent?.legacy.prompt).toBe("legacy-local")
      expect(loggedOut.agent?.legacy.options?.source).toBeUndefined()
      expect(loggedOut.agent?.explicit.prompt).toBe("explicit-local")
      expect(yield* t.agent.get("code")).toEqual(code)
      expect((yield* t.agent.list()).map((agent) => agent.name)).not.toContain("org-B")
      expect(t.calls).toHaveLength(2)
      expect(installs).toHaveLength(count)
      expect(yield* InstanceState.get(t.state)).toBe(t.healthy)
      expect(t.health.disposed).toBe(0)
    }),
  { config: { agent: { explicit: { prompt: "explicit-local" } } } },
)

it.instance("same-org OAuth completion and identical explicit login invalidate the existing projection", () =>
  Effect.gen(function* () {
    const t = yield* setup
    yield* t.auth.set("kilo", credential("same", "account-A"))
    const a = yield* t.config.get()
    expect(a.agent?.legacy.prompt).toBe("same/account-A")
    const store = AuthStore.create()
    const before = yield* Effect.promise(() => store.snapshot("kilo"))
    yield* Effect.promise(() => store.commit(before, credential("same", "account-A-renewed")))
    expect(yield* t.config.get()).toBe(a)
    expect(t.calls).toHaveLength(1)
    const ticket = yield* Effect.promise(() => store.begin("kilo", 0))
    yield* Effect.promise(() =>
      AuthAttempt.invoke({
        store,
        ticket,
        callback: async () => ({
          type: "success",
          access: "account-B",
          refresh: "refresh-B",
          expires: 0,
          accountId: "same",
        }),
      }),
    )
    expect((yield* t.config.get()).agent?.legacy.prompt).toBe("same/account-B")
    expect((yield* t.agent.get("legacy")).prompt).toBe("same/account-B")
    yield* t.auth.set("kilo", credential("same", "account-B"))
    expect((yield* t.config.get()).agent?.legacy.prompt).toBe("same/account-B")
    expect(t.calls).toHaveLength(3)
    yield* t.auth.set("kilo", { type: "api", key: "fixture-api" })
    expect((yield* t.config.get()).agent?.legacy).toBeUndefined()
    expect(yield* t.agent.get("legacy")).toBeUndefined()
    expect(t.health.disposed).toBe(0)
  }),
)

it.instance("effective environment auth survives disk logout and isolates unrelated provider changes", () =>
  Effect.gen(function* () {
    const t = yield* setup
    yield* t.auth.set("kilo", credential("disk"))
    expect((yield* t.config.get()).agent?.["org-disk"]).toBeDefined()
    process.env.KILO_AUTH_CONTENT = JSON.stringify({ kilo: credential("env-A") })
    const a = yield* t.config.get()
    expect(a.agent?.["org-env-A"]).toBeDefined()
    expect(a.agent?.["org-disk"]).toBeUndefined()
    yield* t.auth.remove("kilo")
    expect(yield* t.config.get()).toBe(a)
    process.env.KILO_AUTH_CONTENT = JSON.stringify({
      kilo: credential("env-A"),
      "org-unrelated": { type: "api", key: "changed" },
    })
    expect(yield* t.config.get()).toBe(a)
    expect(t.calls).toHaveLength(2)
    process.env.KILO_AUTH_CONTENT = JSON.stringify({ kilo: credential("env-B") })
    expect((yield* t.agent.list()).map((agent) => agent.name)).toContain("org-env-B")
    expect((yield* t.config.get()).agent?.["org-env-A"]).toBeUndefined()
    delete process.env.KILO_AUTH_CONTENT
    expect((yield* t.config.get()).agent?.["org-env-B"]).toBeUndefined()
    expect(t.health.disposed).toBe(0)
  }),
)

for (const change of ["switch", "logout"] as const) {
  it.instance(`delayed organization fetch cannot restore A after ${change}`, () =>
    Effect.gen(function* () {
      const t = yield* setup
      yield* t.config.get()
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      t.blocked.set("A", { entered: () => entered.resolve(), wait: released.promise })
      yield* Effect.addFinalizer(() => Effect.sync(() => released.resolve()))
      yield* t.auth.set("kilo", credential("A"))
      const pending = yield* t.config.get().pipe(Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      if (change === "switch") yield* t.auth.set("kilo", credential("B"))
      else yield* t.auth.remove("kilo")
      const next = yield* t.config.get()
      expect(next.agent?.["org-A"]).toBeUndefined()
      released.resolve()
      const late = yield* Fiber.join(pending)
      expect(late.agent?.["org-A"]).toBeUndefined()
      expect(late.agent?.["org-B"]).toEqual(next.agent?.["org-B"])
      expect((yield* t.agent.list()).map((agent) => agent.name)).not.toContain("org-A")
      expect(t.health.disposed).toBe(0)
    }),
  )
}

it.instance("organization changes are observed in every previously loaded directory", () =>
  Effect.gen(function* () {
    const t = yield* setup
    const other = yield* tmpdirScoped({ config: { agent: { other: { prompt: "other-local" } } } })
    yield* t.auth.set("kilo", credential("A"))
    yield* t.config.get()
    expect((yield* provideInstance(other)(t.config.get())).agent?.["org-A"]).toBeDefined()
    yield* t.auth.set("kilo", credential("B"))
    expect((yield* t.config.get()).agent?.["org-A"]).toBeUndefined()
    const next = yield* provideInstance(other)(t.config.get())
    expect(next.agent?.["org-A"]).toBeUndefined()
    expect(next.agent?.["org-B"]).toBeDefined()
    expect(next.agent?.other.prompt).toBe("other-local")
    yield* t.auth.remove("kilo")
    expect((yield* provideInstance(other)(t.config.get())).agent?.["org-B"]).toBeUndefined()
    expect(t.health.disposed).toBe(0)
  }),
)

it.instance("gateway cache clearing fences a delayed publication and separates same-org credentials", () =>
  Effect.gen(function* () {
    const t = yield* setup
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    t.blocked.set("same", { entered: () => entered.resolve(), wait: released.promise })
    yield* Effect.addFinalizer(() => Effect.sync(() => released.resolve()))
    const pending = fetchOrganizationModes("account-A", "same")
    yield* Effect.promise(() => entered.promise)
    clearModesCache()
    released.resolve()
    yield* Effect.promise(() => pending)
    yield* Effect.promise(() => fetchOrganizationModes("account-A", "same"))
    const b = yield* Effect.promise(() => fetchOrganizationModes("account-B", "same"))
    expect(b[0].config.roleDefinition).toBe("same/account-B")
    expect(t.calls).toHaveLength(3)
  }),
)
