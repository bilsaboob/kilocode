import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { CodexAuthExpiredError, refreshCodexAuth } from "../../src/kilocode/provider/codex-refresh"
import { AuthSourceError, AuthStaleError, AuthStorageError } from "../../src/kilocode/auth/store"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID } from "../../src/provider/schema"
import { expired, fixture, tokens, fault } from "./fixture/auth-store"

describe("Codex auth refresh authority", () => {
  test("serializes auth authority failures as nonretryable ProviderAuthError without tokens", () => {
    for (const error of [
      new CodexAuthExpiredError(),
      new AuthSourceError(),
      new AuthStaleError(),
      new AuthStorageError(),
    ]) {
      const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") })
      expect(result).toMatchObject({
        name: "ProviderAuthError",
        data: { providerID: "openai", message: error.message },
      })
      expect(JSON.stringify(result)).not.toContain("old-refresh")
    }
  })

  test("coalesces concurrent refreshes and persists rotated tokens", async () => {
    await using f = await fixture(expired())
    const auth = expired()
    const copy = expired()
    await Promise.all([f.store.snapshot("openai", auth), f.store.snapshot("openai", copy)])
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const input = {
      store: f.store,
      auth,
      account: () => undefined,
      refresh: async () => {
        calls++
        entered.resolve()
        await release.promise
        return tokens()
      },
    }
    const first = refreshCodexAuth(input)
    await entered.promise
    const second = refreshCodexAuth({ ...input, auth: copy })
    release.resolve()
    const results = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(results.map((a) => a.access)).toEqual(["next-access", "next-access"])
    expect((await f.store.all()).openai).toEqual(results[0])
  })

  for (const change of ["logout", "api", "account", "identical", "logout-login"] as const) {
    test(`delayed renewal cannot overwrite ${change}`, async () => {
      await using f = await fixture(expired())
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const auth = (await f.store.all()).openai
      if (auth.type !== "oauth") throw new Error("Fixture is not OAuth")
      const result = refreshCodexAuth({
        store: f.store,
        auth,
        account: () => undefined,
        refresh: async () => {
          entered.resolve()
          await release.promise
          return tokens()
        },
      }).catch((err) => err)
      await entered.promise
      if (change === "logout" || change === "logout-login") await f.store.remove("openai")
      if (change === "api") await f.store.set("openai", { type: "api", key: "replacement" })
      if (change === "account") await f.store.set("openai", { ...expired(), accountId: "other-account" })
      if (change === "identical" || change === "logout-login") await f.store.set("openai", expired())
      const expected = await f.store.all()
      release.resolve()
      expect(await result).toBeInstanceOf(AuthStaleError)
      expect(await f.store.all()).toEqual(expected)
      expect(auth).toEqual(expired())
    })
  }

  for (const change of ["generation", "revision"] as const) {
    test(`same-token new ${change} cannot join old pending refresh`, async () => {
      await using f = await fixture(expired())
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let calls = 0
      const refresh = async () => {
        if (++calls === 1) {
          entered.resolve()
          await release.promise
        }
        return tokens()
      }
      const input = { store: f.store, auth: expired(), account: () => undefined, refresh }
      const first = refreshCodexAuth(input).catch((err) => err)
      await entered.promise
      if (change === "generation") await f.store.set("openai", expired())
      else await f.store.commit(await f.store.snapshot("openai"), expired())
      const second = refreshCodexAuth({ ...input, auth: (await f.store.all()).openai as ReturnType<typeof expired> })
      release.resolve()
      expect(await first).toBeInstanceOf(AuthStaleError)
      expect((await second).access).toBe("next-access")
      expect(calls).toBe(2)
    })
  }

  for (const change of ["generation", "revision", "account"] as const) {
    test(`401 fallback respects ${change} authority`, async () => {
      await using f = await fixture(expired())
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const result = refreshCodexAuth({
        store: f.store,
        auth: expired(),
        account: () => undefined,
        refresh: async () => {
          entered.resolve()
          await release.promise
          throw new Error("Token refresh failed: 401")
        },
      }).catch((err) => err)
      await entered.promise
      const next = {
        ...expired(),
        access: "same-token-new-revision",
        expires: Date.now() + 60_000,
        ...(change === "account" && { accountId: "other-account" }),
      }
      if (change === "generation") await f.store.set("openai", next)
      else await f.store.commit(await f.store.snapshot("openai"), next)
      release.resolve()
      if (change !== "revision") expect(await result).toBeInstanceOf(AuthStaleError)
      else expect(await result).toEqual(next)
    })
  }

  test("missing or API auth before exchange makes zero requests", async () => {
    await using f = await fixture()
    let calls = 0
    const input = {
      store: f.store,
      auth: expired(),
      account: () => undefined,
      refresh: async () => {
        calls++
        return tokens()
      },
    }
    await expect(refreshCodexAuth(input)).rejects.toBeInstanceOf(AuthStaleError)
    await f.store.set("openai", { type: "api", key: "replacement" })
    await expect(refreshCodexAuth(input)).rejects.toBeInstanceOf(AuthStaleError)
    expect(calls).toBe(0)
  })

  test("a changed same-generation account cannot be adopted before exchange", async () => {
    await using f = await fixture(expired())
    const auth = (await f.store.all()).openai
    if (auth.type !== "oauth") throw new Error("Invalid fixture")
    await f.store.commit(await f.store.snapshot("openai"), {
      ...expired(),
      accountId: "other-account",
      expires: Date.now() + 60_000,
    })
    let calls = 0
    await expect(
      refreshCodexAuth({
        store: f.store,
        auth,
        account: () => undefined,
        refresh: async () => {
          calls++
          return tokens()
        },
      }),
    ).rejects.toBeInstanceOf(AuthStaleError)
    expect(calls).toBe(0)
  })

  test("storage failure advances authority but exposes no new credentials", async () => {
    await using f = await fixture(expired())
    const before = await f.store.snapshot("openai")
    using broken = await fault(f.file, f.file, "rename")
    const auth = expired()
    await expect(
      refreshCodexAuth({ store: broken.store, auth, account: () => undefined, refresh: async () => tokens() }),
    ).rejects.toBeInstanceOf(AuthStorageError)
    expect(auth).toEqual(expired())
    expect(JSON.parse(await fs.readFile(f.file, "utf8")).openai).toEqual(expired())
    const meta = JSON.parse(await fs.readFile(`${f.dir}/auth.revisions.json`, "utf8"))
    expect(meta.providers.openai.tokenRevision).toBe(before.tokenRevision + 1)
    await expect(f.store.snapshot("openai")).rejects.toBeInstanceOf(AuthStorageError)
    broken[Symbol.dispose]()
    await f.store.set("openai", expired())
    await expect(f.store.check(before)).rejects.toBeInstanceOf(AuthStaleError)
  })

  test("environment-backed renewal fails before exchange", async () => {
    await using f = await fixture(expired())
    const saved = process.env.KILO_AUTH_CONTENT
    let calls = 0
    try {
      process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: expired() })
      await expect(
        refreshCodexAuth({
          store: f.store,
          auth: expired(),
          account: () => undefined,
          refresh: async () => {
            calls++
            return tokens()
          },
        }),
      ).rejects.toBeInstanceOf(AuthSourceError)
      expect(calls).toBe(0)
      expect(JSON.parse(await fs.readFile(f.file, "utf8")).openai).toEqual(expired())
    } finally {
      if (saved === undefined) delete process.env.KILO_AUTH_CONTENT
      else process.env.KILO_AUTH_CONTENT = saved
    }
  })

  test("401 without a newer revision requires sign-in", async () => {
    await using f = await fixture(expired())
    await expect(
      refreshCodexAuth({
        store: f.store,
        auth: expired(),
        account: () => undefined,
        refresh: async () => {
          throw new Error("Token refresh failed: 401")
        },
      }),
    ).rejects.toBeInstanceOf(CodexAuthExpiredError)
  })

  test("transient failures and aborts release pending entries and exchange locks", async () => {
    await using f = await fixture(expired())
    const input = { store: f.store, auth: expired(), account: () => undefined }
    await expect(
      refreshCodexAuth({
        ...input,
        refresh: async () => {
          throw new Error("offline")
        },
      }),
    ).rejects.toThrow("offline")
    await expect(
      refreshCodexAuth({
        ...input,
        timeout: 1,
        refresh: async (_, signal) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          }),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
    expect((await refreshCodexAuth({ ...input, refresh: async () => tokens() })).access).toBe("next-access")
  })

  for (const method of ["write", "rename"] as const) {
    test(`sidecar ${method} failure accepts no result and leaves credentials and authority unchanged`, async () => {
      await using f = await fixture(expired())
      const before = await f.store.snapshot("openai")
      using failure = await fault(f.file, path.join(f.dir, "auth.revisions.json"), method)
      await expect(
        refreshCodexAuth({
          store: failure.store,
          auth: expired(),
          account: () => undefined,
          refresh: async () => tokens(),
        }),
      ).rejects.toBeInstanceOf(AuthStorageError)
      expect(await f.store.snapshot("openai")).toEqual(before)
      expect((await f.store.all()).openai).toEqual(expired())
      expect((await fs.readdir(f.dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    })
  }

  for (const change of ["logout-login", "revision"] as const) {
    test(`every final waiter rechecks authority after commit and before adoption: ${change}`, async () => {
      await using f = await fixture(expired())
      const one = expired()
      const two = expired()
      await Promise.all([f.store.snapshot("openai", one), f.store.snapshot("openai", two)])
      const waiting = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const adopt = f.store.adopt.bind(f.store)
      let waiters = 0
      using _barrier = spyOn(f.store, "adopt").mockImplementation(async (snapshot) => {
        if (++waiters === 2) waiting.resolve()
        await release.promise
        return adopt(snapshot)
      })
      const input = { store: f.store, account: () => undefined, refresh: async () => tokens() }
      const results = [refreshCodexAuth({ ...input, auth: one }), refreshCodexAuth({ ...input, auth: two })].map(
        (result) => result.catch((error) => error),
      )
      await waiting.promise
      const committed = await f.store.snapshot("openai")
      expect(committed.value?.type === "oauth" && committed.value.access).toBe("next-access")
      if (change === "logout-login") {
        await f.store.remove("openai")
        await f.store.set("openai", expired())
      } else {
        await f.store.commit(committed, { ...expired(), access: "newer", expires: Date.now() + 60_000 })
      }
      const expected = await f.store.all()
      release.resolve()
      for (const result of results) expect(await result).toBeInstanceOf(AuthStaleError)
      expect(await f.store.all()).toEqual(expected)
      expect([one, two]).toEqual([expired(), expired()])
    })
  }

  test("an outstanding disk renewal fails closed when the effective source becomes env", async () => {
    await using f = await fixture(expired())
    const before = await f.store.snapshot("openai")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const result = refreshCodexAuth({
      store: f.store,
      auth: expired(),
      account: () => undefined,
      refresh: async () => {
        entered.resolve()
        await release.promise
        return tokens()
      },
    }).catch((error) => error)
    await entered.promise
    const saved = process.env.KILO_AUTH_CONTENT
    try {
      process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { ...expired(), access: "env" } })
      release.resolve()
      expect(await result).toBeInstanceOf(AuthSourceError)
    } finally {
      if (saved === undefined) delete process.env.KILO_AUTH_CONTENT
      else process.env.KILO_AUTH_CONTENT = saved
    }
    expect(await f.store.snapshot("openai")).toEqual(before)
  })
})
