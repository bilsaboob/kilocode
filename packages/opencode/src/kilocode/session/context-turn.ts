import type { MessageV2 } from "@/session/message-v2"
import { KiloContextPolicy } from "./context-policy"
import { isDeepStrictEqual } from "node:util"

export namespace KiloContextTurn {
  export function identical(
    user: MessageV2.User,
    input: {
      model?: MessageV2.User["model"]
      variant?: string
      agent?: string
      system?: string
      format?: MessageV2.User["format"]
    },
  ) {
    const format =
      input.format?.type === "json_schema"
        ? { ...input.format, retryCount: input.format.retryCount ?? 2 }
        : { ...input.format }
    if (
      (input.model &&
        (input.model.modelID !== user.model.modelID || input.model.providerID !== user.model.providerID)) ||
      (input.variant !== undefined && input.variant !== user.model.variant) ||
      (input.model?.variant !== undefined && input.model.variant !== user.model.variant) ||
      (input.agent !== undefined && input.agent !== user.agent) ||
      (input.system !== undefined && input.system !== user.system) ||
      (input.format !== undefined && !isDeepStrictEqual(format, { ...user.format }))
    )
      throw KiloContextPolicy.blocked("An admitted message's explicit request fields are immutable")
  }

  function partition(messages: MessageV2.WithParts[], source: string) {
    const index = messages.findIndex((message) => message.info.id === source && message.info.role === "user")
    if (index < 0) throw KiloContextPolicy.blocked("The immutable pending turn is missing")
    const tail = messages
      .slice(index + 1)
      .filter((message) => !message.parts.some((part) => part.type === "compaction"))
    const unresolved = messages.some((message) =>
      message.parts.some(
        (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
      ),
    )
    const steps = tail.filter(
      (message) =>
        message.info.role === "assistant" &&
        message.info.parentID === source &&
        !message.info.summary &&
        message.info.finish &&
        !message.info.error &&
        message.parts.some((part) => part.type === "tool") &&
        message.parts.every(
          (part) => part.type !== "tool" || part.state.status === "completed" || part.state.status === "error",
        ),
    )
    const newest =
      steps.length > 1 ? messages.findIndex((message) => message.info.id === steps.at(-1)!.info.id) : index + 1
    const older = messages.slice(index + 1, newest)
    const safe = older.every(
      (message) =>
        message.info.role === "assistant" &&
        message.info.parentID === source &&
        !message.info.summary &&
        !message.info.error &&
        (!!message.info.finish || message.parts.length === 0),
    )
    const boundary = safe && steps.length > 1 ? newest : index + 1
    return {
      index,
      unresolved,
      head: [...messages.slice(0, index), ...messages.slice(index + 1, boundary)],
      tail: boundary > index + 1 ? messages[boundary].info.id : undefined,
    }
  }

  function completed(messages: MessageV2.WithParts[]) {
    return new Set(
      messages.flatMap((message) =>
        message.info.role === "assistant" && message.info.summary && message.info.finish && !message.info.error
          ? [message.info.parentID]
          : [],
      ),
    )
  }

  // Summary markers are transport history, not a replacement user submission.
  // Keep the original user/assistant/tool identities as the active turn.
  export function active(messages: MessageV2.WithParts[]) {
    const done = completed(messages)
    const markers = new Set(
      messages
        .filter(
          (message) =>
            done.has(message.info.id) &&
            message.parts.some((part) => part.type === "compaction" && part.context !== undefined),
        )
        .map((message) => message.info.id),
    )
    return messages.filter(
      (message) =>
        !markers.has(message.info.id) &&
        !(message.info.role === "assistant" && message.info.summary && markers.has(message.info.parentID)),
    )
  }

  export function state(messages: MessageV2.WithParts[], user: MessageV2.User): KiloContextPolicy.State | undefined {
    if (!user.contextPolicy) return undefined
    const responses = messages.filter(
      (message) =>
        message.info.role === "assistant" && !message.info.summary && message.info.finish && !message.info.error,
    )
    const progress = responses.findLast(
      (message) => message.info.role === "assistant" && message.info.parentID === user.id,
    )?.info.id
    const done = completed(messages)
    const attempted = messages.some(
      (message) =>
        done.has(message.info.id) &&
        message.parts.some(
          (part) =>
            part.type === "compaction" && part.context?.source === user.id && part.context.progress === progress,
        ),
    )
    const plan = partition(messages, user.id)
    const latest = responses.at(-1)?.info
    return {
      progress,
      currentTokens: KiloContextPolicy.count(latest?.role === "assistant" ? latest.tokens : undefined),
      attempted,
      unresolved: plan.unresolved,
      reducible:
        !plan.unresolved &&
        plan.head.some((message) =>
          message.parts.some(
            (part) => (part.type === "text" && !!part.text.trim()) || part.type === "tool" || part.type === "file",
          ),
        ),
    }
  }

  export function retain(messages: MessageV2.WithParts[], receipt: KiloContextPolicy.Receipt) {
    const plan = partition(messages, receipt.source)
    if (plan.unresolved)
      throw KiloContextPolicy.blocked("An unresolved tool execution cannot be replaced by compaction")
    return { head: plan.head, tail_start_id: messages[plan.index].info.id, context: { ...receipt, tail: plan.tail } }
  }

  // Only the provider projection omits summarized steps. Original user/media,
  // tool-call/result pairs and every execution receipt remain untouched in storage.
  export function project(messages: MessageV2.WithParts[], part: MessageV2.CompactionPart) {
    if (!part.context?.tail) return messages
    const source = messages.findIndex((message) => message.info.id === part.context!.source)
    const tail = messages.findIndex((message) => message.info.id === part.context!.tail)
    const summary = messages.findIndex(
      (message) =>
        message.info.role === "assistant" &&
        message.info.summary &&
        message.info.parentID === part.messageID &&
        message.info.finish &&
        !message.info.error,
    )
    if (summary < 0) return messages
    if (source < 0 || tail <= source) throw KiloContextPolicy.blocked("The retained tool-history boundary is missing")
    const receipts = messages
      .slice(source + 1, tail)
      .flatMap((message) =>
        message.parts.flatMap((item) =>
          item.type === "tool" ? [`${message.info.id}/${item.callID}: ${item.tool} (${item.state.status})`] : [],
        ),
      )
    const projected = [...messages.slice(0, source + 1), ...messages.slice(tail)]
    const preserved = messages[summary]
    return projected.map((message) =>
      message !== preserved
        ? message
        : {
            ...message,
            parts: message.parts.map((item) =>
              item.type !== "text"
                ? item
                : {
                    ...item,
                    text: `Earlier tool execution receipts (already executed; do not replay these calls merely to reconstruct history. Read-only inspection may be repeated for the pending task; new side effects still require its authorization):\n${receipts.join("\n")}\n\n${item.text}`,
                  },
            ),
          },
    )
  }
}
