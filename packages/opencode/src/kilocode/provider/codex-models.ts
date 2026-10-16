import { createHash } from "node:crypto"
import { Schema } from "effect"
import { z } from "zod"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Auth } from "@/auth"
import { makeRuntime } from "@/effect/run-service"

export namespace CodexModels {
  export const Capability = Schema.Union([
    Schema.Struct({
      status: Schema.Literal("ready"),
      context: Schema.Int,
      maximum: Schema.Int,
      effectivePercent: Schema.Int,
      source: Schema.String,
      revision: Schema.String,
      binding: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: Schema.String,
      binding: Schema.optional(Schema.String),
    }),
  ]).annotate({ identifier: "CodexContextCapability" })
  export type Capability = Schema.Schema.Type<typeof Capability>
  type Loader = () => Promise<Map<string, Capability> | Capability>
  const loaders = new WeakMap<Capability, Loader>()
  const bindings = new Map<string, Loader>()
  const scopes = new WeakMap<Map<string, Capability>, string>()

  type Credentials = {
    type: "oauth"
    access: string
    refresh: string
    expires: number
    accountId?: string
  }

  type Input = {
    auth: Credentials
    endpoint: string
    getAuth: () => Promise<Credentials | undefined>
    refresh: (auth: Credentials) => Promise<Credentials>
    timeout?: number
  }

  // The model-catalog protocol version, not a claim about an installed native CLI.
  const version = "0.162.0"
  const ttl = 5 * 60 * 1000
  const maximum = 16 * 1024 * 1024
  const storage = makeRuntime(Auth.Service, Auth.defaultLayer)
  const row = z.object({
    slug: z.string().min(1).max(256),
    context_window: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
    max_context_window: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
    effective_context_window_percent: z.number().int().min(1).max(100).nullish(),
  })

  function digest(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex")
  }

  function same(auth: Pick<Credentials, "accountId" | "refresh">, current: Credentials | undefined) {
    if (!current) return false
    if (auth.accountId || current.accountId) return auth.accountId === current.accountId
    return auth.refresh === current.refresh
  }

  export function unavailable(reason: string): Capability {
    return Object.freeze({ status: "unavailable", reason })
  }

  export async function current(): Promise<Credentials | undefined> {
    const auth = await storage.runPromise((store) => store.get("openai"))
    return auth?.type === "oauth" ? auth : undefined
  }

