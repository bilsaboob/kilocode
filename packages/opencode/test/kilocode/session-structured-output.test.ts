import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session/session"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { KiloSessionRecovery } from "../../src/kilocode/session/recovery"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, TestLLMServer } from "../lib/llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    AppFileSystem.defaultLayer,
    TestLLMServer.layer,
  ).pipe(Layer.provide(NodeFileSystem.layer)),
)
const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["components"],
  properties: { components: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 0 } },
}

for (const scenario of ["empty", "valid", "provider-error", "ordinary"]) {
  it.instance(
    `structured prompt boundary: ${scenario}`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const llm = yield* TestLLMServer
        yield* fs.writeWithDirs(
          path.join(fixture.directory, "opencode.json"),
          JSON.stringify({
            model: "test/test-model",
            small_model: "test/test-model",
            provider: {
              test: {
                name: "Test",
                npm: "@ai-sdk/openai-compatible",
                env: [],
                options: { apiKey: "test-only", baseURL: llm.url, maxRetries: 0 },
                models: {
                  "test-model": {
                    name: "Test",
                    tool_call: true,
                    limit: { context: 128000, output: 4096 },
                    cost: { input: 0, output: 0 },
                  },
                },
              },
            },
          }),
        )
        if (scenario === "valid") yield* llm.tool("StructuredOutput", { components: [] })
        else if (scenario === "provider-error")
          yield* llm.error(400, {
            error: {
              message: "Invalid schema supplied by caller",
              type: "invalid_request_error",
              code: "invalid_json_schema",
            },
          })
        else yield* llm.push(raw({ chunks: [] }))
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const chat = yield* sessions.create({ title: "Isolated QA contract regression" })
        const result = yield* prompt.prompt({
          sessionID: chat.id,
          model: ref,
          agent: "code",
          format: scenario === "ordinary" ? undefined : { type: "json_schema", schema, retryCount: 0 },
          parts: [
            {
              type: "text",
              text: "Return components: [] using StructuredOutput. Do not invent component rows or use other tools.",
            },
          ],
        })
        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") throw new Error("missing final assistant")
        if (scenario === "empty") {
          expect(result.info.error?.name).toBe("APIError")
          if (result.info.error?.name !== "APIError") throw new Error("missing incomplete-response error")
          expect(result.info.error.data.message).toContain("[STRUCTURED_OUTPUT_INCOMPLETE]")
          expect(KiloSessionRecovery.interrupted(result.info)).toBe(false)
        }
        if (scenario === "valid") {
          expect(result.info.structured).toEqual({ components: [] })
          expect(result.info.error).toBeUndefined()
        }
        if (scenario === "provider-error") {
          if (result.info.error?.name !== "APIError") throw new Error("missing original provider error")
          expect(result.info.error.data.message).toContain("Invalid schema supplied by caller")
          expect(result.info.error.data.message).not.toContain("[STRUCTURED_OUTPUT_INCOMPLETE]")
        }
        if (scenario === "ordinary") expect(result.info.error).toBeUndefined()
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const encoded = Schema.encodeSync(Schema.Array(MessageV2.WithParts))(messages)
        expect(encoded.filter((message) => message.info.role === "user")).toHaveLength(1)
        expect(encoded.filter((message) => message.info.role === "assistant")).toHaveLength(1)
        expect(yield* llm.calls).toBe(1)
      }),
    30_000,
  )
}
