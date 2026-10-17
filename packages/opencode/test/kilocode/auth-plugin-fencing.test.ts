import { expect, spyOn, test } from "bun:test"
import type { PluginInput } from "@kilocode/plugin"
import type { Auth } from "../../src/auth"
import { AuthStaleError, AuthSourceError } from "../../src/kilocode/auth/store"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { XaiAuthPlugin } from "../../src/plugin/xai"
import { DigitalOceanAuthPlugin } from "../../src/plugin/digitalocean"
import { expired, fixture, tokens } from "./fixture/auth-store"

for (const provider of ["openai", "xai"] as const) {
  test(`${provider} loader cannot share an old-generation renewal after identical login`, async () => {
    await using f = await fixture(expired(), provider)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const captured = Promise.withResolvers<void>()
    let exchanges = 0
    let reads = 0
    const requests: string[] = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/oauth/token") {
          if (++exchanges === 1) {
            entered.resolve()
            await release.promise
          }
          return Response.json({ ...tokens(), access_token: `access-${exchanges}` })
        }
        requests.push(request.headers.get("authorization") ?? "")
        return Response.json({ ok: true })
      },
    })
    const input = {} as PluginInput
    const plugin =
      provider === "openai"
        ? await CodexAuthPlugin(input, {
            store: f.store,
            issuer: server.url.origin,
            codexApiEndpoint: new URL("/responses", server.url).href,
          })
        : await XaiAuthPlugin(input, { store: f.store, tokenUrl: new URL("/oauth/token", server.url).href })
    const loaded = await plugin.auth!.loader!(async () => {
      const auth = (await f.store.all())[provider]
      if (++reads === 3) captured.resolve()
      return auth
    }, {} as never)
    const url = new URL("/v1/responses", server.url)
    const first = loaded.fetch(url).catch((err: unknown) => err)
    await entered.promise
    await f.store.set(provider, expired())
    const second = loaded.fetch(url)
    await captured.promise
    release.resolve()
    expect(await first).toBeInstanceOf(AuthStaleError)
    expect((await second).status).toBe(200)
    expect(exchanges).toBe(2)
    expect(requests).toEqual(["Bearer access-2"])
  })

  test(`${provider} late renewal after logout makes no API request`, async () => {
    await using f = await fixture(expired(), provider)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let requests = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/oauth/token") {
          entered.resolve()
          await release.promise
          return Response.json(tokens())
        }
        requests++
        return Response.json({ ok: true })
      },
    })
    const plugin =
      provider === "openai"
        ? await CodexAuthPlugin({} as PluginInput, {
            store: f.store,
            issuer: server.url.origin,
            codexApiEndpoint: new URL("/responses", server.url).href,
          })
        : await XaiAuthPlugin({} as PluginInput, { store: f.store, tokenUrl: new URL("/oauth/token", server.url).href })
    const loaded = await plugin.auth!.loader!(async () => (await f.store.all())[provider], {} as never)
    const pending = loaded.fetch(new URL("/v1/responses", server.url)).catch((err: unknown) => err)
    await entered.promise
    await f.store.remove(provider)
    release.resolve()
    expect(await pending).toBeInstanceOf(AuthStaleError)
    expect((await f.store.all())[provider]).toBeUndefined()
    expect(requests).toBe(0)
  })

  test(`${provider} env renewal fails before any HTTP exchange`, async () => {
    await using f = await fixture(expired(), provider)
    const saved = process.env.KILO_AUTH_CONTENT
    const plugin =
      provider === "openai"
        ? await CodexAuthPlugin({} as PluginInput, { store: f.store })
        : await XaiAuthPlugin({} as PluginInput, { store: f.store })
    let calls = 0
    using _fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          calls++
          throw new Error("Unexpected network access")
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    try {
      process.env.KILO_AUTH_CONTENT = JSON.stringify({ [provider]: expired() })
      const loaded = await plugin.auth!.loader!(async () => (await f.store.all())[provider], {} as never)
      await expect(loaded.fetch("http://127.0.0.1:9/v1/responses")).rejects.toBeInstanceOf(AuthSourceError)
      expect(calls).toBe(0)
    } finally {
      if (saved === undefined) delete process.env.KILO_AUTH_CONTENT
      else process.env.KILO_AUTH_CONTENT = saved
    }
  })

  test(`${provider} malformed HTTP 200 renewal cannot change credentials or be exchanged again`, async () => {
    await using f = await fixture(expired(), provider)
    const before = await f.store.snapshot(provider)
    let requests = 0
    let exchanges = 0
    let reads = 0
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<void>()
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/oauth/token") {
          exchanges++
          entered.resolve()
          await release.promise
          return Response.json(
            provider === "openai"
              ? { access_token: "malformed", id_token: "", expires_in: 3600 }
              : { refresh_token: "malformed", expires_in: 3600 },
          )
        }
        requests++
        return Response.json({ ok: true })
      },
    })
    const plugin =
      provider === "openai"
        ? await CodexAuthPlugin({} as PluginInput, {
            store: f.store,
            issuer: server.url.origin,
            codexApiEndpoint: new URL("/responses", server.url).href,
          })
        : await XaiAuthPlugin({} as PluginInput, { store: f.store, tokenUrl: new URL("/oauth/token", server.url).href })
    const loaded = await plugin.auth!.loader!(async () => {
      const auth = (await f.store.all())[provider]
      if (++reads === 3) waiting.resolve()
      return auth
    }, {} as never)
    const url = new URL("/v1/responses", server.url)
    const first = loaded.fetch(url).catch((error: unknown) => error)
    try {
      await entered.promise
      const second = loaded.fetch(url).catch((error: unknown) => error)
      await waiting.promise
      release.resolve()
      for (const error of await Promise.all([first, second]))
        expect(error).toMatchObject({
          name: "CredentialReadinessError",
          reason: "exchange-uncertain",
          isRetryable: false,
        })
      await expect(loaded.fetch(url)).rejects.toMatchObject({ reason: "exchange-uncertain" })
      const fresh = await plugin.auth!.loader!(async () => (await f.store.all())[provider], {} as never)
      await expect(fresh.fetch(url)).rejects.toMatchObject({ reason: "exchange-uncertain" })
      expect(await f.store.snapshot(provider)).toEqual(before)
      expect(await f.store.observe(provider, true)).toMatchObject({ issue: "exchange-uncertain" })
      expect(exchanges).toBe(1)
      expect(requests).toBe(0)
    } finally {
      release.resolve()
      await first
      await plugin.dispose?.()
    }
  })

  test(`${provider} recognized transient rejection permits an explicit later attempt without implicit retry`, async () => {
    await using f = await fixture(expired(), provider)
    let exchanges = 0
    let requests = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/oauth/token")
          return ++exchanges === 1 ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json(tokens())
        requests++
        return Response.json({ ok: true })
      },
    })
    const plugin =
      provider === "openai"
        ? await CodexAuthPlugin({} as PluginInput, {
            store: f.store,
            issuer: server.url.origin,
            codexApiEndpoint: new URL("/responses", server.url).href,
          })
        : await XaiAuthPlugin({} as PluginInput, { store: f.store, tokenUrl: new URL("/oauth/token", server.url).href })
    const loaded = await plugin.auth!.loader!(async () => (await f.store.all())[provider], {} as never)
    const url = new URL("/v1/responses", server.url)
    await expect(loaded.fetch(url)).rejects.toMatchObject({ reason: "exchange-unavailable", isRetryable: false })
    expect(exchanges).toBe(1)
    expect(requests).toBe(0)
    expect((await loaded.fetch(url)).status).toBe(200)
    expect(exchanges).toBe(2)
    expect(requests).toBe(1)
    await plugin.dispose?.()
  })
}

