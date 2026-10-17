import { Context, Effect, Layer } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { WorkspaceRouteContext } from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { AuthOutcome } from "@/kilocode/auth/outcome"
import type { KiloAuth } from "@/kilocode/auth/authority"
import { KiloRuntime } from "@/kilocode/runtime/control"

class Ready extends Context.Service<Ready, boolean>()("@kilocode/PassiveInstanceReady") {}

export class PassiveInstance extends HttpApiMiddleware.Service<
  PassiveInstance,
  {
    requires: WorkspaceRouteContext
    provides: Ready
  }
>()("@kilocode/PassiveInstance") {}

export const layer = Layer.effect(
  PassiveInstance,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return PassiveInstance.of((effect) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        const directory = yield* Effect.try({
          try: () => decodeURIComponent(route.directory),
          catch: () => route.directory,
        }).pipe(Effect.catch((value) => Effect.succeed(value)))
        const ctx = yield* store.peek(directory)
        return yield* effect.pipe(
          Effect.provideService(Ready, ctx !== undefined),
          Effect.provideService(InstanceRef, ctx),
          Effect.provideService(WorkspaceRef, route.workspaceID),
        )
      }),
    )
  }),
)

export function readiness<E, R>(
  input: { providerID: string; modelID?: string },
  inspect: Effect.Effect<KiloAuth.Readiness, E, R>,
) {
  return Effect.gen(function* () {
    if (yield* Ready) return yield* inspect
    const detail = AuthOutcome.detail("unverifiable")
    return {
      providerID: input.providerID,
      modelID: input.modelID,
      state: detail.state,
      source: "unknown",
      reason: "unverifiable",
      action: detail.action,
      runtimeID: KiloRuntime.info.id,
      observedAt: Math.floor(performance.timeOrigin + performance.now()),
      validation: "local",
      disruption: "none",
    } satisfies KiloAuth.Readiness
  })
}
