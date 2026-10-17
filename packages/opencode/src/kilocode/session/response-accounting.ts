import { Effect } from "effect"
import { Usage } from "@opencode-ai/llm"
import type { Provider } from "@/provider/provider"
import type { MessageV2 } from "@/session/message-v2"
import { PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { KiloResponse } from "./response"
import { KiloUsage } from "./usage"

export namespace KiloResponseAccounting {
  type Options = Pick<MessageV2.StepFinishPart, "snapshot" | "model">
  export function create(input: {
    session: Session.Interface
    message: MessageV2.Assistant
    model: Provider.Model
    responses: KiloResponse.Collector
    reconcile: () => Effect.Effect<void>
  }) {
    const stored = new Map<string, { part: PartID; meta: PartID; cost: number; fingerprint?: string } & Options>()
    const flush = Effect.fn("KiloResponseAccounting.flush")(function* (options?: Options) {
      for (const receipt of input.responses.receipts) {
        if (!receipt.observed) continue
        const entry = stored.get(receipt.key) ?? { part: PartID.ascending(), meta: PartID.ascending(), cost: 0 }
        stored.set(receipt.key, entry)
        if (options && receipt === input.responses.receipts.at(-1)) Object.assign(entry, options)
        const billing = Session.getUsage({
          model: input.model,
          usage: receipt.usage ?? new Usage({}),
          metadata: receipt.metadata,
        })
        const meta = {
          ...KiloResponse.metadata(receipt),
          measurement: KiloUsage.report(receipt, billing.tokens),
          partID: entry.part,
        }
        const fingerprint = JSON.stringify([meta, billing, receipt.finish, entry.snapshot, entry.model])
        if (entry.fingerprint === fingerprint) continue
        if (receipt.usage || (receipt.finished && receipt.status === "completed")) {
          yield* input.reconcile()
          yield* input.session.updatePart({
            id: entry.part,
            sessionID: input.message.sessionID,
            messageID: input.message.id,
            type: "step-finish",
            reason: receipt.status === "completed" && !receipt.aborted ? (receipt.finish ?? "unknown") : "error",
            snapshot: entry.snapshot,
            ...(entry.model ? { model: entry.model } : {}),
            ...billing,
          })
          input.message.cost += billing.cost - entry.cost
          entry.cost = billing.cost
          if (receipt.usage) input.message.tokens = billing.tokens
        }
        yield* input.session.updatePart({
          id: entry.meta,
          sessionID: input.message.sessionID,
          messageID: input.message.id,
          type: "text",
          text: "",
          ignored: true,
          metadata: { kiloResponse: meta },
        })
        yield* input.session.updateMessage(input.message)
        entry.fingerprint = fingerprint
      }
    })
    // Streaming writes are interruptible; partially persisted upserts retain their stable IDs for cleanup.
    return {
      flush: (options?: Options) =>
        flush(options).pipe(Effect.onInterrupt(() => Effect.sync(() => input.responses.interrupt()))),
    }
  }
}
