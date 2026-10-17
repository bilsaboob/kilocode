import { ModelCache } from "@/provider/model-cache"
import { Effect } from "effect"

export const afterProviderAuthCallback = Effect.fn("KiloServer.afterProviderAuthCallback")(function* (
  providerID: string,
) {
  const cache = yield* ModelCache.Service
  yield* cache.clear(providerID)
})

export const invalidateAfterProviderAuthChange = Effect.fn("KiloServer.invalidateAfterProviderAuthChange")(function* (
  providerID: string,
) {
  const cache = yield* ModelCache.Service
  yield* cache.clear(providerID)
})
