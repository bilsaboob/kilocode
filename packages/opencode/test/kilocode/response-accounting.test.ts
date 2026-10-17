import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { APICallError, jsonSchema, stepCountIs, streamText, tool, wrapLanguageModel } from "ai"
import { expect } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { LLM as NativeLLM } from "@opencode-ai/llm"
import { Auth, LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import * as Responses from "@opencode-ai/llm/protocols/openai-responses"
import * as Chat from "@opencode-ai/llm/protocols/openai-chat"
import { WebSocketServer } from "ws"
import { createServer } from "node:http"
import path from "node:path"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Image } from "../../src/image/image"
import { KiloResponse } from "../../src/kilocode/session/response"
import { KiloAuth } from "../../src/kilocode/auth/authority"
import { Env } from "../../src/env"
import { KiloResponseAccounting } from "../../src/kilocode/session/response-accounting"
import { KiloSessionRecovery } from "../../src/kilocode/session/recovery"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { OpenAIWebSocket } from "../../src/plugin/openai/ws"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { LLMAISDK } from "../../src/session/llm/ai-sdk"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { MessageID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { SyncEvent } from "../../src/sync"
import { isRecord } from "../../src/util/record"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { raw, TestLLMServer } from "../lib/llm-server"

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const usage = {
  input_tokens: 100,
  output_tokens: 30,
  total_tokens: 130,
  input_tokens_details: { cached_tokens: 20 },
  output_tokens_details: { reasoning_tokens: 10 },
}
const created = {
  type: "response.created",
  response: { id: "resp_paid", model: "test-model", created_at: 1, service_tier: null },
}
const call = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{}" },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}", status: "completed" },
  },
]
const terminal = (type = "response.completed", extra: Record<string, unknown> = {}) => ({
  type,
  response: { id: "resp_paid", service_tier: null, incomplete_details: null, usage, ...extra },
})

class Probe extends Context.Service<
  Probe,
  {
    current: Effect.Effect<KiloResponse.Collector | undefined>
    hold: Effect.Effect<void>
    ready: Effect.Effect<void>
    release: Effect.Effect<boolean>
    block: (mode: "receipt" | "spending") => Effect.Effect<void>
  }
>()("@test/ResponseProbe") {}
// Observe the real service request; no provider, parser, middleware, or processor logic is substituted.
const observed = Layer.unwrap(
  Effect.gen(function* () {
    const live = yield* LLM.Service
    const session = yield* Session.Service
    const ready = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let holding: "message" | "receipt" | "spending" | undefined
    let current: KiloResponse.Collector | undefined
    return Layer.mergeAll(
      Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          stream(input) {
            current = input.responses
            return live.stream(input)
          },
        }),
      ),
      Layer.succeed(
        Session.Service,
        Session.Service.of({
          ...session,
          updateMessage(message) {
            if (holding === "message" && message.role === "assistant" && message.time.completed) {
              holding = undefined
              return Deferred.succeed(ready, undefined).pipe(
                Effect.andThen(Deferred.await(release).pipe(Effect.timeout("5 seconds"), Effect.orDie)),
                Effect.andThen(session.updateMessage(message)),
              )
            }
            return session.updateMessage(message)
          },
          updatePart(part) {
            if (
              (holding === "receipt" && part.type === "text" && part.metadata?.kiloResponse) ||
              (holding === "spending" && part.type === "step-finish")
            ) {
              const persisted = holding === "spending"
              holding = undefined
              return Effect.gen(function* () {
                if (persisted) yield* session.updatePart(part)
                yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(release).pipe(Effect.timeout("5 seconds"), Effect.orDie)
                return yield* session.updatePart(part)
              })
            }
            return session.updatePart(part)
          },
        }),
      ),
      Layer.succeed(Probe, {
        current: Effect.sync(() => current),
        hold: Effect.sync(() => {
          holding = "message"
        }),
        block: (mode) =>
          Effect.sync(() => {
            holding = mode
          }),
        ready: Deferred.await(ready),
        release: Deferred.succeed(release, undefined),
      }),
    )
  }),
).pipe(Layer.provide(Layer.mergeAll(LLM.defaultLayer, Session.defaultLayer)))
const deps = Layer.mergeAll(
  observed,
  Snapshot.defaultLayer,
  Agent.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  Env.defaultLayer,
  Provider.defaultLayer,
  SessionStatus.defaultLayer,
  Image.defaultLayer,
  Bus.layer,
  SyncEvent.defaultLayer,
  EventV2Bridge.defaultLayer,
  RuntimeFlags.layer({ experimentalEventSystem: true }),
  Layer.mock(SessionSummary.Service)({ summarize: () => Effect.void }),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)))
