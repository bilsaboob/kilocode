import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import * as Sandbox from "@kilocode/sandbox"
import { Global } from "@opencode-ai/core/global"
import { Auth } from "../../src/auth"
import { AuthStorageError, AuthStore } from "../../src/kilocode/auth/store"
import { AuthIO } from "../../src/kilocode/auth/io"
import { refreshCodexAuth } from "../../src/kilocode/provider/codex-refresh"
import { CodexModels } from "../../src/kilocode/provider/codex-models"
import { organization } from "../../src/kilocode/auth/mutations"
import { expired, fixture, tokens } from "./fixture/auth-store"

const denied: Sandbox.Profile = {
  filesystem: { allowWrite: [], denyWrite: [], denyNames: [] },
  network: { mode: "deny", allowedHosts: [] },
  environment: { deny: [], set: {} },
}

async function files(dir: string): Promise<Record<string, unknown>> {
  return Object.fromEntries(
    await Promise.all(
      (await fs.readdir(dir)).sort().map(async (name) => {
        const file = path.join(dir, name)
        return [name, (await fs.stat(file)).isDirectory() ? await files(file) : await fs.readFile(file, "utf8")]
      }),
    ),
  )
}

for (const supplied of [false, true]) {
  test(`new caller context survives the bound snapshot await (${supplied ? "supplied store" : "credential owner"})`, async () => {
    await using f = await fixture(expired())
    const auth = (await f.store.all()).openai
    if (auth.type !== "oauth") throw new Error("Invalid fixture")
    const before = await files(f.dir)
    const requests: string[] = []
    let exchanges = 0
    const profile = {
      ...denied,
      filesystem: { ...denied.filesystem, allowWrite: [{ path: f.dir, kind: "literal" as const }] },
    }
    const result = await Effect.runPromise(
      Sandbox.withRunner(
        (_, request) => {
          // Only ensureDir on this existing fixture directory is permitted. The
          // decorated filesystem must reject every child mutation before this runner.
          expect(request).toMatchObject({ op: "makeDirectory", path: f.dir })
          requests.push(request.op)
          return Effect.succeed(undefined)
        },
        Sandbox.run(
          profile,
          Effect.tryPromise({
            try: () =>
              refreshCodexAuth({
                auth,
                ...(supplied && { store: f.store }),
                account: () => undefined,
                refresh: async () => {
                  exchanges++
                  return tokens()
                },
              }),
            catch: (error) => error,
          }),
        ),
      ).pipe(Effect.exit),
    )
    expect(result._tag).toBe("Failure")
    expect(exchanges).toBe(0)
    expect(requests).toEqual(["makeDirectory"])
    expect(await files(f.dir)).toEqual(before)
  })
}

for (const method of ["set", "remove", "check", "commit", "adopt", "exchange"] as const) {
  test(`direct ${method} pins a newer caller at entry even inside an older operation`, async () => {
    await using f = await fixture(expired())
    const auth = (await f.store.all()).openai
    const store = AuthStore.from(auth)
    const snapshot = await store.snapshot("openai")
    const before = await files(f.dir)
    const profile = {
      ...denied,
      filesystem: { ...denied.filesystem, allowWrite: [{ path: f.dir, kind: "literal" as const }] },
    }
    let exchanges = 0
    const invoke = (): Promise<unknown> => {
      switch (method) {
        case "set":
          return store.set("openai", { type: "api", key: "denied" })
        case "remove":
          return store.remove("openai")
        case "check":
          return store.check(snapshot)
        case "commit":
          return store.commit(snapshot, { ...expired(), access: "denied" })
        case "adopt":
          return store.adopt(snapshot)
        case "exchange":
          return store.exchange(snapshot, async () => {
            exchanges++
          })
      }
    }
    await store.run(async () => {
      const result = await Effect.runPromise(
        Sandbox.withRunner(
          (_, request) => {
            expect(request).toMatchObject({ op: "makeDirectory", path: f.dir })
            return Effect.succeed(undefined)
          },
          Sandbox.run(profile, Effect.tryPromise({ try: invoke, catch: (error) => error })),
        ).pipe(Effect.exit),
      )
      expect(result._tag).toBe("Failure")
      // A nested caller's policy must not leak back into the surrounding operation.
      expect(await store.check(snapshot, true)).toEqual(snapshot)
    })
    expect(exchanges).toBe(0)
    expect(await files(f.dir)).toEqual(before)
  })
}

