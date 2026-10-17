import type { AuthOAuthResult, Hooks } from "@kilocode/plugin"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Auth } from "@/auth"
import { InstanceState } from "@/effect/instance-state"
import { AuthStore } from "@/kilocode/auth/store" // kilocode_change
import { AuthAttempt } from "@/kilocode/auth/attempt" // kilocode_change
import { optionalOmitUndefined } from "@opencode-ai/core/schema"
import { Plugin } from "../plugin"
import { ProviderID } from "./schema"
import { Array as Arr, Effect, Layer, Record, Result, Context, Schema } from "effect"

// kilocode_change start
import { Telemetry } from "@kilocode/kilo-telemetry"
import { ModelCache } from "./model-cache"
// kilocode_change end

const When = Schema.Struct({
  key: Schema.String,
  op: Schema.Literals(["eq", "neq"]),
  value: Schema.String,
})

const TextPrompt = Schema.Struct({
  type: Schema.Literal("text"),
  key: Schema.String,
  message: Schema.String,
  placeholder: optionalOmitUndefined(Schema.String),
  when: optionalOmitUndefined(When),
})

const SelectOption = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  hint: optionalOmitUndefined(Schema.String),
})

const SelectPrompt = Schema.Struct({
  type: Schema.Literal("select"),
  key: Schema.String,
  message: Schema.String,
  options: Schema.Array(SelectOption),
  when: optionalOmitUndefined(When),
})

const Prompt = Schema.Union([TextPrompt, SelectPrompt])

export class Method extends Schema.Class<Method>("ProviderAuthMethod")({
  type: Schema.Literals(["oauth", "api"]),
  label: Schema.String,
  prompts: optionalOmitUndefined(Schema.Array(Prompt)),
}) {}

export const Methods = Schema.Record(Schema.String, Schema.Array(Method))
export type Methods = typeof Methods.Type

export class Authorization extends Schema.Class<Authorization>("ProviderAuthAuthorization")({
  attemptID: Schema.optional(Schema.String), // kilocode_change
  url: Schema.String,
  method: Schema.Literals(["auto", "code"]),
  instructions: Schema.String,
}) {}

export const AuthorizeInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({ description: "Prompt inputs" }),
})
export type AuthorizeInput = Schema.Schema.Type<typeof AuthorizeInput>

export const CallbackInput = Schema.Struct({
  attemptID: Schema.optional(Schema.String), // kilocode_change
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  code: Schema.optional(Schema.String).annotate({ description: "OAuth authorization code" }),
})
export type CallbackInput = Schema.Schema.Type<typeof CallbackInput>

export class OauthMissing extends Schema.TaggedErrorClass<OauthMissing>()("ProviderAuthOauthMissing", {
  providerID: ProviderID,
}) {}

export class OauthCodeMissing extends Schema.TaggedErrorClass<OauthCodeMissing>()("ProviderAuthOauthCodeMissing", {
  providerID: ProviderID,
}) {}

export class OauthCallbackFailed extends Schema.TaggedErrorClass<OauthCallbackFailed>()(
  "ProviderAuthOauthCallbackFailed",
  {},
) {}

export class ValidationFailed extends Schema.TaggedErrorClass<ValidationFailed>()("ProviderAuthValidationFailed", {
  field: Schema.String,
  message: Schema.String,
}) {}

export type Error = Auth.AuthError | OauthMissing | OauthCodeMissing | OauthCallbackFailed | ValidationFailed

type Hook = NonNullable<Hooks["auth"]>

export interface Interface {
  readonly methods: () => Effect.Effect<Methods>
  readonly authorize: (
    input: {
      providerID: ProviderID
    } & AuthorizeInput,
  ) => Effect.Effect<Authorization | undefined, Error>
  readonly callback: (input: { providerID: ProviderID } & CallbackInput) => Effect.Effect<void, Error>
}

interface State {
  hooks: Record<ProviderID, Hook>
  pending: Map<string, { ticket: AuthStore.Attempt; result?: AuthOAuthResult }> // kilocode_change
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderAuth") {}

export const use = serviceUse(Service)

// kilocode_change start
export const layer: Layer.Layer<Service, never, Auth.Service | Plugin.Service | ModelCache.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const cache = yield* ModelCache.Service
    // kilocode_change end
    const state = yield* InstanceState.make<State>(
      Effect.fn("ProviderAuth.state")(function* () {
        const plugins = yield* plugin.list()
        return {
          hooks: Record.fromEntries(
            Arr.filterMap(plugins, (x) =>
              x.auth?.provider !== undefined
                ? Result.succeed([ProviderID.make(x.auth.provider), x.auth] as const)
                : Result.failVoid,
            ),
          ),
          pending: new Map<string, { ticket: AuthStore.Attempt; result?: AuthOAuthResult }>(), // kilocode_change
        }
      }),
    )

