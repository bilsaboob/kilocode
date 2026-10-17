import { expect } from "bun:test"
import { Cause, Effect, Fiber, Layer } from "effect"
import type { AuthOAuthResult } from "@kilocode/plugin"
import { Hash } from "@opencode-ai/core/util/hash"
import { Auth } from "../../src/auth"
import { ProviderAuth } from "../../src/provider/auth"
import { ProviderID } from "../../src/provider/schema"
import { Plugin } from "../../src/plugin"
import { ModelCache } from "../../src/provider/model-cache"
import { InstanceState } from "../../src/effect/instance-state"
import { AuthStore } from "../../src/kilocode/auth/store"
import { testEffect } from "../lib/effect"
import { expired } from "./fixture/auth-store"

const controls = new Map<string, () => Promise<AuthOAuthResult>>()
const id = Effect.map(InstanceState.context, (ctx) => ProviderID.make(`auth-callback-${Hash.fast(ctx.directory)}`))
const plugin = Layer.mock(Plugin.Service, {
  list: () =>
    Effect.gen(function* () {
      const provider = yield* id
      return [
        {
          auth: {
            provider,
            methods: [0, 1].map((index) => ({
              type: "oauth" as const,
              label: `fixture-${index}`,
              authorize: () => controls.get(provider)!(),
            })),
          },
        },
      ]
    }),
})
const layer = ProviderAuth.layer.pipe(
  Layer.provide(
    Layer.mergeAll(plugin, Auth.defaultLayer, Layer.mock(ModelCache.Service, { clear: () => Effect.void })),
  ),
)
const it = testEffect(layer)

it.instance(
  "reordered authorize completion cannot replace newest attempt, and IDs/methods are checked before exchange",
  () =>
    Effect.gen(function* () {
      const providerID = yield* id
      const auth = yield* ProviderAuth.Service
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<AuthOAuthResult>()
      let starts = 0
      let callbacks = 0
      const ready: AuthOAuthResult = {
        url: "http://127.0.0.1/fixture",
        instructions: "fixture",
        method: "auto",
        callback: async () => {
          callbacks++
          return { type: "success", key: "newest" }
        },
      }
      controls.set(providerID, async () => {
        if (++starts === 1) {
          entered.resolve()
          return release.promise
        }
        return ready
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          controls.delete(providerID)
          await AuthStore.disk.remove(providerID)
        }),
      )
      const before = yield* Effect.promise(() => AuthStore.disk.snapshot(providerID))
      const first = yield* auth.authorize({ providerID, method: 0 }).pipe(Effect.exit, Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      const second = yield* auth.authorize({ providerID, method: 0 })
      expect(second?.attemptID).toBeTypeOf("string")
      const during = yield* Effect.promise(() => AuthStore.disk.snapshot(providerID))
      expect(during.loginGeneration).toBe(before.loginGeneration)
      expect(during.tokenRevision).toBe(before.tokenRevision)
      release.resolve(ready)
      expect((yield* Fiber.join(first))._tag).toBe("Failure")
      for (const input of [
        { providerID, method: 0 },
        { providerID, method: 1, attemptID: second!.attemptID },
      ]) {
        const result = yield* auth.callback(input).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(Cause.squash(result.cause)).toBeInstanceOf(ProviderAuth.OauthMissing)
      }
      expect(callbacks).toBe(0)
      yield* auth.callback({ providerID, method: 0, attemptID: second!.attemptID })
      const duplicate = yield* auth.callback({ providerID, method: 0, attemptID: second!.attemptID }).pipe(Effect.exit)
      expect(duplicate._tag).toBe("Failure")
      expect(callbacks).toBe(1)
      expect((yield* Effect.promise(() => AuthStore.disk.all()))[providerID]).toEqual({ type: "api", key: "newest" })
    }),
)

for (const change of ["logout", "relogin", "renewal"] as const) {
  it.instance(`actual auth callback remains fenced across ${change}`, () =>
    Effect.gen(function* () {
      const providerID = yield* id
      const auth = yield* ProviderAuth.Service
      yield* Effect.promise(() => AuthStore.disk.set(providerID, expired()))
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      controls.set(providerID, async () => ({
        url: "http://127.0.0.1/fixture",
        instructions: "fixture",
        method: "code",
        callback: async () => {
          entered.resolve()
          await release.promise
          return { type: "success", key: "authorized" }
        },
      }))
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          controls.delete(providerID)
          await AuthStore.disk.remove(providerID)
        }),
      )
      const pending = yield* auth.authorize({ providerID, method: 0 })
      const callback = yield* auth
        .callback({ providerID, method: 0, attemptID: pending!.attemptID, code: "fixture-code" })
        .pipe(Effect.exit, Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      if (change === "logout" || change === "relogin") yield* Effect.promise(() => AuthStore.disk.remove(providerID))
      if (change === "relogin") yield* Effect.promise(() => AuthStore.disk.set(providerID, expired()))
      if (change === "renewal")
        yield* Effect.promise(async () =>
          AuthStore.disk.commit(await AuthStore.disk.snapshot(providerID), { ...expired(), access: "rotated" }),
        )
      const expected = yield* Effect.promise(() => AuthStore.disk.all())
      release.resolve()
      const result = yield* Fiber.join(callback)
      if (change === "renewal") {
        expect(result._tag).toBe("Success")
        expect((yield* Effect.promise(() => AuthStore.disk.all()))[providerID]).toEqual({
          type: "api",
          key: "authorized",
        })
      } else {
        expect(result._tag).toBe("Failure")
        expect(yield* Effect.promise(() => AuthStore.disk.all())).toEqual(expected)
      }
    }),
  )
}
