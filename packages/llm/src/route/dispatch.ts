// kilocode_change - new file
// kilocode_change - generic request-bound dispatch barrier; no session/auth dependencies
// kilocode_change - per-attempt authority and resource fencing without session policy in the transport
import { Context, Effect } from "effect"
import type { Headers } from "effect/unstable/http"

export const Dispatch = Context.Reference<
  (input: {
    transport: "http" | "websocket"
    phase?: "open" | "send"
    url: string
    headers: Headers.Headers
  }) => Effect.Effect<Headers.Headers>
>("@opencode/LLM/Dispatch", { defaultValue: () => (input) => Effect.succeed(input.headers) })
