import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { LLM, LLMEvent, Usage } from "@opencode-ai/llm"
import type { ProtocolDef } from "@opencode-ai/llm/route"
import * as OpenAI from "@opencode-ai/llm/providers/openai"
import { protocol as chat } from "@opencode-ai/llm/protocols/openai-chat"
import { protocol as anthropic } from "@opencode-ai/llm/protocols/anthropic-messages"
import { protocol as google } from "@opencode-ai/llm/protocols/gemini"
import { protocol as bedrock } from "@opencode-ai/llm/protocols/bedrock-converse"
import { asLanguageModelUsage } from "ai/internal"
import { KiloResponse } from "../../src/kilocode/session/response"
import { KiloResponseAccounting } from "../../src/kilocode/session/response-accounting"
import { KiloUsage } from "../../src/kilocode/session/usage"
import { KiloCompactionState } from "../../src/kilocode/session/compaction-state"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { LLMAISDK } from "../../src/session/llm/ai-sdk"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const model = ProviderTest.model()
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

function response(value?: unknown) {
  let now = 100
  const collector = KiloResponse.collector({ now: () => now })
  const receipt = collector.begin(true)
  collector.raw(receipt, { type: "response.completed", response: { id: "resp_usage", usage: value } })
  now = 200
  collector.normalized(receipt, "stop", { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  const billing = Session.getUsage({ model, usage: receipt.usage ?? new Usage({}), metadata: receipt.metadata })
  return { collector, receipt, billing }
}

function native<Body, Frame, Event, State>(protocol: ProtocolDef<Body, Frame, Event, State>, frames: Frame[]) {
  return Effect.gen(function* () {
    const collector = KiloResponse.collector({ now: () => 100 })
    let state = protocol.stream.initial(
      LLM.request({ model: OpenAI.configure({ apiKey: "fixture" }).chat("usage"), prompt: "usage" }),
    )
    for (const frame of frames) {
      const data = yield* Schema.decodeEffect(protocol.stream.event)(frame)
      const [next, events] = yield* protocol.stream.step(state, data)
      state = next
      for (const event of events) collector.native(event)
    }
    for (const event of protocol.stream.onHalt?.(state) ?? []) collector.native(event)
    const receipt = collector.current()
    const billing = Session.getUsage({ model, usage: receipt.usage ?? new Usage({}), metadata: receipt.metadata })
    return { receipt, billing, measurement: KiloUsage.report(receipt, billing.tokens) }
  })
}

function assistant(id: string, parent: string, created: number): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      parentID: MessageID.make(parent),
      sessionID: SessionID.make("ses_usage"),
      role: "assistant",
      agent: "code",
      mode: "code",
      providerID: model.providerID,
      modelID: model.id,
      finish: "stop",
      time: { created, completed: created + 1 },
      path: { cwd: "/fixture", root: "/fixture" },
      cost: 0,
      tokens,
    },
    parts: [],
  }
}

function measured(message: MessageV2.WithParts, value: unknown) {
  const { receipt, billing } = response(value)
  const id = PartID.ascending()
  message.parts.push(
    {
      id,
      messageID: message.info.id,
      sessionID: message.info.sessionID,
      type: "step-finish",
      reason: "stop",
      ...billing,
    },
    {
      id: PartID.ascending(),
      messageID: message.info.id,
      sessionID: message.info.sessionID,
      type: "text",
      text: "",
      ignored: true,
      metadata: {
        kiloResponse: {
          ...KiloResponse.metadata(receipt),
          partID: id,
          measurement: KiloUsage.report(receipt, billing.tokens),
        },
      },
    },
  )
  if (message.info.role === "assistant") message.info.tokens = billing.tokens
  return message
}

