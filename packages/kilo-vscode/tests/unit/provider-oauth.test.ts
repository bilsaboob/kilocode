import { afterEach, describe, expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2"
import {
  handleLogin,
  handleLogout,
  handleSetOrganization,
  type AuthContext,
} from "../../src/kilo-provider/handlers/auth"
import { KiloProvider } from "../../src/KiloProvider"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { handleFinalizeLegacyMigration, type MigrationContext } from "../../src/kilo-provider/handlers/migration"
import type { ProviderOAuthReadyMessage } from "../../webview-ui/src/types/messages"

type Attempt = { providerID: string; method: number; attemptID: string }
type Callback = Omit<Attempt, "attemptID"> & { attemptID?: string; code?: string }
const disposals: Array<{ dispose: number }> = []
afterEach(() => {
  for (const calls of disposals.splice(0)) expect(calls.dispose).toBe(0)
})

function fixture(
  hold: {
    authorize?: (attempt: Attempt) => Promise<void>
    callback?: (input: Callback) => Promise<Response | undefined>
    profile?: () => Promise<void>
  } = {},
) {
  const started: Attempt[] = []
  const callbacks: Callback[] = []
  const posts: Array<{ type: string } & Record<string, unknown>> = []
  const calls = { dispose: 0, profile: 0, refresh: 0, agents: 0, set: 0, remove: 0, organization: [] as unknown[] }
  disposals.push(calls)
  let logged = true
  const client = createKiloClient({
    baseUrl: "http://oauth.invalid",
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        const url = new URL(request.url)
        const route = url.pathname.match(/^\/provider\/([^/]+)\/oauth\/(authorize|callback)$/)
        if (route) {
          expect(url.searchParams.get("directory")).toBe("/fixture")
          const body = (await request.json()) as Omit<Callback, "providerID">
          const providerID = decodeURIComponent(route[1])
          if (route[2] === "authorize") {
            const attempt = { providerID, method: body.method, attemptID: crypto.randomUUID() }
            started.push(attempt)
            await hold.authorize?.(attempt)
            return Response.json({
              attemptID: attempt.attemptID,
              url: "https://oauth.invalid/device",
              method: "auto",
              instructions: "code: FIXTURE",
            })
          }
          const callback = { ...body, providerID }
          callbacks.push(callback)
          return (await hold.callback?.(callback)) ?? Response.json(true)
        }
        if (url.pathname === "/kilo/profile") {
          calls.profile++
          await hold.profile?.()
          return logged
            ? Response.json({ profile: { email: "fixture@example.invalid", organizations: [] } })
            : Response.json({}, { status: 401 })
        }
        if (url.pathname === "/global/dispose" || url.pathname === "/instance/dispose") {
          calls.dispose++
          return Response.json(true)
        }
        if (url.pathname.startsWith("/auth/")) {
          if (request.method === "DELETE") {
            calls.remove++
            if (url.pathname === "/auth/kilo") logged = false
          } else {
            calls.set++
          }
          return Response.json(true)
        }
        if (url.pathname === "/kilo/organization") {
          calls.organization.push(await request.json())
          return Response.json(true)
        }
        if (["/config", "/global/config", "/provider/auth"].includes(url.pathname)) return Response.json({})
        if (url.pathname === "/kilo/auth-status") return Response.json({ authenticated: logged, type: "oauth" })
        if (url.pathname === "/provider") {
          calls.refresh++
          return Response.json({ all: [], connected: [], default: {} })
        }
        if (url.pathname === "/agent") {
          calls.agents++
          return Response.json([])
        }
        throw new Error(`Unexpected fixture request: ${url.pathname}`)
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
  const postMessage = (message: unknown) => posts.push(message as (typeof posts)[number])
  const ctx: AuthContext = {
    client,
    postMessage,
    getWorkspaceDirectory: () => "/fixture",
    refreshAuth: (current) => provider.refreshAuth(current),
  }
  // Exercise the real webview message adapter without constructing an extension host.
  const provider = Object.create(KiloProvider.prototype) as {
    handleProviderAction(message: Record<string, unknown>): Promise<void>
    refreshAuth(current?: () => boolean): Promise<boolean>
    fetchAndSendProviders(): Promise<void>
    fetchAndSendAgents(): Promise<void>
  }
  const connection = Object.create(KiloConnectionService.prototype) as KiloConnectionService
  Object.defineProperties(connection, {
    profileChangeListeners: { value: new Set() },
    authChangeListeners: { value: new Set() },
    authGeneration: { value: 0, writable: true },
  })
  connection.onProfileChanged((data) => postMessage({ type: "profileData", data }))
  connection.onAuthChanged(async () => {
    await Promise.all([provider.fetchAndSendProviders(), provider.fetchAndSendAgents()])
  })
  Object.defineProperties(provider, {
    client: { value: client },
    postMessage: { value: postMessage },
    getWorkspaceDirectory: { value: ctx.getWorkspaceDirectory },
    connectionService: { value: connection },
    providersGeneration: { value: 0, writable: true },
  })
  return { ctx, provider, connection, started, callbacks, posts, calls }
}

describe("Kilo device OAuth attempts", () => {
  it("passes each authorize ID through two sequential logins", async () => {
    const f = fixture()
    let generation = 1
    await handleLogin(f.ctx, generation, () => generation)
    generation++
    await handleLogin(f.ctx, generation, () => generation)

    expect(f.callbacks).toEqual(f.started)
    expect(f.callbacks).toHaveLength(2)
    expect(f.started[0].attemptID).not.toBe(f.started[1].attemptID)
    expect(f.posts.filter((message) => message.type === "deviceAuthComplete")).toHaveLength(2)
    expect(f.calls).toMatchObject({ profile: 2, refresh: 2, agents: 2, dispose: 0 })
    expect(f.posts.filter((message) => message.type === "profileData")).toHaveLength(2)
    expect(f.posts.filter((message) => message.type === "providersLoaded")).toHaveLength(2)
    expect(f.posts.filter((message) => message.type === "agentsLoaded")).toHaveLength(2)
  })

  it("does not start a cancelled callback when its authorize response arrives after restart", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first = true
    const f = fixture({
      authorize: async () => {
        if (!first) return
        first = false
        entered.resolve()
        await release.promise
      },
    })
    let generation = 1
    const old = handleLogin(f.ctx, generation, () => generation)
    await entered.promise
    generation += 2 // cancel, then restart
    await handleLogin(f.ctx, generation, () => generation)
    release.resolve()
    await old

    expect(f.callbacks).toEqual([f.started[1]])
    expect(f.posts.filter((message) => message.type === "deviceAuthStarted")).toHaveLength(1)
    expect(f.posts.filter((message) => message.type === "deviceAuthComplete")).toHaveLength(1)
  })

  it("keeps a delayed old callback bound to its own ID after cancellation and restart", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first = true
    const f = fixture({
      callback: async () => {
        if (!first) return
        first = false
        entered.resolve()
        await release.promise
        return Response.json({ message: "Stale authorization attempt" }, { status: 400 })
      },
    })
    let generation = 1
    const old = handleLogin(f.ctx, generation, () => generation)
    await entered.promise
    generation += 2
    await handleLogin(f.ctx, generation, () => generation)
    release.resolve()
    await old

    expect(f.callbacks).toEqual(f.started)
    expect(f.calls.profile).toBe(1)
    expect(f.posts.filter((message) => message.type === "deviceAuthFailed")).toEqual([])
    expect(f.posts.filter((message) => message.type === "deviceAuthComplete")).toHaveLength(1)
  })

  it("does not publish an old profile after cancellation", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const f = fixture({
      profile: async () => {
        entered.resolve()
        await release.promise
      },
    })
    let generation = 1
    const pending = handleLogin(f.ctx, generation, () => generation)
    await entered.promise
    generation++
    release.resolve()
    await pending

    expect(f.posts.map((message) => message.type)).toEqual(["deviceAuthStarted"])
    expect(f.calls.refresh).toBe(0)
  })

  it("refreshes organization and repeated logout without disposing any workspace", async () => {
    const f = fixture()
    await handleSetOrganization(f.ctx, "fixture-org")
    await handleSetOrganization(f.ctx, null)
    await handleLogout(f.ctx)
    await handleLogout(f.ctx)

    expect(f.calls.organization).toEqual([{ organizationId: "fixture-org" }, { organizationId: null }])
    expect(f.calls).toMatchObject({ remove: 2, profile: 4, refresh: 4, agents: 4, dispose: 0 })
    expect(f.posts.filter((message) => message.type === "profileData").at(-1)).toMatchObject({ data: null })
  })

  it("does not revive a delayed login after logout from another panel", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first = true
    const f = fixture({
      profile: async () => {
        if (!first) return
        first = false
        entered.resolve()
        await release.promise
      },
    })
    const old = handleLogin(f.ctx, 1, () => 1)
    await entered.promise
    const other = Object.create(f.provider) as typeof f.provider
    await handleLogout({ ...f.ctx, refreshAuth: () => other.refreshAuth() })
    const count = f.posts.length
    release.resolve()
    await old
    expect(f.posts).toHaveLength(count)
    expect(f.posts.filter((message) => message.type === "profileData").at(-1)).toMatchObject({ data: null })
    expect(f.calls.agents).toBe(1)
    expect(f.posts.filter((message) => message.type === "deviceAuthComplete")).toEqual([])
  })
})

