import { createHash, createHmac, randomBytes } from "node:crypto"
import { Schema } from "effect"
import { Auth } from "@/auth"
import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { AuthStore } from "./store"
import { AuthOutcome } from "./outcome"
import { BusEvent } from "@/bus/bus-event"
import { KiloRuntime } from "@/kilocode/runtime/control"
import { HEADER_ORGANIZATIONID } from "@kilocode/kilo-gateway"

export namespace AuthSource {
  const salt = randomBytes(32)
  export const runtime = KiloRuntime.info.id
  export const Snapshot = Schema.Struct({
    version: Schema.Literal(1),
    providerID: Schema.String,
    source: AuthOutcome.Source,
    kind: Schema.Literals(["oauth", "api", "anonymous", "external"]),
    authority: Schema.String,
    runtime: Schema.optional(Schema.String),
    managed: Schema.Boolean,
    env: Schema.String,
  }).annotate({ identifier: "AuthAuthority" })
  export type Snapshot = typeof Snapshot.Type
  export function seal(input: unknown): Snapshot {
    const value = Schema.decodeUnknownOption(Snapshot)(input)
    if (value._tag === "None") throw new AuthOutcome.Failure("unverifiable")
    return Object.freeze({ ...value.value })
  }
  export function restore(input: { authAuthority?: Snapshot; authAuthorities?: Readonly<Record<string, Snapshot>> }) {
    return {
      ...(input.authAuthority && { authAuthority: seal(input.authAuthority) }),
      ...(input.authAuthorities && {
        authAuthorities: Object.freeze(
          Object.fromEntries(Object.entries(input.authAuthorities).map(([key, value]) => [key, seal(value)])),
        ),
      }),
    }
  }
  export const Readiness = Schema.Struct({
    providerID: Schema.String,
    modelID: Schema.optional(Schema.String),
    state: AuthOutcome.State,
    source: AuthOutcome.Source,
    reason: AuthOutcome.Reason,
    action: AuthOutcome.Action,
    authority: Schema.optional(Schema.String),
    runtimeID: Schema.String,
    observedAt: Schema.Number,
    validation: Schema.Literal("local"),
    disruption: AuthOutcome.Disruption,
  }).annotate({ identifier: "AuthReadiness" })
  export const Event = BusEvent.define(
    "session.auth",
    Schema.Struct({ ...Readiness.fields, sessionID: Schema.String, messageID: Schema.String }),
  )
  export type Selected = {
    snapshot: Snapshot
    credential?: Auth.Info
    headers?: Record<string, string>
    organization?: string
    expiry?: number
    reason: AuthOutcome.Reason
  }
  export const fields = ["authorization", "x-api-key", "api-key", "x-goog-api-key"] as const
  const headers = /^(authorization|x-api-key|api-key|x-goog-api-key)$/i
  const text = (value: unknown) => (typeof value === "string" && value.length ? value : undefined)
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const opaque = (value: unknown) => createHmac("sha256", salt).update(JSON.stringify(value)).digest("hex")
  export const connection = (url: string, headers: Record<string, string>) =>
    opaque([url, ...fields.map((key) => headers[key]), headers["chatgpt-account-id"]])
  export const version = new Map<string, number>()
  export function names(snapshot: Snapshot) {
    try {
      return Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(snapshot.env))
    } catch {
      throw new AuthOutcome.Failure("unverifiable")
    }
  }

  export async function select(input: {
    provider: Pick<Provider.Info, "id" | "env" | "options" | "source">
    model?: Pick<Provider.Model, "headers">
    cfg: Config.Info
    env: Record<string, string | undefined>
    store: ReturnType<typeof AuthStore.create>
    passive?: boolean
  }): Promise<Selected> {
    const id = input.provider.id
    const configured = input.cfg.provider?.[id]?.options ?? {}
    const observed = await input.store.observe(id, input.passive)
    const auth = observed.value
    if (auth !== undefined && Schema.decodeUnknownOption(Auth.Info)(auth)._tag === "None")
      throw new AuthOutcome.Failure(
        observed.source === "env" ? "source-unmanaged" : "storage-unavailable",
        id,
        observed.source,
      )
    const selected = new Headers(configured.headers as HeadersInit | undefined)
    new Headers(input.model?.headers).forEach((value, name) => selected.set(name, value))
    const override = selected.get(HEADER_ORGANIZATIONID)
    const org =
      id === "kilo"
        ? text(
            override ??
              (Object.hasOwn(configured, "kilocodeOrganizationId")
                ? configured.kilocodeOrganizationId
                : (input.env.KILO_ORG_ID ?? (auth?.type === "oauth" ? auth.accountId : undefined))),
          )
        : undefined
    const renewable = auth?.type === "oauth" && ["openai", "xai"].includes(id)
    const expiry = auth?.type === "oauth" && (renewable || auth.expires > 0) ? auth.expires : undefined
    const external = (
      source: Snapshot["source"],
      material: unknown,
      credential?: Auth.Info,
      managed = true,
    ): Selected => ({
      snapshot: Object.freeze({
        version: 1,
        providerID: id,
        source,
        kind:
          credential?.type === "oauth" || credential?.type === "api"
            ? credential.type
            : source === "none"
              ? "anonymous"
              : "external",
        authority: opaque([id, source, material, org]),
        runtime,
        managed,
        env: JSON.stringify(input.provider.env),
      }),
      credential,
      organization: org,
      expiry: credential?.type === "oauth" ? expiry : undefined,
      reason: !managed ? "external-owner" : source === "none" ? "no-credentials" : "local-valid",
    })
    const configuredToken = id === "kilo" ? text(configured.kilocodeToken) : undefined
    if (configuredToken) return external("config", [configuredToken, org], { type: "api", key: configuredToken })
    const dynamic =
      auth?.type === "oauth" && ["openai", "xai", "kilo", "github-copilot", "github-copilot-enterprise"].includes(id)
    const gateway = id === "kilo" && auth && (auth.type === "oauth" || auth.type === "api")
    if (!dynamic && auth?.type === "oauth") {
      const explicit = input.cfg.provider?.[id]?.options ?? {}
      const configured = new Headers(explicit.headers as HeadersInit | undefined)
      new Headers(input.model?.headers).forEach((value, name) => configured.set(name, value))
      if (text(explicit.apiKey) || Array.from(configured.keys()).some((name) => headers.test(name)))
        throw new AuthOutcome.Failure("source-unmanaged", id, observed.source === "env" ? "env" : "file")
    }
    if (!dynamic && !gateway && auth?.type !== "oauth") {
      const fields = Array.from(selected.entries())
        .filter(([name, value]) => headers.test(name) && text(value))
        .sort(([a], [b]) => a.localeCompare(b))
      if (fields.length)
        return {
          ...external("config", fields),
          headers: Object.fromEntries(fields.map(([key, value]) => [key.toLowerCase(), value])),
        }
      const key = text(configured.apiKey)
      if (key) return external("config", key, { type: "api", key })
    }
    // A stored credential remains authority-bearing even when another plugin
    // owns its exchange protocol. An unmanaged label must not erase its epoch.
    if (auth?.type === "api" || auth?.type === "oauth") {
      if (observed.source === "env") return external("env", auth, auth)
      const current = observed.snapshot ?? (input.passive ? undefined : await input.store.snapshot(id, auth))
      if (!current) return external("unknown", "missing-metadata", auth, false)
      return {
        snapshot: Object.freeze({
          version: 1,
          providerID: id,
          source: "file",
          kind: auth.type,
          managed: true,
          env: JSON.stringify(input.provider.env),
          // Only non-secret store/login/account identity. Revisions and token
          // fingerprints are deliberately excluded, allowing same-login renewal.
          authority: hash([
            current.store,
            id,
            current.epoch,
            current.loginGeneration,
            auth.type,
            auth.type === "oauth" ? auth.accountId : undefined,
            auth.type === "oauth" ? auth.enterpriseUrl : undefined,
            org,
          ]),
        }),
        credential: auth,
        organization: org,
        expiry,
        reason: ("issue" in observed ? observed.issue : undefined) ?? "local-valid",
      }
    }
    const values = input.provider.env.map((name) => [name, input.env[name]] as const).filter(([, value]) => value)
    if (values.length) {
      const key = input.provider.env.length === 1 ? values[0][1] : undefined
      return external("env", values, key ? { type: "api", key } : undefined, input.provider.env.length === 1)
    }
    if (
      auth ||
      typeof input.provider.options.fetch === "function" ||
      (text(input.provider.options.apiKey) && input.provider.options.apiKey !== "anonymous")
    )
      return external(
        "plugin",
        [input.provider.options.apiKey, input.provider.options.headers, auth?.type],
        auth,
        false,
      )
    return external("none", "anonymous")
  }

  export function assert(expected: Snapshot | undefined, current: Snapshot) {
    if (!expected || expected.version !== 1 || (expected.runtime && expected.runtime !== runtime))
      throw new AuthOutcome.Failure(
        "unverifiable",
        expected?.providerID ?? current.providerID,
        expected?.source ?? current.source,
      )
    if (
      expected.providerID !== current.providerID ||
      expected.source !== current.source ||
      expected.kind !== current.kind ||
      expected.authority !== current.authority
    )
      throw new AuthOutcome.Failure("authority-changed", expected.providerID, expected.source)
  }
}