const it = testEffect(
  Layer.mergeAll(
    TestLLMServer.layer,
    LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer)),
    AppFileSystem.defaultLayer,
    SessionProcessor.layer.pipe(Layer.provideMerge(deps)),
  ).pipe(Layer.provide(NodeFileSystem.layer)),
)

const setup = (npm = "@ai-sdk/openai", options?: { pricing?: string; url?: string }) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const fixture = yield* TestInstance
    const fs = yield* AppFileSystem.Service
    yield* fs.writeWithDirs(
      path.join(fixture.directory, "opencode.json"),
      JSON.stringify({
        model: "test/test-model",
        small_model: "test/test-model",
        enabled_providers: ["test"],
        snapshot: false,
        lsp: false,
        formatter: false,
        provider: {
          test: {
            name: "Test",
            npm,
            env: [],
            options: { apiKey: "fake-only", baseURL: options?.url ?? llm.url, maxRetries: 0 },
            models: {
              "test-model": {
                name: "Test",
                tool_call: true,
                limit: { context: 128000, output: 4096 },
                cost: { input: 2, output: 4, cache_read: 1, cache_write: 3 },
              },
            },
          },
        },
      }),
    )
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service
    const processors = yield* SessionProcessor.Service
    const chat = yield* sessions.create({ title: "Isolated response accounting" })
    const events: string[] = []
    const settlements: Record<string, unknown>[] = []
    const bridge = yield* EventV2Bridge.Service
    const unsubscribe = yield* bridge.sync((event) =>
      Effect.sync(() => {
        if (isRecord(event.data) && event.data.sessionID === chat.id) {
          events.push(event.type)
          if (event.type === "session.next.step.ended") settlements.push(event.data)
        }
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: chat.id,
      role: "user",
      time: { created: Date.now() },
      agent: "code",
      model: ref,
      authAuthority: yield* KiloAuth.capture(ref),
    })
    const message: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID: chat.id,
      parentID: user.id,
      role: "assistant",
      agent: "code",
      mode: "code",
      modelID: ref.modelID,
      providerID: ref.providerID,
      path: { cwd: fixture.directory, root: fixture.directory },
      time: { created: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    yield* sessions.updateMessage(message)
    const model = yield* provider.getModel(ref.providerID, ref.modelID)
    const agent = yield* agents.get("code")
    if (!agent) throw new Error("missing fixture agent")
    // A billing-only identity never selects a live provider: the stream still uses the isolated test model.
    const pricing = options?.pricing ? { ...model, providerID: ProviderID.make(options.pricing) } : model
    const handle = yield* processors.create({ assistantMessage: message, sessionID: chat.id, model: pricing })
    const input: LLM.StreamInput = {
      user,
      agent,
      model,
      sessionID: chat.id,
      system: [],
      messages: [{ role: "user", content: "Read the fixture." }],
      tools: {},
    }
    return { llm, sessions, chat, handle, input, events, settlements }
  })

