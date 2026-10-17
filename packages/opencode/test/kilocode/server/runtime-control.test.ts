import { NodeHttpServer } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiGroup } from "effect/unstable/httpapi"
import { KiloRuntime } from "@/kilocode/runtime/control"
import { KiloRuntimeHttp } from "@/kilocode/server/httpapi/runtime"
import { sessionHandlers } from "@/server/routes/instance/httpapi/handlers/session"
import { GlobalApi } from "@/server/routes/instance/httpapi/groups/global"
import { SessionApi } from "@/server/routes/instance/httpapi/groups/session"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { SchemaErrorMiddleware, schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { Config } from "@/config/config"
import { Installation } from "@/installation"
import { Bus } from "@/bus"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionShare } from "@/share/session"
import { SessionStatus } from "@/session/status"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { testEffect } from "../../lib/effect"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"

let pending = Promise.withResolvers<MessageV2.WithParts>()
let started = 0
let cleanup = 0
const message = { info: {}, parts: [] } as unknown as MessageV2.WithParts
const health = GlobalApi.groups.global.endpoints.health
if (health.name !== "health") throw new Error("Unexpected health endpoint")
const root = HttpApi.make("runtime-root")
  .add(HttpApiGroup.make("global").add(health, ...KiloRuntimeHttp.endpoints))
  .middleware(KiloRuntimeHttp.Admission)
const instance = HttpApi.make("opencode-instance")
  .addHttpApi(SessionApi)
  .middleware(KiloRuntimeHttp.Admission)
  .middleware(SchemaErrorMiddleware)
const global = HttpApiBuilder.group(root, "global", (handlers) =>
  handlers
    .handle("health", KiloRuntimeHttp.health)
    .handle("quiesce", KiloRuntimeHttp.quiesce)
    .handle("releaseQuiescence", KiloRuntimeHttp.release),
)
const routes = Layer.mergeAll(
  HttpApiBuilder.layer(root).pipe(Layer.provide(global)),
  HttpApiBuilder.layer(instance).pipe(Layer.provide(sessionHandlers)),
).pipe(
  Layer.provide([
    KiloRuntimeHttp.layer,
    schemaErrorLayer,
    Layer.succeed(
      Authorization,
      Authorization.of((effect) => effect),
    ),
    Layer.succeed(
      InstanceContextMiddleware,
      InstanceContextMiddleware.of((effect) => effect),
    ),
    Layer.succeed(
      WorkspaceRoutingMiddleware,
      WorkspaceRoutingMiddleware.of((effect) =>
        effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: "runtime-fixture" })),
      ),
    ),
    Layer.mock(Config.Service)({}),
    Layer.mock(Installation.Service)({}),
    Layer.mock(Session.Service)({ get: (id) => Effect.succeed({ id } as Session.Info) }),
    Layer.mock(SessionPrompt.Service)({
      prompt: (input) =>
        KiloRuntime.work(
          Effect.promise(() => {
            input.onAdmitted?.()
            started++
            return pending.promise
          }),
        ),
      cancel: () => Effect.sync(() => pending.resolve(message)),
      compact: (input: { sessionID: SessionID }) => Effect.fail(new Session.BusyError({ sessionID: input.sessionID })),
    }),
    Layer.mock(SessionRevert.Service)({
      cleanup: () =>
        Effect.sync(() => {
          cleanup++
        }),
    }),
    Layer.mock(SessionStatus.Service)({ list: () => Effect.succeed(new Map()) }),
    Layer.mock(SessionRunState.Service)({}),
    Layer.mock(SessionShare.Service)({}),
    Layer.mock(SessionSummary.Service)({}),
    Layer.mock(Permission.Service)({}),
    Layer.mock(Todo.Service)({}),
    Layer.mock(Bus.Service)({ publish: () => Effect.void }),
  ]),
)
const it = testEffect(
  HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
  ),
)

const post = (path: string, body: unknown) =>
  HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJson(body), Effect.flatMap(HttpClient.execute))

it.live("health is passive and shared; a lease gates mutations but not reads or abort", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const first = yield* client.get("/global/health").pipe(Effect.flatMap((response) => response.json))
    const second = yield* client.get("/global/health").pipe(Effect.flatMap((response) => response.json))
    expect(first).toEqual(second)
    expect((first as { runtime: unknown }).runtime).toEqual(KiloRuntime.info)
    expect(first).toMatchObject({ compactionBudget: { requests: 12, milliseconds: 900_000 } })
    expect(KiloRuntime.info.capabilities).toContain("compaction-budget-v1")
    const reserved = yield* post("/global/quiesce", { runtimeID: KiloRuntime.info.id })
    expect(reserved.status).toBe(200)
    const lease = yield* reserved.json as Effect.Effect<{ runtimeID: string; token: string }>
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          KiloRuntime.release(lease.runtimeID, lease.token)
        } catch (error) {
          if (!(error instanceof KiloRuntime.Conflict)) throw error
        }
      }),
    )
    const count = started
    expect(yield* client.get("/global/health").pipe(Effect.flatMap((response) => response.json))).toEqual(first)
    expect((yield* post("/session/ses_fixture/prompt_async", { parts: [] })).status).toBe(409)
    expect(started).toBe(count)
    expect((yield* client.get("/session/status")).status).toBe(200)
    expect((yield* post("/session/ses_fixture/abort", {})).status).toBe(200)
    const stolen = yield* post("/global/quiesce", { runtimeID: KiloRuntime.info.id })
    expect(stolen.status).toBe(409)
    expect(yield* stolen.json).toMatchObject({ name: "RuntimeConflict", reason: "leased" })
    const released = yield* HttpClientRequest.delete("/global/quiesce").pipe(
      HttpClientRequest.bodyJson(lease),
      Effect.flatMap(HttpClient.execute),
    )
    expect(released.status).toBe(200)
  }),
)

it.live("prompt_async starts admission before acknowledging 204 and a foreign-workspace lease fails", () =>
  Effect.gen(function* () {
    pending = Promise.withResolvers<MessageV2.WithParts>()
    yield* Effect.addFinalizer(() => Effect.sync(() => pending.resolve(message)))
    const count = started
    const response = yield* post("/session/ses_hidden/prompt_async?directory=another-workspace", { parts: [] })
    expect(response.status).toBe(204)
    expect(started).toBe(count + 1)
    const denied = yield* post("/global/quiesce", { runtimeID: KiloRuntime.info.id })
    expect(denied.status).toBe(409)
    expect(yield* denied.json).toMatchObject({ name: "RuntimeConflict", reason: "active" })
    expect((yield* post("/session/ses_hidden/abort", {})).status).toBe(200)
  }),
)

it.live("manual compaction returns typed 409 without handler cleanup or marker writes", () =>
  Effect.gen(function* () {
    const count = cleanup
    const response = yield* post("/session/ses_busy/summarize", { providerID: "fake", modelID: "fake", auto: false })
    expect(response.status).toBe(409)
    expect(yield* response.json).toMatchObject({ _tag: "SessionBusyError", sessionID: "ses_busy" })
    expect(cleanup).toBe(count)
  }),
)
