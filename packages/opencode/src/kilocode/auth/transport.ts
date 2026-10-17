import { Cause, Effect, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { RequestExecutor } from "@opencode-ai/llm/route"
import type { Tool } from "ai"
import type { AuthRequest } from "./request"
import { AuthOutcome } from "./outcome"

export namespace AuthTransport {
  export function tools(tools: Record<string, Tool>, guard: AuthRequest.Guard) {
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [
        name,
        !tool.execute
          ? tool
          : {
              ...tool,
              execute: async (...args: Parameters<NonNullable<Tool["execute"]>>) => {
                await guard.check()
                return tool.execute!(...args)
              },
            },
      ]),
    )
  }

  export function native(guard: AuthRequest.Guard, fetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        try {
          return await guard.forward(fetch, request, init)
        } catch (error) {
          if (AuthOutcome.control(error) || !guard.error()) throw error
          // The native executor wraps fetch failures as retryable transport errors.
          // A local nonretryable sentinel crosses that boundary; stream restores
          // the original typed failure, without a dependency in the LLM package.
          return new Response(null, { status: 401 })
        }
      },
      { preconnect: globalThis.fetch.preconnect },
    )
  }

  export function stream<A, E, R>(stream: Stream.Stream<A, E, R>, guard: AuthRequest.Guard) {
    const stop = Effect.callback<never, unknown>((resume) => {
      const abort = () => resume(Effect.fail(guard.error() ?? guard.signal.reason))
      if (guard.signal.aborted) {
        abort()
        return Effect.void
      }
      guard.signal.addEventListener("abort", abort, { once: true })
      return Effect.sync(() => guard.signal.removeEventListener("abort", abort))
    })
    return stream.pipe(
      Stream.provideService(RequestExecutor.Dispatch, (input) =>
        Effect.promise(async () => {
          const headers = Headers.fromInput(await guard.headers(input.headers))
          if (input.transport === "websocket" && guard.expected.kind === "oauth") return guard.deny("source-unmanaged")
          if (input.transport === "websocket" && input.phase === "send") await guard.send()
          return headers
        }),
      ),
      Stream.tap(() => (guard.error() ? Effect.fail(guard.error()) : Effect.void)),
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Stream.failCause(cause) : Stream.fail(guard.error() ?? Cause.squash(cause)),
      ),
      Stream.merge(Stream.fromEffect(stop), { haltStrategy: "either" }),
    )
  }
}
