import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { jsonSchema } from "ai"
import { Schema } from "effect"
import { KiloContextPolicy } from "@/kilocode/session/context-policy"
import { KiloContextTurn } from "@/kilocode/session/context-turn"
import { KiloSessionRecovery } from "@/kilocode/session/recovery"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { KiloSessionMessageOrder } from "@/kilocode/session/message-order"
import { KiloCompactionChunks } from "@/kilocode/session/compaction-chunks"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID } from "@/provider/schema"
import { ProviderTest } from "../fake/provider"
import { png } from "./fixture/context-image"
import { CodexModels } from "@/kilocode/provider/codex-models"

const profile = { version: 1, window: "maximum-supported", automaticPercent: 85, admissionPercent: 95 }
const original = process.env.ZEN_KILO_CONTEXT_POLICY
beforeEach(() => {
  process.env.ZEN_KILO_CONTEXT_POLICY = JSON.stringify(profile)
})
afterEach(() => {
  if (original === undefined) delete process.env.ZEN_KILO_CONTEXT_POLICY
  else process.env.ZEN_KILO_CONTEXT_POLICY = original
})
const cfg = Schema.decodeUnknownSync(Config.Info)({ compaction: { auto: true, threshold_percent: 85 } }) as Config.Info
const model = ProviderTest.model({
  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  codex: {
    status: "ready",
    context: 272_000,
    maximum: 872_000,
    effectivePercent: 95,
    source: "fixture",
    revision: "r1",
  },
})
const freeze = () => KiloContextPolicy.freeze({ cfg, model })!

function user(sessionID = SessionID.descending()): MessageV2.WithParts & { info: MessageV2.User } {
  const info: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "build",
    time: { created: 1 },
    model: { providerID: model.providerID, modelID: model.id },
    contextPolicy: freeze(),
    format: { type: "json_schema", retryCount: 0, schema: { type: "object", required: ["answer"] } },
  }
  return {
    info,
    parts: [{ id: PartID.ascending(), sessionID, messageID: info.id, type: "text", text: "Keep this exact request" }],
  }
}

