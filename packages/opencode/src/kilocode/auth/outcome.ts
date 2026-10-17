import { Schema } from "effect"

export namespace AuthOutcome {
  export const State = Schema.Literals([
    "unknown",
    "ready",
    "refreshing",
    "transient-unavailable",
    "sign-in-required",
    "account-changed",
    "unmanaged-source",
    "storage-unavailable",
  ])
  export const Source = Schema.Literals(["file", "env", "config", "plugin", "none", "unknown"])
  export const Reason = Schema.Literals([
    "local-valid",
    "refresh-needed",
    "refreshing",
    "exchange-unavailable",
    "exchange-uncertain",
    "refresh-rejected",
    "authority-changed",
    "source-unmanaged",
    "storage-unavailable",
    "unverifiable",
    "external-owner",
    "no-credentials",
  ])
  export type Reason = typeof Reason.Type
  export const Action = Schema.Literals([
    "none",
    "retry-explicitly",
    "sign-in",
    "reload",
    "update-source",
    "check-storage",
  ])
  export const Disruption = Schema.Literals(["none", "provider", "runtime"])
  const details = {
    "local-valid": ["ready", "none", "Credentials are locally available; provider acceptance has not been checked."],
    "refresh-needed": ["unknown", "none", "Credentials need renewal before the next dispatch."],
    refreshing: ["refreshing", "none", "Credentials are being renewed."],
    "exchange-unavailable": [
      "transient-unavailable",
      "retry-explicitly",
      "Credential renewal is temporarily unavailable. No automatic retry was made.",
    ],
    "exchange-uncertain": [
      "unknown",
      "sign-in",
      "The credential exchange outcome is uncertain. Sign in again rather than retrying a possibly consumed token.",
    ],
    "refresh-rejected": ["sign-in-required", "sign-in", "The provider rejected credential renewal. Sign in again."],
    "authority-changed": [
      "account-changed",
      "reload",
      "Authentication authority changed. Start a new request with the intended account.",
    ],
    "source-unmanaged": [
      "unmanaged-source",
      "update-source",
      "This credential source cannot be renewed here. Update the source explicitly.",
    ],
    "storage-unavailable": [
      "storage-unavailable",
      "check-storage",
      "Credential storage is unavailable. No new credentials were accepted.",
    ],
    unverifiable: [
      "unknown",
      "reload",
      "The admitted authentication authority cannot be reconstructed safely. Start a new request.",
    ],
    "external-owner": [
      "unknown",
      "update-source",
      "Credentials are owned by an external provider integration; account changes cannot be verified here.",
    ],
    "no-credentials": [
      "unknown",
      "sign-in",
      "No managed credentials are configured. The provider may support anonymous access.",
    ],
  } as const

  export function detail(reason: Reason) {
    const [state, action, message] = details[reason]
    return { state, action, message }
  }

  export class Failure extends Error {
    readonly isRetryable = false
    readonly state: typeof State.Type
    readonly action: typeof Action.Type
    constructor(
      readonly reason: Reason,
      readonly providerID?: string,
      readonly source?: typeof Source.Type,
    ) {
      const value = detail(reason)
      super(value.message)
      this.name = "CredentialReadinessError"
      this.state = value.state
      this.action = value.action
    }
  }

  export function known(error: unknown): Failure | undefined {
    if (error instanceof Failure) return error
    if (!(error instanceof Error)) return undefined
    if (error.name === "AuthStaleError") return new Failure("authority-changed")
    if (error.name === "AuthSourceError") return new Failure("source-unmanaged")
    if (error.name === "AuthStorageError") return new Failure("storage-unavailable")
    if (error.name === "CodexAuthExpiredError") return new Failure("refresh-rejected")
    return undefined
  }

  export function exchange(error: unknown): never {
    if (control(error)) throw error
    throw known(error) ?? new Failure("exchange-uncertain")
  }

  export function control(error: unknown) {
    return (
      error instanceof Error &&
      /^(AbortError|InterruptedException|RuntimeDisposedError|InstanceDisposedError)$/.test(error.name)
    )
  }

  // Neither provider text nor token values become diagnostics or retry instructions.
  export async function response(response: Response): Promise<Record<string, unknown>> {
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = ""
    let bytes = 0
    try {
      if (reader)
        while (true) {
          const next = await reader.read()
          if (next.done) break
          bytes += next.value.byteLength
          if (bytes > 65_536) {
            await reader.cancel()
            throw new Failure("exchange-uncertain")
          }
          text += decoder.decode(next.value, { stream: true })
        }
      text += decoder.decode()
      const parsed: unknown = JSON.parse(text)
      const value =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
      if (!response.ok) {
        if (
          response.status === 401 ||
          response.status === 403 ||
          (response.status === 400 && (value?.error === "invalid_grant" || value?.error === "invalid_token"))
        )
          throw new Failure("refresh-rejected")
        throw new Failure(
          response.status === 429 || response.status >= 500 ? "exchange-unavailable" : "exchange-uncertain",
        )
      }
      if (!value || typeof value.access_token !== "string" || !value.access_token)
        throw new Failure("exchange-uncertain")
      if (
        typeof value.error === "string" ||
        (value.refresh_token !== undefined && (typeof value.refresh_token !== "string" || !value.refresh_token)) ||
        (value.expires_in !== undefined &&
          (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0))
      )
        throw new Failure("exchange-uncertain")
      return value
    } catch (error) {
      if (!response.ok && !(error instanceof Failure)) {
        throw new Failure(
          response.status === 401 || response.status === 403
            ? "refresh-rejected"
            : response.status === 429 || response.status >= 500
              ? "exchange-unavailable"
              : "exchange-uncertain",
        )
      }
      return exchange(error)
    } finally {
      reader?.releaseLock()
    }
  }
}
