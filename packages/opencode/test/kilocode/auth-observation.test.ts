import { expect, test } from "bun:test"
import type { PluginInput } from "@kilocode/plugin"
import { createKiloClient } from "@kilocode/sdk"
import { AuthStore } from "../../src/kilocode/auth/store"
import { AuthSource } from "../../src/kilocode/auth/source"
import { AuthRequest } from "../../src/kilocode/auth/request"
import { KiloRuntime } from "../../src/kilocode/runtime/control"
import { ProviderID } from "../../src/provider/schema"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { XaiAuthPlugin } from "../../src/plugin/xai"
import { expired, fixture, pause, tokens } from "./fixture/auth-store"

for (const id of ["openai", "xai"] as const) {
  test(`${id} production renewal keeps runtime occupied through HTTP exchange and real credential publication`, async () => {
    await using f = await fixture(expired(), id)
    using writer = await pause(f.file)
    const waiting = Promise.withResolvers<void>()
    const reader = AuthStore.create(f.file, {
      onWait: () => {
        waiting.resolve()
      },
    })
    const provider = { id: ProviderID.make(id), name: id, env: [], source: "api" as const, options: {}, models: {} }
    const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: reader })
    const selected = await resolve()
    const guard = AuthRequest.create({ expected: selected.snapshot, resolve })
    const network = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const active = () => {
      try {
        const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
        KiloRuntime.release(lease.runtimeID, lease.token)
        return false
      } catch (error) {
        if (!(error instanceof KiloRuntime.Conflict)) throw error
        return error.reason === "active"
      }
    }
    let calls = 0
    const requests: string[] = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/oauth/token") {
          calls++
          expect(await request.text()).toContain("old-refresh")
          network.resolve()
          await resume.promise
          return Response.json({ ...tokens(), access_token: "rotated", refresh_token: "rotated-refresh" })
        }
        expect(request.headers.get(AuthRequest.header)).toBeNull()
        requests.push(request.headers.get("authorization") ?? "")
        return Response.json({ ok: true })
      },
    })
    const input: PluginInput = {
      client: createKiloClient({
        baseUrl: server.url.href,
        fetch: Object.assign(
          async () => {
            throw new Error("Interactive auth is forbidden")
          },
          { preconnect: fetch.preconnect },
        ),
      }),
      project: { id: "fixture", worktree: f.dir, time: { created: 0 } },
      directory: f.dir,
      worktree: f.dir,
      experimental_workspace: {
        register() {
          throw new Error("Workspace registration is forbidden")
        },
      },
      serverUrl: server.url,
      $: Bun.$,
    }
    const plugin =
      id === "openai"
        ? await CodexAuthPlugin(input, {
            store: writer.store,
            issuer: server.url.origin,
            codexApiEndpoint: new URL("/responses", server.url).href,
          })
        : await XaiAuthPlugin(input, {
            store: writer.store,
            tokenUrl: new URL("/oauth/token", server.url).href,
          })
    const loaded = await plugin.auth!.loader!(async () => (await f.store.all())[id], provider)
    const before = await f.store.snapshot(id)
    const refresh = guard.fetch(loaded.fetch, new URL("/v1/responses", server.url))
    try {
      await network.promise
      expect(active()).toBe(true)
      resume.resolve()
      await writer.entered
      expect(active()).toBe(true)
      const admitted = guard.check()
      await waiting.promise
      expect(guard.error()).toBeUndefined()
      writer.release()
      expect((await refresh).status).toBe(200)
      await admitted
      expect(guard.error()).toBeUndefined()
      expect(active()).toBe(false)
      const after = await f.store.snapshot(id)
      expect(after.value).toMatchObject({ access: "rotated", refresh: "rotated-refresh" })
      expect(after.loginGeneration).toBe(before.loginGeneration)
      expect(after.tokenRevision).toBe(before.tokenRevision + 1)
      expect(requests).toEqual(["Bearer rotated"])
      expect(calls).toBe(1)
    } finally {
      resume.resolve()
      writer.release()
      await refresh.catch(() => undefined)
      guard.close()
      await plugin.dispose?.()
    }
  })
}