test("a later explicit caller can replace the owner's older context at operation entry", async () => {
  await using f = await fixture(expired())
  const auth = (await f.store.all()).openai
  const expected = await f.store.snapshot("openai")
  const store = await Effect.runPromise(Sandbox.run(denied, AuthStore.make(f.file)).pipe(Effect.provide(AuthIO.layer)))
  const profile = {
    ...denied,
    filesystem: { ...denied.filesystem, allowWrite: [{ path: f.dir, kind: "literal" as const }] },
  }
  const requests: string[] = []
  const actual = await Effect.runPromise(
    Sandbox.withRunner(
      (_, request) => {
        expect(request).toMatchObject({ op: "makeDirectory", path: f.dir })
        requests.push(request.op)
        return Effect.succeed(undefined)
      },
      Sandbox.run(
        profile,
        Effect.tryPromise({
          try: () => store.snapshot("openai", auth),
          catch: (error) => error,
        }),
      ),
    ),
  )
  expect(actual).toEqual(expected)
  expect(requests).toEqual(["makeDirectory"])
})

for (const phase of ["receipt", "commit"] as const) {
  test(`renewal retains the newer policy through ${phase} publication`, async () => {
    await using f = await fixture(expired())
    const auth = (await f.store.all()).openai
    if (auth.type !== "oauth") throw new Error("Invalid fixture")
    const before = await files(f.dir)
    const locks = path.join(f.dir, "auth-locks")
    const original = await fs.readFile(f.file, "utf8")
    const profile = {
      ...denied,
      filesystem: {
        ...denied.filesystem,
        allowWrite: [
          { path: f.dir, kind: phase === "commit" ? ("subtree" as const) : ("literal" as const) },
          { path: locks, kind: "subtree" as const },
        ],
        denyWrite: phase === "commit" ? [{ path: f.file, kind: "literal" as const }] : [],
      },
    }
    let exchanges = 0
    const writes: string[] = []
    const result = await Effect.runPromise(
      Sandbox.withRunner(
        (_, request) =>
          Effect.promise(async () => {
            // The decorator must deny the protected destination before invoking this runner.
            if (request.op === "rename") {
              expect(phase).toBe("commit")
              expect(request.to).toBe(path.join(f.dir, "auth.revisions.json"))
              await fs.rename(request.from, request.to)
              return undefined
            }
            if (!("path" in request)) throw new Error("Unexpected fixture mutation")
            const file = request.path
            expect(file).not.toBe(f.file)
            expect(
              phase === "commit"
                ? file === f.dir || file.startsWith(`${f.dir}${path.sep}`)
                : file === f.dir || file === locks || file.startsWith(`${locks}${path.sep}`),
            ).toBe(true)
            switch (request.op) {
              case "makeDirectory":
                await fs.mkdir(file, request.options)
                break
              case "writeFileString":
                writes.push(file)
                await fs.writeFile(file, request.data, request.options)
                break
              case "remove":
                await fs.rm(file, request.options)
                break
              case "utimes":
                await fs.utimes(
                  file,
                  request.atime.type === "date" ? new Date(request.atime.value) : request.atime.value,
                  request.mtime.type === "date" ? new Date(request.mtime.value) : request.mtime.value,
                )
                break
              case "chmod":
                await fs.chmod(file, request.mode)
                break
              default:
                throw new Error("Unexpected fixture mutation")
            }
            return undefined
          }),
        Sandbox.run(
          profile,
          Effect.tryPromise({
            try: () =>
              refreshCodexAuth({
                auth,
                account: () => undefined,
                refresh: async () => {
                  exchanges++
                  await Promise.resolve()
                  return tokens()
                },
              }),
            catch: (error) => error,
          }),
        ),
      ).pipe(Effect.exit),
    )
    expect(result._tag).toBe("Failure")
    expect(exchanges).toBe(phase === "receipt" ? 0 : 1)
    expect(writes.length).toBeGreaterThan(0)
    if (phase === "receipt") expect(await files(f.dir)).toEqual(before)
    else {
      expect(await fs.readFile(f.file, "utf8")).toBe(original)
      await expect(f.store.snapshot("openai")).rejects.toBeInstanceOf(AuthStorageError)
      expect((await fs.readdir(f.dir)).filter((file) => file.endsWith(".tmp"))).toEqual([])
    }
  })
}

