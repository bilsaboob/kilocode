import { Effect, Schema } from "effect"
import * as ModelsDev from "@opencode-ai/core/models-dev"
import { AuthIO } from "./io"

// Only cached/bundled metadata. No ModelsDev service construction, plugins,
// provider/catalog requests, discovery, or credential rotation occurs here.
export function environment(provider: string) {
  return AuthIO.scope(AuthIO.current, async () => {
    const io = await AuthIO.pinned()
    const data = await Effect.runPromise(ModelsDev.local().pipe(Effect.provide(io.context)))
    const row = data[provider]
    if (!row || typeof row !== "object" || !("env" in row) || !("id" in row) || row.id !== provider) return undefined
    const names = Schema.decodeUnknownOption(Schema.Array(Schema.String))(row.env)
    if (names._tag === "None" || names.value.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) return undefined
    return names.value
  })
}
