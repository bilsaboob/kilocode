import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import type { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import type { SessionProcessor } from "@/session/processor"
import type { MessageID, SessionID } from "@/session/schema"
import { KiloResponse } from "./response"
import { KiloCompactionBudget } from "./compaction-budget"
import { KiloAuth } from "../auth/authority"

type Update = <T extends MessageV2.Part>(part: T) => Effect.Effect<T>
type UpdateMessage = <T extends MessageV2.Info>(msg: T) => Effect.Effect<T>

const pattern = /request entity too large|function_payload_too_large/i

export namespace KiloCompactionPayloadRecovery {
  export function matches(error: MessageV2.Assistant["error"]) {
    if (!error) return false
    if (error.name !== "ContextOverflowError" && error.name !== "APIError") return false
    if (KiloResponse.blocked(error) || KiloCompactionBudget.blocked(error)) return false
    return pattern.test([error.data.message, error.data.responseBody].filter(Boolean).join("\n"))
  }

  export function prompt(text: string) {
    return [
      "The previous compaction request exceeded the provider's 4MB payload limit.",
      "Older tool outputs and media attachments were removed from this compaction request.",
      text,
    ].join("\n\n")
  }

  export function strip(messages: MessageV2.WithParts[]) {
    return messages.map((msg) => ({
      ...msg,
      parts: msg.parts.map((part): MessageV2.Part => {
        if (part.type === "tool" && part.state.status === "completed" && !part.state.time.compacted) {
          return { ...part, state: { ...part.state, time: { ...part.state.time, compacted: Date.now() } } }
        }
        if (part.type === "file" && MessageV2.isMedia(part.mime)) {
          return {
            id: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
            type: "text",
            text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
          }
        }
        return part
      }),
    }))
  }

  export function process(input: {
    processor: SessionProcessor.Handle
    user: MessageV2.User
    agent: Agent.Info
    sessionID: SessionID
    model: Provider.Model
    messages: LLM.StreamInput["messages"]
    prompt: string
    recovery: MessageV2.WithParts[]
    updateMessage: UpdateMessage
    updatePart: Update
  }) {
    const run = Effect.fn("KiloCompactionPayloadRecovery.process")(function* (
      messages: LLM.StreamInput["messages"],
      text: string,
    ) {
      yield* KiloCompactionBudget.check
      return yield* input.processor.process({
        user: input.user,
        authAuthority: KiloAuth.selected(input.user, input.model),
        agent: input.agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...messages,
          {
            role: "user",
            content: [{ type: "text", text }],
          },
        ],
        model: input.model,
      })
    })

    return run(input.messages, input.prompt).pipe(
      Effect.flatMap((result) => {
        if (input.user.contextPolicy) return Effect.succeed(result)
        if (result !== "compact" && (result !== "stop" || !matches(input.processor.message.error))) {
          return Effect.succeed(result)
        }
        if (result === "compact" && !matches(input.processor.compactError?.())) {
          return Effect.succeed(result)
        }
        return Effect.gen(function* () {
          input.processor.message.error = undefined
          input.processor.message.finish = undefined
          yield* input.updateMessage(input.processor.message)
          for (const part of MessageV2.parts(input.processor.message.id)) {
            if (part.type === "text" && !part.ignored) yield* input.updatePart({ ...part, ignored: true })
          }
          const stripped = yield* MessageV2.toModelMessagesEffect(strip(input.recovery), input.model, {
            stripMedia: true,
            toolOutputMaxChars: 0,
          })
          return yield* run(stripped, prompt(input.prompt))
        })
      }),
      (work) => KiloCompactionBudget.run({ sessionID: input.sessionID, messageID: input.user.id }, work),
    )
  }
}