    const decode = Schema.decodeUnknownSync(Methods)
    const methods = Effect.fn("ProviderAuth.methods")(function* () {
      const hooks = (yield* InstanceState.get(state)).hooks
      return decode(
        Record.map(hooks, (item) =>
          item.methods.map((method) => ({
            type: method.type,
            label: method.label,
            ...(method.prompts && {
              prompts: method.prompts.map((prompt) => {
                if (prompt.type === "select") {
                  return {
                    type: "select" as const,
                    key: prompt.key,
                    message: prompt.message,
                    options: prompt.options,
                    ...(prompt.when && { when: prompt.when }),
                  }
                }
                return {
                  type: "text" as const,
                  key: prompt.key,
                  message: prompt.message,
                  ...(prompt.placeholder && { placeholder: prompt.placeholder }),
                  ...(prompt.when && { when: prompt.when }),
                }
              }),
            }),
          })),
        ),
      )
    })

    const authorize = Effect.fn("ProviderAuth.authorize")(function* (
      input: { providerID: ProviderID } & AuthorizeInput,
    ) {
      const { hooks, pending } = yield* InstanceState.get(state)
      const method = hooks[input.providerID]?.methods[input.method] // kilocode_change
      if (!method) return yield* new OauthMissing({ providerID: input.providerID }) // kilocode_change
      if (method.type !== "oauth") return

      if (method.prompts && input.inputs) {
        for (const prompt of method.prompts) {
          if (prompt.type === "text" && prompt.validate && input.inputs[prompt.key] !== undefined) {
            const error = prompt.validate(input.inputs[prompt.key])
            if (error) return yield* new ValidationFailed({ field: prompt.key, message: error })
          }
        }
      }

      // kilocode_change start - newest-start authority precedes the first provider await
      const ticket = yield* Effect.tryPromise({
        try: () => AuthStore.disk.begin(input.providerID, input.method),
        catch: () => new OauthCallbackFailed({}),
      })
      pending.set(ticket.id, { ticket })
      const result = yield* Effect.promise(() => method.authorize(input.inputs))
      yield* Effect.tryPromise({ try: () => AuthStore.disk.attempt(ticket), catch: () => new OauthCallbackFailed({}) })
      pending.set(ticket.id, { ticket, result })
      // kilocode_change end
      return {
        attemptID: ticket.id, // kilocode_change
        url: result.url,
        method: result.method,
        instructions: result.instructions,
      }
    })

    const callback = Effect.fn("ProviderAuth.callback")(function* (input: { providerID: ProviderID } & CallbackInput) {
      const pending = (yield* InstanceState.get(state)).pending
      // kilocode_change start - legacy callbacks cannot select a superseded latest attempt
      const entry = input.attemptID
        ? pending.get(input.attemptID)
        : [...pending.values()].find(
            (entry) => entry.ticket.snapshot.provider === input.providerID && entry.ticket.revision === 1,
          )
      if (
        !entry ||
        entry.ticket.snapshot.provider !== input.providerID ||
        entry.ticket.method !== input.method ||
        !entry.result
      )
        return yield* new OauthMissing({ providerID: input.providerID })
      const match = entry.result
      // kilocode_change end
      if (match.method === "code" && !input.code) {
        return yield* new OauthCodeMissing({ providerID: input.providerID })
      }

      // kilocode_change start - consume before exchange and persist only under the original authority
      pending.delete(entry.ticket.id)
      const saved = yield* Effect.tryPromise({
        try: (signal) =>
          AuthAttempt.invoke({
            ticket: entry.ticket,
            signal,
            callback: () => (match.method === "code" ? match.callback(input.code!) : match.callback()),
          }),
        catch: () => new OauthCallbackFailed({}),
      })
      // kilocode_change end

      // kilocode_change start - Update telemetry identity on Kilo auth
      if (input.providerID === "kilo") {
        const info = yield* auth.get(input.providerID)
        if (info) {
          const token = info.type === "oauth" ? info.access : info.type === "api" ? info.key : null
          const accountId = info.type === "oauth" ? info.accountId : undefined
          yield* Effect.promise(() => Telemetry.updateIdentity(token, accountId))
        }
      }
      Telemetry.trackAuthSuccess(input.providerID)
      yield* cache.clear(saved)
      // kilocode_change end
    })

    return Service.of({ methods, authorize, callback })
  }),
)

// kilocode_change start
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(ModelCache.defaultLayer),
  ),
)
// kilocode_change end

export * as ProviderAuth from "./auth"