for (const transport of ["http", "ws"]) {
  for (const scenario of [
    "completed",
    "unknown-after-tool",
    "missing-reason",
    "null-reason",
    "failed",
    "absent-usage",
    "zero-usage",
    "eof",
    "done-only",
    "empty",
    "malformed",
  ]) {
    it.instance(
      `installed SDK ${transport}: ${scenario}`,
      () =>
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const receipts = KiloResponse.collector()
          const incomplete = [
            "unknown-after-tool",
            "missing-reason",
            "null-reason",
            "absent-usage",
            "zero-usage",
          ].includes(scenario)
          const frame = terminal(
            scenario === "failed" ? "response.failed" : incomplete ? "response.incomplete" : "response.completed",
            {
              incomplete_details:
                scenario === "unknown-after-tool"
                  ? { reason: "provider_interrupted" }
                  : scenario === "missing-reason"
                    ? {}
                    : null,
              ...(scenario === "failed"
                ? { error: { code: "server_error", message: "Rate limit: upstream unavailable" } }
                : {}),
              ...(scenario === "absent-usage"
                ? { usage: null }
                : scenario === "zero-usage"
                  ? { usage: { input_tokens: 0, output_tokens: 0 } }
                  : {}),
              output: [{ encrypted_content: "must-not-be-retained", content: "private-prompt" }],
            },
          )
          const frames =
            scenario === "empty"
              ? []
              : [
                  created,
                  ...(scenario === "unknown-after-tool" ? call : []),
                  ...(scenario === "eof"
                    ? []
                    : scenario === "done-only"
                      ? [{ type: "response.done", response: { id: "resp_paid" } }]
                      : scenario === "malformed"
                        ? [{ type: "response.completed", response: null }]
                        : [frame]),
                ]
          let calls = 0
          const server =
            transport === "ws"
              ? yield* Effect.acquireRelease(
                  Effect.promise(async () => {
                    const http = createServer()
                    const server = new WebSocketServer({ server: http })
                    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
                    server.on("connection", (socket) =>
                      socket.once("message", () => {
                        calls++
                        for (const frame of frames) socket.send(JSON.stringify(frame))
                        socket.close()
                      }),
                    )
                    return { server, http }
                  }),
                  ({ server, http }) =>
                    Effect.sync(() => {
                      for (const socket of server.clients) socket.terminate()
                      server.close()
                      http.close()
                    }),
                )
              : undefined
          const fetcher: typeof fetch | undefined = server
            ? Object.assign(
                async (_url: RequestInfo | URL, init?: RequestInit) => {
                  const address = server.http.address()
                  if (!address || typeof address === "string") throw new Error("missing loopback address")
                  const socket = await OpenAIWebSocket.connectResponsesWebSocket({
                    url: `ws://127.0.0.1:${address.port}`,
                    headers: {},
                  })
                  if (typeof init?.body !== "string") throw new Error("fixture expected a JSON request body")
                  return OpenAIWebSocket.streamResponsesWebSocket({
                    socket,
                    body: JSON.parse(init.body),
                    signal: init?.signal ?? undefined,
                  })
                },
                { preconnect: globalThis.fetch.preconnect },
              )
            : undefined
          if (!server) yield* llm.push(raw({ responses: true, chunks: frames }))
          const sdk = createOpenAI({ apiKey: "fake-only", baseURL: llm.url, fetch: fetcher })
          const result = streamText({
            model: wrapLanguageModel({
              model: sdk.responses("test-model"),
              middleware: KiloResponse.middleware(receipts),
            }),
            prompt: "fixture",
            maxRetries: 0,
            onError: () => undefined,
            tools: {
              read: tool({
                inputSchema: jsonSchema({ type: "object", properties: {} }),
                execute: async () => "read receipt",
              }),
            },
          })
          const events = yield* Effect.promise(async () => {
            const events: { type: string; error?: unknown }[] = []
            try {
              for await (const event of result.fullStream) events.push(event)
            } catch (error) {
              events.push({ type: "error", error })
            }
            return events
          }).pipe(Effect.timeout("5 seconds"))
          const failures = events.filter((event) => event.type === "error")
          expect(receipts.receipts).toHaveLength(1)
          expect(receipts.current().responseID).toBe(scenario === "empty" ? undefined : "resp_paid")
          expect(JSON.stringify(KiloResponse.metadata(receipts.current()))).not.toContain("must-not-be-retained")
          expect(JSON.stringify(KiloResponse.metadata(receipts.current()))).not.toContain("private-prompt")
          expect(events.some((event) => event.type === "raw")).toBe(false)
          expect(server ? calls : yield* llm.calls).toBe(1)
          if (scenario === "completed") {
            expect(failures).toHaveLength(0)
            expect(receipts.current().status).toBe("completed")
          } else {
            expect(failures.length).toBeGreaterThan(0)
            const error = receipts.failure()
            expect(error?.isRetryable).toBe(false)
            expect(error?.message).toContain(
              scenario === "failed"
                ? "[RESPONSE_FAILED]"
                : incomplete
                  ? "[RESPONSE_INCOMPLETE]"
                  : "[RESPONSE_TERMINAL_MISSING]",
            )
            if (scenario === "failed") expect(error?.message).toContain("Rate limit: upstream unavailable")
          }
          if (["absent-usage", "eof", "done-only", "empty", "malformed"].includes(scenario))
            expect(receipts.current().usage).toBeUndefined()
          else expect(receipts.current().usage?.inputTokens).toBe(scenario === "zero-usage" ? 0 : 100)
        }),
      30_000,
    )
  }
}

