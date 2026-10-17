import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Auth } from "../../../src/auth"
import { AuthStore } from "../../../src/kilocode/auth/store"
import { Effect, Layer, PlatformError } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

export const expired = () => ({
  type: "oauth" as const,
  access: "old-access",
  refresh: "old-refresh",
  expires: 0,
  accountId: "test-account",
})

export const tokens = () => ({
  id_token: "",
  access_token: "next-access",
  refresh_token: "next-refresh",
  expires_in: 3600,
})

export async function fixture(value?: Auth.Info, provider = "openai") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-auth-"))
  const file = path.join(dir, "auth.json")
  const store = AuthStore.create(file)
  if (value) await store.set(provider, value)
  return {
    dir,
    file,
    store,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

// Only the failing primitive is replaced; storage and CAS still use real files.
export async function fault(file: string, target: string, method: "write" | "rename") {
  let active = true
  const layer = Layer.effect(
    AppFileSystem.Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const fail = () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method,
            pathOrDescriptor: target,
            description: "fixture fault",
          }),
        )
      return {
        ...fs,
        rename: (from: string, to: string) =>
          active && method === "rename" && to === target ? fail() : fs.rename(from, to),
        writeFileString: (name: string, value: string, options?: Parameters<typeof fs.writeFileString>[2]) =>
          active && method === "write" && name.startsWith(`${target}.`) && name.endsWith(".tmp")
            ? fail()
            : fs.writeFileString(name, value, options),
      }
    }),
  ).pipe(Layer.provide(AppFileSystem.defaultLayer))
  const store = await Effect.runPromise(
    AuthStore.make(file).pipe(Effect.provide(Layer.mergeAll(layer, EffectFlock.defaultLayer))),
  )
  return {
    store,
    [Symbol.dispose]() {
      active = false
    },
  }
}