describe("context measurement provenance", () => {
  test.each([
    { name: "absent", usage: undefined, value: null, lower: null, quality: "unknown", at: null },
    {
      name: "cost-only",
      usage: { cost_details: { upstream_inference_cost: 0.25 } },
      value: null,
      lower: null,
      quality: "unknown",
      at: null,
    },
    { name: "partial", usage: { input_tokens: 100 }, value: null, lower: 100, quality: "partial", at: 100 },
    { name: "total-only", usage: { total_tokens: 130 }, value: 130, lower: 130, quality: "reported", at: 100 },
    {
      name: "reported-zero",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      value: 0,
      lower: 0,
      quality: "reported",
      at: 100,
    },
    {
      name: "small-total",
      usage: { input_tokens: 100, output_tokens: 30, total_tokens: 1 },
      value: 130,
      lower: 130,
      quality: "inconsistent",
      at: 100,
    },
    {
      name: "large-total",
      usage: { input_tokens: 100, output_tokens: 30, total_tokens: 200 },
      value: 200,
      lower: 200,
      quality: "inconsistent",
      at: 100,
    },
    {
      name: "partial-contradictory-total",
      usage: { input_tokens: 100, total_tokens: 0 },
      value: 100,
      lower: 100,
      quality: "inconsistent",
      at: 100,
    },
    {
      name: "cached-reasoning",
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        total_tokens: 130,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 10 },
      },
      value: 130,
      lower: 130,
      quality: "reported",
      at: 100,
    },
  ])("distinguishes $name", (input) => {
    const { receipt, billing } = response(input.usage)
    expect(KiloUsage.report(receipt, billing.tokens)).toEqual({
      version: 1,
      tokens: input.value,
      lowerBound: input.lower,
      quality: input.quality,
      observedAt: input.at,
    })
  })

  test.each([
    { input_tokens: -1, output_tokens: 0, total_tokens: 0 },
    { input_tokens: Number.NaN, output_tokens: 0, total_tokens: 0 },
    { input_tokens: "0", output_tokens: 0, total_tokens: 0 },
    { input_tokens: 0, output_tokens: 0, total_tokens: Number.POSITIVE_INFINITY },
    { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: -1 } },
  ])("invalid reported fields cannot establish measured zero: %j", (value) => {
    const { receipt, billing } = response(value)
    expect(KiloUsage.report(receipt, billing.tokens)).toMatchObject({
      tokens: null,
      lowerBound: null,
      quality: "unknown",
    })
  })

  test.each([0, 100])("SDK-derived totals cannot upgrade partial input %i", async (input) => {
    const collector = KiloResponse.collector({ now: () => 100 })
    const receipt = collector.begin()
    const usage: Parameters<typeof asLanguageModelUsage>[0] = {
      inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }
    collector.normalized(receipt, "stop", usage)
    const normalized = asLanguageModelUsage(usage)
    expect(normalized.totalTokens).toBe(input)
    const events = await Effect.runPromise(
      LLMAISDK.toLLMEvents(LLMAISDK.adapterState(), {
        type: "finish-step",
        finishReason: "stop",
        rawFinishReason: "stop",
        usage: normalized,
        response: { id: "resp_partial_sdk", timestamp: new Date(0), modelId: model.id },
        providerMetadata: { kiloResponse: { receiptID: receipt.key } },
      }),
    )
    for (const event of events) collector.event(event)
    const billing = Session.getUsage({ model, usage: receipt.usage ?? new Usage({}) })
    expect(KiloUsage.report(receipt, billing.tokens)).toEqual({
      version: 1,
      tokens: null,
      lowerBound: input,
      quality: "partial",
      observedAt: 100,
    })
  })

  test("native normalized fallback cannot invent missing reported components", () => {
    const collector = KiloResponse.collector({ now: () => 100 })
    collector.event(
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
        providerMetadata: {
          kiloResponse: {
            source: "openai-responses",
            status: "completed",
            responseID: "resp_partial",
            usage: { inputTokens: 100 },
          },
        },
      }),
    )
    const receipt = collector.current()
    const billing = Session.getUsage({ model, usage: receipt.usage ?? new Usage({}) })
    expect(KiloUsage.report(receipt, billing.tokens)).toMatchObject({
      tokens: null,
      lowerBound: 100,
      quality: "partial",
      observedAt: 100,
    })
  })

  test("preserves the last meaningful measurement and rejects invalid or unlinked receipts", () => {
    const prior = measured(assistant("msg_old", "msg_user", 1), {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
    })
    const unknown = measured(assistant("msg_new", "msg_user", 2), undefined)
    expect(KiloUsage.latest([prior, unknown])?.measurement.tokens).toBe(120)
    const invalid = measured(assistant("msg_invalid", "msg_user", 3), {
      input_tokens: -1,
      output_tokens: 0,
      total_tokens: 0,
    })
    expect(KiloUsage.latest([prior, unknown, invalid])?.measurement.tokens).toBe(120)
    const zero = measured(assistant("msg_zero", "msg_user", 3), { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    expect(KiloUsage.latest([prior, unknown, zero])?.measurement.tokens).toBe(0)
    zero.parts = zero.parts.filter((part) => part.type !== "step-finish")
    expect(KiloUsage.read(zero).tokens).toBeNull()
    const corrupt = measured(assistant("msg_corrupt", "msg_user", 4), { total_tokens: 10 })
    const meta = corrupt.parts.find((part) => part.type === "text")
    if (meta?.type !== "text") throw new Error("missing measurement")
    meta.metadata!.kiloResponse.measurement.quality = "unknown"
    expect(KiloUsage.read(corrupt).tokens).toBeNull()
    const legacy = assistant("msg_legacy", "msg_user", 4)
    expect(KiloUsage.read(legacy).tokens).toBeNull()
    if (legacy.info.role !== "assistant") throw new Error("expected assistant")
    legacy.info.tokens = { input: 2, output: 1, reasoning: 0, total: 50 } as MessageV2.Assistant["tokens"]
    expect(KiloUsage.read(legacy)).toMatchObject({ tokens: 50, quality: "legacy" })
  })

  test("failed spending and summary workers are not context measurements", () => {
    const prior = measured(assistant("msg_prior", "msg_user", 1), { input_tokens: 100, output_tokens: 20 })
    const failed = measured(assistant("msg_failed", "msg_user", 2), { input_tokens: 5, output_tokens: 1 })
    if (failed.info.role !== "assistant") throw new Error("expected assistant")
    failed.info.error = new MessageV2.APIError({
      message: "[RESPONSE_INCOMPLETE] failed",
      isRetryable: false,
    }).toObject()
    const worker = measured(assistant("msg_worker", "msg_marker", 3), { input_tokens: 1, output_tokens: 1 })
    if (worker.info.role !== "assistant") throw new Error("expected assistant")
    worker.info.summary = true
    worker.parts.push(KiloCompactionState.mark({ message: worker.info, status: "worker" }))
    expect(KiloUsage.latest([prior, failed, worker])?.message.info.id).toBe(prior.info.id)
  })
})

