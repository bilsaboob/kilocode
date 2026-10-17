import type { MessageV2 } from "@/session/message-v2"
import type { KiloResponse } from "./response"
import { KiloCompactionState } from "./compaction-state"
import { isRecord } from "@/util/record"

export namespace KiloUsage {
  export type Measurement = {
    version: 1
    tokens: number | null
    lowerBound: number | null
    quality: "reported" | "partial" | "inconsistent" | "unknown" | "legacy"
    observedAt: number | null
  }

  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
  const empty = (): Measurement => ({
    version: 1,
    tokens: null,
    lowerBound: null,
    quality: "unknown",
    observedAt: null,
  })

  function legacy(tokens: MessageV2.Assistant["tokens"] | undefined) {
    if (!tokens) return null
    const fields = [
      tokens.input,
      tokens.output,
      tokens.reasoning,
      tokens.cache?.read,
      tokens.cache?.write,
      tokens.total,
    ]
    if (fields.some((value) => value !== undefined && number(value) === undefined)) return null
    const sum = fields.slice(0, -1).reduce<number>((sum, value) => sum + (number(value) ?? 0), 0)
    const value = Math.max(sum, number(tokens.total) ?? 0)
    return Number.isFinite(value) && value > 0 ? value : null
  }

  export function report(receipt: KiloResponse.Receipt, tokens: MessageV2.Assistant["tokens"]): Measurement {
    const fields = receipt.measurement
    if (!fields || receipt.measurementInvalid) return empty()
    const sum = [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write].reduce<number>(
      (sum, value) => sum + (number(value) ?? 0),
      0,
    )
    const total = number(fields.totalTokens)
    const complete = number(fields.inputTokens) !== undefined && number(fields.outputTokens) !== undefined
    const known = total !== undefined || complete
    const value = Math.max(sum, total ?? 0)
    if (!Number.isFinite(value)) return empty()
    return {
      version: 1,
      tokens: known ? value : null,
      lowerBound: value,
      quality:
        total !== undefined && (total < sum || (complete && total !== sum))
          ? "inconsistent"
          : known
            ? "reported"
            : "partial",
      observedAt: number(receipt.observedAt) ?? null,
    }
  }

  export function read(message: MessageV2.WithParts): Measurement {
    const receipts = message.parts.flatMap((part) => {
      if (part.type !== "text" || !part.ignored || !isRecord(part.metadata?.kiloResponse)) return []
      return [part.metadata.kiloResponse as Record<string, unknown>]
    })
    if (receipts.some((receipt) => receipt.status !== "completed" || receipt.aborted === true)) return empty()
    const measurements = receipts.flatMap((receipt) => {
      const value = receipt.measurement
      if (
        !isRecord(value) ||
        value.version !== 1 ||
        !["reported", "partial", "inconsistent", "unknown"].includes(String(value.quality))
      )
        return []
      if (
        (value.tokens !== null && number(value.tokens) === undefined) ||
        (value.lowerBound !== null && number(value.lowerBound) === undefined) ||
        (value.observedAt !== null && number(value.observedAt) === undefined)
      )
        return []
      if (value.quality === "unknown" && (value.tokens !== null || value.lowerBound !== null)) return []
      if (value.quality === "partial" && value.tokens !== null) return []
      if ((value.quality === "reported" || value.quality === "inconsistent") && value.tokens === null) return []
      if (typeof value.tokens === "number" && typeof value.lowerBound === "number" && value.lowerBound > value.tokens)
        return []
      if (
        typeof receipt.partID !== "string" ||
        !message.parts.some(
          (part) =>
            part.id === receipt.partID &&
            part.type === "step-finish" &&
            (part.reason === "stop" || part.reason === "tool-calls"),
        )
      )
        return []
      return [{ value: value as Measurement, id: receipt.partID }]
    })
    measurements.sort((a, b) => (a.value.observedAt ?? -1) - (b.value.observedAt ?? -1) || a.id.localeCompare(b.id))
    const last = measurements.findLast(({ value }) => value.tokens !== null)?.value
    if (last) return last
    if (measurements.length || receipts.some((receipt) => Object.hasOwn(receipt, "measurement")))
      return measurements.at(-1)?.value ?? empty()
    if (message.info.role !== "assistant") return empty()
    const tokens = legacy(message.info.tokens)
    return tokens === null
      ? empty()
      : {
          version: 1,
          tokens,
          lowerBound: tokens,
          quality: "legacy",
          observedAt: number(message.info.time.completed) ?? null,
        }
  }

  export function latest(messages: MessageV2.WithParts[]) {
    const measured = messages.filter(
      (message) => message.info.role !== "assistant" || message.info.summary || read(message).tokens !== null,
    )
    const last = KiloCompactionState.latest(measured)
    const message = last && messages.find((message) => message.info.id === last.id)
    return message ? { message, measurement: read(message) } : undefined
  }
}