describe("provider OAuth webview messages", () => {
  it("refreshes repeated API connects and auth-only disconnects without disposal", async () => {
    const f = fixture()
    for (let index = 0; index < 2; index++) {
      await f.provider.handleProviderAction({
        type: "connectProvider",
        requestId: `connect-${index}`,
        providerID: "openai",
        apiKey: "fixture-key",
      })
      await f.provider.handleProviderAction({
        type: "disconnectProvider",
        requestId: `disconnect-${index}`,
        providerID: "openai",
      })
    }
    expect(f.calls).toMatchObject({ set: 2, remove: 2, profile: 0, agents: 4, dispose: 0 })
    expect(f.posts.filter((message) => message.type === "providerConnected")).toHaveLength(2)
    expect(f.posts.filter((message) => message.type === "providerDisconnected")).toHaveLength(2)
    expect(f.posts.filter((message) => message.type === "providerActionError")).toEqual([])
  })

  it("forwards the provider, method, code and matching ID across two sequential logins", async () => {
    const f = fixture()
    for (const method of [0, 1]) {
      await f.provider.handleProviderAction({
        type: "authorizeProviderOAuth",
        requestId: `auth-${method}`,
        providerID: "openai",
        method,
      })
      const ready = f.posts.at(-1) as unknown as ProviderOAuthReadyMessage
      expect(ready.type).toBe("providerOAuthReady")
      expect(ready.authorization.attemptID).toBe(f.started[method].attemptID)
      await f.provider.handleProviderAction({
        type: "completeProviderOAuth",
        requestId: `callback-${method}`,
        providerID: ready.providerID,
        method,
        attemptID: ready.authorization.attemptID,
        code: `code-${method}`,
      })
    }

    expect(f.callbacks).toEqual(f.started.map((attempt, index) => ({ ...attempt, code: `code-${index}` })))
    expect(f.posts.filter((message) => message.type === "providerConnected")).toHaveLength(2)
  })

  it("forwards a delayed old callback ID without substituting or consuming the newer ID", async () => {
    const f = fixture({
      callback: async (input) =>
        input.attemptID === f.started[0].attemptID
          ? Response.json({ message: "Stale authorization attempt" }, { status: 400 })
          : undefined,
    })
    for (const method of [0, 1]) {
      await f.provider.handleProviderAction({
        type: "authorizeProviderOAuth",
        requestId: `auth-${method}`,
        providerID: "openai",
        method,
      })
    }
    await f.provider.handleProviderAction({
      type: "completeProviderOAuth",
      requestId: "old",
      ...f.started[0],
      code: "old-code",
    })
    expect(f.posts.at(-1)).toMatchObject({ type: "providerActionError", requestId: "old" })
    await f.provider.handleProviderAction({
      type: "completeProviderOAuth",
      requestId: "new",
      ...f.started[1],
      code: "new-code",
    })

    expect(f.callbacks).toEqual([
      { ...f.started[0], code: "old-code" },
      { ...f.started[1], code: "new-code" },
    ])
    expect(f.posts.at(-1)).toMatchObject({ type: "providerConnected", requestId: "new" })
    expect(f.calls.refresh).toBe(1)
  })

  it("rejects a missing attempt ID without calling the backend", async () => {
    const f = fixture()
    await f.provider.handleProviderAction({
      type: "completeProviderOAuth",
      requestId: "missing",
      providerID: "openai",
      method: 0,
    })
    expect(f.callbacks).toEqual([])
    expect(f.posts.at(-1)).toMatchObject({ type: "providerActionError", requestId: "missing" })
  })
})

