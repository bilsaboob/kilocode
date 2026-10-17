import { NodeHttpServer } from "@effect/platform-node"
import { expect, spyOn } from "bun:test"
import { Context, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { ChildProcessSpawner } from "effect/unstable/process"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EventV2 } from "@opencode-ai/core/event"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Image } from "@/image/image"
import { KiloAuth } from "@/kilocode/auth/authority"
import { AuthRequest } from "@/kilocode/auth/request"
import type { InstanceContext } from "@/kilocode/instance"
import { KiloRuntime } from "@/kilocode/runtime/control"
import { KiloRuntimeHttp } from "@/kilocode/server/httpapi/runtime"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import { KiloCompactionBudget } from "@/kilocode/session/compaction-budget"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Reference } from "@/reference/reference"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { Snapshot } from "@/snapshot"
import { Database } from "@/storage/db"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { SessionApi } from "@/server/routes/instance/httpapi/groups/session"
import { sessionHandlers } from "@/server/routes/instance/httpapi/handlers/session"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { SchemaErrorMiddleware, schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"

const model = { providerID: ProviderID.make("runtime-fixture"), modelID: ModelID.make("fake") }
const authority: KiloAuth.Snapshot = {
  version: 1,
  providerID: model.providerID,
  source: "none",
  kind: "anonymous",
  authority: "fixture",
  managed: false,
  env: "[]",
}
const instance = {
  directory: "runtime-memory-fixture",
  worktree: "runtime-memory-fixture",
  project: { id: "prj_runtime" },
} as InstanceContext
const agent = { name: "code", mode: "primary", permission: [], model, options: {} } as Agent.Info
const resolved = {
  id: model.modelID,
  providerID: model.providerID,
  api: { id: "fake", npm: "fake" },
  capabilities: {},
  options: {},
  headers: {},
  limit: { context: 10000, output: 1000 },
} as Provider.Model

function fixture() {
  const blocks = new Map<
    string,
    { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }
  >()
  const messages = new Map<MessageID, MessageV2.WithParts>()
  const sessions = new Map<SessionID, Session.Info>()
  const history = (id: SessionID) => [...messages.values()].filter((message) => message.info.sessionID === id)
  const data = {
    blocks,
    messages,
    sessions,
    history,
    writes: 0,
    cleanup: 0,
    markers: 0,
    processed: 0,
    titles: 0,
    summaries: 0,
    prunes: 0,
    spawns: 0,
    block(name: string) {
      const barrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      blocks.set(name, barrier)
      return barrier
    },
    pause(name: string): Effect.Effect<void> {
      return Effect.suspend(() => {
        const barrier = blocks.get(name)
        if (!barrier) return Effect.void
        barrier.entered.resolve()
        return Effect.promise(() => barrier.release.promise).pipe(Effect.ensuring(data.pause(`${name}-settle`)))
      })
    },
    session(id: SessionID) {
      if (!sessions.has(id))
        sessions.set(id, {
          id,
          slug: "fixture",
          projectID: instance.project.id,
          directory: instance.directory,
          title: "New session - 2026-10-17T00:00:00.000Z",
          version: "test",
          time: { created: 0, updated: 0 },
        })
      return sessions.get(id)!
    },
    save<T extends MessageV2.Info>(info: T) {
      data.writes++
      messages.set(info.id, { info, parts: messages.get(info.id)?.parts ?? [] })
      return info
    },
    part<T extends MessageV2.Part>(part: T) {
      const row = messages.get(part.messageID)!
      row.parts = [...row.parts.filter((current) => current.id !== part.id), part]
      return part
    },
    assistant(id: SessionID, parentID: MessageID) {
      return data.save({
        id: MessageID.ascending(),
        sessionID: id,
        parentID,
        role: "assistant",
        agent: "code",
        mode: "code",
        providerID: model.providerID,
        modelID: model.modelID,
        finish: "stop",
        path: { cwd: instance.directory, root: instance.worktree },
        time: { created: Date.now(), completed: Date.now() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    },
  }
  return data
}

class Fixture extends Context.Service<Fixture, ReturnType<typeof fixture>>()("RuntimePromptFixture") {}
const store = Layer.effect(
  Fixture,
  Effect.gen(function* () {
    const data = fixture()
    // Only persistence/auth boundaries are replaced. Prompt, run-state, queue, runner and HTTP handlers are production code.
    const spies = [
      spyOn(Database, "use").mockReturnValue(undefined as never),
      spyOn(Database, "transaction").mockImplementation(() => {
        throw new Error("Unexpected database transaction in runtime fixture")
      }),
      spyOn(KiloCompactionBudget, "admit").mockReturnValue(Effect.succeed(undefined as never)),
      spyOn(MessageV2, "filterCompactedEffect").mockImplementation((id) => Effect.sync(() => data.history(id))),
      spyOn(MessageV2, "get").mockImplementation(({ messageID }) => Effect.sync(() => data.messages.get(messageID)!)),
      spyOn(MessageV2, "toModelMessagesEffect").mockImplementation(() => Effect.succeed([])),
      spyOn(KiloAuth, "bind").mockImplementation(() => ({
        capture: () => Effect.succeed(authority),
        check: () => Effect.void,
        admit: () => Effect.succeed({ authority, authorities: { [model.providerID]: authority } }),
        readiness: () => Effect.die(new Error("Unexpected auth readiness access in runtime fixture")),
        request: () =>
          Effect.succeed(
            AuthRequest.create({
              expected: authority,
              resolve: async () => ({ snapshot: authority, reason: "no-credentials" }),
            }),
          ),
      })),
    ]
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const barrier of data.blocks.values()) barrier.release.resolve()
        for (const spy of spies) spy.mockRestore()
      }),
    )
    return data
  }),
)

