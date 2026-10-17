import { NodeHttpServer } from "@effect/platform-node"
import { expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import path from "node:path"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceID } from "@/control-plane/schema"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { Session } from "@/session/session"
import { ProviderID } from "@/provider/schema"
import { KiloAuth } from "@/kilocode/auth/authority"
import { KiloRuntime } from "@/kilocode/runtime/control"
import * as Passive from "@/kilocode/server/httpapi/passive-instance"
import { ServerAuth } from "@/server/auth"
import { Authorization, authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import {
  InstanceContextMiddleware,
  instanceContextLayer,
} from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQueryFields,
  workspaceRoutingLayer,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { SchemaErrorMiddleware, schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { awaitWithTimeout, testEffect } from "../../lib/effect"

class Fixture extends Context.Service<
  Fixture,
  {
    boots: string[]
    projects: string[]
    inspected: Array<{ directory: string; workspace?: WorkspaceID }>
    pending?: {
      entered: ReturnType<typeof Promise.withResolvers<void>>
      release: ReturnType<typeof Promise.withResolvers<void>>
    }
    workspace?: Workspace.Info
  }
>()("PassiveInstanceFixture") {}
const state = Layer.sync(Fixture, () => ({ boots: [], projects: [], inspected: [] }))
const store = InstanceStore.layer.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const f = yield* Fixture
        return Layer.mergeAll(
          Layer.mock(Project.Service)({
            fromDirectory: (directory) =>
              Effect.sync(() => {
                f.projects.push(directory)
                return {
                  sandbox: directory,
                  project: {
                    id: ProjectID.global,
                    worktree: directory,
                    time: { created: 0, updated: 0 },
                    sandboxes: [],
                  },
                }
              }),
          }),
          Layer.succeed(InstanceBootstrap.Service, {
            run: Effect.gen(function* () {
              const ctx = yield* InstanceRef
              f.boots.push(ctx!.directory)
              if (!f.pending) return
              f.pending.entered.resolve()
              yield* Effect.promise(() => f.pending!.release.promise)
            }),
          }),
        )
      }),
    ),
  ),
)
const workspace = Layer.unwrap(
  Effect.gen(function* () {
    const f = yield* Fixture
    return Layer.mock(Workspace.Service)({
      get: (id) => Effect.succeed(f.workspace?.id === id ? f.workspace : undefined),
    })
  }),
)
const api = HttpApi.make("passive-instance-probe")
  .add(
    HttpApiGroup.make("probe")
      .add(
        HttpApiEndpoint.get("active", "/active", {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          success: Schema.Struct({ directory: Schema.String }),
        }).middleware(InstanceContextMiddleware),
        HttpApiEndpoint.get("readiness", "/provider/:providerID/auth/readiness", {
          params: { providerID: ProviderID },
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, modelID: Schema.optional(Schema.String) }),
          success: KiloAuth.Readiness,
        }).middleware(Passive.PassiveInstance),
      )
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .middleware(SchemaErrorMiddleware)
const handlers = HttpApiBuilder.group(api, "probe", (handlers) =>
  Effect.gen(function* () {
    const f = yield* Fixture
    return handlers
      .handle("active", () =>
        Effect.gen(function* () {
          return { directory: (yield* InstanceRef)!.directory }
        }),
      )
      .handle("readiness", (input) =>
        Passive.readiness(
          { providerID: input.params.providerID, modelID: input.query.modelID },
          Effect.gen(function* () {
            const ctx = yield* InstanceRef
            const workspace = yield* WorkspaceRef
            f.inspected.push({ directory: ctx!.directory, workspace })
            return {
              providerID: input.params.providerID,
              modelID: input.query.modelID,
              state: "ready",
              source: "config",
              reason: "local-valid",
              action: "none",
              runtimeID: KiloRuntime.info.id,
              observedAt: Date.now(),
              validation: "local",
              disruption: "none",
            } as const
          }),
        ),
      )
  }),
)
const deps = Layer.mergeAll(
  store,
  workspace,
  Layer.mock(Session.Service)({}),
  Layer.succeed(ServerAuth.Config, { username: "kilo", password: Option.some("fixture-password") }),
).pipe(Layer.provideMerge(state))
const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(handlers),
  Layer.provide([
    Passive.layer,
    instanceContextLayer,
    authorizationLayer,
    schemaErrorLayer,
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  ]),
  Layer.provideMerge(deps),
)
const it = testEffect(
  HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(deps),
    Layer.provideMerge(NodeHttpServer.layerTest),
  ),
)
const header = ServerAuth.header({ username: "kilo", password: "fixture-password" })!
const request = (url: string, directory?: string) =>
  HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeaders({ authorization: header, ...(directory ? { "x-kilo-directory": directory } : {}) }),
    HttpClient.execute,
  )
const dir = (name: string) => path.join(process.env.TEMP!, "passive fixture", name)

