import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { NamedError } from "@opencode-ai/core/util/error"
import * as Log from "@opencode-ai/core/util/log"
import { BusEvent } from "@/bus/bus-event"
import type { Bus } from "@/bus"
import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "@/session/message-v2"
import { Token } from "@/util/token"
import { KiloSessionOverflow } from "./overflow"
import { CodexModels } from "@/kilocode/provider/codex-models"
import { KiloContextMedia } from "./context-media"

const log = Log.create({ service: "session.context" })
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const positive = (value: number) => Number.isSafeInteger(value) && value > 0

export namespace KiloContextPolicy {
  const fields = {
    version: Schema.Literal(1),
    window: Schema.Literal("maximum-supported"),
    automaticPercent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })),
    admissionPercent: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 100 })),
  }
  const Settings = Schema.Struct(fields)
  export const Profile = Schema.Struct({ ...fields, id: Schema.String })
  export type Profile = Schema.Schema.Type<typeof Profile>
  export const Snapshot = Schema.Struct({
    profile: Profile,
    providerID: Schema.String,
    modelID: Schema.String,
    apiID: Schema.String,
    kind: Schema.Literals(["codex", "model"]),
    window: Schema.Finite,
    input: Schema.Finite,
    output: Schema.Finite,
    combined: Schema.NullOr(Schema.Finite),
    source: Schema.String,
    revision: Schema.String,
    hash: Schema.String,
  })
  export type Snapshot = Schema.Schema.Type<typeof Snapshot>
  export const Receipt = Schema.Struct({
    source: Schema.String,
    progress: Schema.optional(Schema.String),
    currentTokens: Schema.NullOr(Schema.Finite),
    nextTokens: Schema.Finite,
    tail: Schema.optional(Schema.String),
  })
  export type Receipt = Schema.Schema.Type<typeof Receipt>
  export type State = {
    currentTokens: number | null
    progress?: string
    attempted: boolean
    reducible: boolean
    unresolved?: boolean
  }

  export const Blocked = NamedError.create("ContextAdmissionError", {
    message: Schema.String,
    reason: Schema.String,
    isRetryable: Schema.Literal(false),
  })
  export function blocked(reason: string, message = reason) {
    return new Blocked({
      message: `[CONTEXT_ADMISSION_BLOCKED] ${message}. No oversized request was submitted.`,
      reason,
      isRetryable: false,
    })
  }

  export const Event = BusEvent.define(
    "session.context",
    Schema.Struct({
      sessionID: Schema.String,
      messageID: Schema.optional(Schema.String),
      sessionTitle: Schema.optional(Schema.String),
      providerID: Schema.String,
      modelID: Schema.String,
      phase: Schema.Literals(["admission", "compacting", "compacted", "blocked"]),
      reason: Schema.String,
      window: Schema.Finite,
      automaticThreshold: Schema.Finite,
      admissionThreshold: Schema.Finite,
      currentTokens: Schema.NullOr(Schema.Finite),
      nextTokens: Schema.NullOr(Schema.Finite),
      profileID: Schema.String,
    }),
  )

  export function configured(): Profile | undefined {
    const text = process.env.ZEN_KILO_CONTEXT_POLICY
    if (text === undefined) return undefined
    try {
      const value: unknown = JSON.parse(text)
      if (
        !Schema.is(Settings)(value) ||
        Object.keys(value).sort().join(",") !== "admissionPercent,automaticPercent,version,window" ||
        value.automaticPercent >= value.admissionPercent
      )
        throw blocked("Invalid ZEN_KILO_CONTEXT_POLICY profile")
      const profile = {
        version: 1 as const,
        window: "maximum-supported" as const,
        automaticPercent: value.automaticPercent,
        admissionPercent: value.admissionPercent,
      }
      return { ...profile, id: digest(profile) }
    } catch {
      throw blocked("Invalid ZEN_KILO_CONTEXT_POLICY profile")
    }
  }

  export function validate(cfg: Config.Info, profile: Profile) {
    const value = {
      version: profile.version,
      window: profile.window,
      automaticPercent: profile.automaticPercent,
      admissionPercent: profile.admissionPercent,
    }
    if (
      !Schema.is(Profile)(profile) ||
      profile.automaticPercent >= profile.admissionPercent ||
      profile.id !== digest(value)
    )
      throw blocked("Invalid frozen context profile")
    if (cfg.compaction?.auto !== true || cfg.compaction.threshold_percent !== profile.automaticPercent)
      throw blocked("Effective compaction configuration conflicts with the frozen context policy")
  }

  export function freeze(input: {
    cfg: Config.Info
    model: Provider.Model
    inherited?: Snapshot
    oauth?: boolean
    outputTokenMax?: number
  }) {
    const profile = input.inherited?.profile ?? configured()
    if (!profile) return undefined
    validate(input.cfg, profile)
    const capability = input.model.codex
    const codex = capability?.status === "ready" ? capability : undefined
    if (
      codex &&
      (!positive(codex.maximum) ||
        !positive(codex.context) ||
        codex.context > codex.maximum ||
        !Number.isFinite(codex.effectivePercent) ||
        codex.effectivePercent <= 0 ||
        codex.effectivePercent > 100 ||
        !codex.source ||
        !codex.revision)
    )
      throw blocked("Invalid Codex capacity evidence")
    if (input.inherited) {
      const { hash, ...value } = input.inherited
      if (
        digest(value) !== hash ||
        !positive(value.window) ||
        !positive(value.input) ||
        !positive(value.output) ||
        (value.combined !== null && !positive(value.combined)) ||
        value.input > value.window
      )
        throw blocked("Invalid frozen context policy")
      if (value.providerID === input.model.providerID && value.modelID === input.model.id) {
        if (
          value.apiID !== input.model.api.id ||
          (input.oauth === false && value.kind === "codex" && input.model.providerID === "openai") ||
          (input.oauth === true && value.kind !== "codex")
        )
          throw blocked("The admitted model identity changed")
        if (
          capability?.status === "unavailable" &&
          !/could not be read safely|HTTP (429|5\d\d)/.test(capability.reason)
        )
          throw blocked("Codex capacity identity cannot be verified")
        const window = codex?.maximum ?? (value.kind === "model" ? input.model.limit.context : undefined)
        const capacity =
          value.kind === "model" ? (input.model.limit.input ?? input.model.limit.context) : codex?.maximum
        const combined =
          value.kind === "model" || input.model.limit.context >= value.window ? input.model.limit.context : undefined
        if (
          (window !== undefined && window < value.window) ||
          (capacity !== undefined && capacity < value.input) ||
          (combined !== undefined && (value.combined === null || combined < value.combined))
        )
          throw blocked("Known provider capacity decreased below the frozen turn budget")
        return input.inherited
      }
    }
    if (capability?.status === "unavailable" || (input.oauth && !codex))
      throw blocked("Supported Codex capacity is unavailable")
    const window = codex?.maximum ?? input.model.limit.context
    const output = input.model.limit.output
    const capacity = codex
      ? window
      : Math.min(window, input.model.limit.input || window) - (input.cfg.compaction?.reserved ?? 0)
    // A smaller static API/default context is not a hard limit on an advertised
    // Codex maximum. Preserve a separately known combined limit when consistent.
    const combined = codex && input.model.limit.context < window ? null : input.model.limit.context
    if (!positive(window) || !positive(output) || !positive(capacity))
      throw blocked("Validated model capacity is unavailable")
    const value = {
      profile,
      providerID: String(input.model.providerID),
      modelID: String(input.model.id),
      apiID: input.model.api.id,
      kind: codex ? ("codex" as const) : ("model" as const),
      window,
      input: capacity,
      output,
      combined,
      source: codex?.source ?? "model-limits",
      revision: codex?.revision ?? digest(input.model.limit),
    }
    return { ...value, hash: digest(value) } satisfies Snapshot
  }

  export async function capture(input: Parameters<typeof freeze>[0]) {
    const profile = input.inherited?.profile ?? configured()
    if (!profile) return undefined
    validate(input.cfg, profile)
    const codex = input.model.codex && (await CodexModels.resolve(input.model.codex, input.model.api.id))
    return freeze({ ...input, model: { ...input.model, codex } })
  }

  export function same(before: Snapshot | undefined, after: Snapshot | undefined) {
    if (before?.hash !== after?.hash || (before && after && digest(before) !== digest(after)))
      throw blocked("An admitted message's context policy is immutable")
  }

  export function thresholds(snapshot: Snapshot) {
    return {
      automaticThreshold: Math.floor((snapshot.window * snapshot.profile.automaticPercent) / 100),
      admissionThreshold: Math.floor((snapshot.window * snapshot.profile.admissionPercent) / 100),
    }
  }

  export function count(tokens: MessageV2.Assistant["tokens"] | undefined) {
    if (!tokens) return null
    const value = Math.max(KiloSessionOverflow.count(tokens), tokens.total ?? 0)
    return Number.isFinite(value) && value > 0 ? value : null
  }

  export function transform(messages: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (part.type === "image" && !model.capabilities.input.image)
          throw blocked("The model cannot receive required image evidence")
        if (part.type === "file" && part.mediaType === "application/pdf" && !model.capabilities.input.pdf)
          throw blocked("The model cannot receive required PDF evidence")
      }
    }
    const seen = new WeakMap<object, unknown>()
    const copy = (value: unknown): unknown => {
      if (value === null || typeof value !== "object") return value
      if (value instanceof URL) return new URL(value.href)
      if (Buffer.isBuffer(value)) return Buffer.from(value)
      if (value instanceof Uint8Array) return new Uint8Array(value)
      if (value instanceof ArrayBuffer) return value.slice(0)
      if (value instanceof Date) return new Date(value.getTime())
      if (seen.has(value)) return seen.get(value)
      if (Array.isArray(value)) {
        const result: unknown[] = []
        seen.set(value, result)
        for (const item of value) result.push(copy(item))
        return result
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null)
        throw blocked("A non-JSON context object cannot be copied safely")
      const result: Record<string, unknown> = {}
      seen.set(value, result)
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(result, key, { value: copy(item), enumerable: true, writable: true, configurable: true })
      }
      return result
    }
    // Bun cannot structuredClone URL instances used by standard image parts.
    return ProviderTransform.message(copy(messages) as ModelMessage[], model, options)
  }

  // next is input plus uncertainty, not a reservation of future output. The
  // output/combined provider constraints are checked independently below.
  export async function estimate(input: {
    messages: ModelMessage[]
    tools: Record<string, Tool>
    options: Record<string, unknown>
    snapshot: Snapshot
    output?: number
    outputLimit?: number
  }) {
    try {
      if (input.options.previousResponseId || input.options.previous_response_id || input.options.conversation)
        throw blocked("Server-retained context cannot be bounded by the complete local request")
      const tools = await Promise.all(
        Object.entries(input.tools).map(async ([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: await asSchema(tool.inputSchema).jsonSchema,
        })),
      )
      const prepared = await KiloContextMedia.prepare({ messages: input.messages, tools, options: input.options })
      const text = JSON.stringify(prepared.value)
      const estimate = Math.max(Token.estimate(text), Buffer.byteLength(text, "utf8") / 4)
      const tokens = Math.ceil(estimate * 1.3) + prepared.tokens
      const allowance =
        input.output === undefined
          ? input.snapshot.output
          : Math.min(input.snapshot.output, input.outputLimit ?? input.snapshot.output)
      const output = input.output ?? allowance
      if (!positive(output) || !positive(allowance) || !Number.isSafeInteger(tokens + output + 2_048))
        throw blocked("Cannot bound request output allowance")
      return { input: tokens, next: tokens + 2_048, output, outputLimit: allowance }
    } catch (error) {
      if (Blocked.isInstance(error)) throw error
      if (error instanceof KiloContextMedia.Unsupported) throw blocked(error.message)
      throw blocked("Complete request token estimate is unavailable")
    }
  }

  export function reason(input: {
    snapshot: Snapshot
    state?: State
    tokens: { input: number; next: number; output: number; outputLimit?: number }
  }) {
    if (input.state?.unresolved) return "unresolved-tool"
    if (input.tokens.output > Math.min(input.snapshot.output, input.tokens.outputLimit ?? input.snapshot.output))
      return "provider-output-capacity"
    if (input.tokens.next > input.snapshot.input) return "provider-input-capacity"
    if (input.snapshot.combined !== null && input.tokens.next + input.tokens.output > input.snapshot.combined)
      return "provider-combined-capacity"
    const limit = thresholds(input.snapshot)
    if (input.tokens.next > limit.admissionThreshold) return "predictive-admission-threshold"
    if ((input.state?.currentTokens ?? 0) >= limit.automaticThreshold) return "reported-usage-threshold"
    return "within-budget"
  }

  export function decide(input: Parameters<typeof reason>[0]) {
    const cause = reason(input)
    if (cause === "unresolved-tool" || cause === "provider-output-capacity") return "blocked" as const
    const soft = cause === "reported-usage-threshold"
    const hard = cause !== "within-budget" && !soft
    if ((hard || soft) && input.state?.reducible && !input.state.attempted) return "compact" as const
    if (hard) return "blocked" as const
    return "admit" as const
  }

  export class Compact extends KiloSessionOverflow.PreflightError {
    constructor(readonly receipt: Receipt) {
      super()
    }
  }

  export function diagnostic(input: {
    snapshot: Snapshot
    sessionID: string
    messageID?: string
    sessionTitle?: string
    phase: "admission" | "compacting" | "compacted" | "blocked"
    reason: string
    currentTokens: number | null
    nextTokens: number | null
  }) {
    return {
      sessionID: input.sessionID,
      messageID: input.messageID,
      sessionTitle: input.sessionTitle?.slice(0, 160),
      providerID: input.snapshot.providerID,
      modelID: input.snapshot.modelID,
      phase: input.phase,
      reason: input.reason.slice(0, 240),
      window: input.snapshot.window,
      ...thresholds(input.snapshot),
      currentTokens: input.currentTokens,
      nextTokens: input.nextTokens,
      profileID: input.snapshot.profile.id,
    }
  }

  export function emit(bus: Bus.Interface, input: Parameters<typeof diagnostic>[0]) {
    const data = diagnostic(input)
    log.info("context", data)
    return bus.publish(Event, data)
  }

  export function admit(input: {
    snapshot: Snapshot
    cfg: Config.Info
    messages: ModelMessage[]
    tools: Record<string, Tool>
    options: Record<string, unknown>
    output?: number
    outputLimit?: number
    state?: State
    sessionID: string
    messageID: string
    sessionTitle?: string
    bus: Bus.Interface
  }) {
    return Effect.gen(function* () {
      const base = { ...input, currentTokens: input.state?.currentTokens ?? null }
      const tokens = yield* Effect.tryPromise({
        try: () => {
          validate(input.cfg, input.snapshot.profile)
          return estimate(input)
        },
        catch: (error) => (Blocked.isInstance(error) ? error : blocked("Complete request estimate failed")),
      }).pipe(
        Effect.tapError(() =>
          emit(input.bus, { ...base, phase: "blocked", reason: "estimate-or-policy-unavailable", nextTokens: null }),
        ),
      )
      const decision = decide({ snapshot: input.snapshot, state: input.state, tokens })
      const cause = reason({ snapshot: input.snapshot, state: input.state, tokens })
      yield* emit(input.bus, {
        ...base,
        phase: input.state?.attempted ? "compacted" : "admission",
        reason: cause,
        nextTokens: tokens.next,
      })
      if (decision === "admit") return undefined
      yield* emit(input.bus, {
        ...base,
        phase: decision === "compact" ? "compacting" : "blocked",
        reason: cause,
        nextTokens: tokens.next,
      })
      if (decision === "blocked") {
        const reasons: Record<string, string> = {
          "unresolved-tool": "An unresolved tool execution prevents safe context admission",
          "provider-output-capacity": "The requested output allowance exceeds the validated provider limit",
          "provider-input-capacity": "The complete next request exceeds the validated provider input limit",
          "provider-combined-capacity": "The next request and its output allowance exceed the provider context limit",
          "predictive-admission-threshold": "The complete next request still exceeds the context admission ceiling",
        }
        return yield* Effect.fail(
          blocked(cause, reasons[cause] ?? "The complete next request cannot be safely admitted"),
        )
      }
      return yield* Effect.fail(
        new Compact({
          source: input.messageID,
          progress: input.state?.progress,
          currentTokens: base.currentTokens,
          nextTokens: tokens.next,
        }),
      )
    })
  }
}
