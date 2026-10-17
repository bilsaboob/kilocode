import { afterEach, beforeEach, expect } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LLMClient } from "@opencode-ai/llm/route"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Env } from "@/env"
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
import { KiloCompactionState } from "@/kilocode/session/compaction-state"
import { KiloCompactionBudget } from "@/kilocode/session/compaction-budget"
import { KiloSessionRecovery } from "@/kilocode/session/recovery"
import { KiloAuth } from "@/kilocode/auth/authority"
import { KiloSessionMessageOrder } from "@/kilocode/session/message-order"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
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
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { png } from "./fixture/context-image"

const profile = JSON.stringify({ version: 1, window: "maximum-supported", automaticPercent: 85, admissionPercent: 95 })
const previous = process.env.ZEN_KILO_CONTEXT_POLICY
const cfg = Schema.decodeUnknownSync(Config.Info)({
  snapshot: false,
  compaction: { auto: true, threshold_percent: 85 },
  provider: { openai: { options: { apiKey: "fixture-key" } } },
}) as Config.Info
let effective = cfg
let reducer: Provider.Model | undefined
let pause = false
let agentRun = false
let sequence = 0
let maximum = 3
let pressure = new Set([3])
let gated = false
let gate = Promise.withResolvers<void>()
let batch = Promise.withResolvers<void>()
const executions = new Map<number, number>()
let started = Promise.withResolvers<void>()
const calls: LanguageModelV3CallOptions[] = []
beforeEach(() => {
  reducer = undefined
  process.env.ZEN_KILO_CONTEXT_POLICY = profile
  calls.length = 0
  pause = false
  agentRun = false
  sequence = 0
  maximum = 3
  pressure = new Set([3])
  gated = false
  gate = Promise.withResolvers<void>()
  batch = Promise.withResolvers<void>()
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
  cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
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
const helper = ProviderTest.model({
  providerID: ProviderID.make("helper"),
  id: ModelID.make("helper-model"),
  limit: { context: 60_000, output: 4_096 },
  variants: { "fixture-variant": {} },
})
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
    const step = task && sequence < maximum ? ++sequence : undefined
    started.resolve()
    if (gated) {
      const waiting = gate.promise
      if (calls.length % 3 === 0) batch.resolve()
      await waiting
    }
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
                total: step && pressure.has(step) ? 85_000 : 10,
                noCache: step && pressure.has(step) ? 85_000 : 10,
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
const agents = Layer.mock(Agent.Service, {
  get: (name) =>
    Effect.succeed({
      ...agent,
      name,
      ...(name === "compaction" && reducer ? { model: { providerID: reducer.providerID, modelID: reducer.id } } : {}),
    }),
})
const provider = ProviderTest.fake({
  model,
  list: () =>
    Effect.succeed({
      [model.providerID]: ProviderTest.info({}, model),
      ...(reducer ? { [reducer.providerID]: ProviderTest.info({}, reducer) } : {}),
    }),
  getProvider: (id) =>
    id === model.providerID
      ? Effect.succeed(ProviderTest.info({}, model))
      : reducer && id === reducer.providerID
        ? Effect.succeed(ProviderTest.info({}, reducer))
        : Effect.die(new Error(`Unknown fixture provider: ${id}`)),
  getModel: (providerID, id) =>
    providerID === model.providerID && id === model.id
      ? Effect.succeed(model)
      : reducer && providerID === reducer.providerID && id === reducer.id
        ? Effect.succeed(reducer)
        : Effect.die(new Error(`Unknown fixture model: ${providerID}/${id}`)),
  getLanguage: (input) => Effect.succeed({ ...language, modelId: input.id }),
}).layer
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
  Layer.mock(Env.Service, { all: () => Effect.succeed({}) }),
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

for (const mode of ["continue", "replay", "chunks"] as const) {
  queued.instance(
    `compaction ${mode} retains admitted helper-provider and model-header authority`,
    () =>
      Effect.gen(function* () {
        delete process.env.ZEN_KILO_CONTEXT_POLICY
        const headers: Record<string, string> =
          mode === "replay" ? { authorization: "Bearer fixture-helper-header" } : {}
        reducer = { ...helper, headers }
        effective = {
          ...cfg,
          compaction: { auto: true, tail_turns: 0 },
          provider: {
            ...cfg.provider,
            [helper.providerID]: {
              options: { apiKey: "fixture-helper-default" },
              models: { [helper.id]: { headers } },
            },
          },
        }
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const service = yield* SessionCompaction.Service
        const chat = yield* sessions.create({ title: `Helper binding ${mode}` })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [
            { type: "text", text: mode === "chunks" ? "Older history ".repeat(30_000) : "An earlier independent task" },
          ],
        })
        const original = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          variant: "fixture-variant",
          noReply: true,
          parts: [
            {
              type: "text",
              text: mode === "replay" ? "The pending request ".repeat(12_000) : "Preserve this exact pending task",
            },
          ],
        })
        if (original.info.role !== "user") throw new Error("Missing admitted task")
        const selected = KiloAuth.selected(original.info, helper)
        expect(selected?.providerID).toBe(helper.providerID)
        expect(original.info.authAuthority?.providerID).toBe(model.providerID)
        if (mode === "replay") {
          expect(selected).toEqual(original.info.authAuthorities?.[JSON.stringify([helper.providerID, helper.id])])
          expect(selected?.authority).not.toBe(original.info.authAuthorities?.[helper.providerID]?.authority)
        }
        yield* service.create({
          sessionID: chat.id,
          agent: "build",
          model: original.info.model,
          auto: true,
          ...(mode === "replay" ? { overflow: false } : {}),
        })
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const marker = messages.at(-1)!
        if (marker.info.role !== "user") throw new Error("Missing compaction marker")
        expect(marker.info.authAuthorities).toEqual(original.info.authAuthorities)
        expect(marker.info.authAuthority).toEqual(original.info.authAuthority)
        expect(marker.info.model).toEqual(original.info.model)
        expect(
          yield* service.process({
            sessionID: chat.id,
            parentID: marker.info.id,
            messages,
            auto: true,
            ...(mode === "replay" ? { overflow: false } : {}),
          }),
        ).toBe("continue")
        const all = yield* sessions.messages({ sessionID: chat.id })
        const followup = all.findLast((message) => message.info.role === "user")!
        if (followup.info.role !== "user") throw new Error("Missing generated followup")
        expect(followup.info.id).not.toBe(original.info.id)
        expect(followup.info.authAuthorities).toEqual(original.info.authAuthorities)
        expect(followup.info.authAuthority).toEqual(original.info.authAuthority)
        expect(followup.info.model).toEqual(original.info.model)
        expect(KiloAuth.selected(followup.info, helper)).toEqual(selected)
        expect(
          all
            .filter((message) => message.info.role === "assistant" && message.info.summary)
            .every((message) => message.info.role === "assistant" && message.info.providerID === helper.providerID),
        ).toBe(true)
        expect(calls).toHaveLength(mode === "chunks" ? 3 : mode === "replay" ? 2 : 1)
        if (mode === "chunks")
          expect(calls.some((call) => JSON.stringify(call.prompt).includes("<partial-summary"))).toBe(true)
        const usage = KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: original.info.id })!
        expect(usage.requests).toBe(calls.length)
        expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: followup.info.id })).toEqual(usage)
      }),
    30_000,
  )
}

