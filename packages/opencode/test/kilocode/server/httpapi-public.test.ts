import { describe, expect, test } from "bun:test"
import { Result, Schema as EffectSchema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { AgentBuilderPaths } from "../../../src/kilocode/server/httpapi/groups/agent-builder"
import { BackgroundProcessPaths } from "../../../src/kilocode/server/httpapi/groups/background-process"
import { CodexImagePaths } from "../../../src/kilocode/server/httpapi/groups/codex-image"
import { CodexImage25Paths } from "../../../src/kilocode/server/httpapi/groups/codex-image-25"
import { ConfigConsolePaths } from "../../../src/kilocode/server/httpapi/groups/config-console"
import { IndexingPaths, KiloEmbeddingModel } from "../../../src/kilocode/server/httpapi/groups/indexing"
import { KiloGatewayPaths } from "../../../src/kilocode/server/httpapi/groups/kilo-gateway"
import { KilocodePaths } from "../../../src/kilocode/server/httpapi/groups/kilocode"
import { NetworkPaths } from "../../../src/kilocode/server/httpapi/groups/network"
import { TelemetryPaths } from "../../../src/kilocode/server/httpapi/groups/telemetry"
import { ExperimentalPaths } from "../../../src/server/routes/instance/httpapi/groups/experimental"
import { SessionPaths } from "../../../src/server/routes/instance/httpapi/groups/session"
import { PublicApi } from "../../../src/server/routes/instance/httpapi/public"

type Schema = {
  anyOf?: Schema[]
  items?: Schema
  properties?: Record<string, Schema>
  type?: string
  enum?: string[]
  minLength?: number
  maxLength?: number
  pattern?: string
}

type Parameter = {
  in?: string
  name?: string
  schema?: Schema
}

type Method = "get" | "post" | "patch" | "put"

type Body = {
  content?: Record<string, { schema?: Schema }>
}

describe("Kilo PublicApi OpenAPI contract", () => {
  test("uses Kilo branding", () => {
    const spec = OpenApi.fromApi(PublicApi)
    expect(spec.info.title).toBe("kilo")
    expect(spec.info.description).toBe("kilo api")
  })

  test("publishes the Codex subscription image route", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const route = spec.paths[CodexImagePaths.generate]?.post
    expect(route).toBeDefined()
    const body = route?.requestBody as Body | undefined
    const schema = body?.content?.["application/json"]?.schema
    expect(schema?.properties?.background).toEqual({ type: "string", enum: ["auto", "opaque"] })
    expect(schema?.properties?.model).toBeUndefined()
    expect(schema?.properties?.quality).toEqual({ type: "string", enum: ["auto", "low", "medium", "high"] })
  })

  test("publishes a separate explicit-model experiment without changing the baseline route", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const route = spec.paths[CodexImage25Paths.generate]?.post
    expect(route).toBeDefined()
    const body = route?.requestBody as Body | undefined
    const props = body?.content?.["application/json"]?.schema?.properties
    expect(props?.model).toEqual({ type: "string", enum: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] })
    expect(props?.background).toEqual({ type: "string", enum: ["auto", "opaque", "transparent"] })
    expect(props?.quality).toEqual({ type: "string", enum: ["auto", "low", "medium", "high", "xhigh", "max"] })
    const response = route?.responses?.["200"] as Body | undefined
    const output = response?.content?.["application/json"]?.schema?.properties
    expect(output?.requested).toBeDefined()
    expect(output?.reported).toBeDefined()
    expect(output?.image).toBeDefined()
    expect(output?.model).toBeUndefined()
    expect(route?.parameters?.map((param) => (param as Parameter).name)).toEqual(["directory", "workspace"])
  })

  test("publishes the session file activity route", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const path = KilocodePaths.fileActivity.replace(":sessionID", "{sessionID}")
    expect(spec.paths[path]?.get).toBeDefined()
  })

  test("constrains embedding model metadata", () => {
    const accepts = (dimension: number, scoreThreshold: number) =>
      Result.isSuccess(
        EffectSchema.decodeUnknownResult(KiloEmbeddingModel)({
          id: "provider/model",
          name: "Model",
          dimension,
          scoreThreshold,
        }),
      )

    expect(accepts(1, 0)).toBe(true)
    expect(accepts(1024, 1)).toBe(true)
    expect(accepts(0, 0.5)).toBe(false)
    expect(accepts(1.5, 0.5)).toBe(false)
    expect(accepts(1024, -0.1)).toBe(false)
    expect(accepts(1024, 1.1)).toBe(false)
  })

  test("constrains agent builder route ids", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const save = AgentBuilderPaths.save.replace(":id", "{id}")
    const params = spec.paths[save]?.put?.parameters as Parameter[] | undefined
    const schema = params?.find((param) => param.name === "id")?.schema

    expect(schema).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
    })
  })

  test("keeps workspace routing queries on background process routes", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const routes = [
      { method: "get", path: BackgroundProcessPaths.list },
      { method: "get", path: BackgroundProcessPaths.get },
      { method: "get", path: BackgroundProcessPaths.logs },
      { method: "post", path: BackgroundProcessPaths.stop },
      { method: "post", path: BackgroundProcessPaths.restart },
      { method: "post", path: BackgroundProcessPaths.stopSession },
    ] satisfies Array<{ method: Method; path: string }>

    for (const route of routes) {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")
      const params = spec.paths[path]?.[route.method]?.parameters as Parameter[] | undefined
      const query = params?.filter((param) => param.in === "query").map((param) => param.name)
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toEqual(["directory", "workspace"])
    }
  })

  test("keeps directory routing queries on Kilo Console routes", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const routes = [
      { method: "get", path: ExperimentalPaths.worktreeDiff },
      { method: "get", path: ExperimentalPaths.worktreeDiffSummary },
      { method: "get", path: ExperimentalPaths.worktreeDiffFile },
      { method: "post", path: SessionPaths.viewed },
      { method: "get", path: ConfigConsolePaths.overlay },
      { method: "patch", path: ConfigConsolePaths.overlay },
      { method: "get", path: IndexingPaths.status },
      { method: "get", path: IndexingPaths.models },
    ] satisfies Array<{ method: Method; path: string }>

    for (const route of routes) {
      const params = spec.paths[route.path]?.[route.method]?.parameters as Parameter[] | undefined
      const query = params?.filter((param) => param.in === "query").map((param) => param.name)
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toContain("directory")
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toContain("workspace")
    }
  })

  test("keeps workspace routing queries on all Kilo-owned routed endpoints", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const routes = [
      { method: "post", path: AgentBuilderPaths.preview },
      { method: "put", path: AgentBuilderPaths.save },
      { method: "post", path: "/commit-message" },
      { method: "post", path: "/enhance-prompt" },
      { method: "get", path: NetworkPaths.list },
      { method: "post", path: NetworkPaths.reply },
      { method: "post", path: NetworkPaths.reject },
      { method: "post", path: TelemetryPaths.capture },
      { method: "post", path: TelemetryPaths.setEnabled },
      { method: "get", path: ConfigConsolePaths.sources },
      { method: "get", path: ConfigConsolePaths.effective },
      { method: "get", path: ConfigConsolePaths.rules },
      { method: "put", path: ConfigConsolePaths.rules },
      { method: "get", path: ConfigConsolePaths.modelState },
      { method: "patch", path: ConfigConsolePaths.modelState },
      { method: "get", path: ConfigConsolePaths.tuiConfig },
      { method: "get", path: ConfigConsolePaths.tuiKeybinds },
      { method: "patch", path: ConfigConsolePaths.tuiConfig },
    ] satisfies Array<{ method: Method; path: string }>

    for (const route of routes) {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")
      const params = spec.paths[path]?.[route.method]?.parameters as Parameter[] | undefined
      const query = params?.filter((param) => param.in === "query").map((param) => param.name)
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toContain("directory")
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toContain("workspace")
    }
  })

  test("keeps personal organization resets nullable", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const body = spec.paths[KiloGatewayPaths.organization]?.post?.requestBody as Body | undefined
    const schema = body?.content?.["application/json"]?.schema
    const props = schema?.properties
    expect(props?.organizationId).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })
  })

  test("keeps Kilo gateway responses nullable", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const response = (path: string) => {
      const body = spec.paths[path]?.get?.responses?.["200"] as Body | undefined
      return body?.content?.["application/json"]?.schema
    }

    const profile = response(KiloGatewayPaths.profile)?.properties
    expect(profile?.balance).toEqual({ anyOf: [expect.objectContaining({ type: "object" }), { type: "null" }] })
    expect(profile?.currentOrgId).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })

    const auth = response(KiloGatewayPaths.authStatus)?.properties
    expect(auth).toEqual({
      authenticated: { type: "boolean" },
      type: { type: "string", enum: ["api", "oauth"] },
    })

    const sessions = response(KiloGatewayPaths.cloudSessions)?.properties
    expect(sessions?.cliSessions?.items?.properties?.title).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
    expect(sessions?.nextCursor).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })

    const claw = response(KiloGatewayPaths.clawStatus)?.properties
    expect(claw?.status).toEqual({ anyOf: [expect.objectContaining({ type: "string" }), { type: "null" }] })
    for (const field of ["openclawVersion", "lastStartedAt", "lastStoppedAt", "botName"]) {
      expect(claw?.[field]).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })
    }

    expect(response(KiloGatewayPaths.clawChatCredentials)).toEqual({
      anyOf: [expect.objectContaining({ type: "object" }), { type: "null" }],
    })
  })

  test("keeps transcription prompts in the public contract", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const body = spec.paths[KiloGatewayPaths.audioTranscriptions]?.post?.requestBody as Body | undefined
    const schema = body?.content?.["application/json"]?.schema
    expect(schema?.properties?.prompt).toEqual({ type: "string" })
  })

  test("preserves unknown context measurements as nullable values", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const schemas = spec.components?.schemas as Record<string, Schema> | undefined
    const snapshot = schemas?.UserMessage?.properties?.contextPolicy?.properties
    const receipt = schemas?.CompactionPart?.properties?.context?.properties
    const context = schemas?.EventSessionContext?.properties?.properties?.properties
    for (const field of [snapshot?.combined, receipt?.currentTokens, context?.currentTokens, context?.nextTokens]) {
      expect(field).toEqual({ anyOf: [{ type: "number" }, { type: "null" }] })
    }
  })
})