for (const scenario of ["completed", "incomplete", "failed", "missing", "zero", "absent"]) {
  it.instance(
    `processor spending receipt: ${scenario}`,
    () =>
      Effect.gen(function* () {
        const { llm, sessions, chat, handle, input, events } = yield* setup()
        yield* llm.push(
          raw({
            responses: true,
            chunks: [
              created,
              ...(scenario === "missing"
                ? []
                : [
                    terminal(
                      scenario === "completed"
                        ? "response.completed"
                        : scenario === "failed"
                          ? "response.failed"
                          : "response.incomplete",
                      {
                        incomplete_details: scenario === "completed" ? null : { reason: "max_output_tokens" },
                        ...(scenario === "failed"
                          ? { error: { code: "context_length_exceeded", message: "Rate limit and context window" } }
                          : {}),
                        ...(scenario === "absent"
                          ? { usage: null }
                          : scenario === "zero"
                            ? { usage: { input_tokens: 0, output_tokens: 0 } }
                            : {}),
                      },
                    ),
                  ]),
            ],
          }),
        )
        const result = yield* handle.process(input)
        const saved = yield* sessions.messages({ sessionID: chat.id })
        const parts = saved.flatMap((message) => message.parts)
        const spending = parts.filter((part) => part.type === "step-finish")
        const receipts = parts.filter((part) => part.type === "text" && part.metadata?.kiloResponse)
        expect(receipts).toHaveLength(1)
        expect(spending.length).toBeLessThanOrEqual(1)
        if (["absent", "missing"].includes(scenario)) expect(spending).toHaveLength(0)
        expect(yield* llm.calls).toBe(1)
        if (!["absent", "missing"].includes(scenario)) {
          expect(spending).toHaveLength(1)
          expect(spending[0].tokens.input).toBe(scenario === "zero" ? 0 : 80)
          expect(spending[0].tokens.cache.read).toBe(scenario === "zero" ? 0 : 20)
          expect(spending[0].tokens.reasoning).toBe(scenario === "zero" ? 0 : 10)
          expect(spending[0].cost).toBeCloseTo(scenario === "zero" ? 0 : 0.0003, 10)
          expect(handle.message.cost).toBeCloseTo(spending[0].cost, 10)
          expect((yield* sessions.get(chat.id)).cost).toBeCloseTo(spending[0].cost, 10)
        }
        expect(
          events.filter((type) => type === "session.next.step.ended" || type === "session.next.step.failed"),
        ).toEqual([scenario === "completed" ? "session.next.step.ended" : "session.next.step.failed"])
        if (scenario === "completed") {
          expect(result).toBe("continue")
          expect(handle.message.error).toBeUndefined()
          return
        }
        expect(result).toBe("stop")
        expect(handle.message.error?.name).toBe("APIError")
        expect(KiloSessionRecovery.interrupted(handle.message)).toBe(false)
        expect(SessionRetry.retryable(handle.message.error!)).toBeUndefined()
        const receipt = receipts[0]
        if (receipt.type !== "text") throw new Error("missing receipt")
        expect(receipt.ignored).toBe(true)
        expect(receipt.metadata?.kiloResponse.usageReported).toBe(!["absent", "missing"].includes(scenario))
      }),
    30_000,
  )
}

for (const stage of ["created", "usage"]) {
  it.instance(
    `Stop preserves ${stage} receipt before tool completion`,
    () =>
      Effect.gen(function* () {
        const { llm, sessions, chat, handle, input, events } = yield* setup()
        const probe = yield* Probe
        let executions = 0
        input.tools.read = tool({
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: (_input, options) => {
            executions++
            return new Promise((_resolve, reject) =>
              options.abortSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
                once: true,
              }),
            )
          },
        })
        yield* llm.push(
          raw({
            responses: true,
            chunks: [created, ...call, ...(stage === "usage" ? [terminal()] : [])],
            hang: stage === "created",
          }),
        )
        const fiber = yield* handle.process(input).pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const collector = yield* probe.current
            const receipt = collector?.receipts.at(-1)
            return executions === 1 && receipt?.responseID && (stage === "created" || receipt.usage) ? true : undefined
          }),
          "raw receipt was not observed",
          "5 seconds",
        )
        yield* Fiber.interrupt(fiber)
        const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(
          events.filter((type) => type === "session.next.step.ended" || type === "session.next.step.failed"),
        ).toEqual(["session.next.step.failed"])
        expect(KiloSessionRecovery.interrupted(handle.message)).toBe(false)
        const spending = parts.filter((part) => part.type === "step-finish")
        expect(spending).toHaveLength(stage === "usage" ? 1 : 0)
        expect(handle.message.cost).toBeCloseTo(stage === "usage" ? 0.0003 : 0, 10)
        expect((yield* sessions.get(chat.id)).cost).toBeCloseTo(stage === "usage" ? 0.0003 : 0, 10)
        expect(executions).toBe(1)
        expect(yield* llm.calls).toBe(1)
        const receipts = parts.filter((part) => part.type === "text" && part.metadata?.kiloResponse)
        expect(receipts).toHaveLength(1)
        expect(receipts[0]).toMatchObject({
          ignored: true,
          metadata: { kiloResponse: { responseID: "resp_paid", aborted: true, usageReported: stage === "usage" } },
        })
      }),
    30_000,
  )
}

