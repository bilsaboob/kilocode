import { expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLM, tool } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as Responses from "../../src/protocols/openai-responses"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"
import { it } from "../lib/effect"

const request = LLM.request({
  model: Responses.route
    .with({ endpoint: { baseURL: "https://fixture.invalid/v1/" }, auth: Auth.bearer("fake-only") })
    .model({ id: "fixture" }),
  prompt: "fixture",
})

for (const scenario of [
  "completed",
  "unknown-after-tool",
  "missing-reason",
  "null-reason",
  "failed",
  "zero",
  "absent",
  "eof",
  "done-only",
  "malformed",
]) {
  it.effect(`native response receipt: ${scenario}`, () =>
    Effect.gen(function* () {
      const incomplete = ["unknown-after-tool", "missing-reason", "null-reason", "zero", "absent"].includes(scenario)
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              ...(scenario === "malformed" ? [] : [{ type: "response.created", response: { id: "resp_native" } }]),
              ...(scenario === "unknown-after-tool"
                ? [
                    {
                      type: "response.output_item.added",
                      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read" },
                    },
                    { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{}" },
                  ]
                : []),
              ...(scenario === "eof"
                ? []
                : scenario === "done-only"
                  ? [{ type: "response.done" }]
                  : [
                      {
                        type:
                          scenario === "failed"
                            ? "response.failed"
                            : incomplete
                              ? "response.incomplete"
                              : "response.completed",
                        response:
                          scenario === "malformed"
                            ? undefined
                            : {
                                ...(scenario === "malformed" ? {} : { id: "resp_native" }),
                                incomplete_details:
                                  scenario === "unknown-after-tool"
                                    ? { reason: "unknown_provider_reason" }
                                    : scenario === "missing-reason"
                                      ? {}
                                      : null,
                                ...(scenario === "failed"
                                  ? { error: { code: "server_error", message: "Upstream rate limit" } }
                                  : {}),
                                usage:
                                  scenario === "absent"
                                    ? null
                                    : {
                                        input_tokens: scenario === "zero" ? 0 : 100,
                                        output_tokens: scenario === "zero" ? 0 : 30,
                                        input_tokens_details: { cached_tokens: 20 },
                                        output_tokens_details: { reasoning_tokens: 10 },
                                      },
                                output: [{ encrypted_content: "private-reasoning", content: "private-prompt" }],
                              },
                      },
                    ]),
            ),
          ),
        ),
      )
      const errors = response.events.filter((event) => event.type === "provider-error")
      const steps = response.events.filter((event) => event.type === "step-finish")
      const metadata = response.events.flatMap((event) => ("providerMetadata" in event ? [event.providerMetadata] : []))
      expect(JSON.stringify(metadata)).not.toContain("private-reasoning")
      expect(JSON.stringify(metadata)).not.toContain("private-prompt")
      if (scenario !== "malformed")
        expect(metadata[0]?.kiloResponse).toMatchObject({ status: "created", responseID: "resp_native" })
      if (scenario === "completed") {
        expect(errors).toHaveLength(0)
        expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
      } else {
        expect(errors).toHaveLength(1)
        expect(errors[0].retryable).toBe(false)
        expect(errors[0].message).toContain(
          scenario === "failed"
            ? "[RESPONSE_FAILED]"
            : incomplete
              ? "[RESPONSE_INCOMPLETE]"
              : "[RESPONSE_TERMINAL_MISSING]",
        )
        expect(response.events.some((event) => event.type === "finish")).toBe(false)
        expect(steps.some((event) => event.reason === "tool-calls" || event.reason === "stop")).toBe(false)
      }
      if (["eof", "done-only"].includes(scenario)) expect(steps).toHaveLength(0)
      else {
        expect(steps).toHaveLength(1)
        if (scenario === "absent" || scenario === "malformed") expect(steps[0].usage).toBeUndefined()
        else expect(steps[0].usage?.inputTokens).toBe(scenario === "zero" ? 0 : 100)
      }
    }),
  )
}

it.effect("native failed tool response has one terminal and never dispatches or replays the tool", () =>
  Effect.gen(function* () {
    let executions = 0
    const read = tool({
      description: "Read an isolated fixture",
      parameters: Schema.Struct({}),
      success: Schema.String,
      execute: () =>
        Effect.sync(() => {
          executions++
          return "receipt"
        }),
    })
    const events = yield* LLM.stream({ request, tools: { read } }).pipe(
      Stream.runCollect,
      Effect.provide(
        fixedResponse(
          sseEvents(
            {
              type: "response.output_item.added",
              item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read" },
            },
            { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{}" },
            {
              type: "response.incomplete",
              response: {
                id: "resp_native",
                incomplete_details: { reason: "unknown" },
                usage: { input_tokens: 5, output_tokens: 3 },
              },
            },
          ),
        ),
      ),
    )
    expect(executions).toBe(0)
    expect(events.filter((event) => event.type === "provider-error")).toHaveLength(1)
    expect(events.some((event) => event.type === "finish")).toBe(false)
    expect(events.filter((event) => event.type === "step-finish")).toHaveLength(1)
  }),
)

it.effect("native created ID is available before cancellation without consuming a terminal", () =>
  Effect.gen(function* () {
    const events = yield* LLMClient.stream(request).pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.provide(
        fixedResponse(
          sseEvents(
            { type: "response.created", response: { id: "resp_early" } },
            {
              type: "response.completed",
              response: { id: "resp_early", usage: { input_tokens: 10, output_tokens: 3 } },
            },
          ),
        ),
      ),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "text-delta",
      text: "",
      providerMetadata: { kiloResponse: { status: "created", responseID: "resp_early" } },
    })
  }),
)
