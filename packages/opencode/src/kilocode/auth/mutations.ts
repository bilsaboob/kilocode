import type { Auth } from "@/auth"
import { AuthSourceError, AuthStaleError, AuthStore } from "./store"

export async function organization(info: Auth.Oauth, id?: string, store = AuthStore.from(info)) {
  return store.run(async () =>
    store.commit(
      await store.snapshot("kilo", info),
      {
        type: "oauth",
        refresh: info.refresh,
        access: info.access,
        expires: info.expires,
        ...(id && { accountId: id }),
      },
      true,
    ),
  )
}

export function legacy(store: ReturnType<typeof AuthStore.create>) {
  let snapshot: AuthStore.Snapshot | undefined
  return {
    async exists() {
      snapshot = await store.snapshot("kilo").catch((err) => {
        if (err instanceof AuthSourceError) return undefined
        throw err
      })
      return !snapshot || snapshot.value !== undefined
    },
    async persist(auth: Auth.Info) {
      if (!snapshot) throw new AuthStaleError()
      await store.commit(snapshot, auth, true)
    },
  }
}
