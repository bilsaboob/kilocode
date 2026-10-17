import { onCleanup } from "solid-js"

/** Auth routes invalidate providers; only refresh client state while this dialog is still mounted. */
export function useAuthRefresh(sync: { bootstrap(input?: { fatal?: boolean }): Promise<void> }) {
  let active = true
  onCleanup(() => {
    active = false
  })
  return {
    current: () => active,
    async refresh() {
      if (!active) return false
      await sync.bootstrap({ fatal: false }).catch((error) => {
        if (active) throw error
      })
      return active
    },
  }
}
