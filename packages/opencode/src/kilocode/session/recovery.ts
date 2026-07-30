import { MessageError } from "@/session/message-error"
import { MessageV2 } from "@/session/message-v2"
import type { MessageID, SessionID } from "@/session/schema"

export namespace KiloSessionRecovery {
  export const COOLDOWN = 10 * 60 * 1000
  const limit = 280
  const states = new Map<SessionID, State>()
  let seq = 0

  export type Kind = "automatic" | "manual"

  export type Activity = {
    messageID: MessageID
    path: string
    action: "read" | "created" | "modified" | "deleted"
    time: { created: number }
  }

  export type Anchor = {
    sessionID: SessionID
    resumeMessageID: MessageID
    userMessageID?: MessageID
    assistantMessageID?: MessageID
    topic?: string
    needsClarification: boolean
    unfinished: Array<{ callID: string; tool: string; title?: string; status: string }>
    created: string[]
    modified: string[]
    deleted: string[]
    read: string[]
    shared: Array<{ path: string; sessionIDs: SessionID[] }>
  }

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

  const leads = new Set(["please"])
  const refs = new Set([
    "from",
    "where",
    "you",
    "we",
    "i",
    "it",
    "the",
    "response",
    "request",
    "answer",
    "output",
    "were",
    "was",
    "got",
    "has",
    "been",
    "unexpectedly",
    "suddenly",
    "previously",
    "last",
    "left",
    "off",
    "interrupted",
    "aborted",
  ])

  export type Decision =
    | { action: "resume"; count: number; delay: number; token: number; topic: string }
    | { action: "pause"; count: number; topic: string }

  function marker(parts: readonly Part[]) {
    const part = parts.find((item) => item.type === "text" && item.metadata?.auto_resume === true)
    const token = part?.metadata?.recovery_token
    return typeof token === "number" ? token : undefined
  }

  export function detect(parts: readonly Part[]): Kind | undefined {
    const tagged = parts.find((part) => part.type === "text" && part.metadata?.session_resume === true)
    if (tagged) return tagged.metadata?.resume_kind === "automatic" ? "automatic" : "manual"
    if (marker(parts) !== undefined) return "automatic"
    const text = parts
      .filter((part) => part.type === "text" && !part.synthetic)
      .map((part) => part.text ?? "")
      .join(" ")
    return intent(text) ? "manual" : undefined
  }

  export function current(messages: MessageV2.WithParts[]) {
    const user = messages.findLast((message) => message.info.role === "user")
    return user?.info.role === "user" ? detect(user.parts) : undefined
  }

  export function intent(text: string) {
    const tokens: string[] = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
    const index = tokens.indexOf("resume")
    if (index < 0 || tokens.slice(0, index).some((word) => !leads.has(word))) return false
    const tail = tokens.slice(index + 1)
    if (tail.length === 0) return true
    const where = tail.indexOf("where")
    const start = where >= 0 ? where + 1 : 0
    const window = tail.slice(start, start + 5)
    const interrupted = window.indexOf("interrupted")
    const aborted = window.indexOf("aborted")
    const left = window.findIndex((word, offset) => word === "left" && window[offset + 1] === "off")
    const match = interrupted >= 0 ? interrupted : aborted >= 0 ? aborted : left
    if (match < 0) return false
    const length = start + match + (left === match ? 2 : 1)
    if (tail.slice(0, length).some((word) => !refs.has(word))) return false
    return tail.slice(length).every((word) => leads.has(word) || word === "interrupted" || word === "aborted")
  }

