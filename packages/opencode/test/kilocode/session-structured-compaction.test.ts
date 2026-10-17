import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { KiloSessionPrompt } from "../../src/kilocode/session/prompt"
import { KiloSessionRecovery } from "../../src/kilocode/session/recovery"
import { KiloStructuredCompaction } from "../../src/kilocode/session/structured-compaction"
import { KiloCompactionBudget } from "../../src/kilocode/session/compaction-budget"
import { Plugin } from "../../src/plugin"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SyncEvent } from "../../src/sync"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const model = ProviderTest.model({ limit: { context: 128_000, output: 8_000 } })
model.capabilities.input.image = true
const ref = { providerID: model.providerID, modelID: model.id }
const cfg = Schema.decodeUnknownSync(Config.Info)({}) as Config.Info
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kF6kAAAAASUVORK5CYII="

function turn(
  sessionID = SessionID.descending(),
  text = "Inspect every region, component, constraint, and preserved relationship.",
) {
  const info: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "build",
    model: ref,
    time: { created: 1 },
    format: {
      type: "json_schema",
      retryCount: 0,
      schema: {
        type: "object",
        required: ["regions", "issues"],
        properties: { regions: { type: "array" }, issues: { type: "array" } },
      },
    },
    tools: { read: false, bash: false },
    system: "Use both original images. Return the complete requested structured report without omitting findings.",
  }
  const parts: MessageV2.Part[] = [
    { id: PartID.ascending(), sessionID, messageID: info.id, type: "text", text },
    ...["target.png", "actual.png"].map(
      (filename): MessageV2.FilePart => ({
        id: PartID.ascending(),
        sessionID,
        messageID: info.id,
        type: "file",
        mime: "image/png",
        filename,
        url: png,
      }),
    ),
  ]
  return { info, parts }
}

function response(source: ReturnType<typeof turn>, input: Partial<MessageV2.Assistant> = {}): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID: source.info.sessionID,
      parentID: source.info.id,
      role: "assistant",
      agent: "build",
      mode: "build",
      modelID: model.id,
      providerID: model.providerID,
      path: { cwd: "/fixture", root: "/fixture" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 2 },
      ...input,
    },
    parts: input.summary
      ? [
          {
            id: PartID.ascending(),
            sessionID: source.info.sessionID,
            messageID: id,
            type: "text",
            text: "Completed summary.",
          },
        ]
      : [],
  }
}

function marker(source: ReturnType<typeof turn>): MessageV2.WithParts {
  const info: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: source.info.sessionID,
    role: "user",
    agent: "build",
    model: ref,
    time: { created: 3 },
  }
  return {
    info,
    parts: [{ id: PartID.ascending(), sessionID: info.sessionID, messageID: info.id, type: "compaction", auto: true }],
  }
}

function plan(messages: MessageV2.WithParts[], overflow?: boolean) {
  return KiloStructuredCompaction.plan({ messages, auto: true, overflow, cfg, model })
}