it.instance(
  "generic output limit spends once and does not auto-resume",
  () =>
    Effect.gen(function* () {
      const { llm, handle, input, events } = yield* setup("@ai-sdk/openai-compatible")
      yield* llm.push(
        raw({
          chunks: [
            {
              id: "chat_fixture",
              choices: [{ delta: { content: "Partial" }, finish_reason: "length" }],
              usage: { prompt_tokens: 10, completion_tokens: 20 },
            },
          ],
        }),
      )
      expect(yield* handle.process(input)).toBe("stop")
      expect(handle.message.error).toMatchObject({
        name: "APIError",
        data: { isRetryable: false, message: expect.stringContaining("[RESPONSE_INCOMPLETE]") },
      })
      expect(handle.message.cost).toBeCloseTo(0.0001, 10)
      expect(KiloSessionRecovery.interrupted(handle.message)).toBe(false)
      expect(KiloSessionRecovery.interrupted({ ...handle.message, finish: "length", error: undefined })).toBe(false)
      expect(
        events.filter((type) => type === "session.next.step.ended" || type === "session.next.step.failed"),
      ).toEqual(["session.next.step.failed"])
      expect(yield* llm.calls).toBe(1)
    }),
  30_000,
)

it.instance(
  "Stop during processor finalization chooses failure once and retains spending",
  () =>
    Effect.gen(function* () {
      const { llm, handle, input, events, sessions, chat } = yield* setup()
      const probe = yield* Probe
      yield* probe.hold
      yield* llm.push(raw({ responses: true, chunks: [created, terminal()] }))
      const fiber = yield* handle.process(input).pipe(Effect.forkChild)
      yield* probe.ready.pipe(Effect.timeout("5 seconds"))
      expect(events.some((type) => type === "session.next.step.ended")).toBe(false)
      yield* Effect.sync(() => fiber.interruptUnsafe())
      yield* probe.release
      yield* Fiber.await(fiber)
      expect(handle.message.error?.name).toBe("MessageAbortedError")
      expect(
        events.filter((type) => type === "session.next.step.ended" || type === "session.next.step.failed"),
      ).toEqual(["session.next.step.failed"])
      const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
      expect(parts.filter((part) => part.type === "step-finish")).toHaveLength(1)
      expect((yield* sessions.get(chat.id)).cost).toBeCloseTo(0.0003, 10)
      expect(parts.find((part) => part.type === "text" && part.metadata?.kiloResponse)).toMatchObject({
        metadata: { kiloResponse: { aborted: true, responseID: "resp_paid", usageReported: true } },
      })
      expect(yield* llm.calls).toBe(1)
    }),
  30_000,
)

it.effect("terminal markers override 500 and rate-limit retry heuristics", () =>
  Effect.sync(() => {
    for (const marker of [
      "RESPONSE_INCOMPLETE",
      "RESPONSE_FAILED",
      "RESPONSE_TERMINAL_MISSING",
      "COMPACTION_RESOURCE_LIMIT",
    ]) {
      const error = MessageV2.fromError(
        new APICallError({
          message: `[${marker}] rate limit: context length exceeded`,
          statusCode: 500,
          isRetryable: false,
          url: "",
          requestBodyValues: {},
        }),
        { providerID: ProviderID.make("openai") },
      )
      expect(error.name).toBe("APIError")
      expect(SessionRetry.retryable(error)).toBeUndefined()
      expect(
        SessionRetry.retryable({ name: "UnknownError", data: { message: `[${marker}] rate limit` } }),
      ).toBeUndefined()
    }
  }),
)

it.effect("Stop freezes accounting observations without draining later queued terminals", () =>
  Effect.sync(() => {
    for (const observed of [false, true]) {
      const responses = KiloResponse.collector()
      const receipt = responses.begin(true)
      responses.raw(receipt, created)
      if (observed) responses.raw(receipt, terminal())
      responses.interrupt()
      responses.raw(receipt, terminal("response.failed", { usage: { input_tokens: 999, output_tokens: 999 } }))
      responses.normalized(receipt, "stop", { inputTokens: 999, outputTokens: 999 })
      expect(receipt.usage?.inputTokens).toBe(observed ? 100 : undefined)
      expect(receipt.status).toBe(observed ? "completed" : "aborted")
      expect(responses.failure()).toBeUndefined()
    }
  }),
)

