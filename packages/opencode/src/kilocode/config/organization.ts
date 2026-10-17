import { Effect } from "effect"
import { mergeDeep } from "remeda"
import type { Auth } from "@/auth"
import type { Config } from "@/config/config"
import { AuthStore } from "../auth/store"
import { KilocodeConfig } from "./config"

export namespace KilocodeOrganization {
  export function create(base: Config.Info, legacy: Config.Info["agent"], auth: Auth.Interface) {
    const config = { ...base, agent: mergeDeep(legacy ?? {}, base.agent ?? {}) }
    let cached: { key: string; config: Config.Info } | undefined
    let pending: { key: string; modes: ReturnType<typeof KilocodeConfig.loadOrganizationModes> } | undefined
    const current = Effect.gen(function* () {
      const kilo = (yield* auth.all().pipe(Effect.orDie)).kilo
      if (kilo?.type !== "oauth" || !kilo.access || !kilo.accountId) return undefined
      return { kilo, key: AuthStore.identity(kilo) }
    })

    const organization = Effect.gen(function* () {
      // Auth changes must not rerun config migrations, dependency installs or instance initialization.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = yield* current
        if (!before) {
          cached = undefined
          pending = undefined
          return config
        }
        if (cached?.key === before.key) return cached.config
        const flight =
          pending?.key === before.key
            ? pending
            : { key: before.key, modes: KilocodeConfig.loadOrganizationModes({ kilo: before.kilo }, before.key) }
        pending = flight
        const modes = yield* Effect.promise(() => flight.modes)
        const after = yield* current
        if (after?.key !== before.key) {
          if (pending === flight) pending = undefined
          continue
        }
        // Legacy modes < organization modes < explicit global/project/managed agents.
        const projected = {
          ...base,
          agent: mergeDeep(mergeDeep(legacy ?? {}, modes.agents), base.agent ?? {}),
        }
        cached = { key: before.key, config: projected }
        if (pending === flight) pending = undefined
        return projected
      }
      // Continuous account churn must never expose the previous organization's modes.
      return config
    })
    return { config, organization }
  }
}
