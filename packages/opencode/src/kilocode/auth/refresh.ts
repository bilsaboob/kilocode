import type { Auth } from "@/auth"
import type { Flock } from "@opencode-ai/core/util/flock"
import { AuthStaleError, AuthStore } from "./store"
import { KiloRuntime } from "../runtime/control"

const pending = new Map<string, Promise<AuthStore.Snapshot>>()

export async function refreshOAuth(input: {
  provider: string
  auth: Auth.Oauth
  store?: ReturnType<typeof AuthStore.create>
  expired: (auth: Auth.Oauth) => boolean
  refresh: (auth: Auth.Oauth) => Promise<Auth.Oauth>
  rejected?: (err: unknown) => Error | undefined
  lock?: Flock.Options
}) {
  const store = input.store ?? AuthStore.from(input.auth)
  return KiloRuntime.track(() =>
    store.run(async () => {
      const expected = await store.snapshot(input.provider, input.auth)
      const key = AuthStore.key(expected)
      const existing = pending.get(key)
      const promise =
        existing ??
        store
          .exchange(
            expected,
            async () => {
              const current = await store.check(expected)
              if (current.value?.type !== "oauth") throw new AuthStaleError()
              if (!input.expired(current.value)) return current
              const value = await input.refresh(current.value).catch(async (err: unknown) => {
                const failure = input.rejected?.(err)
                if (!failure) throw err
                const latest = await store.check(current)
                if (
                  latest.tokenRevision !== current.tokenRevision &&
                  latest.value?.type === "oauth" &&
                  !input.expired(latest.value)
                )
                  return latest
                throw failure
              })
              if ("source" in value) return value
              return store.commit(current, value)
            },
            input.lock,
          )
          .finally(() => pending.delete(key))
      if (!existing) pending.set(key, promise)
      const next = await store.adopt(await promise)
      if (next.type !== "oauth") throw new AuthStaleError()
      return next
    }),
  )
}