test("a coalesced waiter cannot adopt using its older permissive owner after await", async () => {
  await using f = await fixture(expired())
  const one = (await f.store.all()).openai
  const two = (await f.store.all()).openai
  if (one.type !== "oauth" || two.type !== "oauth") throw new Error("Invalid fixture")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let exchanges = 0
  const refresh = async () => {
    exchanges++
    entered.resolve()
    await release.promise
    return tokens()
  }
  const first = refreshCodexAuth({ auth: one, account: () => undefined, refresh })
  await entered.promise
  const joined = Promise.withResolvers<void>()
  const key = AuthStore.key
  using _barrier = spyOn(AuthStore, "key").mockImplementation((snapshot) => {
    // The pending lookup follows synchronously, before the test can release the
    // first exchange. This proves the second caller really joins that promise.
    joined.resolve()
    return key(snapshot)
  })
  const profile = {
    ...denied,
    filesystem: { ...denied.filesystem, allowWrite: [{ path: f.dir, kind: "literal" as const }] },
  }
  const second = Effect.runPromise(
    Sandbox.withRunner(
      (_, request) => {
        expect(request).toMatchObject({ op: "makeDirectory", path: f.dir })
        return Effect.succeed(undefined)
      },
      Sandbox.run(
        profile,
        Effect.tryPromise({
          try: () => refreshCodexAuth({ auth: two, account: () => undefined, refresh }),
          catch: (error) => error,
        }),
      ),
    ).pipe(Effect.exit),
  )
  await joined.promise
  release.resolve()
  expect((await first).access).toBe("next-access")
  expect((await second)._tag).toBe("Failure")
  expect(exchanges).toBe(1)
  expect(two).toEqual(expired())
  expect((await f.store.all()).openai).toMatchObject({ access: "next-access" })
})

test("organization changes pin a newer caller across the snapshot and commit awaits", async () => {
  await using f = await fixture(expired(), "kilo")
  const auth = (await f.store.all()).kilo
  if (auth.type !== "oauth") throw new Error("Invalid fixture")
  const before = await files(f.dir)
  const profile = {
    ...denied,
    filesystem: { ...denied.filesystem, allowWrite: [{ path: f.dir, kind: "literal" as const }] },
  }
  const result = await Effect.runPromise(
    Sandbox.withRunner(
      (_, request) => {
        expect(request).toMatchObject({ op: "makeDirectory", path: f.dir })
        return Effect.succeed(undefined)
      },
      Sandbox.run(profile, Effect.tryPromise({ try: () => organization(auth, "denied"), catch: (error) => error })),
    ).pipe(Effect.exit),
  )
  expect(result._tag).toBe("Failure")
  expect(await files(f.dir)).toEqual(before)
})

test("cached catalog origins do not bypass a newer caller's auth policy", async () => {
  await using f = await fixture({ ...expired(), expires: Date.now() + 120_000 })
  const auth = (await f.store.all()).openai
  if (auth.type !== "oauth") throw new Error("Invalid fixture")
  const before = await files(f.dir)
  const catalog = CodexModels.create()
  let requests = 0
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return Response.json({ models: [] })
    },
  })
  const input = {
    auth,
    endpoint: new URL("/responses", server.url).href,
    refresh: async () => {
      throw new Error("Unexpected renewal")
    },
  }
  expect(await catalog.load(input)).toBeInstanceOf(Map)
  const profile = {
    ...denied,
    filesystem: { ...denied.filesystem, allowWrite: [{ path: f.dir, kind: "literal" as const }] },
  }
  const result = await Effect.runPromise(
    Sandbox.withRunner(
      (_, request) => {
        expect(request).toMatchObject({ op: "makeDirectory", path: f.dir })
        return Effect.succeed(undefined)
      },
      Sandbox.run(profile, Effect.tryPromise({ try: () => catalog.load(input), catch: (error) => error })),
    ),
  )
  expect(result instanceof Map).toBe(false)
  expect(requests).toBe(1)
  expect(await files(f.dir)).toEqual(before)
})

