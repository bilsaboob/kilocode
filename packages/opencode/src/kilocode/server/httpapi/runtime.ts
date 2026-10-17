import { KiloRuntime } from "@/kilocode/runtime/control"
import { KiloContextPolicy } from "@/kilocode/session/context-policy"
import { KiloCompactionBudget } from "@/kilocode/session/compaction-budget"
import { Runner } from "@/effect/runner"
import { Session } from "@/session/session"
import { SessionBusyError } from "@/server/routes/instance/httpapi/errors"
import { Cause, Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiEndpoint, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"

export namespace KiloRuntimeHttp {
  export const health = () =>
    Effect.sync(() => ({
      healthy: true as const,
      version: KiloRuntime.info.version,
      contextPolicy: KiloContextPolicy.configured(),
      runtime: KiloRuntime.info,
      compactionBudget: KiloCompactionBudget.settings(),
    }))
  export const Info = Schema.Struct({
    id: Schema.String,
    version: Schema.String,
    capabilities: Schema.Array(Schema.String),
  }).annotate({ identifier: "RuntimeInfo" })

  export const Budget = Schema.Struct({
    requests: Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(KiloCompactionBudget.bounds.requests),
    ),
    milliseconds: Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(KiloCompactionBudget.bounds.milliseconds),
    ),
  }).annotate({
    identifier: "CompactionBudgetSettings",
    description:
      "Validated process-start limits for newly admitted logical prompts; existing durable budgets stay frozen.",
  })

  export const Input = Schema.Struct({ runtimeID: Schema.String })
  export const Release = Schema.Struct({ runtimeID: Schema.String, token: Schema.String })
  export const Lease = Schema.Struct({
    runtimeID: Schema.String,
    token: Schema.String,
    expiresAt: Schema.Number,
  }).annotate({ identifier: "RuntimeLease" })

  export class Conflict extends Schema.ErrorClass<Conflict>("RuntimeConflict")(
    {
      name: Schema.Literal("RuntimeConflict"),
      reason: Schema.Literals(["active", "changed", "leased"]),
      message: Schema.String,
    },
    { httpApiStatus: 409 },
  ) {}

  export function guard<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return effect.pipe(
      Effect.catchCause((cause): Effect.Effect<never, E | Conflict> => {
        const error = Cause.squash(cause)
        if (error instanceof KiloRuntime.Conflict)
          return Effect.fail(new Conflict({ name: "RuntimeConflict", reason: error.reason, message: error.message }))
        return Effect.failCause(cause)
      }),
    )
  }

  export const endpoints = [
    HttpApiEndpoint.post("quiesce", "/global/quiesce", {
      payload: Input,
      success: Lease,
      error: Conflict,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "global.quiesce", summary: "Reserve an idle runtime for restart" }),
    ),
    HttpApiEndpoint.delete("releaseQuiescence", "/global/quiesce", {
      payload: Release,
      success: Schema.Boolean,
      error: Conflict,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "global.releaseQuiescence", summary: "Release a runtime restart reservation" }),
    ),
  ] as const

  export const quiesce = (ctx: { payload: typeof Input.Type }) =>
    guard(Effect.sync(() => KiloRuntime.quiesce(ctx.payload.runtimeID)))
  export const release = (ctx: { payload: typeof Release.Type }) =>
    guard(Effect.sync(() => KiloRuntime.release(ctx.payload.runtimeID, ctx.payload.token)))

  export class Admission extends HttpApiMiddleware.Service<Admission>()("@kilocode/RuntimeAdmission", {
    error: [Conflict, SessionBusyError],
  }) {}

  function session<A, E, R>(effect: Effect.Effect<A, E, R>, path: string) {
    return effect.pipe(
      Effect.catchCause((cause): Effect.Effect<never, E | SessionBusyError> => {
        const error = Cause.squash(cause)
        if (error instanceof Session.BusyError || error instanceof Runner.Busy)
          return Effect.fail(
            new SessionBusyError({
              sessionID: /\/session\/([^/]+)/.exec(path)?.[1] ?? "",
              message: "Session is busy or settling; manual compaction requires exclusive ownership",
            }),
          )
        return Effect.failCause(cause)
      }),
    )
  }

  export const layer = Layer.succeed(
    Admission,
    Admission.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const path = new URL(request.url, "http://localhost").pathname
        const passive =
          request.method === "GET" ||
          request.method === "HEAD" ||
          request.method === "OPTIONS" ||
          path === "/global/quiesce" ||
          /\/(abort|cancel|stop)$/.test(path)
        return yield* session(guard(passive ? effect : KiloRuntime.work(effect)), path)
      }),
    ),
  )
}
