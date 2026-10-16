import { afterEach, beforeEach, expect } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LLMClient } from "@opencode-ai/llm/route"
import { Effect, Fiber, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Image } from "@/image/image"
import { Command } from "@/command"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Question } from "@/question"
import { Reference } from "@/reference/reference"
import { KiloContextPolicy } from "@/kilocode/session/context-policy"
import { KiloContextTurn } from "@/kilocode/session/context-turn"
import { KiloSessionMessageOrder } from "@/kilocode/session/message-order"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionRevert } from "@/session/revert"
import { SystemPrompt } from "@/session/system"
import { Instruction } from "@/session/instruction"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { png } from "./fixture/context-image"

const profile = JSON.stringify({ version: 1, window: "maximum-supported", automaticPercent: 85, admissionPercent: 95 })
const previous = process.env.ZEN_KILO_CONTEXT_POLICY
const cfg = Schema.decodeUnknownSync(Config.Info)({
  snapshot: false,
  compaction: { auto: true, threshold_percent: 85 },
}) as Config.Info
let effective = cfg
let pause = false
let agentRun = false
let sequence = 0
const executions = new Map<number, number>()
let started = Promise.withResolvers<void>()
const calls: LanguageModelV3CallOptions[] = []
beforeEach(() => {
  process.env.ZEN_KILO_CONTEXT_POLICY = profile
  calls.length = 0
  pause = false
  agentRun = false
  sequence = 0
  executions.clear()
  effective = cfg
  started = Promise.withResolvers<void>()
})
afterEach(() => {
  if (previous === undefined) delete process.env.ZEN_KILO_CONTEXT_POLICY
  else process.env.ZEN_KILO_CONTEXT_POLICY = previous
})

