import { Cause, Effect } from "effect"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { HEADER_ORGANIZATIONID } from "@kilocode/kilo-gateway"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { Bus } from "@/bus"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { AuthStore } from "./store"
import { AuthSource } from "./source"
import { AuthOutcome } from "./outcome"
import { AuthRequest } from "./request"
import * as AuthCatalog from "./catalog"

export namespace KiloAuth {
  export const Snapshot = AuthSource.Snapshot
  export type Snapshot = AuthSource.Snapshot
  export type Bindings = Readonly<Record<string, Snapshot>>
  export const seal = AuthSource.seal
  export function seals(input: Bindings | undefined) {
    return input && Object.freeze(Object.fromEntries(Object.entries(input).map(([key, value]) => [key, seal(value)])))
  }
  const key = (model: { providerID: string; modelID?: string; id?: string }) =>
    JSON.stringify([model.providerID, model.modelID ?? model.id])
  export function selected(
    input: { authAuthority?: Snapshot; authAuthorities?: Bindings },
    model: { providerID: string; modelID?: string; id?: string },
  ) {
    const value =
      input.authAuthorities?.[key(model)] ??
      input.authAuthorities?.[model.providerID] ??
      (input.authAuthority?.providerID === model.providerID ? input.authAuthority : undefined)
    return value && seal(value)
  }
  export const Readiness = AuthSource.Readiness
  export type Readiness = typeof Readiness.Type
  export const Event = AuthSource.Event
  const observed = new Map<string, Readiness>()
  const views = new Map<string, Pick<Provider.Info, "id" | "env" | "options" | "source" | "models">>()

  const resolve = Effect.fn("KiloAuth.resolve")(function* (
    model: { providerID: string; modelID?: string; id?: string },
    passive = false,
    expected?: Snapshot,
    directory?: string,
  ) {
    const config = yield* Config.Service
    const env = yield* Env.Service
    const cfg = yield* passive ? (config.peek?.(directory) ?? Effect.succeed(undefined)) : config.get()
    if (!cfg) return yield* Effect.fail(new AuthOutcome.Failure("unverifiable", model.providerID))
    const values = yield* env.all(passive ? directory : undefined)
    const providerID = ProviderID.make(model.providerID)
    const modelID = model.modelID ?? model.id
    const configured = cfg.provider?.[providerID]
    const names =
      passive && configured?.env === undefined
        ? yield* Effect.promise(() => AuthCatalog.environment(providerID))
        : undefined
    const cached = expected && views.get(expected.authority)
    const provider =
      passive || expected
        ? {
            id: providerID,
            source: cached?.source ?? ("config" as const),
            env: [...(configured?.env ?? (expected ? AuthSource.names(expected) : (names ?? [])))],
            options: cached?.options ?? configured?.options ?? {},
            models: cached?.models ?? {},
          }
        : yield* Provider.Service.use((service) => service.getProvider(providerID))
    if (!provider) return yield* Effect.fail(new AuthOutcome.Failure("unverifiable"))
    const details = {
      headers: modelID
        ? (configured?.models?.[modelID]?.headers ??
          ("models" in provider ? provider.models[modelID]?.headers : undefined) ??
          {})
        : {},
    }
    const selected = yield* Effect.tryPromise({
      try: () =>
        AuthStore.disk.run(() =>
          AuthSource.select({ provider, model: details, cfg, env: values, store: AuthStore.disk, passive }),
        ),
      catch: (error) => AuthOutcome.known(error) ?? new AuthOutcome.Failure("storage-unavailable"),
    })
    if (passive && names === undefined && configured?.env === undefined && selected.snapshot.source === "none")
      return { ...selected, reason: "unverifiable" as const }
    if (!passive && !expected) {
      if (views.size >= 512) views.delete(views.keys().next().value!)
      views.set(selected.snapshot.authority, provider)
    }
    return selected
  })

  export const capture = Effect.fn("KiloAuth.capture")(function* (model: { providerID: string; modelID: string }) {
    return Object.freeze((yield* resolve(model)).snapshot)
  })

  export const admit = Effect.fn("KiloAuth.admit")(function* (model: { providerID: string; modelID: string }) {
    const primary = yield* capture(model)
    const providers = yield* Provider.Service.use((service) => service.list())
    const cfg = yield* Config.Service.use((service) => service.get())
    const env = yield* Env.Service.use((service) => service.all())
    const bindings = yield* Effect.promise(() =>
      AuthStore.disk.run(async () => {
        const values: Record<string, Snapshot> = Object.create(null)
        for (const provider of Object.values(providers)) {
          const configured = cfg.provider?.[provider.id]?.models ?? {}
          const model = Object.fromEntries(
            Object.keys({ ...provider.models, ...configured }).map((id) => [
              id,
              {
                headers: configured[id]?.headers ?? provider.models[id]?.headers ?? {},
              },
            ]),
          )
          const rows = [
            [provider.id, undefined],
            ...Object.entries(model)
              .filter(([, value]) =>
                Object.keys(value?.headers ?? {}).some(
                  (name) =>
                    AuthSource.fields.some((field) => field === name.toLowerCase()) ||
                    (provider.id === "kilo" && name.toLowerCase() === HEADER_ORGANIZATIONID.toLowerCase()),
                ),
              )
              .map(([id, value]) => [key({ providerID: provider.id, id }), value] as const),
          ] as const
          for (const [id, model] of rows) {
            // Unavailable secondary owners are not silently admitted later.
            const selected = await AuthSource.select({
              provider,
              model: model ? { headers: model.headers ?? {} } : undefined,
              cfg,
              env,
              store: AuthStore.disk,
            }).catch((error) => {
              if (AuthOutcome.control(error)) throw error
              return undefined
            })
            if (!selected) continue
            values[id] = selected.snapshot
            views.set(selected.snapshot.authority, provider)
          }
        }
        values[key(model)] = primary
        return Object.freeze(values)
      }),
    )
    return { authority: primary, authorities: bindings }
  })