const deps = Layer.unwrap(
  Effect.gen(function* () {
    const f = yield* Fixture
    return Layer.mergeAll(
      Layer.mergeAll(
        Layer.mock(Session.Service)({
          get: (id) => f.pause("loop").pipe(Effect.map(() => f.session(id))),
          messages: ({ sessionID, limit }) =>
            Effect.sync(() => (limit ? f.history(sessionID).slice(-limit) : f.history(sessionID))),
          findMessage: (id, predicate) => Effect.sync(() => Option.fromUndefinedOr(f.history(id).findLast(predicate))),
          updateMessage: (message) => Effect.sync(() => f.save(message)),
          updatePart: (part) => Effect.sync(() => f.part(part)),
          touch: () => Effect.void,
          setPermission: () => Effect.void,
          setTitle: () => Effect.void,
        }),
        Layer.mock(Agent.Service)({
          defaultInfo: () => f.pause("prepare").pipe(Effect.as(agent)),
          defaultAgent: () => Effect.succeed("code"),
          get: (name) => Effect.succeed({ ...agent, name }),
          list: () => Effect.succeed([agent]),
        }),
        Layer.mock(Provider.Service)({
          defaultModel: () => Effect.succeed(model),
          getModel: () => Effect.succeed(resolved),
          getSmallModel: () => Effect.succeed(resolved),
        }),
        Layer.mock(Config.Service)({ get: () => Effect.succeed({}) }),
        Layer.mock(Env.Service)({ all: () => Effect.succeed({}), get: () => Effect.succeed(undefined) }),
        Layer.mock(Plugin.Service)({ trigger: (_name, _input, output) => Effect.succeed(output) }),
        Layer.mock(SessionRevert.Service)({
          cleanup: () =>
            Effect.sync(() => {
              f.cleanup++
            }),
        }),
        Layer.mock(BackgroundJob.Service)({ list: () => Effect.succeed([]) }),
        Layer.mock(Bus.Service)({ publish: () => Effect.void }),
        Layer.effect(
          EventV2Bridge.Service,
          Effect.gen(function* () {
            return yield* EventV2.Service
          }),
        ).pipe(Layer.provide(EventV2.layer)),
        Layer.mock(Snapshot.Service)({ init: () => Effect.void }),
        Layer.mock(Question.Service)({ dismissAll: () => Effect.void }),
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
          spawn: () =>
            Effect.sync(() => {
              f.spawns++
              throw new Error("Unexpected process spawn in runtime fixture")
            }),
        }),
        RuntimeFlags.layer({ experimentalEventSystem: false, experimentalPlanMode: false }),
        Layer.succeed(InstanceRef, instance),
      ),
      Layer.mergeAll(
        Layer.mock(SessionCompaction.Service)({
          create: (input) =>
            Effect.sync(() => {
              f.markers++
              const previous = f.history(input.sessionID).findLast((message) => message.info.role === "user")!
                .info as MessageV2.User
              const user = { ...previous, id: MessageID.ascending(), time: { created: Date.now() + 1 } }
              f.save(user)
              f.part({
                id: PartID.ascending(),
                sessionID: user.sessionID,
                messageID: user.id,
                type: "compaction",
                auto: input.auto,
              })
            }),
          process: (input) =>
            f.pause("compact").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  f.assistant(input.sessionID, input.parentID)
                  return "stop" as const
                }),
              ),
            ),
          prune: () =>
            Effect.sync(() => {
              f.prunes++
            }).pipe(Effect.andThen(f.pause("prune"))),
          isOverflow: () => Effect.succeed(false),
        }),
        Layer.mock(SessionProcessor.Service)({
          create: ({ assistantMessage }) =>
            Effect.succeed({
              message: assistantMessage,
              process: () =>
                f.pause("process").pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      f.processed++
                      assistantMessage.finish = "stop"
                      assistantMessage.time.completed = Date.now()
                      f.save(assistantMessage)
                      return "stop" as const
                    }),
                  ),
                ),
              updateToolCall: () => Effect.succeed(undefined),
              metadata: () => Effect.void,
              completeToolCall: () => Effect.void,
            }),
        }),
        Layer.mock(SessionSummary.Service)({
          summarize: () =>
            Effect.sync(() => {
              f.summaries++
            }).pipe(Effect.andThen(f.pause("summary"))),
        }),
        Layer.mock(LLM.Service)({
          stream: () =>
            Stream.fromEffect(
              Effect.sync(() => {
                f.titles++
              }).pipe(Effect.andThen(f.pause("title"))),
            ).pipe(Stream.drain),
        }),
        Layer.mock(SystemPrompt.Service)({
          skills: () => Effect.succeed(undefined),
          environment: () => Effect.succeed([]),
        }),
        Layer.mock(Instruction.Service)({ system: () => Effect.succeed([]), clear: () => Effect.void }),
        Layer.mock(ToolRegistry.Service)({ tools: () => Effect.succeed([]) }),
        Layer.mock(MCP.Service)({ tools: () => Effect.succeed({}) }),
        Layer.mock(Command.Service)({
          get: () =>
            f.pause("command").pipe(
              Effect.as({
                name: "fixture",
                template: "hello",
                hints: [],
                agent: "code",
                model: "runtime-fixture/fake",
                subtask: false,
              } as Command.Info),
            ),
        }),
        Layer.succeed(
          AppFileSystem.Service,
          new Proxy({} as Context.Service.Shape<typeof AppFileSystem.Service>, {
            get: () => {
              throw new Error("Unexpected filesystem access in runtime fixture")
            },
          }),
        ),
        Layer.mock(Image.Service)({}),
        Layer.mock(Reference.Service)({}),
        Layer.mock(LSP.Service)({}),
        Layer.mock(Permission.Service)({}),
        Layer.mock(Truncate.Service)({}),
        Layer.mock(Todo.Service)({}),
        Layer.mock(SessionShare.Service)({}),
      ),
    )
  }),
).pipe(Layer.provideMerge(store))
const status = SessionStatus.layer.pipe(Layer.provideMerge(deps))
const runtime = SessionPrompt.layer.pipe(Layer.provideMerge(SessionRunState.layer), Layer.provideMerge(status))
const api = HttpApi.make("opencode-instance")
  .addHttpApi(SessionApi)
  .middleware(KiloRuntimeHttp.Admission)
  .middleware(SchemaErrorMiddleware)
