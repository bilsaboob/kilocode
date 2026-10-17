import { expect, test } from "bun:test"
import type { PluginInput } from "@kilocode/plugin"
import { ProviderID } from "../../src/provider/schema"
import { CopilotAuthPlugin } from "../../src/plugin/github-copilot/copilot"
import { AuthSource } from "../../src/kilocode/auth/source"
import { AuthRequest } from "../../src/kilocode/auth/request"
import { AuthTransport } from "../../src/kilocode/auth/transport"
import { fixture } from "./fixture/auth-store"

for (const change of ["login", "override", "api"] as const) {
  test(`cached Copilot dispatch, retry and tool continuation reject ${change} replacement`, async () => {
    const credential = { type: "oauth" as const, access: "", refresh: "copilot-A", expires: 0, accountId: "account-A" }
    await using f = await fixture(credential, "github-copilot")
    const saved = process.env.KILO_AUTH_CONTENT
    let reads = 0
    const plugin = await CopilotAuthPlugin({ client: {} } as PluginInput)
    const cached = await plugin.auth!.loader!(async () => {
      reads++
      return credential
    }, {} as never)
    const provider = { id: ProviderID.make("github-copilot"), env: [], options: cached, source: "custom" as const }
    const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
    const before = await resolve()
    expect(before.snapshot.source).toBe("file")
    expect(before.expiry).toBeUndefined()
    const guard = AuthRequest.create({ expected: before.snapshot, resolve })
    let tools = 0
    const wrapped = AuthTransport.tools(
      {
        probe: {
          execute: async () => {
            tools++
            return "ok"
          },
        } as never,
      },
      guard,
    )
    const calls: string[] = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.get(AuthRequest.header)).toBeNull()
        calls.push(request.headers.get("authorization") ?? "")
        return Response.json({ ok: true })
      },
    })
    let next: AuthRequest.Guard | undefined
    try {
      const init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "fixture" }] }),
      }
      await guard.fetch(cached.fetch, new URL("/chat/completions", server.url), init)
      if (change === "login")
        await f.store.set("github-copilot", { ...credential, refresh: "copilot-B", accountId: "account-B" })
      if (change === "override")
        process.env.KILO_AUTH_CONTENT = JSON.stringify({
          "github-copilot": {
            ...credential,
            refresh: "environment-B",
            accountId: "account-B",
          },
        })
      if (change === "api") await f.store.set("github-copilot", { type: "api", key: "api-B" })
      for (let retry = 0; retry < 2; retry++)
        await expect(guard.fetch(cached.fetch, new URL("/chat/completions", server.url), init)).rejects.toMatchObject({
          reason: "authority-changed",
        })
      await expect(wrapped.probe.execute!({}, { toolCallId: "fixture", messages: [] })).rejects.toMatchObject({
        reason: "authority-changed",
      })
      expect(tools).toBe(0)
      expect(calls).toEqual(["Bearer copilot-A"])
      if (change !== "api") {
        next = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
        await next.fetch(cached.fetch, new URL("/chat/completions", server.url), init)
        expect(calls).toEqual(["Bearer copilot-A", `Bearer ${change === "login" ? "copilot-B" : "environment-B"}`])
      }
      expect(reads).toBe(1)
      expect(JSON.stringify(before.snapshot)).not.toContain("copilot-A")
      expect(JSON.stringify(before.snapshot)).not.toContain("account-A")
    } finally {
      guard.close()
      next?.close()
      if (saved === undefined) delete process.env.KILO_AUTH_CONTENT
      else process.env.KILO_AUTH_CONTENT = saved
    }
  })
}

test("an external stored OAuth label still binds durable login and account authority", async () => {
  await using f = await fixture(
    { type: "oauth", refresh: "external-A", access: "external-A", expires: 0, accountId: "A" },
    "external-fixture",
  )
  const provider = { id: ProviderID.make("external-fixture"), env: [], options: {}, source: "custom" as const }
  const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
  const guard = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
  try {
    await f.store.set("external-fixture", {
      type: "oauth",
      refresh: "external-B",
      access: "external-B",
      expires: 0,
      accountId: "B",
    })
    await expect(guard.check()).rejects.toMatchObject({ reason: "authority-changed" })
  } finally {
    guard.close()
  }
})