const model = ProviderTest.model({
  limit: { context: 200_000, output: 4_096 },
  codex: {
    status: "ready",
    context: 32_000,
    maximum: 100_000,
    effectivePercent: 95,
    source: "fake-catalog",
    revision: "r1",
  },
})
model.capabilities.input.image = true
const ref = { providerID: model.providerID, modelID: model.id }
const language: LanguageModelV3 = {
  specificationVersion: "v3",
  provider: "fixture",
  modelId: model.id,
  supportedUrls: {},
  doGenerate: async () => {
    throw new Error("Unexpected generate")
  },
  doStream: async (input) => {
    calls.push(input)
    const task = agentRun && input.tools?.some((tool) => tool.name === "fixture")
    const step = task && sequence < 3 ? ++sequence : undefined
    started.resolve()
    if (pause)
      return new Promise((_, reject) => {
        if (input.abortSignal?.aborted) return reject(new DOMException("Stopped", "AbortError"))
        input.abortSignal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), {
          once: true,
        })
      })
    return {
      stream: new ReadableStream({
        start(controller) {
          if (step)
            controller.enqueue({
              type: "tool-call",
              toolCallId: `execution-${step}`,
              toolName: "fixture",
              input: JSON.stringify({ step }),
            })
          if (!step) {
            controller.enqueue({ type: "text-start", id: "text" })
            controller.enqueue({ type: "text-delta", id: "text", delta: "Bounded fixture summary or answer." })
            controller.enqueue({ type: "text-end", id: "text" })
          }
          controller.enqueue({
            type: "finish",
            finishReason: { unified: step ? "tool-calls" : "stop", raw: step ? "tool-calls" : "stop" },
            usage: {
              inputTokens: {
                total: step === 3 ? 85_000 : 10,
                noCache: step === 3 ? 85_000 : 10,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 10, text: 10, reasoning: 0 },
            },
          })
          controller.close()
        },
      }),
    }
  },
}
const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [],
  prompt: "Fixture agent instructions",
}
const config = Layer.mock(Config.Service, { get: () => Effect.sync(() => effective) })
const plugin = Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) })
const agents = Layer.mock(Agent.Service, { get: (name) => Effect.succeed({ ...agent, name }) })
const provider = ProviderTest.fake({ model, getLanguage: () => Effect.succeed(language) }).layer
const flags = RuntimeFlags.layer({ experimentalEventSystem: false, experimentalNativeLlm: false })
const deps = Layer.mergeAll(
  config,
  plugin,
  agents,
  provider,
  flags,
  Bus.layer,
  Session.defaultLayer,
  Permission.defaultLayer,
  Image.defaultLayer,
  EventV2Bridge.defaultLayer,
  Layer.mock(Snapshot.Service, { track: () => Effect.succeed(undefined) }),
  Layer.mock(SessionSummary.Service, { summarize: () => Effect.void }),
  SessionStatus.defaultLayer,
)
const llm = LLM.layer.pipe(
  Layer.provide(
    Layer.mock(Auth.Service, {
      get: () => Effect.succeed({ type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 60_000 }),
    }),
  ),
  Layer.provide(Layer.mock(LLMClient.Service, {})),
  Layer.provideMerge(deps),
)
const processors = SessionProcessor.layer.pipe(Layer.provideMerge(llm))
const compactor = SessionCompaction.layer.pipe(Layer.provideMerge(processors))
const it = testEffect(Layer.mergeAll(compactor, CrossSpawnSpawner.defaultLayer))
const prompts = SessionPrompt.layer.pipe(
  Layer.provideMerge(compactor),
  Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
  Layer.provide(Layer.mock(Command.Service, {})),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Layer.mock(LSP.Service, {})),
  Layer.provide(Layer.mock(MCP.Service, { tools: () => Effect.succeed({}) })),
  Layer.provide(Layer.mock(Question.Service, { dismissAll: () => Effect.void })),
  Layer.provide(Layer.mock(Reference.Service, {})),
  Layer.provide(
    Layer.mock(ToolRegistry.Service, {
      tools: () =>
        Effect.succeed(
          agentRun
            ? [
                {
                  id: "fixture",
                  description: "Offline side effect receipt",
                  parameters: Schema.Struct({ step: Schema.Number }),
                  execute: (args: unknown) =>
                    Effect.sync(() => {
                      const input = Schema.decodeUnknownSync(Schema.Struct({ step: Schema.Number }))(args)
                      executions.set(input.step, (executions.get(input.step) ?? 0) + 1)
                      return {
                        title: `Step ${input.step}`,
                        output: `Completed operation ${input.step}: ` + "evidence ".repeat(1_000),
                        metadata: {},
                      }
                    }),
                },
              ]
            : [],
        ),
    }),
  ),
  Layer.provide(Layer.mock(Truncate.Service, {})),
  Layer.provide(Layer.mock(SessionRevert.Service, { cleanup: () => Effect.void })),
  Layer.provide(Layer.mock(Instruction.Service, { clear: () => Effect.void, system: () => Effect.succeed([]) })),
  Layer.provide(
    Layer.mock(SystemPrompt.Service, { skills: () => Effect.succeed(""), environment: () => Effect.succeed([]) }),
  ),
  Layer.provide(SessionRunState.defaultLayer),
)
const queued = testEffect(prompts)