for (const diagnostic of ["socket hang up", "fetch failed"]) {
  it.instance(
    `provider diagnostic cannot authorize replay: ${diagnostic}`,
    () =>
      Effect.gen(function* () {
        const { llm, handle, input, events } = yield* setup()
        yield* llm.push(
          raw({
            responses: true,
            chunks: [created, terminal("response.failed", { error: { code: "server_error", message: diagnostic } })],
          }),
        )
        expect(yield* handle.process(input)).toBe("stop")
        if (handle.message.error?.name !== "APIError") throw new Error("missing failed response APIError")
        expect(handle.message.error.data.isRetryable).toBe(false)
        expect(handle.message.error.data.message).toContain(`[RESPONSE_FAILED] server_error: ${diagnostic}`)
        expect(KiloResponse.blocked(handle.message.error)).toBe(true)
        expect(SessionRetry.retryable(handle.message.error)).toBeUndefined()
        expect(KiloSessionRecovery.interrupted(handle.message)).toBe(false)
        expect(
          events.filter((type) => type === "session.next.step.ended" || type === "session.next.step.failed"),
        ).toEqual(["session.next.step.failed"])
        expect(yield* llm.calls).toBe(1)
        expect(yield* llm.pending).toBe(0)
      }),
    30_000,
  )
}

const chat = (cost: number, toolcall = false, tokens = 100) => ({
  id: "chat_paid",
  provider: "fixture",
  choices: [
    {
      index: 0,
      delta: toolcall
        ? { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] }
        : { content: "done" },
      finish_reason: toolcall ? "tool_calls" : "stop",
    },
  ],
  usage: {
    prompt_tokens: tokens,
    completion_tokens: 30,
    total_tokens: tokens + 30,
    cost,
    cost_details: { upstream_inference_cost: cost / 2 },
  },
})

for (const billing of ["openrouter", "kilo", "anthropic"]) {
  it.instance(
    `installed SDK billing survives aggregate finish and cleanup: ${billing}`,
    () =>
      Effect.gen(function* () {
        const {
          llm,
          handle,
          input,
          sessions,
          chat: session,
          settlements,
        } = yield* setup(billing === "anthropic" ? "@ai-sdk/anthropic" : "@openrouter/ai-sdk-provider", {
          pricing: billing,
        })
        const frames =
          billing === "anthropic"
            ? [
                {
                  type: "message_start",
                  message: {
                    id: "msg_paid",
                    type: "message",
                    role: "assistant",
                    model: "test-model",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 100, output_tokens: 0 },
                  },
                },
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
                { type: "content_block_stop", index: 0 },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: { output_tokens: 30, cost_details: { upstream_inference_cost: 0.37 } },
                },
                { type: "message_stop" },
              ]
            : [chat(0.42)]
        yield* llm.push(raw({ chunks: frames }))
        expect(yield* handle.process(input)).toBe("continue")
        const expected = billing === "anthropic" ? 0.37 : billing === "kilo" ? 0.21 : 0.42
        const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) => message.parts)
        const spending = parts.filter((part) => part.type === "step-finish")
        expect(spending).toHaveLength(1)
        expect(spending[0].cost).toBeCloseTo(expected, 10)
        expect(handle.message.cost).toBeCloseTo(expected, 10)
        expect((yield* sessions.get(session.id)).cost).toBeCloseTo(expected, 10)
        expect(settlements).toHaveLength(1)
        expect(settlements[0].cost).toBeCloseTo(expected, 10)
        expect(handle.message.error).toBeUndefined()
        expect(yield* llm.calls).toBe(1)
      }),
    30_000,
  )
}