for (const change of ["login", "override", "enterprise"] as const) {
  test(`external OAuth final transport fences a fresh detached credential across ${change}`, async () => {
    const credential = {
      type: "oauth" as const,
      access: "fresh-A",
      refresh: "refresh-A",
      expires: Date.now() + 3600_000,
      accountId: "account-A",
      enterpriseUrl: "tenant-A.invalid",
    }
    await using f = await fixture(credential, "external-fixture")
    const provider = { id: ProviderID.make("external-fixture"), env: [], options: {}, source: "custom" as const }
    const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
    const before = await resolve()
    const guard = AuthRequest.create({ expected: before.snapshot, resolve })
    const saved = process.env.KILO_AUTH_CONTENT
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        calls.push(request.headers.get("authorization") ?? "")
        return Response.json({ ok: true })
      },
    })
    const cached = AuthRequest.delegate(async (request: RequestInfo | URL, init?: RequestInit) => {
      const auth = await AuthRequest.credential(init, async () => {
        throw new Error("Unbound credential lookup")
      })
      if (auth?.type !== "oauth") throw new Error("Invalid OAuth fixture")
      expect(auth).not.toBe(before.credential)
      entered.resolve()
      await release.promise
      return AuthRequest.fetch(globalThis.fetch, request, {
        ...init,
        headers: { authorization: `Bearer ${auth.access}` },
      })
    })
    const pending = guard.fetch(cached, server.url).catch((error: unknown) => error)
    let next: AuthRequest.Guard | undefined
    try {
      await entered.promise
      const value = { ...credential, access: "fresh-B", refresh: "refresh-B", accountId: "account-B" }
      if (change === "login") await f.store.set("external-fixture", value)
      if (change === "override") process.env.KILO_AUTH_CONTENT = JSON.stringify({ "external-fixture": value })
      if (change === "enterprise")
        await f.store.commit(await f.store.snapshot("external-fixture"), {
          ...credential,
          enterpriseUrl: "tenant-B.invalid",
        })
      release.resolve()
      expect(await pending).toMatchObject({ reason: "authority-changed" })
      expect(calls).toEqual([])
      next = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
      await next.fetch(cached, server.url)
      expect(calls).toEqual([`Bearer ${change === "enterprise" ? "fresh-A" : "fresh-B"}`])
    } finally {
      release.resolve()
      await pending
      guard.close()
      next?.close()
      if (saved === undefined) delete process.env.KILO_AUTH_CONTENT
      else process.env.KILO_AUTH_CONTENT = saved
    }
  })
}

test("external OAuth rejects opaque credential-changing transports and contradictory final credentials", async () => {
  await using f = await fixture(
    { type: "oauth", access: "A", refresh: "refresh-A", expires: Date.now() + 3600_000 },
    "external-fixture",
  )
  const provider = { id: ProviderID.make("external-fixture"), env: [], options: {}, source: "custom" as const }
  const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
  let calls = 0
  const opaque = async () => {
    calls++
    return Response.json({ ok: true })
  }
  const wrong = AuthRequest.delegate((request: RequestInfo | URL, init?: RequestInit) =>
    AuthRequest.fetch(globalThis.fetch, request, { ...init, headers: { authorization: "Bearer B" } }),
  )
  for (const boundary of ["fetch", "dispatch"] as const) {
    for (const [fetch, reason] of [
      [opaque, "source-unmanaged"],
      [wrong, "authority-changed"],
    ] as const) {
      const guard = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
      try {
        const result =
          boundary === "fetch"
            ? guard.fetch(fetch, "http://127.0.0.1:9/forbidden")
            : AuthRequest.dispatch(fetch, "http://127.0.0.1:9/forbidden", {
                headers: { [AuthRequest.header]: guard.id, authorization: "Bearer A" },
              })
        await expect(result).rejects.toMatchObject({ reason })
      } finally {
        guard.close()
      }
    }
  }
  expect(calls).toBe(0)
})

test("external OAuth cannot silently adopt competing config or environment credentials", async () => {
  await using f = await fixture(
    { type: "oauth", access: "A", refresh: "refresh-A", expires: Date.now() + 3600_000 },
    "external-fixture",
  )
  const provider = {
    id: ProviderID.make("external-fixture"),
    env: ["EXTERNAL_FIXTURE_KEY"],
    options: {},
    source: "custom" as const,
  }
  for (const options of [{ apiKey: "B" }, { headers: { authorization: "Bearer B" } }]) {
    await expect(
      AuthSource.select({ provider, cfg: { provider: { "external-fixture": { options } } }, env: {}, store: f.store }),
    ).rejects.toMatchObject({ reason: "source-unmanaged" })
  }
  const selected = await AuthSource.select({
    provider: { ...provider, options: { apiKey: "loader-placeholder" } },
    cfg: {},
    env: { EXTERNAL_FIXTURE_KEY: "B" },
    store: f.store,
  })
  expect(selected.snapshot).toMatchObject({ source: "file", kind: "oauth" })
  expect(selected.credential).toMatchObject({ access: "A" })
})
