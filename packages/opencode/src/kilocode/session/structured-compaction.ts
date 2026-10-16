import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { usable } from "@/session/overflow"
import { PartID } from "@/session/schema"
import { Token } from "@/util/token"
import { KiloSessionOverflow } from "./overflow"

type Turn = { info: MessageV2.User; parts: MessageV2.Part[] }
type Plan = {
  replay?: Turn
  completed?: boolean
  error?: ReturnType<InstanceType<typeof MessageV2.ContextOverflowError>["toObject"]>
}

const MARKER = "kilo_structured_replay"
const PREFIX = "[STRUCTURED_TASK_CONTEXT_LOSS]"
const BYTES = 16 * 1024 * 1024

function current(messages: MessageV2.WithParts[]) {
  const source = messages.findLast(
    (msg) =>
      msg.info.role === "user" &&
      !msg.parts.some((part) => part.type === "compaction") &&
      !(
        msg.parts.length > 0 &&
        msg.parts.every(
          (part) =>
            part.type === "text" &&
            ((part.synthetic && part.metadata?.compaction_continue === true) ||
              (part.metadata?.auto_resume === true &&
                part.metadata?.resume_kind === "automatic" &&
                typeof part.metadata?.anchor_user_message_id === "string")),
        )
      ),
  )
  if (source?.info.role !== "user" || source.info.format?.type !== "json_schema") return
  if (!source.parts.some((part) => part.type === "file" && MessageV2.isMedia(part.mime))) return
  const turn: Turn = { info: source.info, parts: source.parts }
  const responses = messages.filter(
    (msg) => msg.info.role === "assistant" && msg.info.parentID === source.info.id && !msg.info.summary,
  )
  const completed = responses.some(
    (msg) =>
      msg.info.role === "assistant" &&
      msg.info.time.completed !== undefined &&
      !msg.info.error &&
      msg.info.structured !== undefined &&
      msg.info.structured !== null,
  )
  const continued = messages
    .slice(messages.indexOf(source) + 1)
    .some(
      (msg) =>
        msg.info.role === "user" &&
        msg.parts.some((part) => part.type === "text" && part.metadata?.auto_resume === true),
    )
  return { turn, responses, completed, continued }
}

export namespace KiloStructuredCompaction {
  export function blocked(error: MessageV2.Assistant["error"]) {
    return error?.name === "ContextOverflowError" && error.data.message.startsWith(PREFIX)
  }

  export function pending(messages: MessageV2.WithParts[]) {
    const task = current(messages)
    return task?.completed ? undefined : task?.turn
  }

  export function plan(input: {
    messages: MessageV2.WithParts[]
    auto: boolean
    overflow?: boolean
    cfg: Config.Info
    model: Provider.Model
    outputTokenMax?: number
  }): Plan | undefined {
    const task = current(input.messages)
    if (!task) return
    // StructuredOutput can succeed with finish=tool-calls; its persisted result,
    // not the provider's finish spelling, establishes task completion.
    if (task.completed) return { completed: true }
    const fail = (reason: string): Plan => ({
      error: new MessageV2.ContextOverflowError({
        message:
          PREFIX +
          " The pending structured image request cannot continue safely after compaction: " +
          reason +
          ". No further model request was submitted. Reissue a bounded request preserving the complete output schema, instructions, and required images; do not retry the same oversized payload.",
      }).toObject(),
    })
    if (!input.auto) return fail("manual compaction would discard the pending task's required inputs")
    if (input.overflow) return fail("the provider rejected the original context; required media will not be stripped")
    if (task.turn.parts.some((part) => part.type === "text" && part.metadata?.[MARKER])) {
      return fail("the intact task has already been replayed once")
    }
    // Only an unsubmitted task, or a completed preflight-only attempt, can be
    // replayed. Never replace an in-flight or tool-executed model request.
    if (
      task.continued ||
      task.responses.some(
        (msg) =>
          msg.info.role === "assistant" &&
          (input.overflow !== false ||
            msg.info.time.completed === undefined ||
            msg.info.error !== undefined ||
            msg.info.finish !== undefined ||
            msg.parts.some((part) => part.type === "tool" || part.type === "text" || part.type === "reasoning")),
      )
    ) {
      return fail("the original model submission is unresolved or cannot be proven safe to replace")
    }
    if (
      task.turn.parts.some(
        (part) =>
          part.type === "file" &&
          MessageV2.isMedia(part.mime) &&
          (!part.url.startsWith(`data:${part.mime};base64,`) || part.url.length === `data:${part.mime};base64,`.length),
      )
    ) {
      return fail("required media is not retained as inline evidence")
    }
    if (
      task.turn.parts.some(
        (part) =>
          part.type === "file" &&
          ((part.mime.startsWith("image/") && !input.model.capabilities.input.image) ||
            (part.mime === "application/pdf" && !input.model.capabilities.input.pdf)),
      )
    ) {
      return fail("the selected model cannot receive the required images")
    }
    const payload = {
      format: task.turn.info.format,
      system: task.turn.info.system,
      tools: task.turn.info.tools,
      parts: task.turn.parts,
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > BYTES) {
      return fail("the intact request exceeds the 16 MiB replay payload bound")
    }
    const text = JSON.stringify(payload, function (this: unknown, key, value: unknown) {
      if (
        key === "url" &&
        this &&
        typeof this === "object" &&
        "type" in this &&
        this.type === "file" &&
        "mime" in this &&
        typeof this.mime === "string" &&
        MessageV2.isMedia(this.mime)
      ) {
        return "[required media retained]"
      }
      return value
    })
    const capacity = KiloSessionOverflow.limit({ ...input, usable: usable(input) })
    // Leave half the effective context for the summary, system/tool overhead,
    // and vision tokens. This is admission only: no original text is clipped.
    if (capacity <= 0 || Math.ceil(Token.estimate(text) * 1.3) >= Math.floor(capacity / 2)) {
      return fail("the complete request, output schema, and instructions exceed the safe replay context budget")
    }
    return {
      replay: {
        info: task.turn.info,
        parts: [
          ...task.turn.parts,
          {
            id: PartID.ascending(),
            messageID: task.turn.info.id,
            sessionID: task.turn.info.sessionID,
            type: "text",
            text: "",
            synthetic: true,
            ignored: true,
            metadata: { [MARKER]: task.turn.info.id },
          },
        ],
      },
    }
  }
}