for (const mode of ["missing", "changed", "header", "late-header"] as const) {
  queued.instance(
    `compaction fails closed for ${mode} helper binding without a late credential capture`,
    () =>
      Effect.gen(function* () {
        delete process.env.ZEN_KILO_CONTEXT_POLICY
        const headers: Record<string, string> = mode === "header" ? { authorization: "Bearer fixture-header-one" } : {}
        reducer = mode === "missing" ? undefined : { ...helper, headers }
        effective = {
          ...cfg,
          compaction: { auto: true, tail_turns: 0 },
          provider: {
            ...cfg.provider,
            [helper.providerID]: { options: { apiKey: "fixture-helper-one" }, models: { [helper.id]: { headers } } },
          },
        }
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const service = yield* SessionCompaction.Service
        const chat = yield* sessions.create({ title: `Pinned helper ${mode}` })
        const original = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          variant: "fixture-variant",
          noReply: true,
          parts: [{ type: "text", text: "Original source and helper admission" }],
        })
        if (original.info.role !== "user") throw new Error("Missing admitted task")
        if (mode === "missing") expect(KiloAuth.selected(original.info, helper)).toBeUndefined()
        reducer = { ...helper, headers }
        if (mode !== "missing")
          effective = {
            ...effective,
            provider: {
              ...effective.provider,
              [helper.providerID]: {
                options: { apiKey: mode === "changed" ? "fixture-helper-two" : "fixture-helper-one" },
                models: {
                  [helper.id]: {
                    headers:
                      mode === "header" || mode === "late-header"
                        ? { authorization: "Bearer fixture-header-two" }
                        : headers,
                  },
                },
              },
            },
          }
        yield* service.create({ sessionID: chat.id, agent: "build", model: original.info.model, auto: false })
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const marker = messages.at(-1)!
        expect(yield* service.process({ sessionID: chat.id, parentID: marker.info.id, messages, auto: false })).toBe(
          "stop",
        )
        const all = yield* sessions.messages({ sessionID: chat.id })
        const stopped = all.findLast((message) => message.info.role === "assistant")!
        expect(stopped.info).toMatchObject({ role: "assistant", finish: "error", error: { name: "ProviderAuthError" } })
        expect(calls).toHaveLength(0)
        expect(all.some((message) => KiloCompactionState.bound(message, all))).toBe(false)
        expect((yield* MessageV2.get({ sessionID: chat.id, messageID: original.info.id })).info).toEqual(original.info)
        expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: original.info.id })).toMatchObject({
          root: original.info.id,
          requests: 0,
        })
      }),
    30_000,
  )
}

