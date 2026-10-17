import { expect, test } from "bun:test"
import { createKilo, HEADER_ORGANIZATIONID } from "@kilocode/kilo-gateway"
import { Config } from "../../src/config/config"
import { Effect, Layer } from "effect"
import { Env } from "../../src/env"
import { Provider } from "../../src/provider/provider"
import { KiloAuth } from "../../src/kilocode/auth/authority"
import { Bus } from "../../src/bus"
import { testEffect } from "../lib/effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ProviderID } from "../../src/provider/schema"
import { AuthSource } from "../../src/kilocode/auth/source"
import { AuthRequest } from "../../src/kilocode/auth/request"
import { organization } from "../../src/kilocode/auth/mutations"
import { fixture } from "./fixture/auth-store"

const credential = { type: "oauth" as const, access: "static-token", refresh: "", expires: 0, accountId: "stored-org" }
const provider = { id: ProviderID.make("kilo"), env: ["KILO_API_KEY"], options: {}, source: "api" as const }
const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "fixture" }] }]
const response = () =>
  Response.json({
    id: "fixture",
    model: "fixture",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
const model = (sdk: ReturnType<typeof createKilo>) => sdk.openaiCompatible("fixture") as LanguageModelV3

test("actual gateway SDK final organization honors header over option and rejects an unadmitted request override", async () => {
  await using f = await fixture(credential, "kilo")
  const cfg: Config.Info = {
    provider: {
      kilo: {
        options: {
          kilocodeOrganizationId: "option-A",
          headers: { [HEADER_ORGANIZATIONID]: "header-B" },
        },
      },
    },
  }
  const resolve = () => AuthSource.select({ provider, cfg, env: {}, store: f.store })
  const selected = await resolve()
  expect(selected.organization).toBe("header-B")
  expect(selected.expiry).toBeUndefined()
  const guard = AuthRequest.create({ expected: selected.snapshot, resolve })
  const calls: string[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer static-token")
      expect(request.headers.get(AuthRequest.header)).toBeNull()
      calls.push(request.headers.get(HEADER_ORGANIZATIONID) ?? "")
      return response()
    },
  })
  const fetch = Object.assign(
    (request: RequestInfo | URL, init?: RequestInit) => AuthRequest.dispatch(globalThis.fetch, request, init, "kilo"),
    { preconnect: globalThis.fetch.preconnect },
  )
  const sdk = createKilo({
    baseURL: server.url.href,
    kilocodeToken: credential.access,
    kilocodeOrganizationId: "option-A",
    headers: { [HEADER_ORGANIZATIONID]: "header-B" },
    fetch,
  })
  try {
    await model(sdk).doGenerate({ prompt, headers: { [AuthRequest.header]: guard.id } })
    await expect(
      model(sdk).doGenerate({
        prompt,
        headers: {
          [AuthRequest.header]: guard.id,
          [HEADER_ORGANIZATIONID]: "request-C",
        },
      }),
    ).rejects.toMatchObject({ reason: "authority-changed" })
    expect(calls).toEqual(["header-B"])
  } finally {
    guard.close()
  }
})

test("model organization header is included in authority and validated on the actual gateway request", async () => {
  await using f = await fixture(credential, "kilo")
  const cfg: Config.Info = {
    provider: {
      kilo: {
        options: {
          kilocodeOrganizationId: "option-A",
          headers: { [HEADER_ORGANIZATIONID.toUpperCase()]: "provider-B" },
        },
      },
    },
  }
  let headers = { [HEADER_ORGANIZATIONID]: "model-C" }
  const resolve = () => AuthSource.select({ provider, model: { headers }, cfg, env: {}, store: f.store })
  const selected = await resolve()
  expect(selected.organization).toBe("model-C")
  const guard = AuthRequest.create({ expected: selected.snapshot, resolve })
  const calls: string[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls.push(request.headers.get(HEADER_ORGANIZATIONID) ?? "")
      return response()
    },
  })
  const fetch = Object.assign(
    (request: RequestInfo | URL, init?: RequestInit) => AuthRequest.dispatch(globalThis.fetch, request, init, "kilo"),
    { preconnect: globalThis.fetch.preconnect },
  )
  const sdk = createKilo({
    baseURL: server.url.href,
    kilocodeToken: credential.access,
    kilocodeOrganizationId: "option-A",
    headers: { [HEADER_ORGANIZATIONID.toUpperCase()]: "provider-B" },
    fetch,
  })
  try {
    await model(sdk).doGenerate({ prompt, headers: { ...headers, [AuthRequest.header]: guard.id } })
    headers = { [HEADER_ORGANIZATIONID]: "model-D" }
    await expect(
      model(sdk).doGenerate({ prompt, headers: { ...headers, [AuthRequest.header]: guard.id } }),
    ).rejects.toMatchObject({ reason: "authority-changed" })
    expect(calls).toEqual(["model-C"])
  } finally {
    guard.close()
  }
})

