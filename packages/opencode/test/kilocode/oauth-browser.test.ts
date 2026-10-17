import { expect, spyOn, test } from "bun:test"
import type { AuthOAuthResult, Hooks, PluginInput } from "@kilocode/plugin"
import { createKiloClient } from "@kilocode/sdk"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { XaiAuthPlugin } from "../../src/plugin/xai"
import { OAuthBrowser } from "../../src/kilocode/plugin/oauth-browser"
import { AuthAttempt } from "../../src/kilocode/auth/attempt"
import { AuthStore } from "../../src/kilocode/auth/store"
import { fixture } from "./fixture/auth-store"

type Provider = "openai" | "xai"
type Handler = Parameters<NonNullable<OAuthBrowser.Options["listen"]>>[0]
type Flow = Extract<AuthOAuthResult, { method: "auto" }> & { state: string; ticket: AuthStore.Attempt }
const attack = '<img src=x onerror="globalThis.leaked=1">provider-secret'
const token = (code: string) => ({
  id_token: "",
  access_token: `access-${code}`,
  refresh_token: `refresh-${code}`,
  expires_in: 3600,
})

async function setup(provider: Provider) {
  const f = await fixture(
    { type: "oauth", access: "existing-access", refresh: "existing-refresh", expires: Date.now() + 3600_000 },
    provider,
  )
  const before = await f.store.snapshot(provider)
  const contents = await Bun.file(f.file).text()
  const sockets: Array<{ handle: Handler; address: URL; closes: number }> = []
  const timers: Array<{ expire: () => void; cancelled: boolean }> = []
  const requests: Array<{ code: string; signal: AbortSignal | null; verifier: string | null }> = []
  const waiting = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const held = new Map<string, ReturnType<typeof Promise.withResolvers<Response>>>()
  const hooks: Hooks[] = []
  const unhandled: unknown[] = []
  const failure = (error: unknown) => unhandled.push(error)
  process.on("unhandledRejection", failure)
  const control: { startup?: Promise<void>; shutdown?: Promise<void>; fail?: boolean } = {}
  const notify = (key: string) => waiting.get(key)?.resolve()
  const wait = (key: string) => {
    if (key === "listen" && sockets.length) return Promise.resolve()
    if (key === "second" && timers.length >= 2) return Promise.resolve()
    if (requests.some((request) => request.code === key)) return Promise.resolve()
    const pending = waiting.get(key) ?? Promise.withResolvers<void>()
    waiting.set(key, pending)
    return pending.promise
  }
  const options: OAuthBrowser.Options = {
    listen: async (handle, address) => {
      const socket = { handle, address, closes: 0 }
      sockets.push(socket)
      notify("listen")
      await control.startup
      if (control.fail) throw new Error(`private listener error: ${attack}`)
      return {
        close: async () => {
          socket.closes++
          await control.shutdown
        },
      }
    },
    timer: (expire, ms) => {
      expect(ms).toBe(5 * 60_000)
      const timer = { expire, cancelled: false }
      timers.push(timer)
      if (timers.length >= 2) notify("second")
      return () => {
        timer.cancelled = true
      }
    },
  }
  const endpoint = provider === "openai" ? "https://auth.openai.com/oauth/token" : "https://auth.x.ai/oauth2/token"
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.url !== endpoint) throw new Error("Unexpected outbound request in browser fixture")
        const body = new URLSearchParams(await request.text())
        expect(request.method).toBe("POST")
        expect(body.get("grant_type")).toBe("authorization_code")
        expect(body.get("redirect_uri")).toBe(sockets[sockets.length - 1].address.href)
        expect(body.get("code_verifier")).toBeTruthy()
        const code = body.get("code")!
        expect(code.startsWith("fixture-")).toBe(true)
        requests.push({ code, signal: init?.signal ?? null, verifier: body.get("code_verifier") })
        notify(code)
        return held.get(code)?.promise ?? Response.json(token(code))
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  const input: PluginInput = {
    client: createKiloClient({ baseUrl: "http://127.0.0.1/unused" }),
    project: { id: "fixture", worktree: f.dir, time: { created: 0 } },
    directory: f.dir,
    worktree: f.dir,
    serverUrl: new URL("http://127.0.0.1/unused"),
    $: Bun.$,
    experimental_workspace: {
      register() {
        throw new Error("Unexpected workspace registration")
      },
    },
  }
  const plugin = async () => {
    const value =
      provider === "openai"
        ? await CodexAuthPlugin(input, { store: f.store, browser: options })
        : await XaiAuthPlugin(input, { store: f.store, browser: options })
    hooks.push(value)
    return value
  }
  const initial = await plugin()
  const start = async (hook = initial): Promise<Flow> => {
    const ticket = await f.store.begin(provider, 0)
    const method = hook.auth!.methods[0]
    if (method.type !== "oauth") throw new Error("Browser OAuth method missing")
    const result = await method.authorize()
    if (result.method !== "auto") throw new Error("Unexpected browser callback type")
    return { ...result, state: new URL(result.url).searchParams.get("state")!, ticket }
  }
  return {
    ...f,
    before,
    sockets,
    timers,
    requests,
    control,
    hooks,
    initial,
    unhandled,
    start,
    plugin,
    wait,
    hold(code: string) {
      const pending = Promise.withResolvers<Response>()
      held.set(code, pending)
      return pending
    },
    reply(
      params: Record<string, string | undefined>,
      socket = sockets[sockets.length - 1],
      route = socket.address.pathname,
      origin?: string,
      method = "GET",
    ) {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value)
      return socket.handle({ url: `${route}?${query}`, method, origin })
    },
    invoke(flow: Flow, signal?: AbortSignal, entered?: () => void) {
      return AuthAttempt.invoke({
        store: f.store,
        ticket: flow.ticket,
        signal,
        callback: () => {
          entered?.()
          return flow.callback()
        },
      })
    },
    async unchanged() {
      const current = await f.store.snapshot(provider)
      expect(AuthStore.generation(current)).toBe(AuthStore.generation(before))
      expect(current.tokenRevision).toBe(before.tokenRevision)
      expect(current.value).toEqual(before.value)
      expect(await Bun.file(f.file).text()).toBe(contents)
    },
    async [Symbol.asyncDispose]() {
      for (const hook of hooks) await hook.dispose?.()
      for (const [code, pending] of held) pending.resolve(Response.json(token(code)))
      await new Promise<void>((resolve) => setImmediate(resolve))
      fetch.mockRestore()
      process.off("unhandledRejection", failure)
      expect(unhandled).toEqual([])
      expect(timers.every((timer) => timer.cancelled)).toBe(true)
      await f[Symbol.asyncDispose]()
    },
  }
}

