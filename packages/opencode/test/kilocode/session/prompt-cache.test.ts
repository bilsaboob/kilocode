import { describe, expect, test } from "bun:test"
import { KiloPromptCache } from "@/kilocode/session/prompt-cache"
import { ModelID } from "@/provider/schema"
import { ProviderTest } from "../../fake/provider"

const options = () => ({
  promptCacheRetention: "24h",
  promptCacheKey: "session-cache",
  promptCacheBreakpoint: true,
  reasoningEffort: "high",
})

describe("kilocode.session.prompt-cache", () => {
  test("removes retention for aliases resolving to GPT-5.6 Sol without mutating input", () => {
    const model = ProviderTest.model({
      id: ModelID.make("sol-alias"),
      api: { id: "gpt-5.6-sol", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
      variants: { high: { reasoningEffort: "high" } },
    })
    const input = options()
    const result = KiloPromptCache.sanitize(model, input)

    expect(result).toEqual({
      promptCacheKey: "session-cache",
      promptCacheBreakpoint: true,
      reasoningEffort: "high",
    })
    expect(result).not.toBe(input)
    expect(input).toEqual(options())
  })

  test("keeps retention for unrelated OpenAI models", () => {
    const input = options()
    const result = KiloPromptCache.sanitize(
      ProviderTest.model({
        api: { id: "gpt-5.5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
      }),
      input,
    )

    expect(result).toBe(input)
    expect(result.promptCacheRetention).toBe("24h")
  })

  test.each([
    ["OpenAI-compatible", "@ai-sdk/openai-compatible"],
    ["AI SDK gateway", "@ai-sdk/gateway"],
    ["Kilo gateway", "@kilocode/kilo-gateway"],
  ])("keeps retention for %s providers", (_name, npm) => {
    const input = options()
    const result = KiloPromptCache.sanitize(
      ProviderTest.model({
        api: { id: "gpt-5.6-sol", url: "https://example.com/v1", npm },
      }),
      input,
    )

    expect(result).toBe(input)
    expect(result).toEqual(options())
  })
})
