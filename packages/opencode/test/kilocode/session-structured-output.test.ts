import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import type { Permission } from "../../src/permission"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt, createStructuredOutputTool } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionRetry } from "../../src/session/retry"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { KiloSessionRecovery } from "../../src/kilocode/session/recovery"
import { TestInstance, requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, TestLLMServer } from "../lib/llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    LLM.defaultLayer,
    Agent.defaultLayer,
    Config.defaultLayer,
    Provider.defaultLayer,
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

const setup = Effect.gen(function* () {
  const fixture = yield* TestInstance
  const fs = yield* AppFileSystem.Service
  const llm = yield* TestLLMServer
  yield* fs.writeWithDirs(
    path.join(fixture.directory, "opencode.json"),
    JSON.stringify({
      model: "test/test-model",
      small_model: "test/test-model",
      enabled_providers: ["test"],
      snapshot: false,
      lsp: false,
      formatter: false,
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
  return { fixture, fs, llm }
})

for (const scenario of ["empty", "valid", "provider-error", "ordinary"]) {
  it.instance(
    `structured prompt boundary: ${scenario}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* setup
        if (scenario === "valid") yield* llm.tool("StructuredOutput", { components: [] })
        else if (scenario === "provider-error")
          yield* llm.error(400, {
            error: {
              message: "Invalid schema supplied by caller",
              type: "invalid_request_error",
              code: "invalid_json_schema",
            },
          })
        else if (scenario === "empty") yield* llm.push(raw({ chunks: [] }))
        else yield* llm.push(raw({ chunks: [{ choices: [{ delta: {}, finish_reason: "stop" }] }] }))
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
          expect(result.info.error.data.message).toContain("[RESPONSE_TERMINAL_MISSING]")
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

const restricted: Permission.Ruleset = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*.env", action: "deny" },
  { permission: "read", pattern: "*.env.*", action: "deny" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "list", pattern: "*", action: "allow" },
]

for (const scenario of ["allowed", "missing-allow", "denied", "disabled", "ordinary", "provider-error"]) {
  it.instance(
    `restricted editor boundary: ${scenario}`,
    () =>
      Effect.gen(function* () {
        const { fixture, fs, llm } = yield* setup
        const file = path.join(fixture.directory, "code.html")
        const relative = path.relative((yield* requireInstance).worktree, file)
        const before = "<!doctype html><p>Before</p>\n"
        const after = "<!doctype html><p>After</p>\n"
        yield* fs.writeWithDirs(file, before)
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const chat = yield* sessions.create({
          title: "Isolated restricted editor regression",
          permission: [
            ...restricted,
            ...(scenario === "missing-allow" || scenario === "ordinary"
              ? []
              : [{ permission: "StructuredOutput", pattern: "*", action: "allow" as const }]),
            ...[...new Set([relative, relative.replaceAll("\\", "/")])].map((pattern) => ({
              permission: "edit",
              pattern,
              action: "allow" as const,
            })),
            ...(scenario === "denied"
              ? [{ permission: "StructuredOutput", pattern: "*", action: "deny" as const }]
              : []),
          ],
        })
        if (scenario === "allowed" || scenario === "ordinary") {
          yield* llm.tool("read", { filePath: file })
          yield* llm.tool("edit", { filePath: file, oldString: "Before", newString: "After" })
          if (scenario === "allowed") yield* llm.tool("StructuredOutput", { components: [] })
          else yield* llm.text("Updated code.html.")
        } else if (scenario === "provider-error") {
          yield* llm.error(400, {
            error: { message: "Invalid schema supplied by caller", type: "invalid_request_error" },
          })
        } else {
          // A missing preflight must fail promptly rather than spin on fixture fallbacks.
          yield* llm.push(raw({ chunks: [] }))
        }
        const result = yield* prompt.prompt({
          sessionID: chat.id,
          model: ref,
          agent: "code",
          tools: scenario === "disabled" ? { StructuredOutput: false } : undefined,
          format: scenario === "ordinary" ? undefined : { type: "json_schema", schema, retryCount: 0 },
          parts: [{ type: "text", text: "Read code.html, replace Before with After, then return components: []." }],
        })
        if (result.info.role !== "assistant") throw new Error("missing final assistant")
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const receipts = messages.flatMap((message) => message.parts.filter((part) => part.type === "tool"))
        expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
        expect(KiloSessionRecovery.interrupted(result.info)).toBe(false)
        if (scenario === "allowed" || scenario === "ordinary") {
          expect(result.info.error).toBeUndefined()
          expect(receipts.map((part) => part.tool)).toEqual(
            scenario === "allowed" ? ["read", "edit", "StructuredOutput"] : ["read", "edit"],
          )
          expect(
            receipts.map((part) => (part.state.status === "error" ? part.state.error : part.state.status)),
          ).toEqual(receipts.map(() => "completed"))
          expect(yield* fs.readFileString(file)).toBe(after)
          expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(3)
          expect(yield* llm.calls).toBe(3)
          if (scenario === "allowed") {
            expect(result.info.structured).toEqual({ components: [] })
            expect(result.info.finish).toBe("tool-calls")
          } else {
            expect(result.info.structured).toBeUndefined()
            expect(result.info.finish).toBe("stop")
          }
          const inputs = yield* llm.inputs
          for (const input of inputs) {
            const tools = input.tools as { function: { name: string } }[]
            const names = tools.map((tool) => tool.function.name)
            expect(names).toContain("read")
            expect(names).toContain("edit")
            expect(names.includes("StructuredOutput")).toBe(scenario === "allowed")
            for (const name of ["bash", "shell", "webfetch", "websearch", "task", "background_process"])
              expect(names).not.toContain(name)
            if (scenario === "allowed") expect(input.tool_choice).toBe("required")
          }
          const history = inputs[2].messages as { role: string; content: string }[]
          const outputs = history.filter((message) => message.role === "tool")
          expect(outputs).toHaveLength(2)
          expect(outputs[0].content).toContain("Before")
          expect(outputs[1].content).toContain("Edit applied successfully")
          if (scenario === "allowed") {
            const blocked = yield* prompt.prompt({
              sessionID: chat.id,
              model: ref,
              agent: "code",
              format: { type: "json_schema", schema, retryCount: 0 },
              tools: { StructuredOutput: false },
              parts: [{ type: "text", text: "Report the existing result without repeating the edit." }],
            })
            if (blocked.info.role !== "assistant") throw new Error("missing blocked assistant")
            if (blocked.info.error?.name !== "APIError") throw new Error("missing contract APIError")
            expect(blocked.info.error.data.message).toContain("[STRUCTURED_OUTPUT_UNAVAILABLE]")
            expect(blocked.info.error.data.isRetryable).toBe(false)
            expect(SessionRetry.retryable(blocked.info.error)).toBeUndefined()
            expect(KiloSessionRecovery.interrupted(blocked.info)).toBe(false)
            expect(yield* llm.calls).toBe(3)
            expect(yield* fs.readFileString(file)).toBe(after)
            const retained = yield* sessions.messages({ sessionID: chat.id })
            expect(retained.flatMap((message) => message.parts.filter((part) => part.type === "tool"))).toEqual(
              receipts,
            )
            expect(retained.filter((message) => message.info.role === "user")).toHaveLength(2)
            expect(retained.filter((message) => message.info.role === "assistant")).toHaveLength(4)
          }
          return
        }
        expect(yield* fs.readFileString(file)).toBe(before)
        expect(receipts).toHaveLength(0)
        expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(1)
        if (result.info.error?.name !== "APIError") throw new Error("missing nonretryable error")
        expect(result.info.error.data.isRetryable).toBe(false)
        expect(SessionRetry.retryable(result.info.error)).toBeUndefined()
        if (scenario === "provider-error") {
          expect(result.info.error.data.message).toContain("Invalid schema supplied by caller")
          expect(result.info.error.data.message).not.toContain("[STRUCTURED_OUTPUT_UNAVAILABLE]")
          expect(yield* llm.calls).toBe(1)
          return
        }
        expect(result.info.error.data.message).toContain("[STRUCTURED_OUTPUT_UNAVAILABLE]")
        expect(result.info.error.data.message).toContain("StructuredOutput")
        expect(result.info.error.data.message).not.toContain("[STRUCTURED_OUTPUT_INCOMPLETE]")
        expect(result.info.structured).toBeUndefined()
        expect(yield* llm.calls).toBe(0)
      }),
    30_000,
  )
}

for (const scenario of ["absent", "user-tools-disabled", "side-request"]) {
  it.instance(
    `structured LLM preparation: ${scenario}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* setup
        const sessions = yield* Session.Service
        const service = yield* LLM.Service
        const provider = yield* Provider.Service
        const agents = yield* Agent.Service
        const agent = yield* agents.get("code")
        if (!agent) throw new Error("missing code agent")
        const chat = yield* sessions.create({ title: "Isolated request preparation regression" })
        const user: MessageV2.User = {
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "user",
          time: { created: Date.now() },
          agent: "code",
          model: ref,
          format: { type: "json_schema", schema, retryCount: 0 },
          tools: scenario === "user-tools-disabled" ? { StructuredOutput: false } : undefined,
        }
        const result = yield* service
          .stream({
            user,
            agent,
            sessionID: chat.id,
            model: yield* provider.getModel(ref.providerID, ref.modelID),
            permission: [...restricted, { permission: "StructuredOutput", pattern: "*", action: "allow" }],
            system: [],
            messages: [{ role: "user", content: "Return components: []." }],
            tools:
              scenario === "user-tools-disabled"
                ? {
                    StructuredOutput: createStructuredOutputTool({
                      schema,
                      onSuccess() {
                        throw new Error("disabled finalization tool executed")
                      },
                    }),
                  }
                : {},
            toolChoice: scenario === "side-request" ? undefined : "required",
          })
          .pipe(Stream.runDrain, Effect.exit)
        if (scenario === "side-request") {
          expect(Exit.isSuccess(result)).toBe(true)
          expect(yield* llm.calls).toBe(1)
          return
        }
        expect(Exit.isFailure(result)).toBe(true)
        if (!Exit.isFailure(result)) throw new Error("missing structured contract failure")
        const error = MessageV2.fromError(Cause.squash(result.cause), { providerID: ref.providerID })
        if (error.name !== "APIError") throw new Error("missing contract APIError")
        expect(error.data.message).toContain("[STRUCTURED_OUTPUT_UNAVAILABLE]")
        expect(error.data.isRetryable).toBe(false)
        expect(SessionRetry.retryable(error)).toBeUndefined()
        expect(yield* llm.calls).toBe(0)
      }),
    30_000,
  )
}