it.instance(
  "installed SDK multi-step aggregates never replace per-response billing",
  () =>
    Effect.gen(function* () {
      const { llm, sessions, chat: session, handle, input } = yield* setup()
      const responses = KiloResponse.collector()
      const accounting = KiloResponseAccounting.create({
        session: sessions,
        message: handle.message,
        model: input.model,
        responses,
        reconcile: () => Effect.void,
      })
      yield* llm.push(raw({ chunks: [chat(0.42, true)] }), raw({ chunks: [chat(0.84, false, 200)] }))
      const sdk = createOpenRouter({ apiKey: "fake-only", baseURL: llm.url })
      const result = streamText({
        model: wrapLanguageModel({ model: sdk.chat("test-model"), middleware: KiloResponse.middleware(responses) }),
        prompt: "fixture",
        stopWhen: stepCountIs(2),
        maxRetries: 0,
        tools: {
          read: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "receipt" }),
        },
      })
      const iterator = result.fullStream[Symbol.asyncIterator]()
      const adapter = LLMAISDK.adapterState()
      while (true) {
        const next = yield* Effect.promise(() => iterator.next())
        if (next.done) break
        for (const event of yield* LLMAISDK.toLLMEvents(adapter, next.value)) {
          responses.event(event)
          yield* accounting.flush()
        }
      }
      yield* accounting.flush().pipe(Effect.uninterruptible)
      yield* accounting.flush().pipe(Effect.uninterruptible)
      const spending = (yield* sessions.messages({ sessionID: session.id }))
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "step-finish")
      expect(responses.receipts).toHaveLength(2)
      expect(responses.receipts.map((receipt) => receipt.usage?.inputTokens)).toEqual([100, 200])
      expect(spending).toHaveLength(2)
      expect(spending.map((part) => part.cost)).toEqual([0.42, 0.84])
      expect(handle.message.cost).toBeCloseTo(1.26, 10)
      expect((yield* sessions.get(session.id)).cost).toBeCloseTo(1.26, 10)
      expect(yield* llm.calls).toBe(2)
    }),
  30_000,
)

it.instance(
  "native parser rounds retain separate receipts and reject a late conflicting terminal",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const responses = KiloResponse.collector()
      const request = NativeLLM.request({
        model: Responses.route
          .with({ endpoint: { baseURL: `${llm.url}/` }, auth: Auth.bearer("fake-only") })
          .model({ id: "fixture" }),
        prompt: "fixture",
      })
      for (const [id, tokens] of [
        ["resp_first", 100],
        ["resp_second", 200],
      ] as const) {
        yield* llm.push(
          raw({
            responses: true,
            chunks: [
              { type: "response.created", response: { id, usage: { input_tokens: 0, output_tokens: 0 } } },
              { type: "response.completed", response: { id, usage: { input_tokens: tokens, output_tokens: 30 } } },
            ],
          }),
        )
        const events = yield* LLMClient.stream(request).pipe(Stream.runCollect)
        for (const event of events) responses.native(event)
      }
      expect(responses.receipts.map((receipt) => receipt.responseID)).toEqual(["resp_first", "resp_second"])
      expect(responses.receipts.map((receipt) => receipt.usage?.inputTokens)).toEqual([100, 200])
      yield* llm.push(
        raw({
          responses: true,
          chunks: [
            {
              type: "response.failed",
              response: {
                id: "resp_first",
                error: { code: "server_error", message: "late conflicting terminal" },
                usage: { input_tokens: 999, output_tokens: 999 },
              },
            },
          ],
        }),
      )
      const late = yield* LLMClient.stream(request).pipe(Stream.runCollect)
      for (const event of late) responses.native(event)
      expect(responses.receipts).toHaveLength(2)
      expect(responses.receipts.map((receipt) => receipt.usage?.inputTokens)).toEqual([100, 200])
      expect(responses.receipts[0].status).toBe("failed")
      expect(responses.receipts[1].status).toBe("completed")
      expect(responses.failure()?.message).toContain("[RESPONSE_FAILED]")
      expect(yield* llm.calls).toBe(3)
    }),
  30_000,
)

it.instance(
  "native rounds without response IDs still receive distinct spending identities",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const responses = KiloResponse.collector()
      const request = NativeLLM.request({
        model: Chat.route
          .with({ endpoint: { baseURL: `${llm.url}/` }, auth: Auth.bearer("fake-only") })
          .model({ id: "fixture" }),
        prompt: "fixture",
      })
      for (const tokens of [100, 200]) {
        yield* llm.push(raw({ chunks: [chat(0.42, false, tokens)] }))
        const events = yield* LLMClient.stream(request).pipe(Stream.runCollect)
        for (const event of events) responses.native(event)
      }
      expect(responses.receipts).toHaveLength(2)
      expect(new Set(responses.receipts.map((receipt) => receipt.key)).size).toBe(2)
      expect(responses.receipts.map((receipt) => receipt.usage?.inputTokens)).toEqual([100, 200])
      expect(responses.receipts.every((receipt) => receipt.responseID === undefined)).toBe(true)
      expect(responses.failure()).toBeUndefined()
      expect(yield* llm.calls).toBe(2)
    }),
  30_000,
)