const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(sessionHandlers),
  Layer.provide([
    KiloRuntimeHttp.layer,
    schemaErrorLayer,
    Layer.succeed(
      Authorization,
      Authorization.of((effect) => effect),
    ),
    Layer.succeed(
      InstanceContextMiddleware,
      InstanceContextMiddleware.of((effect) => effect.pipe(Effect.provideService(InstanceRef, instance))),
    ),
    Layer.succeed(
      WorkspaceRoutingMiddleware,
      WorkspaceRoutingMiddleware.of((effect) =>
        effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: instance.directory })),
      ),
    ),
  ]),
  Layer.provideMerge(runtime),
)
const it = testEffect(
  HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(runtime),
    Layer.provideMerge(NodeHttpServer.layerTest),
  ),
)
const post = (path: string, body: unknown) =>
  HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJson(body), Effect.flatMap(HttpClient.execute))
const payload = { parts: [{ type: "text", text: "fixture" }], model }

it.live("production manual ownership follows the session across instance contexts", () =>
  Effect.gen(function* () {
    const f = yield* Fixture
    const prompt = yield* SessionPrompt.Service
    const id = SessionID.make("ses_production_cross_instance")
    yield* prompt.prompt({ sessionID: id, model, parts: [{ type: "text", text: "fixture" }], noReply: true })
    const barrier = f.block("prepare")
    yield* Effect.addFinalizer(() => Effect.sync(() => barrier.release.resolve()))
    const running = yield* prompt.prompt({ sessionID: id, model, parts: [] }).pipe(Effect.forkChild)
    yield* awaitWithTimeout(
      Effect.promise(() => barrier.entered.promise),
      "preparation did not start",
    )
    const before = { cleanup: f.cleanup, markers: f.markers }
    const denied = yield* prompt
      .compact({ sessionID: id, model })
      .pipe(Effect.provideService(InstanceRef, { ...instance, directory: "runtime-other-instance" }), Effect.exit)
    expect(Exit.isFailure(denied)).toBe(true)
    expect({ cleanup: f.cleanup, markers: f.markers }).toEqual(before)
    yield* prompt.cancel(id)
    yield* Fiber.await(running)
  }),
)