queued.instance(
  "trusted automatic recovery binds the original quota before admission and ignores public anchors",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Trusted recovery quota" })
      yield* Effect.addFinalizer(() => Effect.sync(() => KiloSessionRecovery.reset(chat.id)))
      const decoy = yield* prompt.prompt({
        sessionID: chat.id,
        model: ref,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "An earlier independent task" }],
      })
      const original = yield* prompt.prompt({
        sessionID: chat.id,
        model: ref,
        agent: "build",
        variant: "fixture-variant",
        noReply: true,
        parts: [{ type: "text", text: "The actual pending task" }],
      })
      if (original.info.role !== "user") throw new Error("Missing original user")
      expect(
        yield* compact(original.info, { source: original.info.id, currentTokens: 85_000, nextTokens: 90_000 }),
      ).toBe("continue")
      const failure = assistant(original.info)
      failure.finish = "error"
      failure.time.completed = Date.now()
      failure.error = new MessageV2.APIError({
        message: "Fixture transient failure",
        isRetryable: true,
        statusCode: 503,
      }).toObject()
      yield* sessions.updateMessage(failure)
      const decision = KiloSessionRecovery.finish({
        sessionID: chat.id,
        message: failure,
        messages: yield* sessions.messages({ sessionID: chat.id }),
      })
      if (decision?.action !== "resume") throw new Error("Missing recovery decision")
      const input = {
        sessionID: chat.id,
        messageID: MessageID.ascending(),
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "text" as const,
            text: "resume",
            synthetic: true,
            metadata: { auto_resume: true, recovery_token: decision.token, anchor_user_message_id: decoy.info.id },
          },
        ],
      }
      const resumed = yield* prompt.prompt(input)
      if (resumed.info.role !== "user") throw new Error("Missing recovery user")
      expect(resumed.info.id).not.toBe(original.info.id)
      expect(resumed.info.model).toEqual(original.info.model)
      expect(resumed.info.authAuthority).toEqual(original.info.authAuthority)
      expect(resumed.info.authAuthorities).toEqual(original.info.authAuthorities)
      expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: resumed.info.id })).toMatchObject({
        root: original.info.id,
        requests: 1,
      })
      expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: decoy.info.id })?.requests).toBe(0)
      expect(
        resumed.parts.some(
          (part) => part.type === "text" && part.ignored && part.metadata?.kilo_compaction_root === original.info.id,
        ),
      ).toBe(true)
      expect((yield* prompt.prompt(input)).info.id).toBe(resumed.info.id)
      expect(calls).toHaveLength(1)
      expect(yield* compact(resumed.info, { source: resumed.info.id, currentTokens: 85_000, nextTokens: 90_000 })).toBe(
        "continue",
      )
      expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: original.info.id })?.requests).toBe(2)
      expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: resumed.info.id })).toEqual(
        KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: original.info.id }),
      )
      expect(calls).toHaveLength(2)
    }),
  30_000,
)

