import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "node:path"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Global } from "@opencode-ai/core/global"
import { AuthRequest } from "../../src/kilocode/auth/request"
import { AuthStore } from "../../src/kilocode/auth/store"
import { KiloCompactionBudget } from "../../src/kilocode/session/compaction-budget"
import { KiloCompactionState } from "../../src/kilocode/session/compaction-state"
import { KiloContextPolicy } from "../../src/kilocode/session/context-policy"
import { KiloSessionRecovery } from "../../src/kilocode/session/recovery"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, PartID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { isRecord } from "../../src/util/record"
import { requireInstance, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    SessionCompaction.defaultLayer,
    Session.defaultLayer,
    Provider.defaultLayer,
    Config.defaultLayer,
    Auth.defaultLayer,
    SessionStatus.defaultLayer,
    EventV2Bridge.defaultLayer,
    AppFileSystem.defaultLayer,
  ).pipe(Layer.provide(NodeFileSystem.layer)),
)

const ref = { providerID: ProviderID.make("kilo"), modelID: ModelID.make("fixture-model") }
const profile = JSON.stringify({ version: 1, window: "maximum-supported", automaticPercent: 65, admissionPercent: 75 })
const schema = {
  type: "object",
  properties: { components: { type: "array", items: { type: "object" } } },
  required: ["components"],
  additionalProperties: false,
}
const image = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
const packet =
  "TASK-AUTH-CONTEXT: Read code.html, change Before to After exactly once, then return components: []. Keep this image and this task intact."
const credentials = (access: string): Auth.Oauth => ({
  type: "oauth",
  access,
  refresh: "fixture-refresh",
  expires: Date.now() + 3_600_000,
  accountId: "fixture-account",
})

type Request = { body: Record<string, unknown>; bearer: string | null; path: string }