it.live(
  "cold, warming and reloading GETs do not bootstrap, wait, inspect config, or poison active initialization",
  () =>
    Effect.gen(function* () {
      const f = yield* Fixture
      const instances = yield* InstanceStore.Service
      const directory = dir("cold")
      const query = `directory=${encodeURIComponent(directory)}`
      const url = `/provider/openai/auth/readiness?${query}&modelID=fixture%2Fmodel`
      const cold = yield* request(url)
      expect(cold.status).toBe(200)
      expect(yield* cold.json).toMatchObject({
        providerID: "openai",
        modelID: "fixture/model",
        state: "unknown",
        reason: "unverifiable",
        validation: "local",
        runtimeID: KiloRuntime.info.id,
      })
      expect(yield* instances.peek(directory)).toBeUndefined()
      expect(f.boots).toEqual([])
      expect(f.projects).toEqual([])
      expect(f.inspected).toEqual([])

      const pending = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      f.pending = pending
      yield* Effect.addFinalizer(() => Effect.sync(() => pending.release.resolve()))
      const active = yield* request(`/active?${query}`).pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        Effect.promise(() => pending.entered.promise),
        "active bootstrap did not start",
      )
      const duplicate = yield* request(`/active?${query}`).pipe(Effect.forkChild)
      const warming = yield* awaitWithTimeout(request(url), "passive GET waited for bootstrap")
      expect(yield* warming.json).toMatchObject({ state: "unknown", reason: "unverifiable" })
      expect(yield* instances.peek(directory)).toBeUndefined()
      expect(f.inspected).toEqual([])
      expect(f.boots).toEqual([directory])
      pending.release.resolve()
      expect((yield* Fiber.join(active)).status).toBe(200)
      expect((yield* Fiber.join(duplicate)).status).toBe(200)
      expect((yield* request(`/active?${query}`)).status).toBe(200)
      expect(f.boots).toEqual([directory])
      expect(f.projects).toEqual([directory])
      expect((yield* instances.peek(directory))?.directory).toBe(directory)
      expect(yield* (yield* request(url)).json).toMatchObject({ state: "ready", modelID: "fixture/model" })
      expect(f.inspected).toEqual([{ directory, workspace: undefined }])

      const reload = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      f.pending = reload
      yield* Effect.addFinalizer(() => Effect.sync(() => reload.release.resolve()))
      const reloading = yield* instances.reload({ directory }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        Effect.promise(() => reload.entered.promise),
        "reload did not start",
      )
      expect(yield* instances.peek(directory)).toBeUndefined()
      expect(yield* (yield* request(url)).json).toMatchObject({ state: "unknown", reason: "unverifiable" })
      expect(f.inspected).toHaveLength(1)
      reload.release.resolve()
      yield* Fiber.join(reloading)
      expect(yield* (yield* request(url)).json).toMatchObject({ state: "ready" })
      expect(f.boots).toEqual([directory, directory])
    }),
)

it.live("readiness keeps authorization, decoded directory precedence and local workspace routing", () =>
  Effect.gen(function* () {
    const f = yield* Fixture
    const client = yield* HttpClient.HttpClient
    const a = dir("query")
    const b = dir("header")
    const c = dir("workspace")
    expect((yield* client.get(`/provider/openai/auth/readiness?directory=${encodeURIComponent(a)}`)).status).toBe(401)
    expect(f.projects).toEqual([])
    yield* request(`/active?directory=${encodeURIComponent(a)}`)
    yield* request("/active", encodeURIComponent(b))
    expect(
      yield* (yield* request(
        `/provider/openai/auth/readiness?directory=${encodeURIComponent(a)}`,
        encodeURIComponent(b),
      )).json,
    ).toMatchObject({ state: "ready" })
    expect(yield* (yield* request("/provider/openai/auth/readiness", encodeURIComponent(b))).json).toMatchObject({
      state: "ready",
    })
    expect(f.inspected.map((input) => input.directory)).toEqual([a, b])
    const workspace = {
      id: WorkspaceID.make("wrk_passive_fixture"),
      projectID: ProjectID.global,
      name: "fixture",
      type: "worktree",
      directory: c,
      timeUsed: 0,
    }
    f.workspace = workspace
    const query = `workspace=${workspace.id}&directory=${encodeURIComponent(a)}`
    expect(
      yield* (yield* request(`/provider/openai/auth/readiness?${query}`, encodeURIComponent(b))).json,
    ).toMatchObject({ state: "unknown" })
    expect(f.boots).toEqual([a, b])
    expect(yield* (yield* request(`/active?${query}`, encodeURIComponent(b))).json).toEqual({ directory: c })
    expect(
      yield* (yield* request(`/provider/openai/auth/readiness?${query}`, encodeURIComponent(b))).json,
    ).toMatchObject({ state: "ready" })
    expect(f.inspected.at(-1)).toEqual({ directory: c, workspace: workspace.id })
    expect(f.boots).toEqual([a, b, c])
    expect((yield* request(`/provider/openai/auth/readiness?workspace=missing`)).status).toBe(500)
    expect(f.boots).toEqual([a, b, c])
  }),
)
