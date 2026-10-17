import { Effect, Schema, Semaphore } from "effect"
import { createHash } from "node:crypto"
import { mergeDeep } from "remeda"
import type { Auth } from "@/auth"
import type { Config } from "@/config/config"
import type { Env } from "@/env"
import type { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import type { EffectBridge } from "@/effect/bridge"
import { AuthStore } from "./store"
import { AuthSource } from "./source"
import { AuthOutcome } from "./outcome"
import { CodexModels } from "@/kilocode/provider/codex-models"
import { patchKiloProviderPrivacy } from "@/kilocode/provider/provider"
import { ProviderTransform } from "@/provider/transform"

export namespace AuthCache {
  type State = {
    providers: Record<string, Provider.Info>
    catalog: Record<string, Provider.Info>
    models: Map<string, unknown>
    sdk: Map<string, unknown>
    auth: Map<string, string>
  }
  type Services = { state: State; config: Config.Interface; env: Env.Interface; auth: Auth.Interface }
  type Custom = {
    autoload: boolean
    options?: Record<string, unknown>
    discoverModels?: () => Promise<Record<string, Provider.Model>>
  }
  const locks = new WeakMap<State, Map<string, Semaphore.Semaphore>>()

  // Omit absent schema fields without JSON-dropping functional options or capability loaders.
  function copy<T>(value: T): T {
    if (Array.isArray(value)) return value.map(copy) as T
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return value
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, copy(item)]),
    ) as T
  }

  function stamp(selected: AuthSource.Selected, cfg: Config.Info, id: string) {
    const version = ["config", "env"].includes(selected.snapshot.source) ? 0 : (AuthSource.version.get(id) ?? 0)
    return createHash("sha256")
      .update(
        JSON.stringify([selected.snapshot.authority, version, cfg.provider?.[id], cfg.hide_prompt_training_models]),
      )
      .digest("hex")
  }

  export function writer(state: State, id: string) {
    const revision = state.auth.get(id)
    return <T>(cache: Map<string, T>, key: string, value: T) => {
      if (state.auth.get(id) !== revision) throw new AuthOutcome.Failure("authority-changed", id)
      cache.set(key, value)
    }
  }

  export const list = Effect.fn("AuthCache.list")(function* (
    input: Services,
    reconcile: (id: ProviderID) => Effect.Effect<void>,
  ) {
    const cfg = yield* input.config.get()
    const env = yield* input.env.all()
    const auth = yield* input.auth.all().pipe(Effect.orDie)
    const ids = new Set([
      ...Object.keys(input.state.providers),
      ...Object.keys(cfg.provider ?? {}),
      ...Object.keys(auth),
    ])
    for (const provider of Object.values(input.state.catalog)) {
      if (provider.env.some((key) => env[key])) ids.add(provider.id)
    }
    for (const id of ids) yield* reconcile(ProviderID.make(id))
    return input.state.providers
  })

  export const reconcile = Effect.fn("AuthCache.reconcile")(function* <C extends Custom>(
    input: Services & {
      id: ProviderID
      plugin: Plugin.Interface
      bridge: EffectBridge.Shape
      experimental: boolean
      normalize: (provider: Provider.Info, cfg: Config.Info) => Provider.Info
      custom: (provider: Provider.Info) => Effect.Effect<C, unknown>
      publish: (custom?: C) => void
    },
  ) {
    const entries = locks.get(input.state) ?? new Map<string, Semaphore.Semaphore>()
    locks.set(input.state, entries)
    const lock = entries.get(input.id) ?? Semaphore.makeUnsafe(1)
    entries.set(input.id, lock)
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const id = input.id
        const state = input.state
        const current = state.providers[id]
        const cfg = yield* input.config.get()
        const env = yield* input.env.all()
        const configured = cfg.provider?.[id]
        const base =
          state.catalog[id] ??
          (configured ? { id, name: id, env: [], options: {}, source: "config" as const, models: {} } : undefined)
        const clear = () => {
          delete state.providers[id]
          for (const key of state.models.keys()) if (key.startsWith(`${id}/`)) state.models.delete(key)
          for (const key of state.sdk.keys()) if (key.startsWith(`${id}:`)) state.sdk.delete(key)
          input.publish()
        }
        if (
          !base ||
          cfg.disabled_providers?.includes(id) ||
          (cfg.enabled_providers && !cfg.enabled_providers.includes(id))
        ) {
          clear()
          state.auth.delete(id)
          return
        }
        const view = { ...(current ?? base), env: configured?.env ?? base.env }
        const selected = yield* Effect.promise(() =>
          AuthStore.disk.run(() => AuthSource.select({ provider: view, cfg, env, store: AuthStore.disk })),
        )
        const revision = stamp(selected, cfg, id)
        if (state.auth.get(id) === revision) return
        const auth = yield* input.auth.get(id).pipe(Effect.orDie)
        const next = copy(base)
        next.options = {}
        delete next.key
        const hooks = yield* input.plugin.list()
        for (const hook of hooks) {
          if (hook.provider?.id !== id || !hook.provider.models) continue
          const models = yield* Effect.promise(() =>
            CodexModels.defer(() => hook.provider!.models!(Provider.toPublicInfo(next), { auth })),
          )
          if (models)
            next.models = Object.fromEntries(
              Object.entries(models).map(([key, model]) => [
                key,
                {
                  ...mergeDeep(next.models[key] ?? {}, copy(model)),
                  ...(model.codex && { codex: model.codex }),
                  id: ModelID.make(key),
                  providerID: id,
                },
              ]),
            ) as Provider.Info["models"]
        }
        const normalized = input.normalize(next, cfg)
        next.models = normalized.models
        next.name = normalized.name
        next.env = normalized.env
        next.options = normalized.options
        const oauth = auth?.type === "oauth" && hooks.some((hook) => hook.auth?.provider === id && hook.auth.loader)
        const key = oauth ? undefined : next.env.map((name) => env[name]).find(Boolean)
        if (key && next.env.length === 1) next.key = key
        if (auth?.type === "api") next.key = auth.key
        const loaded = { auth: false }
        for (const hook of hooks) {
          if (hook.auth?.provider === id && auth && hook.auth.loader) {
            const options = yield* Effect.promise(() =>
              hook.auth!.loader!(async () => {
                const value = await input.bridge.promise(input.auth.get(id).pipe(Effect.orDie))
                if (!value) throw new AuthOutcome.Failure("authority-changed")
                return value
              }, Provider.toPublicInfo(next)),
            )
            Object.assign(next.options, options)
            loaded.auth = true
          }
        }
        const custom = yield* input.custom(next).pipe(Effect.orDie)
        next.options = mergeDeep(mergeDeep(next.options, custom.options ?? {}), configured?.options ?? {})
        next.source =
          auth?.type === "oauth" && loaded.auth
            ? "custom"
            : configured
              ? "config"
              : loaded.auth || custom.autoload
                ? "custom"
                : auth?.type === "api"
                  ? "api"
                  : "env"
        patchKiloProviderPrivacy(next, cfg)
        const enabled = !!(configured || key || auth?.type === "api" || loaded.auth || custom.autoload)
        if (enabled && custom.discoverModels) {
          // Match initialization's best-effort discovery without retaining another login's models.
          const models = yield* Effect.tryPromise(custom.discoverModels).pipe(
            Effect.catch(() =>
              Effect.logWarning("Provider discovery unavailable").pipe(
                Effect.annotateLogs("provider", id),
                Effect.as({} as Record<string, Provider.Model>),
              ),
            ),
          )
          for (const [key, model] of Object.entries(models)) next.models[key] ??= model
        }
        CodexModels.mark(next, auth)
        for (const [key, model] of Object.entries(next.models)) {
          model.id = ModelID.make(model.id || key)
          if (
            (key === "gpt-5-chat-latest" && ["openai", "github-copilot", "openrouter"].includes(id)) ||
            (id === "openrouter" && key === "openai/gpt-5-chat") ||
            model.status === "deprecated" ||
            (model.status === "alpha" && !input.experimental) ||
            configured?.blacklist?.includes(key) ||
            (configured?.whitelist && !configured.whitelist.includes(key))
          ) {
            delete next.models[key]
            continue
          }
          const variants =
            model.variants && Object.keys(model.variants).length ? model.variants : ProviderTransform.variants(model)
          model.variants = Object.fromEntries(
            Object.entries(mergeDeep(variants, configured?.models?.[key]?.variants ?? {})).flatMap(([key, value]) =>
              value && !value.disabled
                ? [[key, Object.fromEntries(Object.entries(value).filter(([key]) => key !== "disabled"))]]
                : [],
            ),
          )
          const prior = current?.models[key]?.codex
          if (
            prior?.status === "ready" &&
            prior.binding &&
            prior.binding === model.codex?.binding &&
            model.codex.status === "unavailable"
          )
            model.codex = prior
        }
        const result = Schema.decodeUnknownSync(Provider.Info)(copy(next)) as Provider.Info
        for (const [key, model] of Object.entries(result.models)) {
          const capability = next.models[key].codex
          if (model.codex && capability)
            CodexModels.bind(model.codex, () => CodexModels.resolve(capability, model.api.id))
        }
        const connected = enabled && Object.keys(result.models).length > 0
        const latest = yield* input.config.get()
        const values = yield* input.env.all()
        const check = yield* Effect.promise(() =>
          AuthStore.disk.run(() =>
            AuthSource.select({ provider: view, cfg: latest, env: values, store: AuthStore.disk }),
          ),
        )
        AuthSource.assert(selected.snapshot, check.snapshot)
        if (revision !== stamp(check, latest, id))
          throw new AuthOutcome.Failure("authority-changed", id, selected.snapshot.source)
        const final = yield* Effect.promise(() =>
          AuthStore.disk.run(() =>
            AuthSource.select({ provider: connected ? result : base, cfg: latest, env: values, store: AuthStore.disk }),
          ),
        )
        clear()
        if (connected) {
          state.providers[id] = result
          input.publish(custom)
        }
        state.auth.set(id, stamp(final, latest, id))
      }),
    )
  })
}
