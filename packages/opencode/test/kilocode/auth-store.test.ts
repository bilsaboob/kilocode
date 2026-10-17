import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { AuthSourceError, AuthStaleError, AuthStorageError, AuthStore } from "../../src/kilocode/auth/store"
import { expired, fixture } from "./fixture/auth-store"
import { legacy, organization } from "../../src/kilocode/auth/mutations"

test("only one conditional writer wins and unrelated providers survive", async () => {
  await using f = await fixture(expired())
  const second = AuthStore.create(f.file)
  await second.set("other", { type: "api", key: "other-key" })
  const before = await f.store.snapshot("openai")
  const results = await Promise.allSettled([
    f.store.commit(before, { ...expired(), access: "first" }),
    second.commit(before, { ...expired(), access: "second" }),
  ])
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  const rejected = results.find((r) => r.status === "rejected")
  expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(AuthStaleError)
  expect((await f.store.all()).other).toEqual({ type: "api", key: "other-key" })
  const after = await f.store.snapshot("openai")
  expect(after.loginGeneration).toBe(before.loginGeneration)
  expect(after.tokenRevision).toBe(before.tokenRevision + 1)
})

test("explicit identical sets and repeated deletes always revoke authority", async () => {
  await using f = await fixture(expired())
  const snapshots = [await f.store.snapshot("openai")]
  await f.store.set("openai", expired())
  snapshots.push(await f.store.snapshot("openai"))
  await f.store.remove("openai")
  snapshots.push(await f.store.snapshot("openai"))
  await f.store.remove("openai")
  snapshots.push(await f.store.snapshot("openai"))
  expect(new Set(snapshots.map((s) => s.loginGeneration)).size).toBe(4)
  expect(new Set(snapshots.map((s) => s.tokenRevision)).size).toBe(4)
  for (const snapshot of snapshots.slice(0, -1))
    await expect(f.store.check(snapshot)).rejects.toBeInstanceOf(AuthStaleError)
})

test("conditional explicit organization changes and legacy migration cannot restore stale auth", async () => {
  await using f = await fixture(expired(), "kilo")
  const before = await f.store.snapshot("kilo")
  const changed = await f.store.commit(before, { ...expired(), accountId: "new-organization" }, true)
  expect(changed.loginGeneration).not.toBe(before.loginGeneration)
  await f.store.remove("kilo")
  await expect(f.store.commit(changed, expired(), true)).rejects.toBeInstanceOf(AuthStaleError)
  const missing = await f.store.snapshot("kilo")
  await f.store.remove("kilo")
  await expect(f.store.commit(missing, expired(), true)).rejects.toBeInstanceOf(AuthStaleError)
  expect((await f.store.all()).kilo).toBeUndefined()
})

test("same-directory atomic writes preserve the public auth map and restrictive modes", async () => {
  await using f = await fixture(expired())
  expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toEqual({ openai: expired() })
  const names = await fs.readdir(f.dir)
  expect(names.toSorted()).toEqual(["auth-locks", "auth.json", "auth.revisions.json"])
  expect(await fs.readdir(path.join(f.dir, "auth-locks"))).toEqual([])
  if (process.platform === "win32") return
  for (const name of ["auth.json", "auth.revisions.json"])
    expect((await fs.stat(path.join(f.dir, name))).mode & 0o777).toBe(0o600)
})

test("legacy and missing metadata get fresh epochs; corrupt metadata fails closed", async () => {
  await using f = await fixture()
  await fs.writeFile(f.file, JSON.stringify({ openai: expired(), untouched: { external: "preserved" } }))
  const first = await f.store.snapshot("openai")
  const sidecar = path.join(f.dir, "auth.revisions.json")
  await fs.rm(sidecar)
  const second = await f.store.snapshot("openai")
  expect(second.epoch).not.toBe(first.epoch)
  await expect(f.store.commit(first, expired())).rejects.toBeInstanceOf(AuthStaleError)
  await f.store.set("other", { type: "api", key: "fixture" })
  expect(JSON.parse(await fs.readFile(f.file, "utf8")).untouched).toEqual({ external: "preserved" })
  for (const corrupt of ["{", JSON.stringify({ version: 1, epoch: "invalid", providers: {} })]) {
    await fs.writeFile(sidecar, corrupt)
    await expect(f.store.snapshot("openai")).rejects.toBeInstanceOf(AuthStorageError)
    await expect(f.store.set("other", { type: "api", key: "blocked" })).rejects.toBeInstanceOf(AuthStorageError)
  }
})

test("malformed disk data cannot be replaced with an empty map", async () => {
  await using f = await fixture()
  for (const corrupt of ["{", "[]", "null"]) {
    await fs.writeFile(f.file, corrupt)
    await expect(f.store.set("openai", expired())).rejects.toBeInstanceOf(AuthStorageError)
    expect(await fs.readFile(f.file, "utf8")).toBe(corrupt)
  }
})