queued.instance("cancelled or failed followup publication never exposes a phantom prompt", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    for (const mode of ["row", "row-error", "error", "commit", "commit-error"] as const) {
      const fail = mode === "error" || mode === "row-error"
      const valid = mode === "commit" || mode === "commit-error"
      const chat = yield* sessions.create({ title: "Fixture staged followup" })
      const original = user(chat.id, "Original history")
      delete original.info.format
      yield* store(original)
      const service = yield* SessionCompaction.Service
      yield* service.create({ sessionID: chat.id, agent: "build", model: ref, auto: true })
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const wrapped = Session.Service.of({
        ...sessions,
        updateMessage: <T extends MessageV2.Info>(info: T) =>
          sessions
            .updateMessage(info)
            .pipe(
              Effect.tap(() =>
                info.role === "user" && mode === "row-error"
                  ? Effect.die(new Error("fixture durable row notification failure"))
                  : info.role === "user" && mode === "row"
                    ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)))
                    : Effect.void,
              ),
            ),
        updatePart: <T extends MessageV2.Part>(part: T) => {
          if (fail && part.type === "text" && part.metadata?.kilo_compaction_followup)
            return Effect.die(new Error("fixture staging write failure"))
          const state = part.type === "text" ? part.metadata?.kilo_compaction : undefined
          return sessions
            .updatePart(part)
            .pipe(
              Effect.tap(() =>
                state && typeof state === "object" && "status" in state && state.status === "committed"
                  ? mode === "commit-error"
                    ? Effect.die(new Error("fixture post-commit notification failure"))
                    : mode === "commit"
                      ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)))
                      : Effect.void
                  : Effect.void,
              ),
            )
        },
      })
      const before = calls.length
      const process = SessionCompaction.Service.use((value) =>
        value.process({ parentID: messages.at(-1)!.info.id, sessionID: chat.id, messages, auto: true }),
      ).pipe(Effect.provide(Layer.fresh(SessionCompaction.layer)), Effect.provideService(Session.Service, wrapped))
      if (fail || mode === "commit-error") {
        expect(Exit.isFailure(yield* process.pipe(Effect.exit))).toBe(true)
      } else {
        const fiber = yield* process.pipe(Effect.forkChild)
        yield* Effect.raceFirst(
          Deferred.await(ready),
          Fiber.await(fiber).pipe(
            Effect.flatMap((exit) =>
              Effect.die(
                new Error(
                  `Compaction ended before followup publication: ${Exit.isSuccess(exit) ? exit.value : String(exit.cause)}`,
                ),
              ),
            ),
          ),
        ).pipe(Effect.timeout("4 seconds"))
        yield* Effect.sync(() => fiber.interruptUnsafe())
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.await(fiber)
      }
      const saved = yield* sessions.messages({ sessionID: chat.id })
      const projected = MessageV2.filterCompacted([...saved].reverse())
      expect(saved.filter((message) => message.info.role === "user")).toHaveLength(fail ? 2 : 3)
      const target = saved.find((message) => message.info.role === "assistant" && message.info.summary)
      if (!target || target.info.role !== "assistant") throw new Error("missing compaction target")
      expect(!!target.info.error).toBe(!valid)
      if (mode === "row") expect(target.info.error?.name).toBe("MessageAbortedError")
      expect(saved.some((message) => KiloCompactionState.bound(message, saved))).toBe(valid)
      if (valid) {
        expect(
          projected.some(
            (message) =>
              message.info.role === "user" &&
              message.parts.some((part) => part.type === "text" && part.metadata?.compaction_continue),
          ),
        ).toBe(true)
      } else {
        expect(projected.filter((message) => message.info.role === "user")).toHaveLength(2)
        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.id).toBe(target.info.id)
      }
      expect(calls).toHaveLength(before + 1)
    }
  }),
)