it.live("production prompt_async owns preparation before 204; abort prevents later persistence and enqueue", () =>
  Effect.gen(function* () {
    const f = yield* Fixture
    const id = SessionID.make("ses_production_prepare")
    const barrier = f.block("prepare")
    yield* Effect.addFinalizer(() => Effect.sync(() => barrier.release.resolve()))
    expect((yield* post(`/session/${id}/prompt_async`, payload)).status).toBe(204)
    const run = yield* SessionRunState.Service
    expect(Exit.isFailure(yield* run.assertNotBusy(id).pipe(Effect.exit))).toBe(true)
    yield* awaitWithTimeout(
      Effect.promise(() => barrier.entered.promise),
      "production preparation never entered",
    )
    expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
    const before = { cleanup: f.cleanup, markers: f.markers }
    expect((yield* post(`/session/${id}/summarize`, { ...model, auto: false })).status).toBe(409)
    expect({ cleanup: f.cleanup, markers: f.markers }).toEqual(before)
    expect((yield* post(`/session/${id}/abort`, {})).status).toBe(200)
    barrier.release.resolve()
    expect(f.writes).toBe(0)
    expect(f.processed).toBe(0)
    expect(KiloSessionPromptQueue.active(id)).toBeUndefined()
    const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
    KiloRuntime.release(lease.runtimeID, lease.token)
  }),
)

it.live(
  "production command and loop preparation cannot enqueue after Abort; a lease rejects shell before spawning",
  () =>
    Effect.gen(function* () {
      const f = yield* Fixture
      const prompt = yield* SessionPrompt.Service
      for (const name of ["command", "loop"] as const) {
        const id = SessionID.make(`ses_production_${name}`)
        yield* prompt.prompt({ sessionID: id, model, parts: [{ type: "text", text: "fixture" }], noReply: true })
        const barrier = f.block(name)
        yield* Effect.addFinalizer(() => Effect.sync(() => barrier.release.resolve()))
        const before = f.writes
        const fiber = yield* (
          name === "command"
            ? prompt.command({ sessionID: id, command: "fixture", arguments: "" })
            : prompt.loop({ sessionID: id })
        ).pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          Effect.promise(() => barrier.entered.promise),
          `${name} preparation never started`,
        )
        yield* prompt.cancel(id)
        barrier.release.resolve()
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(f.writes).toBe(before)
        expect(KiloSessionPromptQueue.active(id)).toBeUndefined()
      }
      expect(f.processed).toBe(0)
      const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
      yield* Effect.addFinalizer(() => Effect.sync(() => KiloRuntime.release(lease.runtimeID, lease.token)))
      expect(
        Exit.isFailure(
          yield* prompt
            .shell({
              sessionID: SessionID.make("ses_production_shell"),
              agent: "code",
              command: "fixture-must-not-spawn",
              model,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(f.spawns).toBe(0)
    }),
)

it.live("production Abort retains detached ownership until interrupted helper finalizers settle", () =>
  Effect.gen(function* () {
    const f = yield* Fixture
    const prompt = yield* SessionPrompt.Service
    const id = SessionID.make("ses_production_finalizers")
    const title = f.block("title")
    const settle = f.block("title-settle")
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        title.release.resolve()
        settle.release.resolve()
      }),
    )
    yield* prompt.prompt({ sessionID: id, model, parts: [{ type: "text", text: "fixture" }] })
    yield* awaitWithTimeout(
      Effect.promise(() => title.entered.promise),
      "title never started",
    )
    const abort = yield* prompt.cancel(id).pipe(Effect.forkChild)
    yield* awaitWithTimeout(
      Effect.promise(() => settle.entered.promise),
      "title finalizer never started",
    )
    expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
    const before = { cleanup: f.cleanup, markers: f.markers }
    expect(Exit.isFailure(yield* prompt.compact({ sessionID: id, model }).pipe(Effect.exit))).toBe(true)
    expect({ cleanup: f.cleanup, markers: f.markers }).toEqual(before)
    settle.release.resolve()
    yield* awaitWithTimeout(Fiber.join(abort), "Abort did not settle")
    title.release.resolve()
    const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
    KiloRuntime.release(lease.runtimeID, lease.token)
    expect(f.processed).toBe(1)
  }),
)

