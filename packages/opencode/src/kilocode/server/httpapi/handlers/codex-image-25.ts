import { Auth } from "@/auth"
import { CodexImage25Error, generateCodexImage25 } from "@/kilocode/image-generation-25"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CodexImage25RequestError, CodexImage25UpstreamError } from "../groups/codex-image-25"

export const codexImage25Handlers = HttpApiBuilder.group(InstanceHttpApi, "codex-image-25", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const provider = yield* Provider.Service

    return handlers.handle("generate", (ctx) =>
      Effect.gen(function* () {
        const credentials = yield* auth
          .get("openai")
          .pipe(
            Effect.mapError(() => new CodexImage25RequestError({ message: "Unable to read OpenAI authentication." })),
          )
        if (!credentials || credentials.type !== "oauth")
          return yield* new CodexImage25RequestError({
            message: "ChatGPT/Codex OAuth authentication is required for this experiment.",
          })

        const info = yield* provider
          .getProvider(ProviderID.make("openai"))
          .pipe(Effect.mapError(() => new CodexImage25RequestError({ message: "The OpenAI provider is unavailable." })))
        const fetcher = info?.options?.fetch
        if (typeof fetcher !== "function")
          return yield* new CodexImage25RequestError({
            message: "The OpenAI provider does not expose Codex OAuth transport.",
          })

        return yield* Effect.tryPromise({
          try: (signal) => generateCodexImage25(fetcher, ctx.payload, signal),
          catch: (cause) => {
            const message = cause instanceof Error ? cause.message : String(cause)
            if (cause instanceof CodexImage25Error && cause.status === 400 && !cause.diagnostics)
              return new CodexImage25RequestError({ message })
            return new CodexImage25UpstreamError({
              message,
              upstreamStatus: cause instanceof CodexImage25Error ? cause.diagnostics?.upstreamStatus : undefined,
              diagnostics: cause instanceof CodexImage25Error ? cause.diagnostics : undefined,
            })
          },
        })
      }),
    )
  }),
)
