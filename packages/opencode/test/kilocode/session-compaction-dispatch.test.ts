import { expect } from "bun:test"
import { createServer } from "node:http"
import { WebSocketServer } from "ws"
import { createOpenAI } from "@ai-sdk/openai"
import { LLM } from "@opencode-ai/llm"
import * as OpenAI from "@opencode-ai/llm/providers/openai"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { streamText, wrapLanguageModel } from "ai"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { AuthRequest } from "@/kilocode/auth/request"
import { AuthSource } from "@/kilocode/auth/source"
import { AuthTransport } from "@/kilocode/auth/transport"
import { KiloCompactionBudget as Budget } from "@/kilocode/session/compaction-budget"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { OpenAIWebSocketPool } from "@/plugin/openai/ws-pool"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
  ),
)
const model = ProviderTest.model()
const fixture = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({})
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    model: { providerID: model.providerID, modelID: model.id },
    time: { created: Date.now() },
  })
  const input = { sessionID: session.id, messageID: user.id }
  yield* Budget.admit(input)
  return input
})

function selected(oauth = false): AuthSource.Selected {
  return {
    snapshot: {
      version: 1,
      providerID: "openai",
      source: "config",
      kind: oauth ? "oauth" : "api",
      authority: "fixture-authority",
      runtime: AuthSource.runtime,
      managed: true,
      env: "[]",
    },
    credential: oauth
      ? { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 }
      : { type: "api", key: "fixture-key" },
    reason: "local-valid",
  }
}

function guarded(source = selected()) {
  return Effect.gen(function* () {
    const budget = yield* Budget.dispatcher
    const guard = AuthRequest.create({
      expected: source.snapshot,
      resolve: async () => source,
      dispatch: budget?.transport,
      unsupported: () => {
        throw Budget.error("The custom model transport cannot verify physical dispatch accounting")
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => guard.close()))
    return { guard, budget }
  })
}

it.instance("actual SDK HTTP retries spend one reservation each, not model plus fetch", () =>
  Effect.gen(function* () {
    const input = yield* fixture
    let sends = 0
    const errors: unknown[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            sends++
            return new Response("fixture retry", { status: 503, headers: { "retry-after-ms": "0" } })
          },
        }),
      ),
      (value) => Effect.promise(() => value.stop(true)),
    )
    yield* Budget.run(
      input,
      Effect.gen(function* () {
        const { guard, budget } = yield* guarded()
        const fetch: typeof globalThis.fetch = Object.assign(
          (request: RequestInfo | URL, init?: RequestInit) =>
            AuthRequest.dispatch(globalThis.fetch, request, init, "openai"),
          { preconnect: globalThis.fetch.preconnect },
        )
        const sdk = createOpenAI({ apiKey: "fixture-key", baseURL: `${server.url.origin}/v1`, fetch })
        yield* Effect.promise(async (signal) => {
          await streamText({
            model: wrapLanguageModel({ model: sdk.chat(model.id), middleware: Budget.middleware(budget) }),
            prompt: "Summarize",
            abortSignal: signal,
            maxRetries: 20,
            headers: { [AuthRequest.header]: guard.id },
            onError: ({ error }) => {
              errors.push(error)
            },
          }).consumeStream()
        })
      }),
    )
    expect(sends).toBe(12)
    expect(Budget.inspect(input)?.requests).toBe(12)
    expect(errors.some(Budget.blocked)).toBe(true)
  }),
)