queued.instance("prompt results resolve retained workers to the aggregate compaction outcome without dispatch", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    for (const failed of [true, false]) {
      const chat = yield* sessions.create({ title: "Fixture retained compaction workers" })
      const parent = user(chat.id, "Original request")
      const marker: MessageV2.CompactionPart = {
        id: PartID.ascending(),
        messageID: parent.info.id,
        sessionID: chat.id,
        type: "compaction",
        auto: false,
      }
      parent.parts = [marker]
      yield* store(parent)
      const target = assistant(parent.info)
      target.agent = "compaction"
      target.summary = true
      target.finish = failed ? "error" : "stop"
      target.time.completed = Date.now()
      if (failed)
        target.error = new MessageV2.APIError({
          message: "[RESPONSE_INCOMPLETE] Earlier worker failed",
          isRetryable: false,
        }).toObject()
      yield* store({
        info: target,
        parts: [
          KiloCompactionState.mark({ message: target, status: failed ? "candidate" : "committed", marker }),
          { id: PartID.ascending(), sessionID: chat.id, messageID: target.id, type: "text", text: "aggregate summary" },
        ],
      })
      const worker = assistant(parent.info)
      worker.agent = "compaction"
      worker.summary = true
      worker.finish = "stop"
      worker.time.completed = Date.now()
      yield* store({
        info: worker,
        parts: [
          KiloCompactionState.mark({ message: worker, status: "worker", target: target.id }),
          {
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: worker.id,
            type: "text",
            text: "newer successful sibling",
          },
        ],
      })
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.id).toBe(target.id)
      expect(result.info.role === "assistant" && result.info.error).toEqual(target.error)
      expect(calls).toHaveLength(0)
      expect((yield* MessageV2.get({ sessionID: chat.id, messageID: worker.id })).parts).toHaveLength(2)
    }
  }),
)

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
    if (message.info.role === "user") message.info.authAuthority ??= yield* KiloAuth.capture(message.info.model)
    yield* session.updateMessage(message.info)
    for (const part of message.parts) yield* session.updatePart(part)
  })
}
function packet(message: MessageV2.WithParts) {
  return { ...message, parts: message.parts.filter((part) => !KiloCompactionBudget.internal(part)) }
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
    expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id }))).toEqual(packet(pending))
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
    expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id }))).toEqual(packet(pending))
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
    expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id }))).toEqual(packet(pending))
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
    expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id }))).toEqual(packet(pending))
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
    expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id }))).toEqual(packet(pending))
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
      expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: original.info.id }))).toEqual(
        packet(baseline),
      )
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