test("SDK initialization spanning an organization switch cannot dispatch the previous or a silently rebound account", async () => {
  await using f = await fixture(credential, "kilo")
  const resolve = () => AuthSource.select({ provider, cfg: {}, env: {}, store: f.store })
  const before = await resolve()
  const old = AuthRequest.create({ expected: before.snapshot, resolve })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: string[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls.push(request.headers.get(HEADER_ORGANIZATIONID) ?? "")
      return response()
    },
  })
  const fetch = Object.assign(
    (request: RequestInfo | URL, init?: RequestInit) => AuthRequest.dispatch(globalThis.fetch, request, init, "kilo"),
    { preconnect: globalThis.fetch.preconnect },
  )
  const init = (async () => {
    const options = {
      baseURL: server.url.href,
      kilocodeToken: credential.access,
      kilocodeOrganizationId: before.organization,
      fetch,
    }
    entered.resolve()
    await release.promise
    return createKilo(options)
  })()
  let next: AuthRequest.Guard | undefined
  let fresh: AuthRequest.Guard | undefined
  try {
    await entered.promise
    const info = (await f.store.all()).kilo
    if (info.type !== "oauth") throw new Error("Invalid fixture")
    await organization(info, "new-org", f.store)
    release.resolve()
    const stale = await init
    await expect(model(stale).doGenerate({ prompt, headers: { [AuthRequest.header]: old.id } })).rejects.toMatchObject({
      reason: "authority-changed",
    })
    next = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
    await expect(model(stale).doGenerate({ prompt, headers: { [AuthRequest.header]: next.id } })).rejects.toMatchObject(
      { reason: "authority-changed" },
    )
    expect(calls).toEqual([])
    fresh = AuthRequest.create({ expected: (await resolve()).snapshot, resolve })
    const sdk = createKilo({
      baseURL: server.url.href,
      kilocodeToken: credential.access,
      kilocodeOrganizationId: "new-org",
      fetch,
    })
    await model(sdk).doGenerate({ prompt, headers: { [AuthRequest.header]: fresh.id } })
    expect(calls).toEqual(["new-org"])
  } finally {
    release.resolve()
    old.close()
    next?.close()
    fresh?.close()
  }
})

for (const source of ["config", "catalog"] as const) {
  const configured: { headers?: Record<string, string> } =
    source === "config" ? { headers: { [HEADER_ORGANIZATIONID]: "helper-org" } } : {}
  const cfg: Config.Info = {
    small_model: "kilo/helper",
    provider: {
      kilo: {
        options: { kilocodeToken: `helper-${source}`, kilocodeOrganizationId: "primary-org" },
        models: { helper: configured },
      },
    },
  }
  const view = Provider.fromModelsDevProvider({
    id: "kilo",
    name: "fixture",
    env: [],
    models: {
      helper: {
        id: "helper",
        name: "Helper",
        family: "fixture",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        tool_call: true,
        temperature: false,
        limit: { context: 128000, output: 1000 },
        cost: { input: 0, output: 0 },
      },
    },
  })
  view.models.helper.headers = source === "catalog" ? { [HEADER_ORGANIZATIONID]: "helper-org" } : {}
  const it = testEffect(
    Layer.mergeAll(
      Bus.defaultLayer,
      Layer.mock(Config.Service)({ get: () => Effect.succeed(cfg) }),
      Layer.mock(Env.Service)({ all: () => Effect.succeed({}) }),
      Layer.mock(Provider.Service)({
        getProvider: () => Effect.succeed(view),
        list: () => Effect.succeed({ kilo: view }),
      }),
    ),
  )
  it.instance(`helper admission retains ${source} model organization overrides and rejects later replacement`, () =>
    Effect.gen(function* () {
      const admitted = yield* KiloAuth.admit({ providerID: "kilo", modelID: "primary" })
      const model = { providerID: "kilo", modelID: "helper" }
      const selected = KiloAuth.selected(
        { authAuthority: admitted.authority, authAuthorities: admitted.authorities },
        model,
      )
      expect(selected).toBeDefined()
      expect(selected?.authority).not.toBe(admitted.authority.authority)
      yield* KiloAuth.check(selected, model)
      const guard = yield* KiloAuth.request({
        snapshot: selected,
        model: { providerID: "kilo", id: "helper" },
        sessionID: "ses_fixture",
        messageID: "msg_fixture",
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => guard.close()))
      const headers = yield* Effect.promise(() => guard.headers({ [HEADER_ORGANIZATIONID]: "helper-org" }))
      expect(headers.get(HEADER_ORGANIZATIONID)).toBe("helper-org")
      expect(headers.get("authorization")).toBe(`Bearer helper-${source}`)
      if (source === "config") configured.headers = { [HEADER_ORGANIZATIONID]: "replacement-org" }
      else view.models.helper.headers = { [HEADER_ORGANIZATIONID]: "replacement-org" }
      const result = yield* Effect.promise(() => guard.check().catch((error: unknown) => error))
      expect(result).toMatchObject({ reason: "authority-changed" })
    }),
  )
}