test("Auth.Service preserves the caller's denied profile after layer construction", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("sandbox-fixture", { type: "api", key: "original" })
      const file = path.join(Global.Path.data, "auth.json")
      const sidecar = path.join(Global.Path.data, "auth.revisions.json")
      const before = yield* Effect.promise(() =>
        Promise.all([fs.readFile(file, "utf8"), fs.readFile(sidecar, "utf8"), fs.readdir(Global.Path.data)]),
      )
      for (const mutation of [
        auth.set("sandbox-fixture", { type: "api", key: "denied" }),
        auth.remove("sandbox-fixture"),
      ]) {
        const error = yield* Sandbox.run(denied, mutation).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Auth.AuthError)
      }
      const after = yield* Effect.promise(() =>
        Promise.all([fs.readFile(file, "utf8"), fs.readFile(sidecar, "utf8"), fs.readdir(Global.Path.data)]),
      )
      expect(after).toEqual(before)
      expect(yield* Effect.promise(() => fs.readdir(path.join(Global.Path.data, "auth-locks")))).toEqual([])
      yield* auth.remove("sandbox-fixture")
    }).pipe(Effect.provide(Auth.defaultLayer)),
  )
})

test("captured auth storage retains its denied context across Promise awaits", async () => {
  await using f = await fixture(expired())
  const before = await f.store.snapshot("openai")
  const store = await Effect.runPromise(Sandbox.run(denied, AuthStore.make(f.file)).pipe(Effect.provide(AuthIO.layer)))
  await Promise.resolve()
  await expect(store.set("openai", { ...expired(), access: "denied" })).rejects.toThrow()
  await expect(store.remove("openai")).rejects.toThrow()
  expect(await f.store.snapshot("openai")).toEqual(before)
  expect(await fs.readdir(f.dir)).toEqual(["auth-locks", "auth.json", "auth.revisions.json"])
})

test("background renewal cannot reuse a more permissive credential-read context", async () => {
  await using f = await fixture(expired())
  const auth = (await f.store.all()).openai
  if (auth.type !== "oauth") throw new Error("Invalid fixture")
  let calls = 0
  const result = await Effect.runPromise(
    Sandbox.run(
      denied,
      Effect.tryPromise({
        try: () =>
          refreshCodexAuth({
            auth,
            account: () => undefined,
            refresh: async () => {
              calls++
              return tokens()
            },
          }),
        catch: (error) => error,
      }),
    ).pipe(Effect.exit),
  )
  expect(result._tag).toBe("Failure")
  expect(calls).toBe(0)
  expect((await f.store.all()).openai).toEqual(expired())
})

test("auth lock directory mutations also pass through the decorated filesystem", async () => {
  await using f = await fixture(expired())
  const before = await f.store.snapshot("openai")
  const requests: string[] = []
  const profile = {
    ...denied,
    filesystem: { ...denied.filesystem, allowWrite: [{ path: f.dir, kind: "literal" as const }] },
  }
  const store = await Effect.runPromise(
    Sandbox.withRunner(
      (_, request) => {
        // The sole permitted request is ensureDir on an existing fixture directory.
        // All child mutations, including lock files, must be denied before the runner.
        expect(request).toMatchObject({ op: "makeDirectory", path: f.dir })
        requests.push(request.op)
        return Effect.succeed(undefined)
      },
      Sandbox.run(profile, AuthStore.make(f.file)),
    ).pipe(Effect.provide(AuthIO.layer)),
  )
  await expect(store.set("openai", { ...expired(), access: "denied" })).rejects.toThrow()
  expect(requests).toEqual(["makeDirectory"])
  expect(await f.store.snapshot("openai")).toEqual(before)
  expect(await fs.readdir(path.join(f.dir, "auth-locks"))).toEqual([])
})
