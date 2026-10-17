import { expect, test } from "bun:test"
import { Cause, Effect, Stream } from "effect"
import { ProviderID } from "../../src/provider/schema"
import type { Config } from "../../src/config/config"
import type { PluginInput } from "@kilocode/plugin"
import { AuthSource } from "../../src/kilocode/auth/source"
import { AuthRequest } from "../../src/kilocode/auth/request"
import { AuthTransport } from "../../src/kilocode/auth/transport"
import { AuthOutcome } from "../../src/kilocode/auth/outcome"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { OpenAIWebSocketPool } from "../../src/plugin/openai/ws-pool"
import { HEADER_ORGANIZATIONID } from "@kilocode/kilo-gateway"
import { codexExpiring } from "../../src/kilocode/provider/codex-expiry"
import { fixture, expired } from "./fixture/auth-store"

const provider = { id: ProviderID.make("openai"), env: ["OPENAI_API_KEY"], options: {}, source: "api" as const }

test("fresh credentials cannot be adopted by an admitted request, while same-login rotation is allowed", async () => {
  await using f = await fixture({ ...expired(), expires: Date.now() + 3600_000 })
  const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
  const first = await resolve()
  const guard = AuthRequest.create({ expected: first.snapshot, resolve })
  try {
    await f.store.commit(await f.store.snapshot("openai"), {
      ...expired(),
      access: "rotated",
      refresh: "rotated",
      expires: Date.now() + 3600_000,
    })
    await guard.check()
    await f.store.set("openai", {
      ...expired(),
      access: "other-fresh",
      accountId: "other",
      expires: Date.now() + 3600_000,
    })
    await expect(guard.check()).rejects.toMatchObject({ reason: "authority-changed", isRetryable: false })
    expect(JSON.stringify(first.snapshot)).not.toContain("old-refresh")
    expect(JSON.stringify(first.snapshot)).not.toContain("old-access")
    expect(JSON.stringify(first.snapshot)).not.toContain("test-account")
  } finally {
    guard.close()
  }
})

for (const source of ["file", "env", "config", "headers", "override", "anonymous"] as const) {
  test(`selected ${source} source is explicit and independent of unused disk credentials`, async () => {
    await using f = await fixture()
    let cfg: Config.Info = {}
    let env: Record<string, string> = {}
    const saved = process.env.KILO_AUTH_CONTENT
    try {
      if (source === "file") await f.store.set("openai", { type: "api", key: "private-file-A" })
      if (source === "env") env.OPENAI_API_KEY = "private-env-A"
      if (source === "config") {
        await f.store.set("openai", { type: "api", key: "unused-file-A" })
        cfg = { provider: { openai: { options: { apiKey: "private-config-A" } } } }
      }
      if (source === "headers")
        cfg = { provider: { openai: { options: { headers: { Authorization: "Bearer private-header-A" } } } } }
      if (source === "override")
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "private-override-A" } })
      const resolve = () => AuthSource.select({ provider, cfg, env, store: f.store })
      const before = await resolve()
      const guard = AuthRequest.create({ expected: before.snapshot, resolve })
      try {
        expect(before.snapshot.source).toBe(
          source === "headers" ? "config" : source === "override" ? "env" : source === "anonymous" ? "none" : source,
        )
        expect(JSON.stringify(before.snapshot)).not.toContain("private-")
        await f.store.remove("openai")
        if (source === "file") await expect(guard.check()).rejects.toMatchObject({ reason: "authority-changed" })
        else await guard.check()
        if (source === "env") env = { OPENAI_API_KEY: "private-env-B" }
        if (source === "config") cfg = { provider: { openai: { options: { apiKey: "private-config-B" } } } }
        if (source === "headers")
          cfg = { provider: { openai: { options: { headers: { Authorization: "Bearer private-header-B" } } } } }
        if (source === "override")
          process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "private-override-B" } })
        if (["env", "config", "headers", "override"].includes(source))
          await expect(guard.check()).rejects.toMatchObject({ reason: "authority-changed" })
      } finally {
        guard.close()
      }
    } finally {
      if (saved === undefined) delete process.env.KILO_AUTH_CONTENT
      else process.env.KILO_AUTH_CONTENT = saved
    }
  })
}

test("external runtime authorities fail closed when reconstruction is unverifiable", async () => {
  await using f = await fixture()
  const resolve = () => AuthSource.select({ provider, cfg: {}, env: { OPENAI_API_KEY: "fixture" }, store: f.store })
  const current = await resolve()
  let reads = 0
  const guard = AuthRequest.create({
    expected: { ...current.snapshot, runtime: "another-runtime" },
    resolve: async () => {
      reads++
      return resolve()
    },
  })
  try {
    await expect(guard.check()).rejects.toMatchObject({ reason: "unverifiable" })
    expect(reads).toBe(0)
  } finally {
    guard.close()
  }
})