  export function same(expected: Snapshot | undefined, current: Snapshot | undefined) {
    if (!expected || !current) throw new AuthOutcome.Failure("unverifiable")
    AuthSource.assert(expected, current)
    if (expected.env !== current.env || expected.managed !== current.managed)
      throw new AuthOutcome.Failure("authority-changed")
  }

  export const check = Effect.fn("KiloAuth.check")(function* (
    snapshot: Snapshot | undefined,
    model: { providerID: string; modelID?: string; id?: string },
  ) {
    const current = yield* resolve(model, false, snapshot)
    yield* Effect.try({
      try: () => AuthSource.assert(snapshot, current.snapshot),
      catch: (error) => AuthOutcome.known(error) ?? new AuthOutcome.Failure("unverifiable"),
    })
  })

  function value(
    providerID: string,
    modelID: string | undefined,
    reason: AuthOutcome.Reason,
    source: Readiness["source"],
    authority?: string,
  ): Readiness {
    const detail = AuthOutcome.detail(reason)
    return {
      providerID,
      modelID,
      state: detail.state,
      source,
      reason,
      action: detail.action,
      authority,
      runtimeID: AuthSource.runtime,
      observedAt: Math.floor(performance.timeOrigin + performance.now()),
      validation: "local",
      disruption: reason === "authority-changed" ? "provider" : "none",
    }
  }

  export const readiness = Effect.fn("KiloAuth.readiness")(function* (
    providerID: string,
    modelID?: string,
    directory?: string,
  ) {
    const dir = directory ?? (yield* InstanceState.directory)
    const key = JSON.stringify([dir, providerID, modelID])
    return yield* resolve({ providerID, modelID }, true, undefined, dir).pipe(
      Effect.map((current) => {
        const cached = observed.get(key)
        if (
          cached?.authority === current.snapshot.authority &&
          cached.state !== "ready" &&
          current.reason !== "exchange-uncertain" &&
          current.reason !== "refresh-rejected" &&
          (cached.state !== "refreshing" || current.reason === "refreshing")
        )
          return cached
        const reason =
          current.reason === "local-valid" &&
          current.expiry !== undefined &&
          current.expiry <= Date.now() + (providerID === "xai" ? 120_000 : 60_000)
            ? current.snapshot.source === "env"
              ? "source-unmanaged"
              : "refresh-needed"
            : current.reason
        return value(providerID, modelID, reason, current.snapshot.source, current.snapshot.authority)
      }),
      Effect.catchCause((cause) =>
        Effect.succeed(
          value(providerID, modelID, AuthOutcome.known(Cause.squash(cause))?.reason ?? "unverifiable", "unknown"),
        ),
      ),
    )
  })

  export const request = Effect.fn("KiloAuth.request")(function* (input: {
    snapshot: Snapshot | undefined
    model: { providerID: string; id: string }
    sessionID: string
    messageID: string
    signal?: AbortSignal
    dispatch?: () => void
    unsupported?: () => never
  }) {
    const bridge = yield* EffectBridge.make()
    const bus = yield* Bus.Service
    const ctx = yield* InstanceState.context
    const snapshot = input.snapshot
    const report = (reason: AuthOutcome.Reason) => {
      const data = value(
        input.model.providerID,
        input.model.id,
        reason,
        snapshot?.source ?? "unknown",
        snapshot?.authority,
      )
      observed.set(JSON.stringify([ctx.directory, input.model.providerID, input.model.id]), data)
      return bridge.promise(bus.publish(Event, { ...data, sessionID: input.sessionID, messageID: input.messageID }))
    }
    if (!snapshot) {
      yield* Effect.promise(() => report("unverifiable"))
      return yield* Effect.fail(new AuthOutcome.Failure("unverifiable", input.model.providerID))
    }
    const guard = AuthRequest.create({
      expected: snapshot,
      signal: input.signal,
      resolve: () => bridge.promise(resolve(input.model, false, snapshot)),
      observe: report,
      dispatch: input.dispatch,
      unsupported: input.unsupported,
    })
    yield* Effect.tryPromise({ try: () => guard.check(), catch: (error) => AuthOutcome.known(error) ?? error }).pipe(
      Effect.onError(() => Effect.sync(() => guard.close())),
    )
    return guard
  })

  export function bind(deps: {
    config: Config.Interface
    env: Env.Interface
    provider: Provider.Interface
    bus?: Bus.Interface
  }) {
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(Config.Service, deps.config),
        Effect.provideService(Env.Service, deps.env),
        Effect.provideService(Provider.Service, deps.provider),
      )
    return {
      capture: (model: Parameters<typeof capture>[0]) => provide(capture(model)),
      admit: (model: Parameters<typeof admit>[0]) => provide(admit(model)),
      readiness: (providerID: string, modelID?: string, directory?: string) =>
        provide(readiness(providerID, modelID, directory)),
      check: (snapshot: Snapshot | undefined, model: Parameters<typeof check>[1]) => provide(check(snapshot, model)),
      request: (input: Parameters<typeof request>[0]) =>
        deps.bus
          ? provide(request(input)).pipe(Effect.provideService(Bus.Service, deps.bus))
          : Effect.die(new Error("Auth request observation requires Bus.Service")),
    }
  }
}