describe("structured image compaction admission", () => {
  test("ignored budget metadata cannot turn a synthetic continuation into a new structured task", () => {
    const source = turn()
    const followup = marker(source)
    followup.parts = [
      {
        id: PartID.ascending(),
        sessionID: source.info.sessionID,
        messageID: followup.info.id,
        type: "text",
        text: "Continue",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
      {
        id: PartID.ascending(),
        sessionID: source.info.sessionID,
        messageID: followup.info.id,
        type: "text",
        text: "",
        ignored: true,
        metadata: { kilo_compaction_root: source.info.id },
      },
    ]
    expect(KiloStructuredCompaction.pending([source, followup])?.info).toEqual(source.info)
  })
  test("classifies incomplete structured turns without replaying or overwriting provider failures", () => {
    const source = turn()
    for (const finish of [undefined, "unknown"]) {
      const message = response(source, { finish }).info as MessageV2.Assistant
      const error = KiloSessionPrompt.incompleteStructuredOutput(source.info.format!, message, "continue")
      expect(error?.name).toBe("APIError")
      expect(error?.data.isRetryable).toBe(false)
      expect(error?.data.message).toContain("[STRUCTURED_OUTPUT_INCOMPLETE]")
      expect(KiloSessionRecovery.interrupted({ ...message, error })).toBe(false)
      expect(KiloSessionPrompt.incompleteStructuredOutput(source.info.format!, message, "compact")).toBeUndefined()
      expect(KiloSessionPrompt.incompleteStructuredOutput({ type: "text" }, message, "continue")).toBeUndefined()
      const provider = new MessageV2.APIError({
        message: "Original provider diagnostic",
        isRetryable: false,
        responseBody: "retained",
      }).toObject()
      expect(
        KiloSessionPrompt.incompleteStructuredOutput(source.info.format!, { ...message, error: provider }, "stop"),
      ).toBeUndefined()
      expect(
        KiloSessionPrompt.incompleteStructuredOutput(
          source.info.format!,
          { ...message, structured: { regions: [], issues: [] } },
          "continue",
        ),
      ).toBeUndefined()
    }
    for (const finish of ["tool-calls", "stop", "length", "error"]) {
      expect(
        KiloSessionPrompt.incompleteStructuredOutput(
          source.info.format!,
          response(source, { finish }).info as MessageV2.Assistant,
          "continue",
        ),
      ).toBeUndefined()
    }
  })

  test("preserves complete text, schema, system, restrictions, and both original images", () => {
    const source = turn()
    const before = structuredClone(source)
    const result = plan([source, marker(source)])
    expect(result?.error).toBeUndefined()
    expect(result?.replay?.info).toEqual(source.info)
    expect(result?.replay?.parts.slice(0, source.parts.length)).toEqual(source.parts)
    expect(result?.replay?.parts.at(-1)).toMatchObject({ type: "text", ignored: true, synthetic: true })
    expect(source).toEqual(before)
    expect(plan([result!.replay!])?.error?.name).toBe("ContextOverflowError")
    expect(plan([result!.replay!])?.error?.data.message).toContain("already been replayed once")
  })

  test("rejects the oversized complete QA request instead of summarizing away details", () => {
    const source = turn(undefined, "asset-manifest: " + "x".repeat(1_922_653))
    const before = source.parts[0]
    const result = plan([source, marker(source)])
    expect(result?.replay).toBeUndefined()
    expect(result?.error?.name).toBe("ContextOverflowError")
    expect(result?.error?.data.message).toContain("[STRUCTURED_TASK_CONTEXT_LOSS]")
    expect(result?.error?.data.message).toContain("complete request, output schema, and instructions")
    expect(source.parts[0]).toEqual(before)
    expect(source.parts.filter((part) => part.type === "file")).toHaveLength(2)
  })

  test("does not strip media or replace an overflowed provider submission", () => {
    const source = turn()
    const result = plan([source, marker(source)], true)
    expect(result?.replay).toBeUndefined()
    expect(result?.error?.data.message).toContain("required media will not be stripped")
  })

  test("does not schedule automatic recovery for actionable task-integrity failures", () => {
    const source = turn()
    const failure = plan([source], true)!.error!
    const message = response(source, { finish: "error", error: failure, time: { created: 2, completed: 3 } })
    if (message.info.role !== "assistant") throw new Error("expected fixture assistant")
    expect(KiloSessionRecovery.interrupted(message.info)).toBe(false)
    expect(
      KiloSessionRecovery.finish({
        sessionID: source.info.sessionID,
        message: message.info,
        messages: [source, message],
      }),
    ).toBeUndefined()
    const ordinary = {
      ...message.info,
      error: new MessageV2.ContextOverflowError({ message: "ordinary text context overflow" }).toObject(),
    }
    expect(KiloSessionRecovery.interrupted(ordinary)).toBe(true)
  })

  test("does not replace an ambiguous original request", () => {
    const source = turn()
    for (const assistant of [
      response(source),
      response(source, { time: { created: 2, completed: 3 }, finish: "tool-calls" }),
    ]) {
      const result = plan([source, assistant, marker(source)])
      expect(result?.replay).toBeUndefined()
      expect(result?.error?.data.message).toContain("cannot be proven safe to replace")
    }
    const preflight = response(source, { time: { created: 2, completed: 3 } })
    expect(plan([source, preflight, marker(source)], false)?.replay).toBeDefined()
  })

  test("treats successful structured tool-calls as complete without a duplicate replay", () => {
    const source = turn()
    const assistant = response(source, {
      time: { created: 2, completed: 3 },
      finish: "tool-calls",
      structured: { regions: [], issues: [] },
    })
    expect(plan([source, assistant, marker(source)], true)).toEqual({ completed: true })
    expect(KiloStructuredCompaction.pending([source, assistant])).toBeUndefined()
  })

  test("leaves ordinary text-only chat and later unrelated user turns unchanged", () => {
    const source = turn()
    const plain = turn(source.info.sessionID, "Continue normal chat")
    delete plain.info.format
    plain.parts = plain.parts.filter((part) => part.type === "text")
    expect(plan([plain, marker(plain)])).toBeUndefined()
    expect(plan([source, plain, marker(plain)])).toBeUndefined()
    const structured = turn()
    structured.parts = structured.parts.filter((part) => part.type === "text")
    expect(plan([structured, marker(structured)])).toBeUndefined()
  })

  test("does not pretend mutable media links are retained original pixels", () => {
    const source = turn()
    const part = source.parts.find((part) => part.type === "file")!
    part.url = "file:///fixture/image.png"
    expect(plan([source])?.error?.data.message).toContain("not retained as inline evidence")
  })

  test("rejects missing inline pixels and a model without the required image input", () => {
    const source = turn()
    const part = source.parts.find((part) => part.type === "file")!
    part.url = "data:image/png;base64,"
    expect(plan([source])?.error?.data.message).toContain("not retained as inline evidence")
    const capable = turn()
    expect(
      KiloStructuredCompaction.plan({ messages: [capable], auto: true, cfg, model: ProviderTest.model() })?.error?.data
        .message,
    ).toContain("cannot receive the required images")
  })

  test("rejects an unbounded encoded image payload without removing attachments", () => {
    const source = turn()
    const part = source.parts.find((part) => part.type === "file")!
    part.url = "data:image/png;base64," + "A".repeat(16 * 1024 * 1024)
    expect(plan([source])?.error?.data.message).toContain("16 MiB replay payload bound")
    expect(source.parts.filter((part) => part.type === "file")).toHaveLength(2)
  })

  test("protects pending media at the historical-media stripping boundary only", () => {
    const source = turn()
    const compact = marker(source)
    const summary = response(source, {
      summary: true,
      finish: "stop",
      parentID: compact.info.id,
      time: { created: 4, completed: 5 },
    })
    const history = [source, compact, summary]
    const result = KiloSessionPrompt.maybeStripHistoricalMedia(history)
    expect(result[0]!.parts.filter((part) => part.type === "file")).toEqual(
      source.parts.filter((part) => part.type === "file"),
    )
    const complete = response(source, {
      finish: "tool-calls",
      structured: { regions: [], issues: [] },
      time: { created: 2, completed: 3 },
    })
    const retired = KiloSessionPrompt.maybeStripHistoricalMedia([source, complete, compact, summary])
    expect(retired[0]!.parts.some((part) => part.type === "file")).toBe(false)
    expect(source.parts.filter((part) => part.type === "file")).toHaveLength(2)
  })

  test("retains original media behind a bound automatic-recovery continuation", () => {
    const source = turn()
    const compact = marker(source)
    const summary = response(source, {
      summary: true,
      finish: "stop",
      parentID: compact.info.id,
      time: { created: 4, completed: 5 },
    })
    const failed = response(source, {
      error: new MessageV2.StructuredOutputError({ message: "invalid structured output", retries: 0 }).toObject(),
      time: { created: 7, completed: 8 },
    })
    const continuation = turn(source.info.sessionID)
    continuation.parts = [
      {
        id: PartID.ascending(),
        sessionID: source.info.sessionID,
        messageID: continuation.info.id,
        type: "text",
        text: "Continue the same unfinished structured task.",
        metadata: { auto_resume: true, resume_kind: "automatic", anchor_user_message_id: source.info.id },
      },
    ]
    const history = [compact, summary, source, failed, continuation]
    expect(KiloStructuredCompaction.pending(history)?.info.id).toBe(source.info.id)
    const projected = KiloSessionPrompt.maybeStripHistoricalMedia(history)
    expect(projected[2]!.parts.filter((part) => part.type === "file")).toEqual(
      source.parts.filter((part) => part.type === "file"),
    )
    expect(plan(history)?.error?.data.message).toContain("cannot be proven safe to replace")
  })
})

// Only the summarizer's model boundary is substituted. Compaction selection,
// persistence, replay, media filtering, and model-message assembly are real.
const calls: unknown[] = []
const processor = Layer.effect(
  SessionProcessor.Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    return SessionProcessor.Service.of({
      create: Effect.fn("structured-test.create")((input) =>
        Effect.succeed({
          message: input.assistantMessage,
          updateToolCall: Effect.fn("structured-test.updateToolCall")(() => Effect.succeed(undefined)),
          metadata: Effect.fn("structured-test.metadata")(() => Effect.void),
          completeToolCall: Effect.fn("structured-test.completeToolCall")(() => Effect.void),
          process: Effect.fn("structured-test.process")(function* (request) {
            calls.push(request)
            input.assistantMessage.finish = "stop"
            input.assistantMessage.time.completed = Date.now()
            yield* session.updateMessage(input.assistantMessage)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: input.assistantMessage.id,
              sessionID: input.sessionID,
              type: "text",
              text: "Prior conversation summary; no image pixels substituted.",
            })
            return "continue" as const
          }),
        }),
      ),
    })
  }),
).pipe(Layer.provide(Session.defaultLayer))

