import { expect, test } from "bun:test"
import { AuthAttempt } from "../../src/kilocode/auth/attempt"
import { AuthStaleError } from "../../src/kilocode/auth/store"
import { expired, fixture } from "./fixture/auth-store"

test("starting authorization changes only attempt authority, newest start wins, and callbacks are one-shot", async () => {
  await using f = await fixture(expired())
  const before = await f.store.snapshot("openai")
  const first = await f.store.begin("openai", 0)
  const second = await f.store.begin("openai", 1)
  const current = await f.store.snapshot("openai")
  expect(current.loginGeneration).toBe(before.loginGeneration)
  expect(current.tokenRevision).toBe(before.tokenRevision)
  let calls = 0
  const callback = async () => {
    calls++
    return { type: "success" as const, key: "new-key" }
  }
  await expect(AuthAttempt.invoke({ ticket: first, store: f.store, callback })).rejects.toBeInstanceOf(AuthStaleError)
  await expect(
    AuthAttempt.invoke({ ticket: { ...second, method: 0 }, store: f.store, callback }),
  ).rejects.toBeInstanceOf(AuthStaleError)
  await AuthAttempt.invoke({ ticket: second, store: f.store, callback })
  await expect(AuthAttempt.invoke({ ticket: second, store: f.store, callback })).rejects.toBeInstanceOf(AuthStaleError)
  expect(calls).toBe(1)
  expect((await f.store.all()).openai).toEqual({ type: "api", key: "new-key" })
})

for (const change of ["logout", "relogin", "new-attempt", "renewal"] as const) {
  test(`delayed callback is conditional after ${change}`, async () => {
    await using f = await fixture(expired())
    const ticket = await f.store.begin("openai", 0)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pending = AuthAttempt.invoke({
      ticket,
      store: f.store,
      callback: async () => {
        entered.resolve()
        await release.promise
        return { type: "success", access: "new-access", refresh: "new-refresh", expires: Date.now() + 3600_000 }
      },
    }).catch((error) => error)
    await entered.promise
    if (change === "logout" || change === "relogin") await f.store.remove("openai")
    if (change === "relogin") await f.store.set("openai", expired())
    if (change === "new-attempt") await f.store.begin("openai", 0)
    if (change === "renewal")
      await f.store.commit(await f.store.snapshot("openai"), { ...expired(), access: "rotated" })
    const expected = await f.store.all()
    release.resolve()
    if (change === "renewal") {
      expect(await pending).toBe("openai")
      expect((await f.store.snapshot("openai")).loginGeneration).not.toBe(ticket.snapshot.loginGeneration)
    } else {
      expect(await pending).toBeInstanceOf(AuthStaleError)
      expect(await f.store.all()).toEqual(expected)
    }
  })
}

test("CLI API-key callback fallbacks and redirects use the same conditional attempt boundary", async () => {
  await using f = await fixture({ type: "api", key: "old-target" }, "target")
  const first = await f.store.begin("source", 2)
  await AuthAttempt.invoke({
    ticket: first,
    store: f.store,
    fallback: { key: "entered", metadata: { host: "fixture" } },
    callback: async () => ({ type: "success", provider: "target", metadata: { validated: "yes" } }),
  })
  expect((await f.store.all()).target).toEqual({
    type: "api",
    key: "entered",
    metadata: { host: "fixture", validated: "yes" },
  })
  const second = await f.store.begin("source", 2)
  await f.store.remove("target")
  await expect(
    AuthAttempt.invoke({
      ticket: second,
      store: f.store,
      callback: async () => ({ type: "success", provider: "target", key: "stale" }),
    }),
  ).rejects.toBeInstanceOf(AuthStaleError)
  expect((await f.store.all()).target).toBeUndefined()
})

test("Stop during authorization preserves the existing login and does not publish callback credentials", async () => {
  await using f = await fixture(expired())
  const ticket = await f.store.begin("openai", 0)
  const before = await f.store.snapshot("openai")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const result = AuthAttempt.invoke({
    ticket,
    store: f.store,
    signal: controller.signal,
    callback: async () => {
      entered.resolve()
      await release.promise
      return { type: "success", key: "must-not-be-accepted" }
    },
  }).catch((error) => error)
  await entered.promise
  controller.abort(new DOMException("Stopped", "AbortError"))
  release.resolve()
  expect(await result).toBe(controller.signal.reason)
  const after = await f.store.snapshot("openai")
  expect(after.loginGeneration).toBe(before.loginGeneration)
  expect(after.tokenRevision).toBe(before.tokenRevision)
  expect(after.value).toEqual(expired())
})