  export function anchor(input: {
    sessionID: SessionID
    resumeMessageID: MessageID
    messages: MessageV2.WithParts[]
    activity?: Activity[]
    shared?: Map<string, SessionID[]>
  }): Anchor {
    const index = input.messages.findLastIndex((message) => {
      if (message.info.role !== "user") return false
      if (detect(message.parts)) return false
      return message.parts.some(
        (part) => part.type === "text" && !part.synthetic && !part.ignored && Boolean(part.text.trim()),
      )
    })
    if (index < 0) {
      return {
        sessionID: input.sessionID,
        resumeMessageID: input.resumeMessageID,
        needsClarification: true,
        unfinished: [],
        created: [],
        modified: [],
        deleted: [],
        read: [],
        shared: [],
      }
    }
    const user = input.messages[index]!
    const tail = input.messages.slice(index + 1)
    const assistant = tail.findLast((message) => message.info.role === "assistant")
    const ids = new Set(input.messages.slice(index).map((message) => message.info.id))
    const activity = (input.activity ?? []).filter((item) => ids.has(item.messageID))
    const paths = (action: Activity["action"], limit: number) =>
      unique(
        activity
          .filter((item) => item.action === action)
          .sort((left, right) => right.time.created - left.time.created)
          .map((item) => item.path),
      ).slice(0, limit)
    const writes = activity.filter((item) => item.action !== "read").map((item) => item.path)
    return {
      sessionID: input.sessionID,
      resumeMessageID: input.resumeMessageID,
      userMessageID: user.info.id,
      assistantMessageID: assistant?.info.id,
      topic: summarize([user]),
      needsClarification: false,
      unfinished: tail.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.state.status === "completed") return []
          return [
            {
              callID: part.callID,
              tool: part.tool,
              title: "title" in part.state ? part.state.title : undefined,
              status: part.state.status,
            },
          ]
        }),
      ),
      created: paths("created", 12),
      modified: paths("modified", 12),
      deleted: paths("deleted", 12),
      read: paths("read", 8),
      shared: unique(writes).flatMap((path) => {
        const sessions = input.shared?.get(path) ?? []
        return sessions.length ? [{ path, sessionIDs: sessions }] : []
      }),
    }
  }

  export function parts(parts: readonly Part[], kind: Kind, anchor: Anchor, token?: number) {
    return parts.map((part) => {
      if (part.type !== "text") return part
      return {
        ...part,
        metadata: {
          ...part.metadata,
          session_resume: true,
          resume_kind: kind,
          ...(token !== undefined ? { recovery_token: token, auto_resume: true } : {}),
          ...(anchor.userMessageID ? { anchor_user_message_id: anchor.userMessageID } : {}),
          ...(anchor.assistantMessageID ? { interrupted_assistant_message_id: anchor.assistantMessageID } : {}),
        },
      }
    })
  }

  export function system(value: string | undefined, anchor: Anchor) {
    const block = render(anchor)
    if (!value?.trim()) return block
    const pattern = /<kilo-session-resume>[\s\S]*?<\/kilo-session-resume>/
    if (pattern.test(value)) return value.replace(pattern, block)
    return `${value.trim()}\n\n${block}`
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

  export function text(input: {
    sessionID: SessionID
    topic: string
    userMessageID: MessageID
    assistantMessageID: MessageID
  }) {
    return [
      `Continue where you were interrupted or aborted in session ${input.sessionID} only.`,
      `Original user message: ${input.userMessageID}`,
      `Interrupted assistant message: ${input.assistantMessageID}`,
      `Topic: ${input.topic}`,
      "",
      "Resume from this session's existing chat history and tool results only. Do not use or continue work from another session. Do not infer the task from git status, recently modified files, or shared worktree artifacts because concurrent sessions may be using the same directory. Preserve completed work and continue only the unfinished steps.",
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

  function render(anchor: Anchor) {
    const lines = [
      "<kilo-session-resume>",
      `This is a continuation of session ${anchor.sessionID} only.`,
      "",
      "Resume anchor:",
      anchor.userMessageID
        ? `- Original user message: ${anchor.userMessageID}`
        : "- Original user message: unavailable in this session",
      anchor.assistantMessageID
        ? `- Interrupted assistant message: ${anchor.assistantMessageID}`
        : "- Interrupted assistant message: unavailable",
      anchor.topic ? `- Topic: ${anchor.topic}` : "- Topic: unavailable",
      ...section("Files created by this session", anchor.created),
      ...section("Files modified by this session", anchor.modified),
      ...section("Files deleted by this session", anchor.deleted),
      ...section("Files read by this session", anchor.read),
      ...(anchor.unfinished.length
        ? [
            "",
            "Unfinished tool activity:",
            ...anchor.unfinished.map((item) => `- ${item.tool} (${item.callID}): ${item.status}`),
          ]
        : []),
      ...(anchor.shared.length
        ? [
            "",
            "Files also changed by concurrent sessions:",
            ...anchor.shared.map((item) => `- ${item.path}: ${item.sessionIDs.join(", ")}`),
          ]
        : []),
      "",
      "Use only this session's chronological transcript, tool results, and file activity ledger.",
      "Do not infer the resume target from git status, recently modified files, shared worktree artifacts, project-wide/global semantic memory, or another Kilo session. Concurrent sessions may be modifying the same directory.",
      "Do not search or read another session. Current-session recall is allowed only as supporting evidence.",
      anchor.needsClarification
        ? "This session has no substantive earlier user request. Ask the user to clarify what should be resumed."
        : undefined,
      "</kilo-session-resume>",
    ]
    return lines.filter((line): line is string => line !== undefined).join("\n")
  }

  function section(title: string, paths: string[]) {
    return paths.length ? ["", `${title}:`, ...paths.map((path) => `- ${path}`)] : []
  }

  function unique<T>(values: T[]) {
    return [...new Set(values)]
  }

  /** @internal - test-only helper */
  export function _state(sessionID: SessionID) {
    return states.get(sessionID)
  }
}