function user(sessionID: SessionID, text: string): MessageV2.WithParts & { info: MessageV2.User } {
  const info: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "build",
    model: ref,
    time: { created: Date.now() },
    contextPolicy: KiloContextPolicy.freeze({ cfg, model }),
    format: { type: "json_schema", retryCount: 0, schema: { type: "object", required: ["answer"] } },
    system: "Keep the original task contract",
    tools: { bash: false },
  }
  return { info, parts: [{ id: PartID.ascending(), sessionID, messageID: info.id, type: "text", text }] }
}
function assistant(user: MessageV2.User): MessageV2.Assistant {
  return {
    id: MessageID.ascending(),
    parentID: user.id,
    sessionID: user.sessionID,
    role: "assistant",
    agent: "build",
    mode: "build",
    modelID: model.id,
    providerID: model.providerID,
    path: { cwd: "/fixture", root: "/fixture" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  }
}
function store(message: MessageV2.WithParts) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updateMessage(message.info)
    for (const part of message.parts) yield* session.updatePart(part)
  })
}
function run(user: MessageV2.User, messages: MessageV2.WithParts[], state = KiloContextTurn.state(messages, user)) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const processor = yield* SessionProcessor.Service
    const msg = yield* sessions.updateMessage(assistant(user))
    const handle = yield* processor.create({ assistantMessage: msg, sessionID: user.sessionID, model })
    const result = yield* handle.process({
      user,
      agent,
      model,
      sessionID: user.sessionID,
      context: state,
      system: ["System fixture"],
      messages: yield* MessageV2.toModelMessagesEffect(messages, model),
      tools: {},
    })
    return { result, handle }
  })
}
function compact(user: MessageV2.User, receipt: KiloContextPolicy.Receipt, auto = true) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    const service = yield* SessionCompaction.Service
    yield* service.create({
      sessionID: user.sessionID,
      agent: user.agent,
      model: user.model,
      auto,
      overflow: false,
      contextPolicy: user.contextPolicy,
      context: receipt,
    })
    const messages = yield* session.messages({ sessionID: user.sessionID })
    return yield* service.process({
      sessionID: user.sessionID,
      parentID: messages.at(-1)!.info.id,
      messages,
      auto,
      overflow: false,
    })
  })
}

it.instance("tool continuation compacts history, preserves exact task/tools, stays busy and dispatches once", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service
    const events: unknown[] = []
    const listener = (event: { payload: { type: string; properties?: unknown } }) => {
      if (event.payload.type === "session.context") events.push(event.payload.properties)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", listener)),
      () => Effect.sync(() => GlobalBus.off("event", listener)),
    )
    const chat = yield* session.create({})
    const old = user(chat.id, "Earlier history")
    const pending = user(chat.id, "Do not repeat the completed write; inspect the retained evidence")
    pending.parts.push({
      id: PartID.ascending(),
      messageID: pending.info.id,
      sessionID: chat.id,
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
    })
    yield* store(old)
    yield* store(pending)
    const done = assistant(pending.info)
    done.finish = "tool-calls"
    done.time.completed = Date.now()
    done.tokens.input = 85_000
    const tool: MessageV2.ToolPart = {
      id: PartID.ascending(),
      messageID: done.id,
      sessionID: chat.id,
      type: "tool",
      tool: "write",
      callID: "write-once",
      state: {
        status: "completed",
        input: { path: "fixture" },
        output: "saved exactly once",
        title: "saved",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }
    yield* store({ info: done, parts: [tool] })
    const first = yield* run(pending.info, yield* session.messages({ sessionID: chat.id }))
    expect(first.result).toBe("compact")
    expect(calls).toHaveLength(0)
    expect(yield* status.get(chat.id)).toEqual({ type: "busy" })
    expect(yield* compact(pending.info, first.handle.contextReceipt!()!)).toBe("continue")
    expect(yield* status.get(chat.id)).toEqual({ type: "busy" })
    const projected = yield* MessageV2.filterCompactedEffect(chat.id)
    expect(KiloSessionMessageOrder.latest(KiloContextTurn.active(projected)).user?.id).toBe(pending.info.id)
    expect(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id })).toEqual(pending)
    expect((yield* MessageV2.get({ sessionID: chat.id, messageID: done.id })).parts).toEqual([tool])
    const summaries = calls.length
    const next = yield* run(pending.info, projected)
    expect(next.result).toBe("continue")
    expect(calls).toHaveLength(summaries + 1)
    expect(JSON.stringify(calls.at(-1)!.prompt)).toContain("saved exactly once")
    expect(events.some((event) => (event as { phase: string }).phase === "compacting")).toBe(true)
    expect(events.some((event) => (event as { phase: string }).phase === "compacted")).toBe(true)
  }),
)

