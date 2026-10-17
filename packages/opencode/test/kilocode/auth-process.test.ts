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

test("authorization newest-start ordering is shared across processes, not a local pending map", async () => {
  await using f = await fixture()
  const store = AuthStore.create(path.join(f.dir, "share/kilo/auth.json"))
  await store.set("openai", expired())
  const before = await store.snapshot("openai")
  using first = worker({ root: f.dir, state: "first", role: "attempt", stale: true })
  using second = worker({ root: f.dir, state: "second", role: "attempt" })
  await Promise.all([first.wait("ready"), second.wait("ready")])
  first.start()
  await first.wait("begun")
  second.start()
  await second.done
  first.proc.send("finish")
  await first.done
  await first.wait("stale")
  const after = await store.snapshot("openai")
  expect(after.loginGeneration).toBe(before.loginGeneration)
  expect(after.tokenRevision).toBe(before.tokenRevision)
  expect((await store.all()).openai).toEqual(expired())
}, 20_000)

test("ambiguous rotation fences waiting and later processes until explicit reauthentication", async () => {
  await using f = await fixture()
  const store = AuthStore.create(path.join(f.dir, "share/kilo/auth.json"))
  await store.set("openai", expired())
  const before = await store.snapshot("openai")
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
      return Response.json(calls === 1 ? { access_token: "ambiguous-secret" } : tokens())
    },
  })
  using first = worker({ root: f.dir, state: "a", role: "refresh", uncertain: true, url: server.url.href })
  using second = worker({ root: f.dir, state: "b", role: "refresh", uncertain: true, url: server.url.href })
  try {
    await Promise.all([first.wait("ready"), second.wait("ready")])
    first.start()
    await entered.promise
    second.start()
    await second.wait("waiting")
    release.resolve()
    await Promise.all([first.done, second.done])
    await Promise.all([first.wait("uncertain"), second.wait("uncertain")])
    await store.set("unrelated", { type: "api", key: "unrelated-fixture" })
    using later = worker({ root: f.dir, state: "c", role: "refresh", uncertain: true, url: server.url.href })
    await later.wait("ready")
    later.start()
    await later.done
    await later.wait("uncertain")
    expect(calls).toBe(1)
    expect(await store.snapshot("openai")).toEqual(before)
    expect(await store.observe("openai", true)).toMatchObject({ issue: "exchange-uncertain" })
    await store.set("openai", expired())
    using fresh = worker({ root: f.dir, state: "d", role: "refresh", url: server.url.href })
    await fresh.wait("ready")
    fresh.start()
    await fresh.done
    expect(calls).toBe(2)
    expect(await store.observe("openai", true)).toMatchObject({ issue: undefined })
    expect((await store.all()).openai).toMatchObject({ access: "next-access" })
  } finally {
    release.resolve()
  }
}, 30_000)
