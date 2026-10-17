import { Effect, Layer, Schema, Context } from "effect" // kilocode_change
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock" // kilocode_change
import { Telemetry } from "@kilocode/kilo-telemetry" // kilocode_change
import { AuthStore } from "@/kilocode/auth/store" // kilocode_change

export const OAUTH_DUMMY_KEY = "kilo-oauth-dummy-key" // kilocode_change

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // kilocode_change start - capture sandbox policy at each operation, never at layer construction
    const fs = yield* AppFileSystem.Service
    const flock = yield* EffectFlock.Service
    const storage = AuthStore.make().pipe(
      Effect.provideService(AppFileSystem.Service, fs),
      Effect.provideService(EffectFlock.Service, flock),
    )
    // kilocode_change end
    const all = Effect.fn("Auth.all")(function* () {
      // kilocode_change start - bind effective reads to serialized disk authority
      const store = yield* storage
      return yield* Effect.tryPromise({ try: () => store.all(), catch: fail("Failed to read auth data") })
      // kilocode_change end
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[AuthStore.normalize(providerID)] // kilocode_change
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      // kilocode_change start - explicit writes always revoke prior refresh authority
      const store = yield* storage
      yield* Effect.tryPromise({ try: () => store.set(key, info), catch: fail("Failed to write auth data") })
      // kilocode_change end
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      // kilocode_change start - tombstones also advance on repeated logout
      const store = yield* storage
      yield* Effect.tryPromise({ try: () => store.remove(key), catch: fail("Failed to write auth data") })
      // kilocode_change end

      // kilocode_change start - Track logout and reset telemetry identity for Kilo
      if (key === "kilo") {
        yield* Effect.promise(() => Telemetry.updateIdentity(null))
      }
      Telemetry.trackAuthLogout(key)
      // kilocode_change end
    })

    return Service.of({ get, all, set, remove })
  }),
)

// kilocode_change start - both credential and lock IO use decorated Effect services
export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(AppFileSystem.defaultLayer, EffectFlock.defaultLayer)),
)
// kilocode_change end

export * as Auth from "."