it.instance("post-compaction irreducible structured text makes zero task POSTs and persists a nonretryable error", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* session.create({})
    const old = user(chat.id, "Earlier history")
    const pending = user(chat.id, "x".repeat(400_000))
    yield* store(old)
    yield* store(pending)
    const first = yield* run(pending.info, [old, pending])
    expect(first.result).toBe("compact")
    expect(calls).toHaveLength(0)
    expect(yield* compact(pending.info, first.handle.contextReceipt!()!)).toBe("continue")
    const summaries = calls.length
    const next = yield* run(pending.info, yield* MessageV2.filterCompactedEffect(chat.id))
    expect(next.result).toBe("stop")
    expect(next.handle.message.error?.name).toBe("ContextAdmissionError")
    expect(calls).toHaveLength(summaries)
    expect((yield* MessageV2.get({ sessionID: chat.id, messageID: next.handle.message.id })).info).toMatchObject({
      error: { name: "ContextAdmissionError", data: { isRetryable: false } },
    })
    expect(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id })).toEqual(pending)
  }),
)

it.instance("configuration conflict blocks before provider dispatch", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* session.create({})
    const pending = user(chat.id, "A small task")
    yield* store(pending)
    effective = { ...cfg, compaction: { auto: false, threshold_percent: 65 } }
    const next = yield* run(pending.info, [pending])
    expect(next.result).toBe("stop")
    expect(next.handle.message.error?.name).toBe("ContextAdmissionError")
    expect(calls).toHaveLength(0)
  }),
)

it.instance("a real multi-megabyte screenshot is admitted as image context, not base64 text", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* session.create({})
    const pending = user(chat.id, "Inspect the original screenshot")
    delete pending.info.format
    const url = `data:image/png;base64,${png(1920, 1072, 0).toString("base64")}`
    expect(url.length).toBeGreaterThan(2_000_000)
    pending.parts.push({
      id: PartID.ascending(),
      messageID: pending.info.id,
      sessionID: chat.id,
      type: "file",
      mime: "image/png",
      url,
    })
    yield* store(pending)
    const result = yield* run(pending.info, [pending])
    expect(result.handle.message.error).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(
      calls[0].prompt.some(
        (message) =>
          message.role === "user" &&
          message.content.some((part) => part.type === "file" && part.mediaType === "image/png"),
      ),
    ).toBe(true)
    expect((yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id })).parts).toEqual(pending.parts)
  }),
)

it.instance("Stop during compaction cancels the worker without a replacement task dispatch", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* session.create({})
    const old = user(chat.id, "Earlier history")
    const pending = user(chat.id, "Original pending task")
    yield* store(old)
    yield* store(pending)
    pause = true
    const fiber = yield* compact(pending.info, {
      source: pending.info.id,
      currentTokens: 85_000,
      nextTokens: 90_000,
    }).pipe(Effect.forkChild)
    yield* Effect.promise(() => started.promise)
    yield* Fiber.interrupt(fiber)
    expect(calls).toHaveLength(1)
    const all = yield* session.messages({ sessionID: chat.id })
    expect(
      all.some(
        (message) =>
          message.info.role === "assistant" && message.info.summary && message.info.finish && !message.info.error,
      ),
    ).toBe(false)
    expect(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id })).toEqual(pending)
  }),
)

it.instance("snapshot survives persistence/fork and cannot be replaced by a later update", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* session.create({})
    const pending = user(chat.id, "Original task")
    yield* store(pending)
    const fork = yield* session.fork({ sessionID: chat.id })
    const cloned = (yield* session.messages({ sessionID: fork.id }))[0]
    expect(cloned.info).toMatchObject({ contextPolicy: pending.info.contextPolicy })
    const exit = yield* session.updateMessage({ ...pending.info, contextPolicy: undefined }).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id })).toEqual(pending)
    expect(calls).toHaveLength(0)
  }),
)

queued.instance(
  "admission freezes before enqueue, reconnect reuses the original submission and defaults cannot replace it",
  () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* session.create({ title: "Fixture policy session" })
      const id = MessageID.ascending()
      const input = {
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text" as const, text: "Original submission" }],
      }
      const first = yield* prompt.prompt(input)
      expect(first.info).toMatchObject({ contextPolicy: { window: 100_000 } })
      effective = { ...cfg, compaction: { auto: false, threshold_percent: 65 } }
      const again = yield* prompt.prompt(input)
      expect(again).toEqual(first)
      expect(yield* session.messages({ sessionID: chat.id })).toHaveLength(1)
      expect(calls).toHaveLength(0)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info).toMatchObject({ error: { name: "ContextAdmissionError" } })
      expect(calls).toHaveLength(0)
    }),
)

