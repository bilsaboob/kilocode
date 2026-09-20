import type { Provider } from "@/provider/provider"

const unsupported = new Set(["gpt-5.6-sol"])

export namespace KiloPromptCache {
  export function sanitize(model: Provider.Model, options: Record<string, unknown>) {
    if (model.api.npm !== "@ai-sdk/openai") return options
    if (!unsupported.has(model.api.id.toLowerCase())) return options
    if (!Object.hasOwn(options, "promptCacheRetention")) return options

    const result = { ...options }
    delete result["promptCacheRetention"]
    return result
  }
}