const fixture = Effect.gen(function* () {
  const home = process.env.KILO_TEST_HOME
  if (!home || process.env.KILO_AUTH_CONTENT !== undefined || process.env.KILO_DB !== ":memory:")
    throw new Error("combined lifecycle tests require the isolated preload, in-memory database, and no auth override")
  // The preload's home and XDG directories are siblings under one temporary root.
  const root = path.dirname(home)
  const location = path.relative(root, Global.Path.data)
  if (location.startsWith("..") || path.isAbsolute(location))
    throw new Error("auth storage is not inside the isolated test root")
  const instance = yield* TestInstance
  const fs = yield* AppFileSystem.Service
  const env = yield* Env.Service
  const prior = process.env.ZEN_KILO_CONTEXT_POLICY
  process.env.ZEN_KILO_CONTEXT_POLICY = profile
  yield* env.set("ZEN_KILO_CONTEXT_POLICY", profile)
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (prior === undefined) {
        delete process.env.ZEN_KILO_CONTEXT_POLICY
        yield* env.remove("ZEN_KILO_CONTEXT_POLICY")
      } else {
        process.env.ZEN_KILO_CONTEXT_POLICY = prior
        yield* env.set("ZEN_KILO_CONTEXT_POLICY", prior)
      }
    }),
  )

  const file = path.join(instance.directory, "code.html")
  yield* fs.writeWithDirs(file, "<!doctype html><p>Before</p>\n")
  const requests: Request[] = []
  const catalogs: string[] = []
  const unexpected: string[] = []
  const finished: number[] = []
  const pending = new Set<number>()
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const encoder = new TextEncoder()
  const chunk = (index: number, delta: unknown, finish: string | null, tokens?: number) => ({
    id: `fixture-response-${index}`,
    model: ref.modelID,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(tokens === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: tokens,
            completion_tokens: 30,
            total_tokens: tokens + 30,
            cost: 0.02,
            cost_details: { upstream_inference_cost: 0.01 },
          },
        }),
  })
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (request.method === "GET" && url.pathname.endsWith("/models")) {
            catalogs.push(url.pathname)
            return Response.json({
              data: [
                {
                  id: ref.modelID,
                  name: "Isolated lifecycle model",
                  context_length: 64_000,
                  max_completion_tokens: 1024,
                  supported_parameters: ["tools"],
                  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
                  pricing: { prompt: "0.000002", completion: "0.000004" },
                },
              ],
            })
          }
          if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
            unexpected.push(`${request.method} ${url.pathname}`)
            return new Response("unexpected fixture route", { status: 400 })
          }
          const body: unknown = await request.json()
          if (!isRecord(body)) return new Response("invalid fixture body", { status: 400 })
          requests.push({ body, bearer: request.headers.get("authorization"), path: url.pathname })
          const index = requests.length
          let closed = false
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const send = (value: unknown) =>
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
                const end = () => {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                  finished.push(index)
                  controller.close()
                  closed = true
                }
                if (index === 3) {
                  pending.add(index)
                  send(chunk(index, { content: "Retained task and tool receipts. " }, null))
                  entered.resolve()
                  void released.promise.then(() => {
                    pending.delete(index)
                    if (closed) return
                    send(
                      chunk(
                        index,
                        {
                          content:
                            "code.html is already edited. Preserve the original packet and finalize without repeating any tool.",
                        },
                        "stop",
                        300,
                      ),
                    )
                    end()
                  })
                  return
                }
                const name = index === 1 ? "read" : index === 2 ? "edit" : "StructuredOutput"
                const args =
                  index === 1
                    ? { filePath: file }
                    : index === 2
                      ? { filePath: file, oldString: "Before", newString: "After" }
                      : { components: [] }
                send(
                  chunk(
                    index,
                    {
                      tool_calls: [
                        {
                          index: 0,
                          id: `fixture-call-${index}`,
                          type: "function",
                          function: { name, arguments: JSON.stringify(args) },
                        },
                      ],
                    },
                    "tool_calls",
                    index === 2 ? 43_000 : 500,
                  ),
                )
                end()
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
        released.resolve()
        await server.stop(true)
      }),
  )

  const base = `http://127.0.0.1:${server.port}`
  yield* fs.writeWithDirs(
    path.join(instance.directory, "opencode.json"),
    JSON.stringify({
      model: "kilo/fixture-model",
      small_model: "kilo/fixture-model",
      enabled_providers: ["kilo"],
      plugin: [],
      snapshot: false,
      lsp: false,
      formatter: false,
      compaction: { auto: true, threshold_percent: 65, reserved: 0, prune: false, tail_turns: 0 },
      provider: {
        kilo: {
          name: "Isolated Kilo",
          npm: "@kilocode/kilo-gateway",
          env: [],
          options: { baseURL: base, maxRetries: 0 },
          models: {
            "fixture-model": {
              name: "Isolated lifecycle model",
              tool_call: true,
              attachment: true,
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 64_000, input: 64_000, output: 1024 },
              cost: { input: 2, output: 4 },
            },
          },
        },
      },
    }),
  )
  // The preload pins AuthStore.disk and Session storage to this child process's temporary XDG/database.
  yield* Effect.promise(() => AuthStore.disk.set("kilo", credentials("fixture-access-one")))
  yield* Effect.promise(() => AuthRequest.invalidate("kilo"))
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await AuthStore.disk.remove("kilo")
      await AuthRequest.invalidate("kilo")
    }),
  )
  const snapshot = yield* Effect.promise(() => AuthStore.disk.snapshot("kilo"))
  const stored = path.relative(root, snapshot.store)
  expect(!stored.startsWith("..") && !path.isAbsolute(stored)).toBe(true)
  const sessions = yield* Session.Service
  const providers = yield* Provider.Service
  const model = yield* providers.getModel(ref.providerID, ref.modelID)
  const cached = yield* providers.getLanguage(model)
  const relative = path.relative((yield* requireInstance).worktree, file)
  const session = yield* sessions.create({
    title: "Combined auth and reduction acceptance",
    permission: [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "StructuredOutput", pattern: "*", action: "allow" },
      ...[...new Set([relative, relative.replaceAll("\\", "/")])].map((pattern) => ({
        permission: "edit",
        pattern,
        action: "allow" as const,
      })),
    ],
  })
  const older = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "code",
    model: ref,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: older.id,
    type: "text",
    text: "Completed earlier task; this old background can be reduced. ".repeat(30),
  })
  const answer = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    parentID: older.id,
    role: "assistant",
    agent: "code",
    mode: "code",
    providerID: ref.providerID,
    modelID: ref.modelID,
    path: { cwd: instance.directory, root: instance.directory },
    finish: "stop",
    cost: 0,
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), completed: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: answer.id,
    type: "text",
    text: "The earlier task is complete.",
  })
  const committed = yield* Deferred.make<void>()
  const resume = yield* Deferred.make<void>()
  const bridge = yield* EventV2Bridge.Service
  const events: string[] = []
  const unsubscribe = yield* bridge.sync((event) =>
    Effect.gen(function* () {
      if (!isRecord(event.data) || event.data.sessionID !== session.id) return
      events.push(event.type)
      if (event.type !== "session.next.compaction.ended") return
      yield* Deferred.succeed(committed, undefined)
      yield* Deferred.await(resume)
    }),
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  yield* Effect.addFinalizer(() => Deferred.succeed(resume, undefined))
  return {
    instance,
    fs,
    file,
    session,
    sessions,
    providers,
    model,
    cached,
    snapshot,
    requests,
    catalogs,
    unexpected,
    finished,
    pending,
    entered,
    released,
    committed,
    resume,
    events,
  }
})