queued.instance("the original queued turn completes after automatic history compaction without synthetic replay", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const chat = yield* session.create({ title: "Fixture policy session" })
    const old = user(chat.id, "Earlier context")
    delete old.info.format
    yield* store(old)
    const done = assistant(old.info)
    done.finish = "stop"
    done.tokens.input = 85_000
    done.time.completed = Date.now()
    yield* store({ info: done, parts: [] })
    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [{ type: "text", text: "Complete this new task" }],
    })
    expect(result.info).toMatchObject({ role: "assistant", finish: "stop" })
    if (result.info.role !== "assistant") throw new Error("missing response")
    expect(result.info.error).toBeUndefined()
    const messages = yield* session.messages({ sessionID: chat.id })
    const pending = messages.find((message) =>
      message.parts.some((part) => part.type === "text" && part.text === "Complete this new task"),
    )!
    expect(result.info.parentID).toBe(pending.info.id)
    expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(1)
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(3)
    expect(calls).toHaveLength(2)
  }),
)

it.instance("oversized summarizer input uses bounded chunks without recursive automatic compaction", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* session.create({})
    const old = user(chat.id, "history ".repeat(100_000))
    const pending = user(chat.id, "Keep the complete pending request")
    yield* store(old)
    yield* store(pending)
    const first = yield* run(pending.info, [old, pending])
    expect(first.result).toBe("compact")
    expect(calls).toHaveLength(0)
    expect(yield* compact(pending.info, first.handle.contextReceipt!()!)).toBe("continue")
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => JSON.stringify(call.prompt).length < 100_000)).toBe(true)
    const messages = yield* session.messages({ sessionID: chat.id })
    expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(1)
    const receipt = messages.flatMap((message) => message.parts).find((part) => part.type === "compaction")
    expect(receipt).toMatchObject({ tail_start_id: pending.info.id })
    expect(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id })).toEqual(pending)
  }),
)

queued.instance("same message ID rejects changed explicit variant, agent, system and format without enqueueing", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const chat = yield* session.create({ title: "Fixture immutable request" })
    const input = {
      sessionID: chat.id,
      messageID: MessageID.ascending(),
      model: ref,
      agent: "build",
      variant: "original",
      system: "Original system",
      format: { type: "text" as const },
      noReply: true,
      parts: [{ type: "text" as const, text: "Original task" }],
    }
    const original = yield* prompt.prompt(input)
    for (const change of [
      { variant: "changed" },
      { agent: "different" },
      { system: "Changed system" },
      { format: { type: "json_schema" as const, retryCount: 0, schema: { type: "object" } } },
    ]) {
      expect((yield* prompt.prompt({ ...input, ...change }).pipe(Effect.exit))._tag).toBe("Failure")
    }
    expect(yield* prompt.prompt(input)).toEqual(original)
    expect(yield* session.messages({ sessionID: chat.id })).toHaveLength(1)
    expect(calls).toHaveLength(0)
  }),
)