test("xAI legitimately omitted refresh_token retains the old refresh token", async () => {
  await using f = await fixture(expired(), "xai")
  const before = await f.store.snapshot("xai")
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/oauth/token")
        return Response.json({ access_token: "renewed", expires_in: 3600 })
      expect(request.headers.get("authorization")).toBe("Bearer renewed")
      return Response.json({ ok: true })
    },
  })
  const plugin = await XaiAuthPlugin({} as PluginInput, {
    store: f.store,
    tokenUrl: new URL("/oauth/token", server.url).href,
  })
  const loaded = await plugin.auth!.loader!(async () => (await f.store.all()).xai, {} as never)
  expect((await loaded.fetch(new URL("/v1/responses", server.url))).status).toBe(200)
  const after = await f.store.snapshot("xai")
  expect(after.value).toMatchObject({ access: "renewed", refresh: expired().refresh })
  expect(after.loginGeneration).toBe(before.loginGeneration)
  expect(after.tokenRevision).toBe(before.tokenRevision + 1)
})

test("Codex rejects a renewed JWT for a different known account before commit or use", async () => {
  await using f = await fixture(expired())
  const before = await f.store.snapshot("openai")
  let requests = 0
  const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "other-account" } })).toString("base64url")}.signature`
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/oauth/token") return Response.json({ ...tokens(), id_token: jwt })
      requests++
      return Response.json({ ok: true })
    },
  })
  const plugin = await CodexAuthPlugin({} as PluginInput, {
    store: f.store,
    issuer: server.url.origin,
    codexApiEndpoint: new URL("/responses", server.url).href,
  })
  const loaded = await plugin.auth!.loader!(async () => (await f.store.all()).openai, {} as never)
  await expect(loaded.fetch(new URL("/v1/responses", server.url))).rejects.toBeInstanceOf(AuthStaleError)
  expect(await f.store.snapshot("openai")).toEqual(before)
  expect(requests).toBe(0)
})

test("DigitalOcean delayed metadata discovery is read-only after logout", async () => {
  const auth: Auth.Api = {
    type: "api",
    key: "fixture",
    metadata: {
      oauth_access: "fixture-bearer",
      oauth_expires: String(Date.now() + 3600_000),
      routers_fetched_at: "0",
    },
  }
  await using f = await fixture(auth, "digitalocean")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  using _fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        entered.resolve()
        await release.promise
        return Response.json({ model_routers: [{ name: "fixture-router" }] })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  const plugin = await DigitalOceanAuthPlugin({
    client: {
      auth: {
        set: async () => {
          throw new Error("Discovery must not rewrite credentials")
        },
      },
    },
  } as unknown as PluginInput)
  const pending = plugin.provider!.models!({ id: "digitalocean", models: {} } as never, { auth })
  await entered.promise
  await f.store.remove("digitalocean")
  release.resolve()
  await pending
  expect((await f.store.all()).digitalocean).toBeUndefined()
  expect(auth.metadata?.routers).toBeUndefined()
})