describe("native context measurement provenance", () => {
  const it = testEffect(Layer.empty)

  for (const input of [0, 100]) {
    it.effect(`keeps native Chat input-only ${input} partial`, () =>
      Effect.gen(function* () {
        const result = yield* native(chat, [
          JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: input } }),
        ])
        expect(result.billing.tokens.total).toBe(input)
        expect(result.measurement).toEqual({
          version: 1,
          tokens: null,
          lowerBound: input,
          quality: "partial",
          observedAt: 100,
        })
      }),
    )
  }

  it.effect("retains reported Chat zero and rejects invalid raw input", () =>
    Effect.gen(function* () {
      const zero = yield* native(chat, [
        JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
      ])
      expect(zero.measurement).toMatchObject({ tokens: 0, lowerBound: 0, quality: "reported" })
      const invalid = yield* native(chat, [
        JSON.stringify({
          choices: [{ finish_reason: "stop" }],
          usage: { prompt_tokens: -1, completion_tokens: 0, total_tokens: 0 },
        }),
      ])
      expect(invalid.measurement).toMatchObject({ tokens: null, lowerBound: null, quality: "unknown" })
    }),
  )

  it.effect("preserves partial native Anthropic, Gemini, and Bedrock usage", () =>
    Effect.gen(function* () {
      const results = [
        yield* native(anthropic, [
          JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100 } } }),
          JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]),
        yield* native(google, [
          JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100 } }),
        ]),
        yield* native(bedrock, [
          { messageStop: { stopReason: "end_turn" } },
          { metadata: { usage: { inputTokens: 100 } } },
        ]),
      ]
      for (const result of results)
        expect(result.measurement).toMatchObject({ tokens: null, lowerBound: 100, quality: "partial" })
    }),
  )

  it.effect("does not double-count native cached or reasoning components", () =>
    Effect.gen(function* () {
      const results = [
        yield* native(chat, [
          JSON.stringify({
            choices: [{ finish_reason: "stop" }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 30,
              total_tokens: 130,
              prompt_tokens_details: { cached_tokens: 20 },
              completion_tokens_details: { reasoning_tokens: 10 },
            },
          }),
        ]),
        yield* native(anthropic, [
          JSON.stringify({
            type: "message_start",
            message: { usage: { input_tokens: 70, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } },
          }),
          JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } }),
        ]),
        yield* native(google, [
          JSON.stringify({
            candidates: [{ finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 20,
              thoughtsTokenCount: 10,
              cachedContentTokenCount: 20,
              totalTokenCount: 130,
            },
          }),
        ]),
        yield* native(bedrock, [
          { messageStop: { stopReason: "end_turn" } },
          {
            metadata: {
              usage: {
                inputTokens: 100,
                outputTokens: 30,
                totalTokens: 130,
                cacheReadInputTokens: 20,
                cacheWriteInputTokens: 10,
              },
            },
          },
        ]),
      ]
      for (const result of results)
        expect(result.measurement).toMatchObject({ tokens: 130, lowerBound: 130, quality: "reported" })
    }),
  )

  test("native usage without reported-field provenance remains unknown", () => {
    const collector = KiloResponse.collector()
    collector.native(
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
    )
    expect(KiloUsage.report(collector.current(), tokens)).toMatchObject({ tokens: null, quality: "unknown" })
  })
})

const it = testEffect(Session.defaultLayer)
it.instance("publishes stable linked measurements through real spending persistence", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* session.create({})
    const message = assistant(MessageID.ascending(), MessageID.ascending(), 1)
    if (message.info.role !== "assistant") throw new Error("expected assistant")
    message.info.sessionID = chat.id
    yield* session.updateMessage(message.info)
    const { collector } = response({ input_tokens: 100, output_tokens: 30, total_tokens: 130 })
    const accounting = KiloResponseAccounting.create({
      session,
      message: message.info,
      model,
      responses: collector,
      reconcile: () => Effect.void,
    })
    yield* accounting.flush()
    yield* accounting.flush()
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: message.info.id })
    expect(stored.parts.filter((part) => part.type === "step-finish")).toHaveLength(1)
    expect(KiloUsage.read(stored)).toEqual({
      version: 1,
      tokens: 130,
      lowerBound: 130,
      quality: "reported",
      observedAt: 100,
    })
  }),
)