it("finalizes credential-only migration by refreshing clients instead of disposing instances", async () => {
  const f = fixture()
  const states: unknown[] = []
  const calls: string[] = []
  const ctx = {
    client: f.ctx.client,
    extensionContext: {
      globalState: {
        update: async (key: string, value: unknown) => {
          states.push([key, value])
        },
      },
    },
    refreshAuth: () => f.provider.refreshAuth(),
    broadcastComplete: () => {
      calls.push("complete")
    },
    refreshSessions: () => {
      calls.push("sessions")
    },
  } as unknown as MigrationContext
  await handleFinalizeLegacyMigration(ctx)
  expect(states).toEqual([["kilo.legacyMigrationStatus", "completed"]])
  expect(calls).toEqual(["complete", "sessions"])
  expect(f.calls).toMatchObject({ profile: 1, refresh: 1, agents: 1, dispose: 0 })
})

it("notifies all auth refresh listeners and honors unsubscribe without backend disposal", async () => {
  const f = fixture()
  const seen: string[] = []
  const off = f.connection.onAuthChanged(() => {
    seen.push("other-panel")
  })
  f.connection.onAuthChanged(() => {
    seen.push("autocomplete")
  })
  await f.provider.refreshAuth()
  off()
  await f.provider.refreshAuth()
  expect(seen).toEqual(["other-panel", "autocomplete", "autocomplete"])
})
