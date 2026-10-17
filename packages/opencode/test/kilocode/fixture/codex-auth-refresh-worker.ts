import fs from "node:fs/promises"
import { readSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

const input = z
  .object({
    root: z.string(),
    state: z.string(),
    role: z.enum(["refresh", "hold", "set", "service", "logout", "relogin"]),
    stale: z.boolean().optional(),
    provider: z.string().default("openai"),
    url: z.string().optional(),
  })
  .parse(JSON.parse(process.argv[2]))

delete process.env.KILO_AUTH_CONTENT
process.env.XDG_DATA_HOME = path.join(input.root, "share")
process.env.XDG_CACHE_HOME = path.join(input.root, input.state, "cache")
process.env.XDG_CONFIG_HOME = path.join(input.root, input.state, "config")
process.env.XDG_STATE_HOME = path.join(input.root, input.state, "state")
process.env.KILO_TEST_HOME = path.join(input.root, input.state, "home")
process.env.KILO_DB = ":memory:"

const { AuthStore, AuthStaleError } = await import("../../../src/kilocode/auth/store")
const { Global } = await import("@opencode-ai/core/global")
const { Flock } = await import("@opencode-ai/core/util/flock")
const file = path.join(Global.Path.data, "auth.json")
const store = AuthStore.create(file, {
  onWait: () => {
    process.send?.("waiting")
  },
})
const auth = input.role === "refresh" ? (await store.all()).openai : undefined
const start = new Promise<void>((resolve) => process.once("message", () => resolve()))
process.send?.("ready")
await start

try {
  if (input.role === "hold") {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await using _lock = await Flock.acquire("auth-store", {
      dir: path.join(path.dirname(file), "auth-locks"),
      reclaim: false,
      staleMs: 10,
    })
    await new Promise<void>((resolve) => process.send?.("held", () => resolve()))
    // Block the event loop (and heartbeat) until the parent releases stdin.
    readSync(0, Buffer.alloc(1), 0, 1, null)
  }
  if (input.role === "set") await store.set(input.provider, { type: "api", key: input.provider })
  if (input.role === "service") {
    const { Effect } = await import("effect")
    const { Auth } = await import("../../../src/auth")
    await Effect.runPromise(
      Auth.Service.use((service) => service.set(input.provider, { type: "api", key: input.provider })).pipe(
        Effect.provide(Auth.defaultLayer),
      ),
    )
  }
  if (input.role === "logout" || input.role === "relogin") {
    const { Effect } = await import("effect")
    const { Auth } = await import("../../../src/auth")
    await Effect.runPromise(
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          yield* auth.remove("openai")
          if (input.role === "relogin")
            yield* auth.set("openai", {
              type: "oauth",
              access: "old-access",
              refresh: "old-refresh",
              expires: 0,
              accountId: "test-account",
            })
        }),
      ).pipe(Effect.provide(Auth.defaultLayer)),
    )
  }
  if (input.role === "refresh") {
    if (auth?.type !== "oauth" || !input.url) throw new Error("Invalid refresh fixture")
    const { refreshCodexAuth } = await import("../../../src/kilocode/provider/codex-refresh")
    const next = await refreshCodexAuth({
      store,
      auth,
      account: () => undefined,
      lock: {
        staleMs: 10,
        onWait: () => {
          process.send?.("waiting")
        },
      },
      refresh: async (token, signal) => {
        const response = await fetch(input.url!, {
          method: "POST",
          signal,
          body: new URLSearchParams({ refresh_token: token }),
        })
        if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
        return z
          .object({ id_token: z.string(), access_token: z.string(), refresh_token: z.string(), expires_in: z.number() })
          .parse(await response.json())
      },
    }).catch((error) => {
      if (input.stale && error instanceof AuthStaleError) {
        process.send?.("stale")
        return undefined
      }
      throw error
    })
    if (input.stale ? next !== undefined : next?.access !== "next-access") throw new Error("Unexpected fixture result")
  }
  process.send?.("done")
} finally {
  process.disconnect?.()
}
