import { NodeHttpServer } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../../src/auth"
import type { CodexImageFetch } from "../../../src/kilocode/image-generation"
import { CodexImageApi, CodexImagePaths } from "../../../src/kilocode/server/httpapi/groups/codex-image"
import { CodexImage25Api, CodexImage25Paths } from "../../../src/kilocode/server/httpapi/groups/codex-image-25"
import { codexImageHandlers } from "../../../src/kilocode/server/httpapi/handlers/codex-image"
import { codexImage25Handlers } from "../../../src/kilocode/server/httpapi/handlers/codex-image-25"
import { Provider } from "../../../src/provider/provider"
import { Session } from "../../../src/session/session"
import { Authorization } from "../../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../../src/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { ProviderTest } from "../../fake/provider"
import { testEffect } from "../../lib/effect"
import { KiloRuntimeHttp } from "../../../src/kilocode/server/httpapi/runtime"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNc8AAAAASUVORK5CYII="
const api = HttpApi.make("opencode-instance").addHttpApi(CodexImageApi).addHttpApi(CodexImage25Api)
const oauth = new Auth.Oauth({ type: "oauth", access: "test-only", refresh: "test-only", expires: 0 })
const calls: Array<Record<string, unknown>> = []

function suite(credentials: Auth.Info | undefined, fetcher?: CodexImageFetch) {
  const layer = HttpRouter.serve(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide([codexImageHandlers, codexImage25Handlers]),
      Layer.provide(schemaErrorLayer),
      Layer.provide(KiloRuntimeHttp.layer),
      Layer.provide([
        Layer.mock(Auth.Service)({ get: () => Effect.succeed(credentials) }),
        Layer.mock(Session.Service)({}),
        Layer.mock(Provider.Service)({
          getProvider: () => Effect.succeed(ProviderTest.info({ options: fetcher ? { fetch: fetcher } : {} })),
        }),
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
            effect.pipe(
              Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: process.cwd() })),
            ),
          ),
        ),
      ]),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
  return testEffect(layer)
}

function post(path: string, body: Record<string, unknown>) {
  return HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJson(body), Effect.flatMap(HttpClient.execute))
}

const it = suite(oauth, async (_, init) => {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body")
  const body: Record<string, unknown> = JSON.parse(init.body)
  calls.push(body)
  if (body.prompt === "reject")
    return Response.json({ error: "rate limited" }, { status: 429, headers: { "x-request-id": "limited-123" } })
  return Response.json({ created: 123, size: "1x1", data: [{ b64_json: png }] })
})

it.live("serves both image endpoints without changing the baseline response", () =>
  Effect.gen(function* () {
    const count = calls.length
    const baseline = yield* post(CodexImagePaths.generate, { prompt: "same prompt", size: "1024x1024" })
    expect(baseline.status).toBe(200)
    expect(yield* baseline.json).toEqual({
      model: "gpt-image-2",
      created: 123,
      size: "1x1",
      quality: null,
      background: null,
      mediaType: "image/png",
      dataBase64: png,
    })

    const experimental = yield* post(CodexImage25Paths.generate, {
      model: "gpt-image-2.5-sunburst",
      prompt: "same prompt",
      size: "1024x1024",
    })
    expect(experimental.status).toBe(200)
    expect(yield* experimental.json).toMatchObject({
      requested: { model: "gpt-image-2.5-sunburst", size: "1024x1024" },
      reported: { size: "1x1" },
      image: { width: 1, height: 1 },
      dataBase64: png,
    })
    expect(calls.slice(count).map((body) => body.model)).toEqual(["gpt-image-2", "gpt-image-2.5-sunburst"])
  }),
)

it.live("rejects invalid model and size before calling the authenticated transport", () =>
  Effect.gen(function* () {
    const count = calls.length
    const invalid = yield* post(CodexImage25Paths.generate, { model: "not-a-model", prompt: "frame" })
    expect(invalid.status).toBe(400)
    const size = yield* post(CodexImage25Paths.generate, {
      model: "gpt-image-2.5-flare",
      prompt: "frame",
      size: "1024x3",
    })
    expect(size.status).toBe(400)
    expect(calls.length).toBe(count)
  }),
)

it.live("retains upstream status and request metadata on a failed experiment", () =>
  Effect.gen(function* () {
    const count = calls.length
    const response = yield* post(CodexImage25Paths.generate, { model: "gpt-image-2.5-flare", prompt: "reject" })
    expect(response.status).toBe(502)
    expect(yield* response.json).toMatchObject({ upstreamStatus: 429, diagnostics: { requestID: "limited-123" } })
    expect(calls.length).toBe(count + 1)
  }),
)

const unauthenticated = suite(new Auth.Api({ type: "api", key: "test-only" }), async () => {
  throw new Error("API credentials must never be sent to the subscription endpoint")
})
unauthenticated.live("requires subscription OAuth rather than accepting public API credentials", () =>
  Effect.gen(function* () {
    const response = yield* post(CodexImage25Paths.generate, { model: "gpt-image-2.5-flare", prompt: "frame" })
    expect(response.status).toBe(400)
    expect(yield* response.json).toMatchObject({
      message: "ChatGPT/Codex OAuth authentication is required for this experiment.",
    })
  }),
)

const missing = suite(oauth)
missing.live("does not fall back to unauthenticated fetch when the OAuth transport is unavailable", () =>
  Effect.gen(function* () {
    const response = yield* post(CodexImage25Paths.generate, { model: "gpt-image-2.5-flare", prompt: "frame" })
    expect(response.status).toBe(400)
    expect(yield* response.json).toMatchObject({
      message: "The OpenAI provider does not expose Codex OAuth transport.",
    })
  }),
)