test("cached OAuth loader uses the explicit request view, not its old getAuth bridge", async () => {
  await using f = await fixture({ ...expired(), expires: Date.now() + 3600_000 })
  const old = (await f.store.all()).openai
  const requests: string[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get(AuthRequest.header)).toBeNull()
      requests.push(request.headers.get("authorization") ?? "")
      return Response.json({ ok: true })
    },
  })
  const plugin = await CodexAuthPlugin({} as PluginInput, {
    store: f.store,
    codexApiEndpoint: new URL("/responses", server.url).href,
  })
  const cached = await plugin.auth!.loader!(async () => old, {} as never)
  const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
  const before = await resolve()
  await f.store.set("openai", {
    ...expired(),
    access: "fresh-B",
    accountId: "account-B",
    expires: Date.now() + 3600_000,
  })
  const after = await resolve()
  const first = AuthRequest.create({ expected: before.snapshot, resolve })
  const second = AuthRequest.create({ expected: after.snapshot, resolve })
  try {
    await expect(first.fetch(cached.fetch, new URL("/v1/responses", server.url))).rejects.toMatchObject({
      reason: "authority-changed",
    })
    expect((await second.fetch(cached.fetch, new URL("/v1/responses", server.url))).status).toBe(200)
    expect(requests).toEqual(["Bearer fresh-B"])
    await f.store.set("openai", { type: "api", key: "replacement" })
    await expect(second.fetch(cached.fetch, new URL("/v1/responses", server.url))).rejects.toMatchObject({
      reason: "authority-changed",
    })
    expect(requests).toHaveLength(1)
  } finally {
    first.close()
    second.close()
  }
})

test("one session cannot reuse an authenticated WebSocket across admitted accounts", async () => {
  await using f = await fixture({ type: "api", key: "account-A" })
  const frames: string[] = []
  let connections = 0
  using server = Bun.serve<{ key: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      expect(request.headers.get(AuthRequest.header)).toBeNull()
      if (server.upgrade(request, { data: { key: request.headers.get("authorization") ?? "" } })) return
      throw new Error("Unexpected HTTP fallback")
    },
    websocket: {
      open() {
        connections++
      },
      message(socket) {
        frames.push(socket.data.key)
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "fixture" }))
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `response-${frames.length}` } }))
      },
    },
  })
  const url = new URL("/responses", server.url)
  const pool = OpenAIWebSocketPool.createWebSocketFetch({ url: url.href })
  const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
  const first = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
  let second: AuthRequest.Guard | undefined
  try {
    const request = (key: string) => ({
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-session-affinity": "same-session" },
      body: JSON.stringify({ stream: true, input: "fixture" }),
    })
    await (await first.fetch(pool, url, request("account-A"))).text()
    await f.store.set("openai", { type: "api", key: "account-B" })
    second = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
    await (await second.fetch(pool, url, request("account-B"))).text()
    await expect(first.fetch(pool, url, request("account-A"))).rejects.toMatchObject({
      reason: "authority-changed",
    })
    expect(connections).toBe(2)
    expect(frames).toEqual(["Bearer account-A", "Bearer account-B"])
  } finally {
    first.close()
    second?.close()
    pool.close()
  }
})

test("provider invalidation interrupts only matching authority, not other sources or providers", async () => {
  await using f = await fixture({ type: "api", key: "file-A" })
  const select = (id: string, cfg: Config.Info = {}) =>
    AuthSource.select({ provider: { ...provider, id: ProviderID.make(id) }, cfg, env: {}, store: f.store })
  const same = AuthRequest.create({ expected: (await select("openai")).snapshot, resolve: () => select("openai") })
  const config: Config.Info = { provider: { openai: { options: { apiKey: "independent" } } } }
  const separate = AuthRequest.create({
    expected: (await select("openai", config)).snapshot,
    resolve: () => select("openai", config),
  })
  const other = AuthRequest.create({ expected: (await select("other")).snapshot, resolve: () => select("other") })
  try {
    await f.store.remove("openai")
    await AuthRequest.invalidate("openai")
    expect(same.signal.aborted).toBe(true)
    expect(separate.signal.aborted).toBe(false)
    expect(other.signal.aborted).toBe(false)
  } finally {
    same.close()
    separate.close()
    other.close()
  }
})

