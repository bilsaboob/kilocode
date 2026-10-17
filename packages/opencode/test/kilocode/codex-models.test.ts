import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CodexModels } from "../../src/kilocode/provider/codex-models"
import { patchConfigModel } from "../../src/kilocode/provider/provider"
import { AuthStore } from "../../src/kilocode/auth/store"
import { refreshCodexAuth } from "../../src/kilocode/provider/codex-refresh"

const profile = process.env.ZEN_KILO_CONTEXT_POLICY
const deadline = Date.now() + 3600_000
beforeEach(() => AuthStore.disk.set("openai", credentials()))
afterEach(async () => {
  await AuthStore.disk.remove("openai")
  if (profile === undefined) {
    delete process.env.ZEN_KILO_CONTEXT_POLICY
    return
  }
  process.env.ZEN_KILO_CONTEXT_POLICY = profile
})

function credentials(accountId = "test-account") {
  return {
    type: "oauth" as const,
    accountId,
    access: "test-access",
    refresh: "test-refresh",
    expires: deadline,
  }
}

function model(slug = "gpt-5.6-sol") {
  return {
    slug,
    context_window: 272_000,
    max_context_window: 872_000,
    effective_context_window_percent: 95,
    base_instructions: "Untrusted catalog instructions must not enter the context-policy descriptor.",
  }
}

