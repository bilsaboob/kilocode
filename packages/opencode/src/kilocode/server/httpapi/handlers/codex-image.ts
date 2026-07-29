import { Auth } from "@/auth"
import {
  CodexImageGenerationError,
  CodexImageRequest,
  generateCodexImage,
  type CodexImageFetch,
} from "@/kilocode/image-generation"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CodexImageApiError } from "../groups/codex-image"

export const codexImageHandlers = HttpApiBuilder.group(InstanceHttpApi, "codex-image", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const provider = yield* Provider.Service

    const generate = Effect.fn("CodexImageHttpApi.generate")(function* (ctx: {
      payload: typeof CodexImageRequest.Type
    }) {
      const credentials = yield* auth
        .get("openai")
        .pipe(Effect.mapError(() => new CodexImageApiError({ message: "Unable to read OpenAI authentication." })))
      if (!credentials || credentials.type !== "oauth") {
        return yield* new CodexImageApiError({
          message: "ChatGPT/Codex OAuth authentication is required for image generation.",
        })
      }

      const info = yield* provider
        .getProvider(ProviderID.make("openai"))
        .pipe(Effect.mapError(() => new CodexImageApiError({ message: "The OpenAI provider is unavailable." })))
      const fetcher = info?.options?.fetch
      if (typeof fetcher !== "function") {
        return yield* new CodexImageApiError({
          message: "The connected OpenAI provider does not expose Codex OAuth transport.",
        })
      }

      return yield* Effect.tryPromise({
        try: (signal) => generateCodexImage(fetcher as CodexImageFetch, ctx.payload, signal),
        catch: (cause) =>
          new CodexImageApiError({
            message:
              cause instanceof CodexImageGenerationError
                ? `Upstream HTTP ${cause.status}: ${cause.message}`
                : cause instanceof Error
                  ? cause.message
                  : String(cause),
          }),
      })
    })

    return handlers.handle("generate", generate)
  }),
)
