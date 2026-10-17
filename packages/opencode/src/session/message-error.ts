import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { AuthOutcome } from "@/kilocode/auth/outcome" // kilocode_change

export const OutputLengthError = NamedError.create("MessageOutputLengthError", {})

export const AuthError = NamedError.create("ProviderAuthError", {
  // kilocode_change start - bounded credential diagnostics
  reason: Schema.optional(AuthOutcome.Reason),
  state: Schema.optional(AuthOutcome.State),
  action: Schema.optional(AuthOutcome.Action),
  source: Schema.optional(AuthOutcome.Source),
  // kilocode_change end
  providerID: Schema.String,
  message: Schema.String,
})

export const Shared = [AuthError.EffectSchema, NamedError.Unknown.EffectSchema, OutputLengthError.EffectSchema] as const
export const SharedSchema = Schema.Union(Shared)

export * as MessageError from "./message-error"