describe("authenticated Codex context metadata", () => {
  test("gets maximum-window metadata without posting to the generation endpoint", async () => {
    const auth = credentials()
    const requests: Array<{ path: string; method: string }> = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push({ path: url.pathname, method: request.method })
        expect(url.searchParams.get("client_version")).toBe("0.162.0")
        expect(request.headers.get("Authorization")).toBe("Bearer test-access")
        expect(request.headers.get("ChatGPT-Account-Id")).toBe("test-account")
        expect(request.headers.get("User-Agent")).toStartWith("kilo/")
        expect(request.headers.get("originator")).toBe("kilo")
        return Response.json({ models: [model()] })
      },
    })
    const result = await CodexModels.create().load({
      auth,
      endpoint: new URL("/backend-api/codex/responses", server.url).href,
      refresh: async () => {
        throw new Error("Unexpected refresh")
      },
    })
    const capability = CodexModels.lookup(result, "gpt-5.6-sol")
    expect(capability).toMatchObject({
      status: "ready",
      context: 272_000,
      maximum: 872_000,
      effectivePercent: 95,
      source: "codex-catalog@0.162.0",
    })
    expect(Object.keys(capability).toSorted()).toEqual([
      "binding",
      "context",
      "effectivePercent",
      "maximum",
      "revision",
      "source",
      "status",
    ])
    expect(JSON.stringify(capability)).not.toContain("test-account")
    expect(JSON.stringify(capability)).not.toContain("test-access")
    expect(requests).toEqual([{ path: "/backend-api/codex/models", method: "GET" }])
  })

  test("coalesces concurrent reads and expires cached metadata", async () => {
    const auth = credentials()
    let clock = Date.now()
    let calls = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return Response.json({ models: [model()] })
      },
    })
    const catalog = CodexModels.create(() => clock)
    const input = {
      auth,
      endpoint: new URL("/responses", server.url).href,
      refresh: async () => {
        throw new Error("Unexpected refresh")
      },
    }
    const [first, second] = await Promise.all([catalog.load(input), catalog.load(input)])
    expect(CodexModels.lookup(first, "gpt-5.6-sol")).toEqual(CodexModels.lookup(second, "gpt-5.6-sol"))
    expect(calls).toBe(1)
    await catalog.load(input)
    expect(calls).toBe(1)
    clock += 5 * 60_000
    await catalog.load(input)
    expect(calls).toBe(2)
  })

  test("does not reuse metadata between accounts", async () => {
    let auth = credentials("first-account")
    await AuthStore.disk.set("openai", auth)
    let calls = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return Response.json({ models: [model()] })
      },
    })
    const catalog = CodexModels.create()
    const input = {
      endpoint: new URL("/responses", server.url).href,
      refresh: async () => {
        throw new Error("Unexpected refresh")
      },
    }
    const first = CodexModels.lookup(await catalog.load({ ...input, auth }), "gpt-5.6-sol")
    auth = credentials("second-account")
    await AuthStore.disk.set("openai", auth)
    const second = CodexModels.lookup(await catalog.load({ ...input, auth }), "gpt-5.6-sol")
    expect(calls).toBe(2)
    expect(first.status).toBe("ready")
    expect(second.status).toBe("ready")
    expect(first).not.toEqual(second)
  })

  test("refreshes unavailable or expired metadata without mutating an earlier turn's capability", async () => {
    const auth = credentials()
    let clock = Date.now()
    let unavailable = true
    let maximum = 872000
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        if (unavailable) return new Response("unavailable", { status: 503 })
        return Response.json({ models: [{ ...model(), max_context_window: maximum }, model("another-model")] })
      },
    })
    const catalog = CodexModels.create(() => clock)
    const load = () =>
      catalog.load({
        auth,
        endpoint: new URL("/responses", server.url).href,
        refresh: async () => {
          throw new Error("Unexpected refresh")
        },
      })
    const first = CodexModels.bind(CodexModels.lookup(await load(), "gpt-5.6-sol"), load)
    expect(first.status).toBe("unavailable")
    unavailable = false
    const second = await CodexModels.resolve(first, "gpt-5.6-sol")
    expect(second).toMatchObject({ status: "ready", maximum: 872000 })
    maximum = 900000
    clock += 5 * 60_000
    const third = await CodexModels.resolve(second, "gpt-5.6-sol")
    expect(third).toMatchObject({ status: "ready", maximum: 900000 })
    expect(second).toMatchObject({ status: "ready", maximum: 872000 })
    expect(first.status).toBe("unavailable")
    expect((await CodexModels.resolve(third, "unknown-model")).status).toBe("unavailable")
    expect(Object.isFrozen(second)).toBe(true)
  })

  test("credential preparation errors do not invent a usable maximum", async () => {
    const auth = credentials()
    await AuthStore.disk.remove("openai")
    const result = await CodexModels.create().load({
      auth,
      endpoint: "https://example.invalid/responses",
      refresh: async () => {
        throw new Error("Unexpected refresh")
      },
    })
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "Codex credentials could not be prepared for model-limit discovery.",
    })
  })

  for (const change of ["logout", "account-change", "identical-login"] as const) {
    test(`rejects catalog results after ${change}`, async () => {
      let auth: ReturnType<typeof credentials> | undefined = credentials()
      const initial = auth
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      using server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch() {
          entered.resolve()
          await release.promise
          return Response.json({ models: [model()] })
        },
      })
      const pending = CodexModels.create().load({
        auth: initial,
        endpoint: new URL("/responses", server.url).href,
        refresh: async () => {
          throw new Error("Unexpected refresh")
        },
      })
      await entered.promise
      auth = change === "logout" ? undefined : credentials(change === "account-change" ? "replacement" : "test-account")
      if (auth) await AuthStore.disk.set("openai", auth)
      else await AuthStore.disk.remove("openai")
      release.resolve()
      const result = await pending
      expect(CodexModels.lookup(result, "gpt-5.6-sol")).toMatchObject({ status: "unavailable" })
    })
  }

  test("renews expired credentials before the metadata GET", async () => {
    let auth = { ...credentials(), expires: 0, access: "expired" }
    await AuthStore.disk.set("openai", auth)
    let renewed = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.get("Authorization")).toBe("Bearer renewed")
        return Response.json({ models: [model()] })
      },
    })
    const result = await CodexModels.create().load({
      auth,
      endpoint: new URL("/responses", server.url).href,
      refresh: async () => {
        renewed++
        auth = { ...auth, access: "renewed", expires: Date.now() + 60_000 }
        await AuthStore.disk.commit(await AuthStore.disk.snapshot("openai"), auth)
        return auth
      },
    })
    expect(renewed).toBe(1)
    expect(CodexModels.lookup(result, "gpt-5.6-sol").status).toBe("ready")
  })

  test("does not adopt an account change hidden by mutation during credential renewal", async () => {
    const auth = { ...credentials(), expires: 0 }
    await AuthStore.disk.set("openai", auth)
    const result = await CodexModels.create().load({
      auth,
      endpoint: "https://example.invalid/responses",
      refresh: async () => {
        Object.assign(auth, credentials("replacement-account"))
        await AuthStore.disk.set("openai", auth)
        return auth
      },
    })
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "Codex credentials could not be prepared for model-limit discovery.",
    })
  })

  test("catalog renewal cannot adopt an identical new login or send a catalog request", async () => {
    const auth = { ...credentials(), expires: 0 }
    await AuthStore.disk.set("openai", auth)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let requests = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return Response.json({ models: [model()] })
      },
    })
    const pending = CodexModels.create().load({
      auth,
      endpoint: new URL("/responses", server.url).href,
      refresh: (auth) =>
        refreshCodexAuth({
          auth,
          account: () => "test-account",
          refresh: async () => {
            entered.resolve()
            await release.promise
            return { id_token: "", access_token: "renewed", refresh_token: "renewed", expires_in: 3600 }
          },
        }),
    })
    await entered.promise
    await AuthStore.disk.remove("openai")
    await AuthStore.disk.set("openai", auth)
    release.resolve()
    expect((await pending) instanceof Map).toBe(false)
    expect(requests).toBe(0)
  })

  test("catalog renewal cannot silently change account in the same login generation", async () => {
    const auth = { ...credentials(), expires: 0 }
    await AuthStore.disk.set("openai", auth)
    const before = await AuthStore.disk.snapshot("openai")
    let requests = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return Response.json({ models: [model()] })
      },
    })
    const result = await CodexModels.create().load({
      auth,
      endpoint: new URL("/responses", server.url).href,
      refresh: (auth) =>
        refreshCodexAuth({
          auth,
          account: () => "other-account",
          refresh: async () => ({
            id_token: "",
            access_token: "new-account-access",
            refresh_token: "new-account-refresh",
            expires_in: 3600,
          }),
        }),
    })
    expect(CodexModels.lookup(result, "gpt-5.6-sol").status).toBe("unavailable")
    expect(await AuthStore.disk.snapshot("openai")).toEqual(before)
    expect(requests).toBe(0)
  })

  test("catalog account identity remains fenced independently of login generation", async () => {
    const auth = credentials()
    const catalog = CodexModels.create()
    let requests = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return Response.json({ models: [model()] })
      },
    })
    const input = { auth, endpoint: new URL("/responses", server.url).href, refresh: async () => auth }
    const first = CodexModels.lookup(await catalog.load(input), "gpt-5.6-sol")
    const before = await AuthStore.disk.snapshot("openai")
    await AuthStore.disk.commit(before, { ...auth, accountId: "other-account" })
    expect((await AuthStore.disk.snapshot("openai")).loginGeneration).toBe(before.loginGeneration)
    expect(CodexModels.lookup(await catalog.load(input), "gpt-5.6-sol").status).toBe("unavailable")
    const second = CodexModels.lookup(
      await catalog.load({ ...input, auth: credentials("other-account") }),
      "gpt-5.6-sol",
    )
    expect(second.binding).not.toBe(first.binding)
    expect(requests).toBe(2)
  })

  test("in-place auth mutation without persistence cannot redirect catalog discovery", async () => {
    const auth = { ...credentials(), expires: 0 }
    await AuthStore.disk.set("openai", auth)
    const before = await AuthStore.disk.snapshot("openai")
    let requests = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return Response.json({ models: [model()] })
      },
    })
    const result = await CodexModels.create().load({
      auth,
      endpoint: new URL("/responses", server.url).href,
      refresh: async () => {
        Object.assign(auth, credentials("mutated-account"))
        return auth
      },
    })
    expect(CodexModels.lookup(result, "gpt-5.6-sol").status).toBe("unavailable")
    expect(requests).toBe(0)
    expect(await AuthStore.disk.snapshot("openai")).toEqual(before)
  })

  test("cache bindings separate identical relogins and reject the old loader", async () => {
    let calls = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return Response.json({ models: [model()] })
      },
    })
    const catalog = CodexModels.create()
    const input = {
      auth: credentials(),
      endpoint: new URL("/responses", server.url).href,
      refresh: async () => {
        throw new Error("Unexpected renewal")
      },
    }
    const first = CodexModels.lookup(await catalog.load(input), "gpt-5.6-sol")
    await AuthStore.disk.set("openai", credentials())
    expect(CodexModels.lookup(await catalog.load(input), "gpt-5.6-sol").status).toBe("unavailable")
    const second = CodexModels.lookup(await catalog.load({ ...input, auth: credentials() }), "gpt-5.6-sol")
    expect(second.status).toBe("ready")
    expect(second.binding).not.toBe(first.binding)
    expect(calls).toBe(2)
  })

  test("does not invent maxima or borrow another model's metadata", async () => {
    const auth = credentials()
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          models: [
            { slug: "missing", context_window: 272000 },
            { ...model("invalid"), max_context_window: 100000 },
            model("ambiguous"),
            { ...model("ambiguous"), max_context_window: "untrusted" },
            model(),
          ],
        })
      },
    })
    const result = await CodexModels.create().load({
      auth,
      endpoint: new URL("/responses", server.url).href,
      refresh: async () => {
        throw new Error("Unexpected refresh")
      },
    })
    for (const id of ["missing", "invalid", "ambiguous", "gpt-5.6-sol-dated-alias"]) {
      expect(CodexModels.lookup(result, id).status).toBe("unavailable")
    }
    expect(CodexModels.lookup(result, "gpt-5.6-sol").status).toBe("ready")
  })

  test("returns a bounded failure without following catalog redirects", async () => {
    const auth = credentials()
    let generation = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/models") return Response.redirect(new URL("/responses", request.url))
        generation++
        return Response.json({ models: [model()] })
      },
    })
    const result = await CodexModels.create().load({
      auth,
      endpoint: new URL("/responses", server.url).href,
      refresh: async () => {
        throw new Error("Unexpected refresh")
      },
    })
    expect(CodexModels.lookup(result, "gpt-5.6-sol").status).toBe("unavailable")
    expect(generation).toBe(0)
  })

  test("does not silently use an API budget after catalog failure", async () => {
    const auth = credentials()
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("private error details must not be published", { status: 401 }),
    })
    const result = await CodexModels.create().load({
      auth,
      endpoint: new URL("/responses", server.url).href,
      refresh: async () => {
        throw new Error("Unexpected refresh")
      },
    })
    expect(CodexModels.lookup(result, "gpt-5.6-sol")).toMatchObject({
      status: "unavailable",
      reason: "The authenticated Codex model catalog returned HTTP 401.",
    })
  })

  test("preserves authenticated capabilities through configured aliases without accepting forged overrides", () => {
    const capability = {
      status: "ready" as const,
      context: 272000,
      maximum: 872000,
      effectivePercent: 95,
      source: "test",
      revision: "sealed",
    }
    const result = patchConfigModel({ codex: { ...capability, maximum: 999999999 } }, { codex: capability })
    expect(result.codex).toBe(capability)
  })

  test("marks missing OAuth capabilities only for an explicitly profiled backend", () => {
    const provider: { id: string; models: Record<string, { codex?: CodexModels.Capability }> } = {
      id: "openai",
      models: { unknown: {} },
    }
    delete process.env.ZEN_KILO_CONTEXT_POLICY
    CodexModels.mark(provider, { type: "oauth" })
    expect(provider.models.unknown.codex).toBeUndefined()
    process.env.ZEN_KILO_CONTEXT_POLICY = JSON.stringify({
      version: 1,
      window: "maximum-supported",
      automaticPercent: 85,
      admissionPercent: 95,
    })
    CodexModels.mark(provider, { type: "oauth" })
    expect(provider.models.unknown.codex?.status).toBe("unavailable")
    CodexModels.mark(provider, { type: "api" })
    expect(provider.models.unknown.codex).toBeUndefined()
  })
})