it.instance("actual native HTTP internal retries retain the resource error and cannot issue send thirteen", () =>
  Effect.gen(function* () {
    const input = yield* fixture
    const client = yield* LLMClient.Service
    let sends = 0
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            sends++
            return new Response("fixture retry", { status: 503, headers: { "retry-after-ms": "0" } })
          },
        }),
      ),
      (value) => Effect.promise(() => value.stop(true)),
    )
    let failure: unknown
    yield* Budget.run(
      input,
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 14; attempt++) {
          const { guard } = yield* guarded()
          const current = LLMNativeRuntime.stream({
            model,
            provider: {
              id: model.providerID,
              name: "Fixture",
              source: "config",
              env: [],
              models: {},
              options: { apiKey: "fixture-key", baseURL: `${server.url.origin}/v1` },
            },
            auth: selected().credential,
            llmClient: client,
            messages: [{ role: "user", content: "Summarize" }],
            tools: {},
            headers: {},
            abort: guard.signal,
            guard,
          })
          if (current.type !== "supported") throw new Error(current.reason)
          const exit = yield* AuthTransport.stream(current.stream, guard).pipe(Stream.runDrain, Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) failure = Cause.squash(exit.cause)
          if (Budget.blocked(failure)) break
        }
      }),
    )
    expect(sends).toBe(12)
    expect(Budget.inspect(input)?.requests).toBe(12)
    expect(Budget.blocked(failure)).toBe(true)
  }),
)

it.instance("native WebSocket handshakes do not count as a second model dispatch", () =>
  Effect.gen(function* () {
    const input = yield* fixture
    const client = yield* LLMClient.Service
    let sends = 0
    let opens = 0
    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const http = createServer()
        const sockets = new Set<import("node:net").Socket>()
        http.on("connection", (socket) => {
          sockets.add(socket)
          socket.on("close", () => sockets.delete(socket))
        })
        const ws = new WebSocketServer({ server: http })
        ws.on("connection", (socket) => {
          opens++
          socket.on("message", () => {
            sends++
            socket.send(
              JSON.stringify({
                type: "response.completed",
                response: { usage: { input_tokens: 1, output_tokens: 1 } },
              }),
            )
            socket.close(1000)
          })
        })
        await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
        const address = http.address()
        if (!address || typeof address === "string") throw new Error("Missing fixture address")
        return { http, ws, sockets, url: `http://127.0.0.1:${address.port}` }
      }),
      (value) =>
        Effect.promise(async () => {
          for (const socket of value.ws.clients) socket.terminate()
          for (const socket of value.sockets) socket.destroy()
          value.http.closeAllConnections()
          await Promise.all([
            new Promise<void>((resolve) => value.ws.close(() => resolve())),
            new Promise<void>((resolve, reject) =>
              value.http.close((error) =>
                error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING") ? reject(error) : resolve(),
              ),
            ),
          ])
        }),
    )
    let failure: unknown
    yield* Budget.run(
      input,
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 13; attempt++) {
          const { guard } = yield* guarded()
          const stream = client.stream(
            LLM.request({
              model: OpenAI.configure({ apiKey: "fixture-key", baseURL: `${server.url}/v1` }).responsesWebSocket(
                model.id,
              ),
              prompt: "Summarize",
            }),
          )
          const exit = yield* AuthTransport.stream(stream, guard).pipe(Stream.runDrain, Effect.scoped, Effect.exit)
          if (Exit.isFailure(exit)) {
            failure = Cause.squash(exit.cause)
            break
          }
        }
      }),
    )
    expect(sends).toBe(12)
    expect(opens).toBe(13)
    expect(Budget.inspect(input)?.requests).toBe(12)
    expect(Budget.blocked(failure)).toBe(true)
  }),
)

