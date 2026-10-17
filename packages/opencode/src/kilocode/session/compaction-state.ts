import type { MessageV2 } from "@/session/message-v2"
import { PartID, type MessageID } from "@/session/schema"
import { KiloSessionMessageOrder } from "./message-order"
import { Effect, Exit } from "effect"
import type { Session } from "@/session/session"

export namespace KiloCompactionState {
  function record(message: MessageV2.WithParts): unknown {
    return message.parts.find(
      (part): part is MessageV2.TextPart =>
        part.type === "text" && !!part.ignored && Object.hasOwn(part.metadata ?? {}, "kilo_compaction"),
    )?.metadata?.kilo_compaction
  }
  export function successful(info: MessageV2.Info) {
    return (
      info.role === "assistant" &&
      !info.error &&
      (info.finish === "stop" || info.finish === "end_turn" || info.finish === "tool-calls")
    )
  }

  export function text(message: MessageV2.WithParts) {
    return message.parts
      .flatMap((part) => (part.type === "text" && !part.ignored && part.text.trim() ? [part.text.trim()] : []))
      .join("\n\n")
  }

  export function ready(message: MessageV2.WithParts) {
    const info = message.info
    return (
      info.role === "assistant" && !!info.summary && successful(info) && info.finish !== "tool-calls" && !!text(message)
    )
  }

  export function completed(message: MessageV2.WithParts, marker?: MessageV2.CompactionPart) {
    const info = message.info
    if (info.role !== "assistant" || !ready(message) || (marker && marker.messageID !== info.parentID)) return false
    const marks = message.parts.filter(
      (part): part is MessageV2.TextPart =>
        part.type === "text" && Object.hasOwn(part.metadata ?? {}, "kilo_compaction"),
    )
    // Previously persisted summaries have no commit receipt. Keep their valid
    // stop/end_turn results readable, without accepting partial or empty output.
    if (!marks.length) return true
    if (marks.length !== 1 || !marks[0].ignored) return false
    const state: unknown = marks[0].metadata?.kilo_compaction
    if (!state || typeof state !== "object" || Array.isArray(state)) return false
    if (
      !("version" in state) ||
      state.version !== 1 ||
      !("status" in state) ||
      state.status !== "committed" ||
      !("target" in state) ||
      state.target !== info.id ||
      !("parent" in state) ||
      state.parent !== info.parentID
    )
      return false
    if (!marker && (!("marker" in state) || state.marker !== null || !("tail" in state) || state.tail !== null))
      return false
    return (
      !marker ||
      (marker.messageID === info.parentID &&
        "marker" in state &&
        state.marker === marker.id &&
        "tail" in state &&
        state.tail === (marker.tail_start_id ?? null))
    )
  }

  export function bound(message: MessageV2.WithParts, messages: MessageV2.WithParts[]) {
    if (message.info.role !== "assistant") return false
    const parent = message.info.parentID
    const user = messages.find((item) => item.info.role === "user" && item.info.id === parent)
    if (
      !(
        !!user &&
        completed(
          message,
          user.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction"),
        )
      )
    )
      return false
    const state = record(message)
    if (!state) return true
    if (typeof state !== "object" || !("followup" in state)) return false
    if (state.followup === null) return true
    if (
      !("packet" in state) ||
      !Array.isArray(state.packet) ||
      !state.packet.length ||
      !state.packet.every((id) => typeof id === "string")
    )
      return false
    const packet: string[] = state.packet
    return (
      typeof state.followup === "string" &&
      messages.some((item) => {
        if (item.info.role !== "user" || item.info.id !== state.followup) return false
        if (!packet.every((id) => item.parts.some((part) => part.id === id))) return false
        const mark = item.parts.find(
          (part): part is MessageV2.TextPart =>
            part.type === "text" && !!part.ignored && Object.hasOwn(part.metadata ?? {}, "kilo_compaction_followup"),
        )
        return !mark || mark.metadata?.kilo_compaction_followup === message.info.id
      })
    )
  }

  export function target(message: MessageV2.WithParts) {
    const state = record(message)
    if (
      !state ||
      typeof state !== "object" ||
      !("version" in state) ||
      state.version !== 1 ||
      !("status" in state) ||
      state.status !== "worker" ||
      !("target" in state) ||
      typeof state.target !== "string"
    )
      return undefined
    return state.target as MessageID
  }

  export function followup(message: MessageV2.User, target: MessageID): MessageV2.TextPart {
    return {
      id: PartID.ascending(),
      messageID: message.id,
      sessionID: message.sessionID,
      type: "text",
      text: "",
      ignored: true,
      metadata: { kilo_compaction_followup: target },
    }
  }