describe("Zen process context policy", () => {
  test("transformation preserves inline URL and binary image parts without mutating evidence", () => {
    const bytes = png(32, 32)
    const image = new URL(`data:image/png;base64,${bytes.toString("base64")}`)
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "image" as const, image },
          { type: "image" as const, image: new Uint8Array(bytes), mediaType: "image/png" },
        ],
      },
    ]
    const before = JSON.stringify(messages)
    const result = KiloContextPolicy.transform(
      messages,
      {
        ...model,
        capabilities: { ...model.capabilities, input: { ...model.capabilities.input, image: true } },
      },
      {},
    )
    const content = result[0].content
    if (!Array.isArray(content) || content[0].type !== "image" || content[1].type !== "image")
      throw new Error("Missing images")
    expect(content[0].image).toBeInstanceOf(URL)
    expect(content[0].image).not.toBe(image)
    if (!(content[0].image instanceof URL)) throw new Error("Missing image URL")
    expect(content[0].image.href).toBe(image.href)
    expect(content[1].image).toBeInstanceOf(Uint8Array)
    expect(content[1].image).not.toBe(messages[0].content[1].image)
    expect(JSON.stringify(messages)).toBe(before)
  })
  test("strict explicit profile, deterministic identity, no implicit Zen or ordinary 65 change", () => {
    const first = KiloContextPolicy.configured()
    process.env.ZEN_KILO_CONTEXT_POLICY = JSON.stringify({
      admissionPercent: 95,
      window: "maximum-supported",
      version: 1,
      automaticPercent: 85,
    })
    expect(KiloContextPolicy.configured()).toEqual(first)
    for (const value of [
      "",
      "null",
      "{}",
      JSON.stringify({ ...profile, automaticPercent: 95 }),
      JSON.stringify({ ...profile, automaticPercent: 0 }),
      JSON.stringify({ ...profile, automaticPercent: 80.5 }),
      JSON.stringify({ ...profile, admissionPercent: 101 }),
      JSON.stringify({ ...profile, extra: true }),
    ]) {
      process.env.ZEN_KILO_CONTEXT_POLICY = value
      expect(() => KiloContextPolicy.configured()).toThrow("ContextAdmissionError")
    }
    delete process.env.ZEN_KILO_CONTEXT_POLICY
    expect(KiloContextPolicy.configured()).toBeUndefined()
    expect(KiloContextPolicy.freeze({ cfg, model })).toBeUndefined()
    expect(
      KiloSessionOverflow.limit({ cfg: { ...cfg, compaction: { threshold_percent: 65 } }, model, usable: 902_000 }),
    ).toBe(599_300)
  })

  test("uses maximum, not API limits, default context or twice the 95 percent margin", () => {
    const before = structuredClone(model)
    const snapshot = freeze()
    expect(snapshot.window).toBe(872_000)
    expect(KiloContextPolicy.thresholds(snapshot)).toEqual({ automaticThreshold: 741_200, admissionThreshold: 828_400 })
    expect(model).toEqual(before)
  })

  test("custom 80/90 profile is validated, hashed and exposed without silently changing defaults", () => {
    process.env.ZEN_KILO_CONTEXT_POLICY = JSON.stringify({ ...profile, automaticPercent: 80, admissionPercent: 90 })
    const custom = KiloContextPolicy.configured()!
    expect(Schema.decodeUnknownSync(KiloContextPolicy.Profile)(custom)).toEqual(custom)
    const snapshot = KiloContextPolicy.freeze({
      cfg: { ...cfg, compaction: { auto: true, threshold_percent: 80 } },
      model,
    })!
    expect(KiloContextPolicy.thresholds(snapshot)).toEqual({ automaticThreshold: 697_600, admissionThreshold: 784_800 })
    expect(() => KiloContextPolicy.freeze({ cfg, model })).toThrow("ContextAdmissionError")
    process.env.ZEN_KILO_CONTEXT_POLICY = JSON.stringify({ ...profile, automaticPercent: 90, admissionPercent: 80 })
    expect(() => KiloContextPolicy.configured()).toThrow("ContextAdmissionError")
  })

  test("new admission refreshes a cached unavailable capability without mutating the provider or an existing turn", async () => {
    let attempts = 0
    const cap = CodexModels.bind(CodexModels.unavailable("temporarily unavailable"), async () => {
      attempts++
      return new Map([[model.api.id, model.codex!]])
    })
    const cached = { ...model, codex: cap }
    const snapshot = (await KiloContextPolicy.capture({ cfg, model: cached }))!
    expect(attempts).toBe(1)
    expect(snapshot.window).toBe(872_000)
    expect(cached.codex).toBe(cap)
    expect(await KiloContextPolicy.capture({ cfg, model: cached, inherited: snapshot })).toEqual(snapshot)
    expect(attempts).toBe(2)
    const reduced = CodexModels.bind(
      cap,
      async () =>
        new Map([
          [
            model.api.id,
            {
              status: "ready",
              context: 16_000,
              maximum: 32_000,
              effectivePercent: 95,
              source: "fixture",
              revision: "r2",
            },
          ],
        ]),
    )
    await expect(
      KiloContextPolicy.capture({ cfg, model: { ...model, codex: reduced }, inherited: snapshot }),
    ).rejects.toMatchObject({
      data: { reason: "Known provider capacity decreased below the frozen turn budget" },
    })
    expect(snapshot.window).toBe(872_000)
    const missing = {
      ...model,
      codex: CodexModels.unavailable("The authenticated Codex model catalog could not be read safely."),
    }
    await expect(KiloContextPolicy.capture({ cfg, model: missing })).rejects.toMatchObject({
      name: "ContextAdmissionError",
    })
    expect(await KiloContextPolicy.capture({ cfg, model: missing, inherited: snapshot })).toEqual(snapshot)
  })

  test("rejects unknown Codex capacity and conflicting emergency/organization config", () => {
    for (const compaction of [{ auto: false, threshold_percent: 85 }, { auto: true, threshold_percent: 65 }, {}])
      expect(() => KiloContextPolicy.freeze({ cfg: { ...cfg, compaction }, model })).toThrow("ContextAdmissionError")
    expect(() =>
      KiloContextPolicy.freeze({ cfg, model: { ...model, codex: { status: "unavailable", reason: "unknown alias" } } }),
    ).toThrow("ContextAdmissionError")
    expect(() => KiloContextPolicy.freeze({ cfg, model: { ...model, codex: undefined }, oauth: true })).toThrow(
      "ContextAdmissionError",
    )
    expect(() =>
      KiloContextPolicy.freeze({ cfg, model: { ...model, codex: undefined, limit: { context: 0, output: 100 } } }),
    ).toThrow("ContextAdmissionError")
  })

  test("freezes JSON snapshots across reconnect and resolves a different child model's own budget", () => {
    const snapshot = freeze()
    const restored = JSON.parse(JSON.stringify(snapshot))
    const changed = {
      ...model,
      codex: {
        ...model.codex!,
        status: "ready" as const,
        context: 16_000,
        maximum: 32_000,
        effectivePercent: 95,
        source: "fixture",
        revision: "r2",
      },
    }
    expect(() => KiloContextPolicy.freeze({ cfg, model: changed, inherited: restored })).toThrow(
      "ContextAdmissionError",
    )
    expect(KiloContextPolicy.freeze({ cfg, model, inherited: restored })).toEqual(snapshot)
    expect(
      KiloContextPolicy.freeze({
        cfg,
        model: {
          ...model,
          codex: { status: "unavailable", reason: "The authenticated Codex model catalog could not be read safely." },
        },
        inherited: restored,
      }),
    ).toEqual(snapshot)
    delete process.env.ZEN_KILO_CONTEXT_POLICY
    const child = KiloContextPolicy.freeze({
      cfg,
      model: { ...changed, id: ModelID.make("child") },
      inherited: restored,
    })!
    expect(child.window).toBe(32_000)
    expect(child.profile).toEqual(snapshot.profile)
    const generic = KiloContextPolicy.freeze({
      cfg,
      model: ProviderTest.model({
        id: ModelID.make("generic"),
        limit: { context: 100_000, input: 90_000, output: 8_000 },
      }),
      inherited: restored,
    })!
    expect(generic.window).toBe(100_000)
    expect(generic.input).toBe(90_000)
    expect(() => KiloContextPolicy.same(snapshot, child)).toThrow("ContextAdmissionError")
    expect(() => KiloContextPolicy.freeze({ cfg, model, inherited: { ...snapshot, window: 9_000_000 } })).toThrow(
      "ContextAdmissionError",
    )
  })

  test("exact soft/hard boundaries and fresh irreducible requests fitting 95 percent", () => {
    const snapshot = freeze()
    const state = { currentTokens: null, attempted: false, reducible: true }
    const decide = (next: number, overrides = {}) =>
      KiloContextPolicy.decide({
        snapshot,
        state: { ...state, ...overrides },
        tokens: { input: next - 10_000, next, output: 128_000 },
      })
    expect(decide(741_199)).toBe("admit")
    expect(decide(741_200)).toBe("admit")
    expect(decide(820_000, { currentTokens: 100_000 })).toBe("admit")
    expect(decide(828_400, { reducible: false })).toBe("admit")
    expect(decide(828_401, { reducible: false })).toBe("blocked")
    expect(decide(828_401, { attempted: true })).toBe("blocked")
    expect(decide(800_000, { attempted: true })).toBe("admit")
    expect(decide(1_000, { currentTokens: 741_200 })).toBe("compact")
  })

  test("reported totals cannot be suppressed by a partial normalized usage record", () => {
    expect(
      KiloContextPolicy.count({ total: 800_000, input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }),
    ).toBe(800_000)
    expect(KiloContextPolicy.count(undefined)).toBeNull()
    expect(KiloContextPolicy.count({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBeNull()
  })

  test("input admission and separate provider input/output/combined limits identify their actual reason", () => {
    const snapshot = freeze()
    const tokens = { input: 800_000, next: 802_048, output: 128_000 }
    expect(KiloContextPolicy.decide({ snapshot, tokens })).toBe("admit")
    expect(KiloContextPolicy.reason({ snapshot, tokens })).toBe("within-budget")
    expect(KiloContextPolicy.reason({ snapshot: { ...snapshot, combined: 900_000 }, tokens })).toBe(
      "provider-combined-capacity",
    )
    expect(KiloContextPolicy.reason({ snapshot: { ...snapshot, input: 790_000 }, tokens })).toBe(
      "provider-input-capacity",
    )
    expect(KiloContextPolicy.reason({ snapshot, tokens: { ...tokens, output: 128_001 } })).toBe(
      "provider-output-capacity",
    )
    expect(KiloContextPolicy.reason({ snapshot, tokens: { ...tokens, next: 828_401 } })).toBe(
      "predictive-admission-threshold",
    )
    expect(
      KiloContextPolicy.reason({
        snapshot,
        tokens,
        state: { attempted: false, reducible: true, currentTokens: 741_200 },
      }),
    ).toBe("reported-usage-threshold")
  })

  test("counts systems, tool schemas, media, reasoning and options without mutating the payload", async () => {
    const snapshot = freeze()
    const base = {
      snapshot,
      messages: [{ role: "user" as const, content: "input" }],
      tools: {},
      options: {},
      output: 1_024,
    }
    const small = await KiloContextPolicy.estimate(base)
    const input = {
      ...base,
      messages: [
        { role: "system" as const, content: "system".repeat(100) },
        {
          role: "user" as const,
          content: [
            {
              type: "image" as const,
              image:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
            },
          ],
        },
        { role: "assistant" as const, content: [{ type: "reasoning" as const, text: "reason".repeat(1_000) }] },
      ],
      tools: { StructuredOutput: { inputSchema: jsonSchema({ type: "object", description: "schema".repeat(1_000) }) } },
      options: { instructions: "instructions".repeat(1_000), reasoning: { encrypted_content: "opaque".repeat(1_000) } },
    }
    const before = JSON.stringify(input)
    const full = await KiloContextPolicy.estimate(input)
    expect(full.next).toBeGreaterThan(small.next + 10_000)
    expect(full.next - full.input).toBe(2_048)
    expect(full.output).toBe(1_024)
    expect(JSON.stringify(input)).toBe(before)
    expect(await KiloContextPolicy.estimate({ ...base, output: undefined })).toMatchObject({
      next: small.next,
      output: snapshot.output,
    })
    expect(await KiloContextPolicy.estimate({ ...base, output: undefined, outputLimit: 2_048 })).toMatchObject({
      next: small.next,
      output: snapshot.output,
    })
    await expect(
      KiloContextPolicy.estimate({
        ...base,
        messages: [{ role: "user", content: [{ type: "image", image: "https://example.invalid/unbounded.png" }] }],
      }),
    ).rejects.toMatchObject({ name: "ContextAdmissionError" })
  })

  test("accounts for UTF-8 text growth rather than only UTF-16 string length", async () => {
    const base = { snapshot: freeze(), tools: {}, options: {}, output: 1 }
    const ascii = await KiloContextPolicy.estimate({ ...base, messages: [{ role: "user", content: "x".repeat(1000) }] })
    const unicode = await KiloContextPolicy.estimate({
      ...base,
      messages: [{ role: "user", content: "\u6f22".repeat(1000) }],
    })
    expect(unicode.input).toBeGreaterThan(ascii.input * 2)
  })

  test("retains original pending schema, media and completed side effects without replaying them", () => {
    const old = user()
    const pending = user(old.info.sessionID)
    pending.parts.push({
      id: PartID.ascending(),
      messageID: pending.info.id,
      sessionID: pending.info.sessionID,
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,AAAA",
    })
    const assistant: MessageV2.WithParts = {
      info: {
        id: MessageID.ascending(),
        parentID: pending.info.id,
        sessionID: pending.info.sessionID,
        role: "assistant",
        agent: "build",
        mode: "build",
        modelID: model.id,
        providerID: model.providerID,
        path: { cwd: "/fixture", root: "/fixture" },
        cost: 0,
        tokens: { input: 750_000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2, completed: 3 },
        finish: "tool-calls",
      },
      parts: [],
    }
    assistant.parts.push({
      id: PartID.ascending(),
      messageID: assistant.info.id,
      sessionID: pending.info.sessionID,
      type: "tool",
      callID: "completed-once",
      tool: "write",
      state: {
        status: "completed",
        input: { path: "fixture" },
        output: "saved",
        title: "saved",
        metadata: {},
        time: { start: 2, end: 3 },
      },
    })
    const marker = user(old.info.sessionID)
    marker.info.time.created = 4
    const receipt = {
      source: pending.info.id,
      progress: assistant.info.id,
      currentTokens: 750_010,
      nextTokens: 840_000,
    }
    marker.parts = [
      {
        id: PartID.ascending(),
        messageID: marker.info.id,
        sessionID: marker.info.sessionID,
        type: "compaction",
        auto: true,
        context: receipt,
        tail_start_id: pending.info.id,
      },
    ]
    const summary: MessageV2.WithParts = {
      info: {
        ...(assistant.info as MessageV2.Assistant),
        id: MessageID.ascending(),
        parentID: marker.info.id,
        summary: true,
        finish: "stop",
        time: { created: 5, completed: 6 },
      },
      parts: [],
    }
    const messages = [old, pending, assistant, marker]
    const before = JSON.stringify(messages)
    expect(KiloContextTurn.retain(messages, receipt)).toMatchObject({ head: [old], tail_start_id: pending.info.id })
    expect(JSON.stringify(messages)).toBe(before)
    const projected = MessageV2.filterCompacted([summary, marker, assistant, pending, old])
    expect(KiloSessionMessageOrder.latest(KiloContextTurn.active(projected)).user?.id).toBe(pending.info.id)
    expect(KiloContextTurn.state(projected, pending.info)?.attempted).toBe(true)
    expect(projected.find((item) => item.info.id === pending.info.id)).toEqual(pending)
    expect(projected.find((item) => item.info.id === assistant.info.id)).toEqual(assistant)
    const progress = { ...assistant, info: { ...assistant.info, id: MessageID.ascending() } }
    expect(KiloContextTurn.state([...projected, progress], pending.info)?.attempted).toBe(false)
  })

  test("bounded diagnostic contract and nonretryable persisted admission errors", () => {
    const snapshot = freeze()
    const payload = KiloContextPolicy.diagnostic({
      snapshot,
      sessionID: "session",
      messageID: "message",
      phase: "compacting",
      reason: "threshold",
      currentTokens: null,
      nextTokens: 800_000,
    })
    expect(Schema.decodeUnknownSync(KiloContextPolicy.Event.properties)(payload)).toEqual(payload)
    expect(payload).toMatchObject({
      window: 872_000,
      nextTokens: 800_000,
      currentTokens: null,
      profileID: snapshot.profile.id,
    })
    expect(Object.keys(payload).sort()).toEqual([
      "admissionThreshold",
      "automaticThreshold",
      "currentTokens",
      "messageID",
      "modelID",
      "nextTokens",
      "phase",
      "profileID",
      "providerID",
      "reason",
      "sessionID",
      "sessionTitle",
      "window",
    ])
    const error = MessageV2.fromError(KiloContextPolicy.blocked("irreducible"), { providerID: model.providerID })
    expect(error.name).toBe("ContextAdmissionError")
    expect(KiloSessionRecovery.interrupted({ error } as MessageV2.Assistant)).toBe(false)
    expect(KiloCompactionChunks.budget({ cfg, model, policy: snapshot })).toBeLessThan(828_400)
  })
})