for (const mode of ["receipt", "spending"] as const) {
  it.instance(
    `Stop freezes during an accounting write: ${mode}`,
    () =>
      Effect.gen(function* () {
        const probe = yield* Probe
        const encoder = new TextEncoder()
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        let closed = false
        let calls = 0
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch() {
                calls++
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(stream) {
                      controller = stream
                      stream.enqueue(encoder.encode(`data: ${JSON.stringify(created)}\n\n`))
                      if (mode === "spending") {
                        stream.enqueue(encoder.encode(`data: ${JSON.stringify(terminal())}\n\ndata: [DONE]\n\n`))
                        stream.close()
                        closed = true
                      }
                    },
                    cancel() {
                      closed = true
                    },
                  }),
                  { headers: { "Content-Type": "text/event-stream" } },
                )
              },
            }),
          ),
          (server) =>
            Effect.promise(async () => {
              await server.stop(true)
            }),
        )
        const {
          handle,
          input,
          sessions,
          chat: session,
        } = yield* setup("@ai-sdk/openai", { url: `http://127.0.0.1:${server.port}/v1` })
        yield* probe.block(mode)
        const fiber = yield* handle.process(input).pipe(Effect.forkChild)
        yield* probe.ready.pipe(Effect.timeout("5 seconds"))
        yield* pollWithTimeout(
          probe.current.pipe(Effect.map((responses) => (responses?.current().responseID ? true : undefined))),
          "created response was not observed",
        )
        yield* Effect.sync(() => fiber.interruptUnsafe())
        // This acknowledgement must occur while the local write gate is still closed.
        yield* pollWithTimeout(
          probe.current.pipe(Effect.map((responses) => (responses?.current().aborted ? true : undefined))),
          "Stop was masked by the local write",
          "3 seconds",
        )
        const responses = yield* probe.current
        if (!responses) throw new Error("missing streaming receipt collector")
        yield* Effect.sync(() => {
          const late = terminal("response.failed", { usage: { input_tokens: 999, output_tokens: 999 } })
          // Attempt a post-Stop terminal before releasing the write; transport cancellation may already reject it.
          if (!closed) controller!.enqueue(encoder.encode(`data: ${JSON.stringify(late)}\n\n`))
          // Also exercise an already-queued middleware callback after transport cancellation.
          responses.raw(responses.current(), late)
        })
        yield* probe.release
        yield* Fiber.await(fiber)
        expect(responses?.current().usage?.inputTokens).toBe(mode === "spending" ? 100 : undefined)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        const spending = (yield* sessions.messages({ sessionID: session.id }))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "step-finish")
        expect(spending).toHaveLength(mode === "spending" ? 1 : 0)
        expect(handle.message.cost).toBeCloseTo(mode === "spending" ? 0.0003 : 0, 10)
        expect((yield* sessions.get(session.id)).cost).toBeCloseTo(mode === "spending" ? 0.0003 : 0, 10)
        expect(calls).toBe(1)
      }),
    30_000,
  )
}

it.instance(
  "Stop after persisted Step.Ended commits success once without continuation",
  () =>
    Effect.gen(function* () {
      const { llm, handle, input, events, sessions, chat: session } = yield* setup()
      const bridge = yield* EventV2Bridge.Service
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const unsubscribe = yield* bridge.sync((event) =>
        event.type === "session.next.step.ended" && isRecord(event.data) && event.data.sessionID === session.id
          ? Deferred.succeed(ready, undefined).pipe(
              Effect.andThen(Deferred.await(release).pipe(Effect.timeout("5 seconds"), Effect.orDie)),
            )
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* llm.push(raw({ responses: true, chunks: [created, terminal()] }))
      const fiber = yield* handle.process(input).pipe(Effect.forkChild)
      yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
      expect(events.filter((type) => type === "session.next.step.ended")).toHaveLength(1)
      yield* Effect.sync(() => fiber.interruptUnsafe())
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(
        events.filter((type) => type === "session.next.step.ended" || type === "session.next.step.failed"),
      ).toEqual(["session.next.step.ended"])
      expect(handle.message.error).toBeUndefined()
      const saved = yield* sessions.messages({ sessionID: session.id })
      expect(saved.find((message) => message.info.id === handle.message.id)?.info).toMatchObject({
        finish: "stop",
        cost: 0.0003,
      })
      const parts = saved.flatMap((message) => message.parts)
      expect(parts.filter((part) => part.type === "step-finish")).toHaveLength(1)
      const receipt = parts.find((part) => part.type === "text" && part.metadata?.kiloResponse)
      expect(receipt).toMatchObject({ metadata: { kiloResponse: { status: "completed", usageReported: true } } })
      if (receipt?.type !== "text") throw new Error("missing committed receipt")
      expect(receipt.metadata?.kiloResponse.aborted).not.toBe(true)
      expect(yield* llm.calls).toBe(1)
    }),
  30_000,
)