it.instance(
  "actual OAuth WS interception counts physical sends and the HTTP fallback, never outer fetch wrappers",
  () =>
    Effect.gen(function* () {
      const input = yield* fixture
      let sends = 0
      let http = 0
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request, server) {
              if (server.upgrade(request)) return undefined
              http++
              return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
            },
            websocket: {
              message(socket) {
                sends++
                socket.send(
                  JSON.stringify({
                    type: "error",
                    error: { code: "websocket_connection_limit_reached", message: "fixture reconnect" },
                  }),
                )
              },
            },
          }),
        ),
        (value) => Effect.promise(() => value.stop(true)),
      )
      const source = selected(true)
      const plugin = yield* Effect.acquireRelease(
        Effect.promise(() =>
          CodexAuthPlugin({} as never, {
            experimentalWebSockets: true,
            codexApiEndpoint: `${server.url.origin}/responses`,
          }),
        ),
        (value) =>
          Effect.promise(async () => {
            await value.dispose?.()
          }),
      )
      const loaded = yield* Effect.promise(() => plugin.auth!.loader!(async () => source.credential!, {} as never))
      yield* Budget.run(
        input,
        Effect.gen(function* () {
          const { guard, budget } = yield* guarded(source)
          for (let attempt = 0; attempt < 6; attempt++) {
            budget!.model()
            yield* Effect.promise(async () => {
              const response = await AuthRequest.dispatch(
                loaded.fetch,
                `${server.url.origin}/v1/responses`,
                {
                  method: "POST",
                  headers: { [AuthRequest.header]: guard.id, "x-session-affinity": "fixture-session" },
                  body: JSON.stringify({ model: model.id, stream: true, input: "Summarize" }),
                },
                "openai",
              )
              await response.text().catch((error: unknown) => {
                if (attempt === 5) throw error
                expect(String(error)).toContain("fixture reconnect")
              })
            })
            expect(Budget.inspect(input)?.requests).toBe(attempt === 5 ? 7 : attempt + 1)
          }
        }),
      )
      expect(sends).toBe(6)
      expect(http).toBe(1)
      expect(Budget.inspect(input)?.requests).toBe(7)
    }),
)

it.instance("an exhausted WS budget preserves the original error and never falls back to paid HTTP", () =>
  Effect.gen(function* () {
    const input = yield* fixture
    let sends = 0
    let http = 0
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            if (server.upgrade(request)) return undefined
            http++
            return new Response("unexpected")
          },
          websocket: {
            message(socket) {
              sends++
              socket.send(JSON.stringify({ type: "response.done", response: { id: "fixture" } }))
            },
          },
        }),
      ),
      (value) => Effect.promise(() => value.stop(true)),
    )
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => OpenAIWebSocketPool.createWebSocketFetch({ streamRetries: 0 })),
      (value) => Effect.sync(() => value.close()),
    )
    let failure: unknown
    yield* Budget.run(
      input,
      Effect.gen(function* () {
        const { guard } = yield* guarded()
        for (let attempt = 0; attempt < 13; attempt++) {
          const exit = yield* Effect.tryPromise(() =>
            AuthRequest.dispatch(
              pool,
              `${server.url.origin}/v1/responses`,
              {
                method: "POST",
                headers: { [AuthRequest.header]: guard.id, "x-session-affinity": "fixture-session" },
                body: JSON.stringify({ stream: true, input: "Summarize" }),
              },
              "openai",
            ).then((response) => response.text()),
          ).pipe(Effect.exit)
          if (Exit.isFailure(exit)) {
            failure = guard.error()
            break
          }
        }
      }),
    )
    expect(sends).toBe(12)
    expect(http).toBe(0)
    expect(Budget.inspect(input)?.requests).toBe(12)
    expect(Budget.blocked(failure)).toBe(true)
  }),
)

it.instance("unverifiable custom fetch retries fail closed before a physical request", () =>
  Effect.gen(function* () {
    const input = yield* fixture
    let sends = 0
    const unknown = Object.assign(
      async () => {
        sends++
        return new Response("unexpected")
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    yield* Budget.run(
      input,
      Effect.gen(function* () {
        const { guard, budget } = yield* guarded()
        budget!.model()
        const exit = yield* Effect.tryPromise(() =>
          AuthRequest.dispatch(
            unknown,
            "https://fixture.invalid",
            { headers: { [AuthRequest.header]: guard.id } },
            "openai",
          ),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Budget.blocked(guard.error())).toBe(true)
      }),
    )
    expect(sends).toBe(0)
    expect(Budget.inspect(input)?.requests).toBe(1)
  }),
)
