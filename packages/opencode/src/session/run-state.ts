import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { KiloRuntime } from "@/kilocode/runtime/control" // kilocode_change
import { KiloSessionRecovery } from "@/kilocode/session/recovery" // kilocode_change

export interface Interface {
  // kilocode_change start
  readonly admit: <A, E, R>(
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Session.BusyError, R>
  readonly startExclusive: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
  // kilocode_change end
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            // kilocode_change start - invalidate delayed recovery before disposing its owning instance
            yield* Effect.forEach(
              runners,
              ([id, runner]) => Effect.sync(() => KiloSessionRecovery.reset(id)).pipe(Effect.andThen(runner.dispose)),
              {
                concurrency: "unbounded",
                discard: true,
              },
            )
            // kilocode_change end
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        key: sessionID, // kilocode_change - directory changes must not bypass session ownership
        pending: () => KiloSessionRecovery.pending(sessionID), // kilocode_change
        onIdle: Effect.gen(function* () {
          // kilocode_change - keep a stable ownership lock through waiter interruption and settling finalizers
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* Effect.sync(() => KiloSessionRecovery.reset(sessionID)) // kilocode_change
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing || !existing.busy) {
        yield* status.set(sessionID, { type: "idle" })
        yield* cancelBackgroundJobs(background, sessionID) // kilocode_change
        return
      }
      // kilocode_change start - Stop includes detached background owners.
      yield* Effect.all([existing.cancel, cancelBackgroundJobs(background, sessionID)], {
        concurrency: "unbounded",
        discard: true,
      }) // kilocode_change
      // kilocode_change end
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* KiloRuntime.work((yield* runner(sessionID, onInterrupt)).ensureRunning(work)) // kilocode_change
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    // kilocode_change start
    const admit: Interface["admit"] = (sessionID, onInterrupt, work) =>
      KiloRuntime.work(
        Effect.gen(function* () {
          return yield* (yield* runner(sessionID, onInterrupt))
            .admit(work)
            .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
        }),
      )
    const startExclusive: Interface["startExclusive"] = (sessionID, onInterrupt, work) =>
      KiloRuntime.work(
        Effect.gen(function* () {
          if ((yield* status.get(sessionID)).type !== "idle") return yield* busyError(sessionID)
          return yield* (yield* runner(sessionID, onInterrupt))
            .startExclusive(work)
            .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
        }),
      )
    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell, admit, startExclusive })
    // kilocode_change end
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