  async function body(response: Response) {
    const size = Number(response.headers.get("content-length") ?? 0)
    if (size > maximum) {
      await response.body?.cancel()
      throw new Error("Codex catalog body is too large")
    }
    if (!response.body) throw new Error("Invalid Codex catalog body")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.length
        if (length > maximum) {
          await reader.cancel()
          throw new Error("Codex catalog body is too large")
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  }

  export function create(now = Date.now) {
    const cache = new Map<string, { time: number; models: Map<string, Capability> }>()
    const pending = new Map<string, Promise<Map<string, Capability> | Capability>>()

    async function query(input: Input): Promise<Map<string, Capability> | Capability> {
      const expected = { accountId: input.auth.accountId, refresh: input.auth.refresh }
      const current = await input.getAuth()
      if (!same(expected, current)) return unavailable("The Codex account changed before loading model limits.")
      const auth = current && current.access && current.expires > now() ? current : await input.refresh(input.auth)
      if (!same(expected, auth) || !same(expected, await input.getAuth()))
        return unavailable("The Codex account changed while renewing credentials.")
      const scope = { accountId: auth.accountId, refresh: auth.refresh }
      if (!URL.canParse(input.endpoint)) return unavailable("The Codex model-catalog endpoint is unsupported.")
      const url = new URL(input.endpoint)
      if (
        url.username ||
        url.password ||
        !url.pathname.endsWith("/responses") ||
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      ) {
        return unavailable("The Codex model-catalog endpoint is unsupported.")
      }
      url.pathname = url.pathname.slice(0, -"responses".length) + "models"
      url.search = ""
      url.hash = ""
      url.searchParams.set("client_version", version)
      const key = digest([url.href, scope.accountId || digest(scope.refresh)])
      const found = cache.get(key)
      if (found && now() - found.time < ttl) return new Map(found.models)
      const existing = pending.get(key)
      if (existing) {
        const result = await existing
        if (!same(scope, await input.getAuth()))
          return unavailable("The Codex account changed while loading model limits.")
        return result instanceof Map ? new Map(result) : result
      }

      const promise = (async (): Promise<Map<string, Capability> | Capability> => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), input.timeout ?? 10_000)
        try {
          const response = await fetch(url, {
            method: "GET",
            signal: controller.signal,
            redirect: "error",
            headers: {
              Authorization: `Bearer ${auth.access}`,
              ...(auth.accountId && { "ChatGPT-Account-Id": auth.accountId }),
              Accept: "application/json",
              "User-Agent": `kilo/${InstallationVersion}`,
              originator: "kilo",
            },
          })
          if (!response.ok) {
            await response.body?.cancel()
            return unavailable(`The authenticated Codex model catalog returned HTTP ${response.status}.`)
          }
          const parsed = z.object({ models: z.array(z.unknown()).max(1000) }).safeParse(await body(response))
          if (!parsed.success) return unavailable("The Codex model catalog has an unsupported shape.")
          const models = new Map<string, Capability>()
          for (const value of parsed.data.models) {
            const identity = row.pick({ slug: true }).safeParse(value)
            if (!identity.success) continue
            if (models.has(identity.data.slug)) {
              models.set(
                identity.data.slug,
                unavailable("The Codex model catalog contains an ambiguous model identity."),
              )
              continue
            }
            const result = row.safeParse(value)
            if (!result.success) {
              models.set(identity.data.slug, unavailable("The Codex model catalog contains invalid window metadata."))
              continue
            }
            const item = result.data
            if (!item.context_window || !item.max_context_window || item.max_context_window < item.context_window) {
              models.set(item.slug, unavailable("Codex has not advertised a valid maximum window for this model."))
              continue
            }
            const fields = {
              context: item.context_window,
              maximum: item.max_context_window,
              effectivePercent: item.effective_context_window_percent ?? 95,
            }
            models.set(
              item.slug,
              Object.freeze({
                status: "ready",
                ...fields,
                source: `codex-catalog@${version}`,
                revision: digest([key, item.slug, fields]),
              }),
            )
          }
          if (!same(scope, await input.getAuth())) {
            return unavailable("The Codex account changed while loading model limits.")
          }
          cache.delete(key)
          cache.set(key, { time: now(), models })
          if (cache.size > 32) {
            const oldest = cache.keys().next().value
            if (oldest) cache.delete(oldest)
          }
          return new Map(models)
        } catch {
          return unavailable("The authenticated Codex model catalog could not be read safely.")
        } finally {
          clearTimeout(timer)
        }
      })().finally(() => pending.delete(key))
      pending.set(key, promise)
      return promise
    }

    return {
      load: async (input: Input): Promise<Map<string, Capability> | Capability> => {
        const binding = digest([input.endpoint, version, input.auth.accountId || digest(input.auth.refresh)])
        const result = await query(input).catch(() =>
          unavailable("Codex credentials could not be prepared for model-limit discovery."),
        )
        if (!(result instanceof Map)) return Object.freeze({ ...result, binding })
        const models = new Map([...result].map(([key, value]) => [key, Object.freeze({ ...value, binding })]))
        scopes.set(models, binding)
        return models
      },
    }
  }

  export const catalog = create()

  export function lookup(result: Map<string, Capability> | Capability, model: string): Capability {
    if (!(result instanceof Map)) return result
    return (
      result.get(model) ??
      Object.freeze({
        ...unavailable("The authenticated Codex catalog does not advertise this model's maximum window."),
        binding: scopes.get(result),
      })
    )
  }

  export function bind(capability: Capability, loader: Loader) {
    loaders.set(capability, loader)
    if (capability.binding) {
      bindings.delete(capability.binding)
      bindings.set(capability.binding, loader)
      if (bindings.size > 32) {
        const oldest = bindings.keys().next().value
        if (oldest) bindings.delete(oldest)
      }
    }
    return capability
  }

  function bound(capability: Capability) {
    return loaders.get(capability) ?? (capability.binding ? bindings.get(capability.binding) : undefined)
  }

  export async function resolve(capability: Capability, model: string) {
    const loader = bound(capability)
    if (!loader)
      return capability.binding
        ? unavailable("The Codex model-limit binding is unavailable; reload the provider before new work.")
        : capability
    return bind(lookup(await loader(), model), loader)
  }

  export function mark(
    provider: { id: string; models: Record<string, { codex?: Capability }> },
    auth: { type: string } | undefined,
  ) {
    if (!process.env.ZEN_KILO_CONTEXT_POLICY || provider.id !== "openai") return
    const loader = Object.values(provider.models)
      .map((model) => model.codex && bound(model.codex))
      .find((value) => value !== undefined)
    const binding = Object.values(provider.models).find((model) => model.codex?.binding)?.codex?.binding
    for (const model of Object.values(provider.models)) {
      if (auth?.type !== "oauth") {
        delete model.codex
        continue
      }
      if (model.codex) continue
      const missing = Object.freeze({
        ...unavailable("This configured model has no authenticated Codex maximum-window metadata."),
        binding,
      })
      model.codex = loader ? bind(missing, loader) : missing
    }
  }
}
