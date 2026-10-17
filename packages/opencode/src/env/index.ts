import { Context, Effect, Layer, ScopedCache } from "effect" // kilocode_change
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { InstanceState } from "@/effect/instance-state"

type State = Record<string, string | undefined>

export interface Interface {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  readonly all: (directory?: string) => Effect.Effect<State> // kilocode_change - explicit directory reads never initialize state
  readonly set: (key: string, value: string) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Env") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(Effect.fn("Env.state")(() => Effect.succeed({ ...process.env })))

    const get = Effect.fn("Env.get")((key: string) => InstanceState.use(state, (env) => env[key]))
    // kilocode_change start - passive directory observations do not require or construct an instance
    const all = Effect.fn("Env.all")(function* (directory?: string) {
      if (directory === undefined) return yield* InstanceState.get(state)
      const entries = yield* ScopedCache.entries(state.cache)
      return entries.find(([key]) => key === directory)?.[1] ?? { ...process.env }
    })
    // kilocode_change end
    const set = Effect.fn("Env.set")(function* (key: string, value: string) {
      const env = yield* InstanceState.get(state)
      env[key] = value
    })
    const remove = Effect.fn("Env.remove")(function* (key: string) {
      const env = yield* InstanceState.get(state)
      delete env[key]
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer

export * as Env from "."