test("provider names cannot alias object prototype properties", async () => {
  await using f = await fixture()
  for (const provider of ["__proto__", "constructor", "toString"]) {
    await f.store.set(provider, { type: "api", key: provider })
    expect((await f.store.all())[provider]).toEqual({ type: "api", key: provider })
    await f.store.remove(provider)
    expect((await f.store.all())[provider]).toBeUndefined()
  }
})

test("env reads override disk, but explicit mutations RMW disk only", async () => {
  await using f = await fixture(expired())
  const saved = process.env.KILO_AUTH_CONTENT
  try {
    const env = { openai: { ...expired(), access: "environment" }, envonly: { type: "api" as const, key: "env" } }
    process.env.KILO_AUTH_CONTENT = JSON.stringify(env)
    expect(await f.store.all()).toEqual(env)
    await f.store.set("other", { type: "api", key: "disk" })
    await f.store.remove("openai")
    expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toEqual({ other: { type: "api", key: "disk" } })
    expect(await f.store.all()).toEqual(env)
    await expect(f.store.snapshot("openai")).rejects.toBeInstanceOf(AuthSourceError)
  } finally {
    if (saved === undefined) delete process.env.KILO_AUTH_CONTENT
    else process.env.KILO_AUTH_CONTENT = saved
  }
})

test("independent Auth.Service layers retain concurrently written providers", async () => {
  const run = (key: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set(key, { type: "api", key })
      }).pipe(Effect.provide(Auth.defaultLayer)),
    )
  await Promise.all([run("fixture-a"), run("fixture-b")])
  try {
    const result = await AuthStore.disk.all()
    expect(result["fixture-a"]).toEqual({ type: "api", key: "fixture-a" })
    expect(result["fixture-b"]).toEqual({ type: "api", key: "fixture-b" })
  } finally {
    await AuthStore.disk.remove("fixture-a")
    await AuthStore.disk.remove("fixture-b")
  }
})

test("trailing-slash snapshots cannot restore credentials after canonical set/remove ABA", async () => {
  await using f = await fixture()
  const provider = "https://example.com"
  const stale = await f.store.snapshot(`${provider}/`)
  expect(stale.provider).toBe(provider)
  await f.store.set(provider, expired())
  await f.store.remove(provider)
  await expect(f.store.commit(stale, expired(), true)).rejects.toBeInstanceOf(AuthStaleError)
  expect(await f.store.all()).toEqual({})
  const meta = JSON.parse(await fs.readFile(path.join(f.dir, "auth.revisions.json"), "utf8"))
  expect(Object.keys(meta.providers)).toEqual([provider])
  expect(meta.providers[provider].tombstone).toBe(true)
})

test("legacy aliases and metadata normalize to a single canonical authority", async () => {
  await using f = await fixture()
  const provider = "https://example.com"
  await fs.writeFile(f.file, JSON.stringify({ [`${provider}/`]: expired() }))
  const first = await f.store.snapshot(`${provider}/`)
  expect(await f.store.snapshot(provider)).toEqual(first)
  await f.store.set(`${provider}//`, expired())
  expect(Object.keys(JSON.parse(await fs.readFile(f.file, "utf8")))).toEqual([provider])
  await expect(f.store.check(first)).rejects.toBeInstanceOf(AuthStaleError)
  await f.store.remove(`${provider}/`)
  expect(await f.store.all()).toEqual({})
})

test("writes validate and detach caller-owned values before asynchronous storage", async () => {
  await using f = await fixture()
  const input = { type: "api" as const, key: "original", metadata: { value: "original" } }
  const write = f.store.set("fixture", input)
  input.key = "mutated"
  input.metadata.value = "mutated"
  await write
  expect((await f.store.all()).fixture).toEqual({ type: "api", key: "original", metadata: { value: "original" } })
})

test("actual organization adapter cannot commit a captured credential after logout", async () => {
  await using f = await fixture(expired(), "kilo")
  const info = (await f.store.all()).kilo
  if (info.type !== "oauth") throw new Error("Invalid fixture")
  const captured = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const commit = f.store.commit.bind(f.store)
  using _barrier = spyOn(f.store, "commit").mockImplementation(async (...args) => {
    captured.resolve()
    await release.promise
    return commit(...args)
  })
  const result = organization(info, "new-organization", f.store).catch((error) => error)
  await captured.promise
  await f.store.remove("kilo")
  release.resolve()
  expect(await result).toBeInstanceOf(AuthStaleError)
  expect((await f.store.all()).kilo).toBeUndefined()
})

test("actual legacy migration callbacks cannot restore a newer logout or sign-in", async () => {
  await using f = await fixture()
  const callbacks = legacy(f.store)
  expect(await callbacks.exists()).toBe(false)
  await f.store.remove("kilo")
  await expect(callbacks.persist(expired())).rejects.toBeInstanceOf(AuthStaleError)
  expect(await callbacks.exists()).toBe(false)
  await f.store.set("kilo", { type: "api", key: "replacement" })
  await expect(callbacks.persist(expired())).rejects.toBeInstanceOf(AuthStaleError)
  expect((await f.store.all()).kilo).toEqual({ type: "api", key: "replacement" })
})
