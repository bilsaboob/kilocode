import { MessageError } from "@/session/message-error"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"

export namespace KiloSessionRecovery {
  export const COOLDOWN = 10 * 60 * 1000
  const limit = 280
  const states = new Map<SessionID, State>()
  let seq = 0

  type State = {
    count: number
    topic: string
    token: number
    paused: boolean
  }

  type Part = {
    type: string
    text?: string
    synthetic?: boolean
    ignored?: boolean
    metadata?: Record<string, unknown>
  }

  export type Decision =
    | { action: "resume"; count: number; delay: number; token: number; topic: string }
    | { action: "pause"; count: number; topic: string }

  function marker(parts: readonly Part[]) {
    const part = parts.find((item) => item.type === "text" && item.metadata?.auto_resume === true)
    const token = part?.metadata?.recovery_token
    return typeof token === "number" ? token : undefined
  }

  export function begin(sessionID: SessionID, parts: readonly Part[]) {
    const token = marker(parts)
    if (token === undefined) {
      reset(sessionID)
      return "user" as const
    }
    const current = states.get(sessionID)
    if (!current || current.paused || current.token !== token) return "stale" as const
    return "auto" as const
  }

  export function interrupted(msg: MessageV2.Assistant) {
    if (msg.finish === "length") return true
    if (!msg.error) return msg.finish === "error"
    if (MessageV2.AbortedError.isInstance(msg.error)) return false
    if (MessageError.AuthError.isInstance(msg.error)) return false
    if (MessageV2.ContextOverflowError.isInstance(msg.error)) return true
    if (MessageV2.StructuredOutputError.isInstance(msg.error)) return true
    if (MessageError.OutputLengthError.isInstance(msg.error)) return true
    if (!MessageV2.APIError.isInstance(msg.error)) return true
    if (msg.error.data.isRetryable) return true
    const detail = `${msg.error.data.message}\n${msg.error.data.responseBody ?? ""}`.toLowerCase()
    return [
      "context_length_exceeded",
      "context window",
      "maximum context",
      "maximum input",
      "maximum output",
      "token limit",
      "connection reset",
      "socket hang up",
    ].some((item) => detail.includes(item))
  }

  export function finish(input: {
    sessionID: SessionID
    message: MessageV2.Assistant
    messages: MessageV2.WithParts[]
  }): Decision | undefined {
    if (!interrupted(input.message)) {
      reset(input.sessionID)
      return
    }

    const current = states.get(input.sessionID)
    const count = (current?.count ?? 0) + 1
    const topic = current?.topic ?? summarize(input.messages)
    if (count > 3) {
      states.set(input.sessionID, { count, topic, token: current?.token ?? ++seq, paused: true })
      return { action: "pause", count, topic }
    }

    const token = ++seq
    const delay = count === 3 ? COOLDOWN : 0
    states.set(input.sessionID, { count, topic, token, paused: false })
    return { action: "resume", count, delay, token, topic }
  }

  export function claim(sessionID: SessionID, token: number) {
    const current = states.get(sessionID)
    return Boolean(current && !current.paused && current.token === token)
  }

  export function valid(sessionID: SessionID, parts: readonly Part[]) {
    const token = marker(parts)
    return token === undefined || claim(sessionID, token)
  }

  export function source(messages: MessageV2.WithParts[], msg: MessageV2.Assistant) {
    const parent = messages.find((item) => item.info.role === "user" && item.info.id === msg.parentID)
    if (parent?.info.role === "user") return parent.info
    return messages.findLast((item) => item.info.role === "user")?.info as MessageV2.User | undefined
  }

  export function text(topic: string) {
    return [
      "Continue where you were interrupted or aborted on the following topic in this session:",
      topic,
      "",
      "Resume from this session's existing chat history and tool results only. Do not use or continue work from another session. Preserve completed work and continue only the unfinished steps.",
    ].join("\n")
  }

  export function reset(sessionID: SessionID) {
    states.delete(sessionID)
  }

  function summarize(messages: MessageV2.WithParts[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const msg = messages[index]
      if (msg?.info.role !== "user") continue
      const value = msg.parts
        .filter(
          (part): part is MessageV2.TextPart =>
            part.type === "text" &&
            !part.synthetic &&
            !part.ignored &&
            part.metadata?.auto_resume !== true &&
            Boolean(part.text.trim()),
        )
        .map((part) => part.text.trim())
        .join(" ")
        .replace(/\s+/g, " ")
      if (!value) continue
      if (value.length <= limit) return value
      return value.slice(0, limit - 3).trimEnd() + "..."
    }
    return "the current task"
  }

  /** @internal - test-only helper */
  export function _state(sessionID: SessionID) {
    return states.get(sessionID)
  }
}