queued.instance(
  "a fresh single-user agent turn compacts completed tool history, keeps original evidence, and never reruns side effects",
  () =>
    Effect.gen(function* () {
      agentRun = true
      const session = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const status = yield* SessionStatus.Service
      const chat = yield* session.create({ title: "Fixture fresh long turn" })
      const states: string[] = []
      const phases: string[] = []
      const listener = (event: {
        payload: { type: string; properties: { sessionID?: string; status?: { type: string }; phase?: string } }
      }) => {
        if (event.payload.properties.sessionID !== chat.id) return
        if (event.payload.type === "session.status") states.push(event.payload.properties.status!.type)
        if (event.payload.type === "session.context") phases.push(event.payload.properties.phase!)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
      const original = yield* prompt.prompt({
        sessionID: chat.id,
        messageID: MessageID.ascending(),
        model: ref,
        agent: "build",
        system: "Retain this original task contract",
        format: { type: "text" },
        noReply: true,
        parts: [
          { type: "text", text: "Perform three operations once, then finish" },
          {
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
          },
        ],
      })
      const baseline = yield* MessageV2.get({ sessionID: chat.id, messageID: original.info.id })
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info).toMatchObject({ role: "assistant", parentID: original.info.id, finish: "stop" })
      expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      expect([...executions]).toEqual([
        [1, 1],
        [2, 1],
        [3, 1],
      ])
      const messages = yield* session.messages({ sessionID: chat.id })
      expect(messages.filter((message) => message.info.role === "user")).toHaveLength(2)
      const receipt = messages.flatMap((message) => message.parts).find((part) => part.type === "compaction")!
      expect(receipt).toMatchObject({ context: { source: original.info.id } })
      expect(receipt.type === "compaction" && receipt.context?.tail).toBeTruthy()
      expect(
        messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool" && part.state.status === "completed"),
      ).toHaveLength(3)
      expect(yield* MessageV2.get({ sessionID: chat.id, messageID: original.info.id })).toEqual(baseline)
      const projected = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(projected.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toHaveLength(1)
      expect(JSON.stringify(calls.at(-1)!.prompt)).toContain("execution-1")
      expect(JSON.stringify(calls.at(-1)!.prompt)).toContain("execution-3")
      expect(phases.filter((phase) => phase === "compacting")).toHaveLength(1)
      expect(calls).toHaveLength(5)
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
      expect(states.at(-1)).toBe("idle")
      expect(states.slice(0, -1).every((state) => state !== "idle")).toBe(true)
    }),
  30_000,
)

it.instance("an unresolved tool in the current turn is terminally blocked, not summarized or reissued", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service
    const chat = yield* session.create({})
    const pending = user(chat.id, "Original task")
    const active = assistant(pending.info)
    active.finish = "tool-calls"
    active.tokens.input = 85_000
    yield* store(pending)
    yield* store({
      info: active,
      parts: [
        {
          type: "tool",
          id: PartID.ascending(),
          messageID: active.id,
          sessionID: chat.id,
          callID: "unresolved",
          tool: "fixture",
          state: { status: "running", input: {}, time: { start: 1 } },
        },
      ],
    })
    const result = yield* run(pending.info, yield* session.messages({ sessionID: chat.id }))
    expect(result.result).toBe("stop")
    expect(result.handle.message.error?.name).toBe("ContextAdmissionError")
    expect(calls).toHaveLength(0)
    expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
  }),
)

it.instance("manual compaction settles idle rather than leaving a summary marked as active work", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service
    const chat = yield* session.create({})
    const old = user(chat.id, "History")
    const pending = user(chat.id, "Original task")
    delete old.info.format
    delete pending.info.format
    yield* store(old)
    yield* store(pending)
    const service = yield* SessionCompaction.Service
    yield* service.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
    const messages = yield* session.messages({ sessionID: chat.id })
    expect(
      yield* service.process({ sessionID: chat.id, parentID: messages.at(-1)!.info.id, messages, auto: false }),
    ).toBe("continue")
    expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    expect(calls).toHaveLength(1)
  }),
)

queued.instance(
  "Stop through the prompt runner during automatic compaction settles idle and never dispatches the original task",
  () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const status = yield* SessionStatus.Service
      const chat = yield* session.create({ title: "Fixture cancellable reduction" })
      const old = user(chat.id, "Earlier history")
      delete old.info.format
      yield* store(old)
      const done = assistant(old.info)
      done.finish = "stop"
      done.time.completed = Date.now()
      done.tokens.input = 85_000
      yield* store({ info: done, parts: [] })
      const original = yield* prompt.prompt({
        sessionID: chat.id,
        model: ref,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Pending original task" }],
      })
      pause = true
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => started.promise)
      expect(yield* status.get(chat.id)).toEqual({ type: "busy" })
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
      expect(calls).toHaveLength(1)
      expect(yield* MessageV2.get({ sessionID: chat.id, messageID: original.info.id })).toEqual(original)
    }),
)