test("Kilo gateway dispatch binds the actual token and organization, not an unused disk login", async () => {
  await using f = await fixture(
    { ...expired(), access: "unused-file-token", accountId: "file-org", expires: Date.now() + 3600_000 },
    "kilo",
  )
  const env: Record<string, string> = { KILO_ORG_ID: "env-org" }
  const cfg: Config.Info = { provider: { kilo: { options: { kilocodeToken: "configured-token" } } } }
  const row = { ...provider, id: ProviderID.make("kilo"), env: ["KILO_API_KEY"] }
  const resolve = () => AuthSource.select({ provider: row, cfg, env, store: f.store })
  const guard = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
  const calls: string[][] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls.push([request.headers.get("authorization") ?? "", request.headers.get(HEADER_ORGANIZATIONID) ?? ""])
      return Response.json({})
    },
  })
  try {
    const stale = { authorization: "Bearer closed-over-token", [HEADER_ORGANIZATIONID]: "env-org" }
    await guard.fetch(globalThis.fetch, server.url, { headers: stale })
    await f.store.remove("kilo")
    await guard.fetch(globalThis.fetch, server.url, { headers: stale })
    env.KILO_ORG_ID = "changed-org"
    await expect(guard.fetch(globalThis.fetch, server.url, { headers: stale })).rejects.toMatchObject({
      reason: "authority-changed",
    })
    expect(calls).toEqual([
      ["Bearer configured-token", "env-org"],
      ["Bearer configured-token", "env-org"],
    ])
  } finally {
    guard.close()
  }
})

for (const [status, body, reason] of [
  [400, { error: "unknown", error_description: "secret-provider-body" }, "exchange-uncertain"],
  [400, { error: "invalid_grant", error_description: "secret-provider-body" }, "refresh-rejected"],
  [401, {}, "refresh-rejected"],
  [429, {}, "exchange-unavailable"],
  [503, {}, "exchange-unavailable"],
  [200, { refresh_token: "secret-provider-body" }, "exchange-uncertain"],
] as const) {
  test(`credential exchange ${status}/${reason} is bounded, redacted, and nonretryable`, async () => {
    const error = await AuthOutcome.response(Response.json(body, { status })).catch((error) => error)
    expect(error).toBeInstanceOf(AuthOutcome.Failure)
    expect(error).toMatchObject({ reason, isRetryable: false })
    expect(String(error) + JSON.stringify(error)).not.toContain("secret-provider-body")
  })
}

test("large/malformed success and timeout are uncertain; Stop and runtime errors are preserved", async () => {
  await expect(AuthOutcome.response(new Response("x".repeat(70_000)))).rejects.toMatchObject({
    reason: "exchange-uncertain",
  })
  await expect(AuthOutcome.response(new Response("{"))).rejects.toMatchObject({ reason: "exchange-uncertain" })
  expect(() => AuthOutcome.exchange(new DOMException("timeout", "TimeoutError"))).toThrow(AuthOutcome.Failure)
  for (const name of ["AbortError", "RuntimeDisposedError", "InstanceDisposedError"]) {
    const error = new Error("fixture")
    error.name = name
    try {
      AuthOutcome.exchange(error)
    } catch (actual) {
      expect(actual).toBe(error)
    }
  }
})

test("native adapter restores the auth failure rather than retrying a wrapped transport error", async () => {
  await using f = await fixture({ type: "api", key: "A" })
  const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
  const guard = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
  let network = 0
  const fetch = AuthTransport.native(
    guard,
    Object.assign(
      async () => {
        network++
        return Response.json({})
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  try {
    await f.store.set("openai", { type: "api", key: "B" })
    expect((await fetch("http://127.0.0.1:9/never")).status).toBe(401)
    const result = await Effect.runPromise(
      AuthTransport.stream(Stream.fail(new Error("native transport wrapper")), guard).pipe(
        Stream.runDrain,
        Effect.exit,
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(Cause.squash(result.cause)).toMatchObject({ reason: "authority-changed" })
    expect(network).toBe(0)
  } finally {
    guard.close()
  }
})

test("Codex uses a modest pre-dispatch margin without an expiry timer on an active request", async () => {
  const now = Date.now()
  expect(codexExpiring({ access: "fixture", expires: now + 60_000 }, now)).toBe(true)
  expect(codexExpiring({ access: "fixture", expires: now + 60_001 }, now)).toBe(false)
  await using f = await fixture({ ...expired(), expires: now + 1 })
  const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
  const guard = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
  try {
    await guard.check()
    expect(guard.signal.aborted).toBe(false)
  } finally {
    guard.close()
  }
})