  export function visible(messages: MessageV2.WithParts[], source = messages) {
    return messages.flatMap((message) => {
      if (message.info.role !== "user") return [message]
      const mark = message.parts.find(
        (part): part is MessageV2.TextPart =>
          part.type === "text" && !!part.ignored && Object.hasOwn(part.metadata ?? {}, "kilo_compaction_followup"),
      )
      if (!mark) return [message]
      const target = source.find((item) => item.info.id === mark.metadata?.kilo_compaction_followup)
      if (!target) throw new Error("[COMPACTION_INCOMPLETE] A followup has no aggregate result")
      const state = record(target)
      if (
        !state ||
        typeof state !== "object" ||
        !("status" in state) ||
        state.status !== "committed" ||
        !("followup" in state) ||
        state.followup !== message.info.id
      )
        return []
      if (!bound(target, source)) throw new Error("[COMPACTION_INCOMPLETE] A committed followup packet is incomplete")
      // Carry full-source validation into detached model projections, without
      // modifying the durable packet or requiring an intentionally omitted parent.
      return [{ ...message, parts: message.parts.filter((part) => part !== mark) }]
    })
  }

  export function history(messages: Iterable<MessageV2.WithParts>) {
    const all: MessageV2.WithParts[] = []
    const summaries = new Map<MessageID, MessageV2.WithParts[]>()
    let end: number | undefined
    let tail: MessageID | undefined
    for (const message of messages) {
      all.push(message)
      if (end === undefined) {
        if (tail) {
          if (message.info.id === tail) end = all.length
        } else if (message.info.role === "user") {
          const marker = message.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")
          if (
            marker &&
            summaries.get(message.info.id)?.some((summary) => completed(summary, marker) && bound(summary, all))
          ) {
            if (marker.tail_start_id && !all.some((item) => item.info.id === marker.tail_start_id))
              tail = marker.tail_start_id
            else end = all.length
          }
        } else if (ready(message)) {
          const items = summaries.get(message.info.parentID) ?? []
          items.push(message)
          summaries.set(message.info.parentID, items)
        }
      }
      if (end === undefined) continue
      // Read beyond the retained boundary only to authenticate a retained
      // followup whose aggregate lives in an earlier compaction generation.
      const pending = all.slice(0, end).some((item) => {
        if (item.info.role !== "user") return false
        const part = item.parts.find(
          (part): part is MessageV2.TextPart =>
            part.type === "text" && !!part.ignored && Object.hasOwn(part.metadata ?? {}, "kilo_compaction_followup"),
        )
        if (!part) return false
        const target = all.find((item) => item.info.id === part.metadata?.kilo_compaction_followup)
        if (!target) return true
        const state = record(target)
        const parent = target.info.role === "assistant" ? target.info.parentID : undefined
        return (
          !!parent &&
          ready(target) &&
          !!state &&
          typeof state === "object" &&
          "status" in state &&
          state.status === "committed" &&
          !all.some((item) => item.info.id === parent)
        )
      })
      if (!pending) break
    }
    return visible(all.slice(0, end ?? all.length), all).reverse()
  }

  export function publish(input: {
    session: Pick<Session.Interface, "updateMessage" | "updatePart" | "removeMessage">
    message: MessageV2.User
    target: MessageID
  }) {
    return Effect.gen(function* () {
      const message = yield* input.session.updateMessage(input.message)
      yield* input.session.updatePart(followup(message, input.target))
      return message
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? input.session.removeMessage({ sessionID: input.message.sessionID, messageID: input.message.id })
          : Effect.void,
      ),
      Effect.uninterruptible,
    )
  }

  export function mark(input: {
    message: MessageV2.Assistant
    status: "candidate" | "worker" | "committed"
    marker?: MessageV2.CompactionPart
    target?: MessageID
    id?: PartID
    followup?: MessageID
    packet?: PartID[]
  }): MessageV2.TextPart {
    return {
      id: input.id ?? PartID.ascending(),
      messageID: input.message.id,
      sessionID: input.message.sessionID,
      type: "text",
      text: "",
      ignored: true,
      metadata: {
        kilo_compaction: {
          version: 1,
          status: input.status,
          target: input.target ?? input.message.id,
          parent: input.message.parentID,
          marker: input.marker?.id ?? null,
          tail: input.marker?.tail_start_id ?? null,
          followup: input.followup ?? null,
          packet: input.packet ?? null,
        },
      },
    }
  }

  export function latest(messages: MessageV2.WithParts[]) {
    const latest = messages.reduce<{ message: MessageV2.WithParts; index: number } | undefined>(
      (prior, message, index) => {
        if (message.info.role !== "assistant" || message.info.summary || !successful(message.info)) return prior
        return !prior || KiloSessionMessageOrder.compare(message, prior.message, index, prior.index) > 0
          ? { message, index }
          : prior
      },
      undefined,
    )
    if (
      latest &&
      messages.some(
        (message, index) =>
          bound(message, messages) && KiloSessionMessageOrder.compare(message, latest.message, index, latest.index) > 0,
      )
    )
      return undefined
    return latest?.message.info.role === "assistant" ? latest.message.info : undefined
  }
}