for (const steps of [6, 15]) {
  queued.instance(
    `productive progress permits more than three compactions but never resets the dispatch budget (${steps} steps)`,
    () =>
      Effect.gen(function* () {
        agentRun = true
        maximum = steps
        pressure = new Set(Array.from({ length: steps - 1 }, (_, index) => index + 2))
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const chat = yield* sessions.create({ title: "Cumulative compaction fixture" })
        const original = yield* prompt.prompt({
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          model: ref,
          agent: "build",
          noReply: true,
          system: "Preserve task authority and execution receipts",
          format: { type: "text" },
          parts: [{ type: "text", text: "Perform each fixture operation once and finish" }],
        })
        const result = yield* prompt.loop({ sessionID: chat.id })
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const summaries = messages.filter((message) => KiloCompactionState.bound(message, messages))
        const state = KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: original.info.id })!
        expect(summaries.length).toBeGreaterThan(3)
        expect(state.requests).toBe(steps === 6 ? 5 : 12)
        expect(summaries).toHaveLength(state.requests)
        expect([...executions.values()].every((count) => count === 1)).toBe(true)
        expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: original.info.id }))).toEqual(
          packet(original),
        )
        if (steps === 6) {
          expect(result.info).toMatchObject({ role: "assistant", finish: "stop" })
          expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
          expect(executions.size).toBe(6)
        } else {
          expect(result.info).toMatchObject({
            role: "assistant",
            finish: "error",
            error: { name: "APIError", data: { isRetryable: false } },
          })
          expect(result.info.role === "assistant" && KiloCompactionBudget.blocked(result.info.error)).toBe(true)
          expect(executions.size).toBe(14)
          const before = calls.length
          yield* prompt.loop({ sessionID: chat.id })
          expect(calls).toHaveLength(before)
          expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: original.info.id })).toEqual(state)
        }
      }),
    30_000,
  )
}

queued.instance(
  "ordinary non-Zen progress rearms the failed-loop guard while generated continuation IDs retain one quota",
  () =>
    Effect.gen(function* () {
      delete process.env.ZEN_KILO_CONTEXT_POLICY
      effective = { ...cfg, compaction: { auto: true, threshold_percent: 30 } }
      agentRun = true
      maximum = 6
      pressure = new Set([2, 3, 4, 5, 6])
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Ordinary cumulative compaction fixture" })
      const original = yield* prompt.prompt({
        sessionID: chat.id,
        model: ref,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Perform six fixture operations once, then finish" }],
      })
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info).toMatchObject({ role: "assistant", finish: "stop" })
      expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
      expect(executions.size).toBe(6)
      expect([...executions.values()].every((value) => value === 1)).toBe(true)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const summaries = messages.filter((message) => KiloCompactionState.bound(message, messages))
      expect(summaries.length).toBeGreaterThan(3)
      const state = KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: original.info.id })!
      expect(state.requests).toBe(summaries.length)
      for (const message of messages.filter((item) =>
        item.parts.some((part) => part.type === "text" && part.metadata?.kilo_compaction_followup),
      )) {
        expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: message.info.id })).toEqual(state)
      }
    }),
  30_000,
)

it.instance(
  "actual parallel chunk calls cannot spend a thirteenth dispatch or commit an incomplete summary",
  () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const chat = yield* session.create({ title: "Parallel resource fixture" })
      for (let index = 0; index < 14; index++) yield* store(user(chat.id, `History ${index}: ` + "x".repeat(160_000)))
      const pending = user(chat.id, "Preserve this indivisible task and schema")
      yield* store(pending)
      gated = true
      const fiber = yield* compact(pending.info, {
        source: pending.info.id,
        currentTokens: 85_000,
        nextTokens: 90_000,
      }).pipe(Effect.forkChild)
      for (let group = 1; group <= 4; group++) {
        yield* Effect.raceFirst(
          Effect.promise(() => batch.promise),
          Fiber.await(fiber).pipe(
            Effect.flatMap((exit) =>
              Effect.die(new Error(`Compaction ended before batch ${group}: ${JSON.stringify(exit)}`)),
            ),
          ),
        )
        expect(calls).toHaveLength(group * 3)
        expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: pending.info.id })?.requests).toBe(
          group * 3,
        )
        const previous = gate
        gate = Promise.withResolvers<void>()
        batch = Promise.withResolvers<void>()
        previous.resolve()
      }
      expect(yield* Fiber.join(fiber)).toBe("stop")
      expect(calls).toHaveLength(12)
      const messages = yield* session.messages({ sessionID: chat.id })
      expect(messages.some((message) => KiloCompactionState.bound(message, messages))).toBe(false)
      const target = messages.find(
        (message) => message.info.role === "assistant" && message.info.summary && !KiloCompactionState.target(message),
      )!
      expect(target.info.role === "assistant" && KiloCompactionBudget.blocked(target.info.error)).toBe(true)
      expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id }))).toEqual(packet(pending))
      const receipts = messages.flatMap((message) => message.parts).filter((part) => part.type === "step-finish")
      expect(receipts.length).toBeGreaterThanOrEqual(10)
      expect(receipts.length).toBeLessThanOrEqual(12)
      expect((yield* session.get(chat.id)).cost).toBeCloseTo(
        receipts.reduce((sum, receipt) => sum + receipt.cost, 0),
        10,
      )
      const state = KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: pending.info.id })!
      expect(state.requests).toBe(12)
      expect(state.active).toBeNull()
      expect(
        Exit.isFailure(
          yield* KiloCompactionBudget.run({ sessionID: chat.id, messageID: pending.info.id }, Effect.void).pipe(
            Effect.exit,
          ),
        ),
      ).toBe(true)
    }),
  30_000,
)