for (const mode of ["rotate", "logout", "account", "generation", "stop"]) {
  it.instance(
    `auth authority across real reduction and continuation: ${mode}`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const prompt = yield* SessionPrompt.Service
        const id = MessageID.ascending()
        const run = yield* prompt
          .prompt({
            sessionID: f.session.id,
            messageID: id,
            agent: "code",
            model: ref,
            format: { type: "json_schema", schema, retryCount: 0 },
            parts: [
              { type: "text", text: packet },
              { type: "file", mime: "image/webp", filename: "packet.webp", url: image },
            ],
          })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          Effect.raceFirst(
            Effect.promise(() => f.entered.promise),
            Fiber.await(run).pipe(
              Effect.flatMap((exit) =>
                Effect.gen(function* () {
                  const stored = yield* f.sessions.messages({ sessionID: f.session.id })
                  return yield* Effect.fail(
                    new Error(
                      `Prompt settled before reducer dispatch: ${JSON.stringify({ error: Exit.isFailure(exit) ? Cause.prettyErrors(exit.cause).map((error) => error.message) : undefined, requests: f.requests.map((request) => ({ path: request.path, model: request.body.model })), messages: stored.map((message) => ({ info: message.info, parts: message.parts.filter((part) => part.type === "tool").map((part) => ({ tool: part.tool, state: part.state })) })) })}`,
                    ),
                  )
                }),
              ),
            ),
          ),
          "the real reducer transport did not start",
          "15 seconds",
        )
        const before = yield* f.sessions.messages({ sessionID: f.session.id })
        const user = before.find((message) => message.info.id === id)
        if (user?.info.role !== "user") throw new Error("missing admitted task")
        expect(user.info.authAuthority?.kind).toBe("oauth")
        expect(user.info.authAuthority?.managed).toBe(true)
        expect(user.info.contextPolicy?.profile).toEqual(KiloContextPolicy.configured())
        const original = user.parts.filter((part) => part.type === "file" || (part.type === "text" && !part.ignored))
        const tools = before.flatMap((message) => message.parts).filter((part) => part.type === "tool")
        expect(tools.map((part) => part.tool)).toEqual(["read", "edit"])
        expect(tools.every((part) => part.state.status === "completed")).toBe(true)
        expect(yield* f.fs.readFileString(f.file)).toBe("<!doctype html><p>After</p>\n")
        expect(f.requests).toHaveLength(3)
        expect(f.requests.every((request) => request.body.model === ref.modelID)).toBe(true)
        expect(f.requests.map((request) => request.bearer)).toEqual(Array(3).fill("Bearer fixture-access-one"))
        expect(Array.isArray(f.requests[2].body.tools) ? f.requests[2].body.tools.length : 0).toBe(0)
        expect(before.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(true)

        const rotated = yield* Effect.promise(() =>
          AuthStore.disk.commit(f.snapshot, credentials("fixture-access-two")),
        )
        expect(rotated.loginGeneration).toBe(f.snapshot.loginGeneration)
        expect(rotated.tokenRevision).toBe(f.snapshot.tokenRevision + 1)
        expect(yield* f.providers.getLanguage(f.model)).toBe(f.cached)

        if (mode === "stop") {
          yield* awaitWithTimeout(prompt.cancel(f.session.id), "Stop waited for the reducer transport", "3 seconds")
          // Canceling the waiter is not evidence that this held provider operation settled.
          expect(f.pending.has(3)).toBe(true)
          expect(f.finished).toEqual([1, 2])
        } else {
          f.released.resolve()
          yield* awaitWithTimeout(Deferred.await(f.committed), "the successful summary did not commit", "15 seconds")
          const pending = yield* f.sessions.messages({ sessionID: f.session.id })
          expect(pending.some((message) => KiloCompactionState.bound(message, pending))).toBe(true)
          expect(f.pending.has(3)).toBe(false)
          expect(f.finished).toContain(3)
          const credential = rotated.value
          if (credential?.type !== "oauth") throw new Error("missing rotated fixture credentials")
          if (mode === "logout") yield* Effect.promise(() => AuthStore.disk.remove("kilo"))
          if (mode === "generation") yield* Effect.promise(() => AuthStore.disk.set("kilo", credential))
          if (mode === "account")
            yield* Effect.promise(() =>
              AuthStore.disk.commit(rotated, {
                type: "oauth",
                access: credential.access,
                refresh: credential.refresh,
                expires: credential.expires,
                enterpriseUrl: credential.enterpriseUrl,
                accountId: "fixture-other-account",
              }),
            )
          if (mode !== "rotate") {
            const changed = yield* Effect.promise(() => AuthStore.disk.snapshot("kilo"))
            if (mode === "account") expect(changed.loginGeneration).toBe(rotated.loginGeneration)
            if (mode !== "account") expect(changed.loginGeneration).not.toBe(rotated.loginGeneration)
            if (mode === "logout") expect(changed.value).toBeUndefined()
            if (mode === "generation") expect(changed.value).toEqual(rotated.value)
            if (mode === "account") {
              if (changed.value?.type !== "oauth") throw new Error("missing changed fixture account")
              expect(changed.value.accountId).toBe("fixture-other-account")
            }
            yield* Effect.promise(() => AuthRequest.invalidate("kilo"))
          }
          yield* Deferred.succeed(f.resume, undefined)
        }

        const result = yield* awaitWithTimeout(Fiber.await(run), "combined lifecycle did not settle", "15 seconds")
        if (mode === "stop") expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
        if (mode !== "stop" && Exit.isFailure(result)) yield* Effect.failCause(result.cause)
        const messages = yield* f.sessions.messages({ sessionID: f.session.id })
        const saved = messages.find((message) => message.info.id === id)
        if (saved?.info.role !== "user") throw new Error("the task identity was lost")
        expect(saved.info).toEqual(user.info)
        expect(saved.parts.filter((part) => part.type === "file" || (part.type === "text" && !part.ignored))).toEqual(
          original,
        )
        const parts = messages.flatMap((message) => message.parts)
        expect(parts.filter((part) => part.type === "tool" && part.tool !== "StructuredOutput")).toEqual(tools)
        expect(parts.filter((part) => part.type === "text" && part.text === packet && !part.ignored)).toHaveLength(1)
        expect(parts.filter((part) => part.type === "file" && part.url === image)).toHaveLength(1)
        expect(yield* f.fs.readFileString(f.file)).toBe("<!doctype html><p>After</p>\n")
        const markers = parts.filter((part) => part.type === "compaction")
        expect(markers).toHaveLength(1)
        expect(messages.filter((message) => message.info.role === "user")).toHaveLength(3)
        expect(markers[0].context?.source).toBe(id)
        const marker = messages.find((message) => message.info.id === markers[0].messageID)
        if (marker?.info.role !== "user") throw new Error("missing reduction marker")
        expect(marker.info.authAuthority).toEqual(user.info.authAuthority)
        expect(marker.info.model).toEqual(user.info.model)
        const ledger = KiloCompactionBudget.inspect({ sessionID: f.session.id, messageID: id })
        const inherited = KiloCompactionBudget.inspect({ sessionID: f.session.id, messageID: marker.info.id })
        expect(ledger?.root).toBe(id)
        expect(inherited?.root).toBe(id)
        const spend = parts.filter((part) => part.type === "step-finish")
        const expected = mode === "rotate" ? 4 : mode === "stop" ? 2 : 3
        expect(spend).toHaveLength(expected)
        expect(new Set(spend.map((part) => part.id)).size).toBe(expected)
        expect(spend.every((part) => part.cost === 0.01)).toBe(true)
        expect((yield* f.sessions.get(f.session.id)).cost).toBeCloseTo(expected * 0.01, 10)
        expect(f.requests).toHaveLength(mode === "rotate" ? 4 : 3)
        expect(f.unexpected).toEqual([])
        expect(f.catalogs.length).toBeGreaterThan(0)
        const status = yield* SessionStatus.Service
        expect(yield* status.get(f.session.id)).toEqual({ type: "idle" })
        const serialized = JSON.stringify(messages)
        for (const secret of ["fixture-access-one", "fixture-access-two", "fixture-refresh"])
          expect(serialized).not.toContain(secret)

        if (mode === "rotate") {
          if (Exit.isFailure(result) || result.value.info.role !== "assistant")
            throw new Error("missing final assistant")
          expect(result.value.info.error).toBeUndefined()
          expect(result.value.info.structured).toEqual({ components: [] })
          expect(result.value.info.parentID).toBe(id)
          expect(f.requests[3].bearer).toBe("Bearer fixture-access-two")
          expect(JSON.stringify(f.requests[3].body)).toContain(packet)
          expect(JSON.stringify(f.requests[3].body)).toContain(image)
          expect(JSON.stringify(f.requests[3].body)).toContain("fixture-call-2")
          expect(JSON.stringify(f.requests[3].body)).toContain("code.html is already edited")
          const continuation = f.requests[3].body.messages
          if (!Array.isArray(continuation)) throw new Error("missing continuation conversation")
          expect(
            continuation.filter(
              (message) => isRecord(message) && message.role === "tool" && message.tool_call_id === "fixture-call-2",
            ),
          ).toHaveLength(1)
          expect(parts.filter((part) => part.type === "tool" && part.tool === "StructuredOutput")).toHaveLength(1)
        }
        if (mode !== "rotate") {
          expect(parts.some((part) => part.type === "tool" && part.tool === "StructuredOutput")).toBe(false)
          const failed = messages.flatMap((message) =>
            message.info.role === "assistant" && message.info.error ? [message.info] : [],
          )
          expect(failed.length).toBeGreaterThan(0)
          if (mode === "stop") {
            expect(failed.some((message) => message.error?.name === "MessageAbortedError")).toBe(true)
            expect(messages.some((message) => KiloCompactionState.bound(message, messages))).toBe(false)
            for (const message of failed) {
              expect(SessionRetry.retryable(message.error!)).toBeUndefined()
              expect(KiloSessionRecovery.interrupted(message)).toBe(false)
            }
          } else {
            const failure = failed.find((message) => message.error?.name === "ProviderAuthError")
            if (failure?.error?.name !== "ProviderAuthError") throw new Error("missing terminal authority failure")
            if (Exit.isFailure(result) || result.value.info.role !== "assistant")
              throw new Error("authority failure did not return an assistant result")
            expect(result.value.info.error?.name).toBe("ProviderAuthError")
            expect(failure.parentID).toBe(id)
            expect(failure.error.data.providerID).toBe(ref.providerID)
            expect(failure.error.data.reason).toBe("authority-changed")
            expect(SessionRetry.retryable(failure.error)).toBeUndefined()
            expect(KiloSessionRecovery.interrupted(failure)).toBe(false)
          }
        }
        expect(ledger?.requests).toBe(1)
        expect(ledger?.reservations).toHaveLength(1)
        if (mode !== "stop") expect(ledger?.reservations[0].status).toBe("settled")
        if (mode === "stop") {
          if (!ledger) throw new Error("missing unresolved request ledger")
          expect(ledger.active).toBeNull()
          expect(ledger.reservations[0].status).toBe("reserved")
          expect(ledger.requests).toBeLessThan(ledger.limits.requests)
          expect(ledger.milliseconds).toBeLessThan(ledger.limits.milliseconds)
          expect(f.pending.has(3)).toBe(true)
          expect(f.finished).toEqual([1, 2])
          const compaction = yield* SessionCompaction.Service
          const reentry = yield* awaitWithTimeout(
            compaction.process({ sessionID: f.session.id, parentID: marker.info.id, messages, auto: true }),
            "same-root reentry did not fail closed",
            "3 seconds",
          )
          expect(reentry).toBe("stop")
          expect(f.requests).toHaveLength(3)
          expect(f.pending.has(3)).toBe(true)
          expect(f.finished).toEqual([1, 2])
          expect(KiloCompactionBudget.inspect({ sessionID: f.session.id, messageID: id })).toEqual(ledger)
          expect(KiloCompactionBudget.inspect({ sessionID: f.session.id, messageID: marker.info.id })).toEqual(
            inherited,
          )
          const retained = yield* f.sessions.messages({ sessionID: f.session.id })
          const root = retained.find((message) => message.info.id === id)
          if (root?.info.role !== "user") throw new Error("reentry lost the original task")
          expect(root.info).toEqual(saved.info)
          expect(root.parts.filter((part) => part.type === "file" || (part.type === "text" && !part.ignored))).toEqual(
            original,
          )
          expect(retained.filter((message) => message.info.role === "user").map((message) => message.info.id)).toEqual(
            messages.filter((message) => message.info.role === "user").map((message) => message.info.id),
          )
          const retainedParts = retained.flatMap((message) => message.parts)
          expect(retainedParts.filter((part) => part.type === "compaction")).toEqual(markers)
          expect(retainedParts.filter((part) => part.type === "tool")).toEqual(tools)
          expect(retainedParts.filter((part) => part.type === "step-finish")).toEqual(spend)
          expect(retained.some((message) => KiloCompactionState.bound(message, retained))).toBe(false)
          expect((yield* f.sessions.get(f.session.id)).cost).toBeCloseTo(0.02, 10)
          expect(yield* f.fs.readFileString(f.file)).toBe("<!doctype html><p>After</p>\n")
          const blocked = retained.find(
            (message) =>
              message.info.role === "assistant" &&
              message.info.parentID === marker.info.id &&
              KiloCompactionBudget.blocked(message.info.error),
          )
          if (blocked?.info.role !== "assistant" || blocked.info.error?.name !== "APIError")
            throw new Error("missing unresolved-reservation rejection")
          expect(blocked.info.error.data.message).toContain("[COMPACTION_RESOURCE_LIMIT]")
          expect(blocked.info.error.data.message).toContain("unfinished compaction reservation")
          expect(blocked.info.error.data.isRetryable).toBe(false)
          expect(SessionRetry.retryable(blocked.info.error)).toBeUndefined()
          expect(KiloSessionRecovery.interrupted(blocked.info)).toBe(false)
        }
      }),
    45_000,
  )
}