const deps = Layer.mergeAll(
  ProviderTest.fake({ model }).layer,
  processor,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  SyncEvent.defaultLayer,
  RuntimeFlags.layer({ experimentalEventSystem: true }),
  EventV2Bridge.defaultLayer,
)
const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    SessionCompaction.layer.pipe(Layer.provide(Session.defaultLayer), Layer.provideMerge(deps)),
  ),
)

function store(message: MessageV2.WithParts) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updateMessage(message.info)
    for (const part of message.parts) yield* session.updatePart(part)
    if (message.parts.some((part) => part.type === "compaction"))
      yield* KiloCompactionBudget.inherit({
        sessionID: message.info.sessionID,
        messageID: message.info.id,
        messages: yield* session.messages({ sessionID: message.info.sessionID }),
      })
  })
}

describe("structured image compaction production path", () => {
  it.instance(
    "encodes stored structured formats on list and individual message API reads without losing media or instructions",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const chat = yield* session.create({})
        for (const format of [turn().info.format, { type: "text" as const }, undefined]) {
          const source = turn(chat.id)
          source.info.format = format
          yield* store(source)
          const item = yield* MessageV2.get({ sessionID: chat.id, messageID: source.info.id })
          const encoded = Schema.encodeSync(MessageV2.WithParts)(item)
          expect(encoded.info).toEqual(source.info)
          expect(encoded.parts).toEqual(source.parts)
        }
        const messages = yield* session.messages({ sessionID: chat.id })
        expect(Schema.encodeSync(Schema.Array(MessageV2.WithParts))(messages)).toHaveLength(3)
      }),
  )

  for (const overflow of [undefined, false]) {
    it.instance(
      `keeps the original contract and inline media through ${overflow === false ? "preflight replay" : "automatic continuation"}`,
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const compact = yield* SessionCompaction.Service
          const chat = yield* session.create({})
          const old = turn(chat.id, "Earlier ordinary conversation")
          delete old.info.format
          old.parts = old.parts.filter((part) => part.type === "text")
          yield* store(old)
          const source = turn(chat.id)
          yield* store(source)
          const end = marker(source)
          yield* store(end)
          const before = calls.length
          expect(
            yield* compact.process({
              parentID: end.info.id,
              sessionID: chat.id,
              messages: yield* session.messages({ sessionID: chat.id }),
              auto: true,
              overflow,
            }),
          ).toBe("continue")
          expect(calls.length).toBe(before + 1)
          const all = yield* session.messages({ sessionID: chat.id })
          const replay = all.at(-1)!
          expect(replay.info.role).toBe("user")
          if (replay.info.role !== "user") throw new Error("missing structured replay")
          expect(replay.info.format).toEqual(source.info.format)
          expect(replay.info.tools).toEqual(source.info.tools)
          expect(replay.info.system).toBe(source.info.system)
          expect(
            replay.parts
              .filter((part) => part.type === "file")
              .map((part) => ({ filename: part.filename, url: part.url })),
          ).toEqual(
            source.parts
              .filter((part) => part.type === "file")
              .map((part) => ({ filename: part.filename, url: part.url })),
          )
          expect(
            replay.parts.some(
              (part) => part.type === "text" && part.text === (source.parts[0] as MessageV2.TextPart).text,
            ),
          ).toBe(true)
          const projected = KiloSessionPrompt.maybeStripHistoricalMedia(
            KiloSessionPrompt.trimBeforeLastSummary(yield* MessageV2.filterCompactedEffect(chat.id)),
          )
          const assembled = yield* MessageV2.toModelMessagesEffect(projected, model)
          const original = yield* MessageV2.toModelMessagesEffect([source], model)
          expect(assembled.findLast((message) => message.role === "user")).toEqual(
            original.findLast((message) => message.role === "user"),
          )
          expect(
            assembled
              .filter((message) => message.role === "user")
              .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
              .filter((part) => part.type === "image" || part.type === "file"),
          ).toHaveLength(2)
          expect(
            all
              .find((message) => message.info.id === source.info.id)
              ?.parts.filter((part) => !KiloCompactionBudget.internal(part)),
          ).toEqual(source.parts)
        }),
    )
  }

  for (const scenario of ["oversized", "overflow", "ambiguous"]) {
    it.instance(`stops ${scenario} structured media without a summary or replacement model call`, () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const compact = yield* SessionCompaction.Service
        const chat = yield* session.create({})
        const source = turn(chat.id, scenario === "oversized" ? "x".repeat(1_922_653) : "Inspect both complete images")
        yield* store(source)
        if (scenario === "ambiguous") yield* store(response(source))
        const end = marker(source)
        yield* store(end)
        const before = calls.length
        expect(
          yield* compact.process({
            parentID: end.info.id,
            sessionID: chat.id,
            messages: yield* session.messages({ sessionID: chat.id }),
            auto: true,
            overflow: scenario === "overflow" ? true : undefined,
          }),
        ).toBe("stop")
        expect(calls.length).toBe(before)
        const all = yield* session.messages({ sessionID: chat.id })
        const last = all.at(-1)!
        expect(last.info.role).toBe("assistant")
        if (last.info.role !== "assistant") throw new Error("missing typed task-integrity error")
        expect(last.info.error?.name).toBe("ContextOverflowError")
        if (last.info.error?.name !== "ContextOverflowError") throw new Error("unexpected task-integrity error type")
        expect(last.info.error.data.message).toContain("[STRUCTURED_TASK_CONTEXT_LOSS]")
        expect(last.info.finish).toBe("error")
        expect(last.info.time.completed).toBeDefined()
        expect(all.filter((message) => message.info.role === "user")).toHaveLength(2)
        expect(
          all
            .find((message) => message.info.id === source.info.id)
            ?.parts.filter((part) => !KiloCompactionBudget.internal(part)),
        ).toEqual(source.parts)
      }),
    )
  }

  it.instance("does not auto-continue an already successful structured tool-call", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const compact = yield* SessionCompaction.Service
      const chat = yield* session.create({})
      const source = turn(chat.id)
      yield* store(source)
      const success = response(source, {
        finish: "tool-calls",
        structured: { regions: [], issues: [] },
        time: { created: 2, completed: 3 },
      })
      yield* store(success)
      const end = marker(source)
      yield* store(end)
      expect(
        yield* compact.process({
          parentID: end.info.id,
          sessionID: chat.id,
          messages: yield* session.messages({ sessionID: chat.id }),
          auto: true,
        }),
      ).toBe("continue")
      const all = yield* session.messages({ sessionID: chat.id })
      expect(all.filter((message) => message.info.role === "user")).toHaveLength(2)
      expect(all.find((message) => message.info.id === success.info.id)?.info).toEqual(success.info)
      expect(all.at(-1)?.info.role).toBe("assistant")
    }),
  )

  it.instance("keeps ordinary chat's existing generic automatic continuation", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const compact = yield* SessionCompaction.Service
      const chat = yield* session.create({})
      const source = turn(chat.id, "Ordinary chat")
      delete source.info.format
      source.parts = source.parts.filter((part) => part.type === "text")
      yield* store(source)
      const end = marker(source)
      yield* store(end)
      expect(
        yield* compact.process({
          parentID: end.info.id,
          sessionID: chat.id,
          messages: yield* session.messages({ sessionID: chat.id }),
          auto: true,
        }),
      ).toBe("continue")
      const last = (yield* session.messages({ sessionID: chat.id })).at(-1)!
      expect(
        last.parts.some(
          (part) =>
            part.type === "text" &&
            part.metadata?.compaction_continue === true &&
            part.text.includes("Continue if you have next steps"),
        ),
      ).toBe(true)
      if (last.info.role === "user") expect(last.info.format).toBeUndefined()
    }),
  )
})