it.effect("the actual compactor deadline preserves observed spending without committing its interrupted summary", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const service = yield* SessionCompaction.Service
      const chat = yield* sessions.create({ title: "Active deadline fixture" })
      const old = user(chat.id, "Earlier history")
      const pending = user(chat.id, "Original exact task contract")
      yield* store(old)
      yield* store(pending)
      yield* service.create({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        auto: true,
        contextPolicy: pending.info.contextPolicy,
        context: { source: pending.info.id, currentTokens: 85_000, nextTokens: 90_000 },
      })
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let blocked = false
      const wrapped = Session.Service.of({
        ...sessions,
        updatePart: <T extends MessageV2.Part>(part: T) =>
          sessions.updatePart(part).pipe(
            Effect.tap(() => {
              if (part.type !== "step-finish" || blocked) return Effect.void
              blocked = true
              return Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)))
            }),
          ),
      })
      const process = SessionCompaction.Service.use((value) =>
        value.process({ sessionID: chat.id, parentID: messages.at(-1)!.info.id, messages, auto: true }),
      ).pipe(
        Effect.provide(Layer.fresh(SessionCompaction.layer.pipe(Layer.provide(Layer.fresh(SessionProcessor.layer))))),
        Effect.provideService(Session.Service, wrapped),
      )
      const fiber = yield* process.pipe(Effect.forkChild)
      yield* Effect.raceFirst(
        Deferred.await(ready),
        Fiber.await(fiber).pipe(
          Effect.flatMap((exit) =>
            Effect.die(new Error(`Compactor ended before spending barrier: ${JSON.stringify(exit)}`)),
          ),
        ),
      )
      yield* TestClock.adjust(900_000)
      expect(yield* Fiber.join(fiber)).toBe("stop")
      const saved = yield* sessions.messages({ sessionID: chat.id })
      expect(saved.some((message) => KiloCompactionState.bound(message, saved))).toBe(false)
      const receipts = saved.flatMap((message) => message.parts).filter((part) => part.type === "step-finish")
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({ tokens: { input: 10, output: 10 } })
      expect((yield* sessions.get(chat.id)).cost).toBeCloseTo(0.00003, 10)
      expect(KiloCompactionBudget.inspect({ sessionID: chat.id, messageID: pending.info.id })).toMatchObject({
        requests: 1,
        milliseconds: 900_000,
        active: null,
      })
      expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: pending.info.id }))).toEqual(packet(pending))
      expect(
        saved.some((message) => message.info.role === "assistant" && KiloCompactionBudget.blocked(message.info.error)),
      ).toBe(true)
      expect(calls).toHaveLength(1)
    }),
  ),
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
      expect(packet(yield* MessageV2.get({ sessionID: chat.id, messageID: original.info.id }))).toEqual(
        packet(original),
      )
    }),
)
