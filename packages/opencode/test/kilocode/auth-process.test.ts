import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AuthStore } from "../../src/kilocode/auth/store"
import { expired, fixture, tokens } from "./fixture/auth-store"
import { worker } from "./fixture/auth-process"

test("processes with shared data and distinct state retain unrelated Auth.Service writes", async () => {
  await using f = await fixture()
  using first = worker({ root: f.dir, state: "a", role: "service", provider: "a" })
  using second = worker({ root: f.dir, state: "b", role: "service", provider: "b" })
  await Promise.all([first.wait("ready"), second.wait("ready")])
  first.start()
  second.start()
  await Promise.all([first.done, second.done])
  const store = AuthStore.create(path.join(f.dir, "share/kilo/auth.json"))
  expect(await store.all()).toEqual({ a: { type: "api", key: "a" }, b: { type: "api", key: "b" } })
}, 20_000)

test("a paused live process cannot lose its auth lock on heartbeat age", async () => {
  await using f = await fixture()
  using holder = worker({ root: f.dir, state: "a", role: "hold" })
  using writer = worker({ root: f.dir, state: "b", role: "set", provider: "writer" })
  await Promise.all([holder.wait("ready"), writer.wait("ready")])
  holder.start()
  await holder.wait("held")
  const dir = path.join(f.dir, "share/kilo/auth-locks")
  const locks = await fs.readdir(dir)
  expect(locks).toHaveLength(1)
  await fs.utimes(path.join(dir, locks[0], "heartbeat"), new Date(0), new Date(0))
  writer.start()
  await writer.wait("waiting")
  expect(await fs.readdir(dir)).toEqual(locks)
  expect(
    await fs.stat(path.join(f.dir, "share/kilo/auth.json")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  holder.proc.stdin!.write("x")
  await Promise.all([holder.done, writer.done])
  expect((await AuthStore.create(path.join(f.dir, "share/kilo/auth.json")).all()).writer).toBeDefined()
}, 20_000)

test("shared-data Codex exchanges serialize across processes with different state roots", async () => {
  await using f = await fixture()
  const store = AuthStore.create(path.join(f.dir, "share/kilo/auth.json"))
  await store.set("openai", expired())
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: string[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push(await request.text())
      entered.resolve()
      await release.promise
      return Response.json(tokens())
    },
  })
  using first = worker({ root: f.dir, state: "a", role: "refresh", url: server.url.href })
  using second = worker({ root: f.dir, state: "b", role: "refresh", url: server.url.href })
  await Promise.all([first.wait("ready"), second.wait("ready")])
  first.start()
  second.start()
  await entered.promise
  await Promise.race([first.wait("waiting"), second.wait("waiting")])
  release.resolve()
  await Promise.all([first.done, second.done])
  expect(calls).toEqual(["refresh_token=old-refresh"])
}, 20_000)

for (const role of ["logout", "relogin"] as const) {
  test(`cross-process ${role} during a delayed exchange rejects the late credentials`, async () => {
    await using f = await fixture()
    const store = AuthStore.create(path.join(f.dir, "share/kilo/auth.json"))
    await store.set("openai", expired())
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        calls++
        entered.resolve()
        await release.promise
        return Response.json(tokens())
      },
    })
    using renewal = worker({ root: f.dir, state: "renewal", role: "refresh", stale: true, url: server.url.href })
    using mutation = worker({ root: f.dir, state: "mutation", role })
    await Promise.all([renewal.wait("ready"), mutation.wait("ready")])
    renewal.start()
    await entered.promise
    mutation.start()
    await mutation.done
    const current = await store.snapshot("openai")
    release.resolve()
    await renewal.done
    await renewal.wait("stale")
    expect(await store.snapshot("openai")).toEqual(current)
    expect(current.value).toEqual(role === "logout" ? undefined : expired())
    expect(calls).toBe(1)
  }, 20_000)
}