function redacted(body: string, values: string[]) {
  for (const value of values) expect(body).not.toContain(value)
  expect(body).not.toMatch(/<script|<img|<svg|onerror=/i)
}

for (const provider of ["openai", "xai"] as const) {
  test(`${provider}: unrelated, missing and delayed states cannot settle the current browser attempt`, async () => {
    await using f = await setup(provider)
    const a = await f.start()
    await f.unchanged()
    if (provider === "xai") {
      const allowed = f.reply({}, f.sockets[0], undefined, "https://accounts.x.ai", "OPTIONS")
      expect(allowed.status).toBe(204)
      expect(allowed.headers["Access-Control-Allow-Origin"]).toBe("https://accounts.x.ai")
      expect(
        f.reply({}, f.sockets[0], undefined, "https://untrusted.invalid", "OPTIONS").headers[
          "Access-Control-Allow-Origin"
        ],
      ).toBeUndefined()
    }
    for (const params of [
      { state: "unrelated-secret", error: attack, error_description: attack, code: "query-secret" },
      { error: attack, error_description: attack, code: "query-secret" },
      { state: "", error: attack, error_description: attack },
      { code: "query-secret" },
    ]) {
      const response = f.reply(params)
      expect(response.status).toBe(400)
      redacted(response.body, [attack, "query-secret", "unrelated-secret", a.state])
      expect(f.sockets[0].closes).toBe(0)
      expect(f.timers[0].cancelled).toBe(false)
    }
    expect(
      f.sockets[0].handle({ url: `${f.sockets[0].address.pathname}?state=${a.state}&state=${a.state}&error=ignored` })
        .status,
    ).toBe(400)
    expect(f.timers[0].cancelled).toBe(false)
    const b = await f.start()
    expect(f.sockets).toHaveLength(1)
    expect(f.timers[0].cancelled).toBe(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.unhandled).toEqual([])
    for (const params of [
      { state: a.state, code: "fixture-A" },
      { state: a.state, error: attack, error_description: attack },
      { error: attack, error_description: attack },
    ]) {
      const response = f.reply(params)
      expect(response.status).toBe(400)
      redacted(response.body, [attack, a.state, b.state])
    }
    expect(f.reply({ state: a.state }, f.sockets[0], "/cancel").status).toBe(400)
    expect(f.reply({}, f.sockets[0], "/cancel").status).toBe(400)
    f.timers[0].expire() // A cleared timer may already have been queued by the host.
    const old = await a.callback().catch((error: unknown) => error)
    expect(old).not.toMatchObject({ type: "success" })
    expect(f.sockets[0].closes).toBe(0)
    expect(f.requests).toEqual([])
    await f.unchanged()
    expect(f.reply({ state: b.state, code: "fixture-B" }).status).toBe(200)
    expect(f.reply({ state: b.state, code: "fixture-duplicate" }).status).toBe(400)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.requests).toEqual([])
    await f.unchanged()
    expect(await f.invoke(b)).toBe(provider)
    expect(f.requests.map((request) => request.code)).toEqual(["fixture-B"])
    expect(f.sockets[0].closes).toBe(1)
    const after = await f.store.snapshot(provider)
    expect(after.loginGeneration).not.toBe(f.before.loginGeneration)
    expect(after.tokenRevision).toBe(f.before.tokenRevision + 1)
    expect(await f.invoke(b).catch((error: unknown) => error)).toMatchObject({ name: "AuthStaleError" })
    expect((await f.store.snapshot(provider)).tokenRevision).toBe(after.tokenRevision)
    expect((await f.store.all())[provider]).toMatchObject({ access: "access-fixture-B" })
  })

  for (const outcome of ["success", "failure"] as const) {
    test(`${provider}: late A exchange ${outcome} and A disposal cannot close B's reused listener`, async () => {
      await using f = await setup(provider)
      const a = await f.start()
      const pending = f.hold("fixture-A")
      const entered = Promise.withResolvers<void>()
      const old = f.invoke(a, undefined, () => entered.resolve()).catch((error: unknown) => error)
      await entered.promise
      expect(f.reply({ state: a.state, code: "fixture-A" }).status).toBe(200)
      await f.wait("fixture-A")
      const other = await f.plugin()
      const b = await f.start(other)
      await old
      await f.initial.dispose?.()
      expect(f.requests[0].signal?.aborted).toBe(true)
      expect(f.sockets[0].closes).toBe(0)
      f.timers[0].expire()
      if (outcome === "success") pending.resolve(Response.json(token("fixture-A")))
      else pending.reject(new Error(attack))
      await new Promise<void>((resolve) => setImmediate(resolve))
      await f.unchanged()
      expect(f.reply({ state: a.state, error: attack }).status).toBe(400)
      expect(f.reply({ state: b.state, code: "fixture-B" }).status).toBe(200)
      await f.invoke(b)
      expect(f.requests.map((request) => request.code)).toEqual(["fixture-A", "fixture-B"])
      for (const [index, flow] of [a, b].entries()) {
        const proof = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(f.requests[index].verifier!))
        const challenge = new URL(flow.url).searchParams.get("code_challenge")
        if (!challenge) throw new Error("Authorization URL omitted its PKCE challenge")
        expect(Buffer.from(proof).toString("base64url")).toBe(challenge)
      }
      expect(f.sockets[0].closes).toBe(1)
      expect((await f.store.all())[provider]).toMatchObject({ access: "access-fixture-B" })
    })
  }

  test(`${provider}: matching denial is redacted and one-shot without revoking existing credentials`, async () => {
    await using f = await setup(provider)
    const a = await f.start()
    const response = f.reply({
      state: a.state,
      error: "upstream-code-secret",
      error_description: attack,
      code: "query-secret",
    })
    expect(response.status).toBe(200)
    expect(response.headers["Cache-Control"]).toBe("no-store")
    redacted(response.body, [attack, "provider-secret", "upstream-code-secret", "query-secret", a.state])
    const failed = await f.invoke(a).catch((error: unknown) => error)
    expect(failed).toMatchObject({ name: "CredentialReadinessError" })
    expect(String(failed)).not.toContain(attack)
    expect(String(failed)).not.toContain("upstream-code-secret")
    await f.unchanged()
    const b = await f.start()
    expect(f.sockets).toHaveLength(2)
    expect(f.reply({ state: b.state, error: attack }, f.sockets[0]).status).toBe(400)
    expect(f.reply({ state: b.state, code: "fixture-B" }).status).toBe(200)
    await f.invoke(b)
    expect(f.requests.map((request) => request.code)).toEqual(["fixture-B"])
    expect(f.sockets.map((socket) => socket.closes)).toEqual([1, 1])
  })

  test(`${provider}: a superseded durable ticket cannot exchange a code already delivered by the browser`, async () => {
    await using f = await setup(provider)
    const a = await f.start()
    expect(f.reply({ state: a.state, code: "fixture-A" }).status).toBe(200)
    await f.store.begin(provider, 0)
    expect(await f.invoke(a).catch((error: unknown) => error)).toMatchObject({ name: "AuthStaleError" })
    expect(f.requests).toEqual([])
    await f.unchanged()
    const b = await f.start()
    expect(f.reply({ state: a.state, error: attack }).status).toBe(400)
    expect(f.reply({ state: b.state, code: "fixture-B" }).status).toBe(200)
    await f.invoke(b)
    expect(f.requests.map((request) => request.code)).toEqual(["fixture-B"])
    expect(f.sockets[0].closes).toBe(1)
  })

  test(`${provider}: an unrelated aborted callback context cannot cancel a new signal-free callback`, async () => {
    await using f = await setup(provider)
    const b = await f.start()
    const stale = new AbortController()
    stale.abort(new DOMException("Unrelated callback stopped", "AbortError"))
    const pending = OAuthBrowser.run(stale.signal, () => f.invoke(b))
    f.reply({ state: b.state, code: "fixture-B" })
    expect(await pending).toBe(provider)
    expect(f.requests.map((request) => request.code)).toEqual(["fixture-B"])
    expect(f.sockets[0].closes).toBe(1)
  })

  for (const ending of ["timeout", "cancel", "dispose", "incomplete"] as const) {
    test(`${provider}: matching ${ending} releases only its own listener`, async () => {
      await using f = await setup(provider)
      const a = await f.start()
      if (ending === "timeout") f.timers[0].expire()
      if (ending === "cancel") expect(f.reply({ state: a.state }, f.sockets[0], "/cancel").status).toBe(200)
      if (ending === "dispose") await f.initial.dispose?.()
      if (ending === "incomplete") {
        const response = f.reply({ state: a.state, error_description: attack })
        expect(response.status).toBe(400)
        redacted(response.body, [attack, a.state])
      }
      const old = await a.callback().catch((error: unknown) => error)
      expect(old).not.toMatchObject({ type: "success" })
      await f.unchanged()
      const b = await f.start(await f.plugin())
      f.timers[0].expire()
      await a.callback().catch(() => undefined)
      expect(f.sockets.map((socket) => socket.closes)).toEqual([1, 0])
      expect(f.reply({ state: a.state, error: attack }).status).toBe(400)
      expect(f.reply({ state: b.state, code: "fixture-B" }).status).toBe(200)
      await f.invoke(b)
      expect(f.sockets.map((socket) => socket.closes)).toEqual([1, 1])
    })
  }

  for (const kind of ["abort", "reason"] as const) {
    test(`${provider}: Stop ${kind} preserves cancellation and blocks late exchange publication`, async () => {
      await using f = await setup(provider)
      const a = await f.start()
      const pending = f.hold("fixture-A")
      const stopped = new AbortController()
      const reason = kind === "abort" ? new DOMException("Stopped", "AbortError") : new Error("Stopped by fixture")
      const entered = Promise.withResolvers<void>()
      const result = f.invoke(a, stopped.signal, () => entered.resolve()).catch((error: unknown) => error)
      await entered.promise
      f.reply({ state: a.state, code: "fixture-A" })
      await f.wait("fixture-A")
      stopped.abort(reason)
      expect(await result).toBe(reason)
      expect(f.requests[0].signal?.aborted).toBe(true)
      expect(f.sockets[0].closes).toBe(1)
      await f.unchanged()
      const b = await f.start()
      pending.resolve(Response.json(token("fixture-A")))
      f.reply({ state: b.state, code: "fixture-B" })
      await f.invoke(b)
      expect((await f.store.all())[provider]).toMatchObject({ access: "access-fixture-B" })
    })
  }

  test(`${provider}: final disposal and a new listener wait for the genuinely unowned listener to close`, async () => {
    await using f = await setup(provider)
    const a = await f.start()
    const gate = Promise.withResolvers<void>()
    f.control.shutdown = gate.promise
    f.reply({ state: a.state, error: "access_denied" })
    let disposed = false
    const closing = f.initial.dispose!().then(() => {
      disposed = true
    })
    const old = a.callback().catch((error: unknown) => error)
    try {
      const b = f.start(await f.plugin())
      await f.wait("second")
      expect(disposed).toBe(false)
      expect(f.sockets).toHaveLength(1)
      expect(f.sockets[0].closes).toBe(1)
      gate.resolve()
      await closing
      await old
      const ready = await b
      expect(f.sockets).toHaveLength(2)
      f.reply({ state: ready.state, code: "fixture-B" })
      await f.invoke(ready)
      expect(f.sockets.map((socket) => socket.closes)).toEqual([1, 1])
    } finally {
      gate.resolve()
      await closing
      await old
    }
  })

  test(`${provider}: overlapping listener startup gives ownership to the newest attempt`, async () => {
    await using f = await setup(provider)
    const gate = Promise.withResolvers<void>()
    f.control.startup = gate.promise
    const a = f.start().catch((error: unknown) => error)
    try {
      await f.wait("listen")
      const b = f.start()
      await f.wait("second")
      gate.resolve()
      expect(await a).toBeInstanceOf(Error)
      const ready = await b
      expect(f.sockets).toHaveLength(1)
      expect(f.sockets[0].closes).toBe(0)
      await f.unchanged()
      f.reply({ state: ready.state, code: "fixture-B" })
      await f.invoke(ready)
      expect(f.sockets[0].closes).toBe(1)
    } finally {
      gate.resolve()
      await a
    }
  })

  test(`${provider}: listener startup failure does not poison a later authorization`, async () => {
    await using f = await setup(provider)
    f.control.fail = true
    const failed = await f.start().catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(String(failed)).not.toContain(attack)
    await f.unchanged()
    f.control.fail = false
    const b = await f.start()
    f.reply({ state: b.state, code: "fixture-B" })
    await f.invoke(b)
    expect(f.sockets[1].closes).toBe(1)
  })
}

test("browser error interpolation escapes HTML metacharacters", () => {
  expect(OAuthBrowser.escape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
})