it.live(
  "production compact owns its marker and internal loop exclusively; a disconnected waiter does not cancel it",
  () =>
    Effect.gen(function* () {
      const f = yield* Fixture
      const prompt = yield* SessionPrompt.Service
      const id = SessionID.make("ses_production_compact")
      yield* prompt.prompt({ sessionID: id, ...payload, parts: [{ type: "text", text: "fixture" }], noReply: true })
      const status = yield* SessionStatus.Service
      const initial = { cleanup: f.cleanup, markers: f.markers }
      for (const value of [
        { type: "retry", attempt: 1, message: "fixture", next: 1 },
        { type: "offline", requestID: QuestionID.make("que_fixture"), message: "fixture" },
      ] satisfies SessionStatus.Info[]) {
        yield* status.set(id, value)
        expect(Exit.isFailure(yield* prompt.compact({ sessionID: id, model }).pipe(Effect.exit))).toBe(true)
        expect({ cleanup: f.cleanup, markers: f.markers }).toEqual(initial)
      }
      yield* status.set(id, { type: "idle" })
      const barrier = f.block("compact")
      yield* Effect.addFinalizer(() => Effect.sync(() => barrier.release.resolve()))
      const compact = yield* prompt.compact({ sessionID: id, model }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        Effect.promise(() => barrier.entered.promise),
        "compact never acquired its runner",
      )
      yield* Fiber.interrupt(compact)
      const before = { writes: f.writes, markers: f.markers, cleanup: f.cleanup }
      expect((yield* post(`/session/${id}/prompt_async`, payload)).status).toBe(409)
      expect(Exit.isFailure(yield* prompt.prompt({ sessionID: id, model, parts: [] }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* prompt.compact({ sessionID: id, model }).pipe(Effect.exit))).toBe(true)
      expect({ writes: f.writes, markers: f.markers, cleanup: f.cleanup }).toEqual(before)
      expect(f.markers).toBe(1)
      expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
      barrier.release.resolve()
      const run = yield* SessionRunState.Service
      yield* pollWithTimeout(
        run.assertNotBusy(id).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
        "compact did not settle",
      )
      expect(f.processed).toBe(0)
      expect(f.prunes).toBe(1)
    }),
)

it.live(
  "production title, summary and prune fibers retain runtime and runner ownership after the prompt finishes",
  () =>
    Effect.gen(function* () {
      const f = yield* Fixture
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const id = SessionID.make("ses_production_detached")
      const barriers = [f.block("title"), f.block("summary"), f.block("prune")]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const barrier of barriers) barrier.release.resolve()
        }),
      )
      yield* prompt.prompt({ sessionID: id, model, parts: [{ type: "text", text: "fixture" }] })
      for (const barrier of barriers)
        yield* awaitWithTimeout(
          Effect.promise(() => barrier.entered.promise),
          "detached production helper never started",
        )
      expect(f.processed).toBe(1)
      expect([f.titles, f.summaries, f.prunes]).toEqual([1, 1, 1])
      for (const barrier of barriers) {
        expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
        expect(Exit.isFailure(yield* run.assertNotBusy(id).pipe(Effect.exit))).toBe(true)
        barrier.release.resolve()
      }
      yield* pollWithTimeout(
        run.assertNotBusy(id).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
        "detached helpers did not settle",
      )
      const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
      KiloRuntime.release(lease.runtimeID, lease.token)
    }),
)
