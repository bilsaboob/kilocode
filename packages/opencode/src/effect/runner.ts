import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"
import { KiloRunner } from "@/kilocode/effect/runner" // kilocode_change

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  // kilocode_change start - use the same runner for preparation and manual compaction ownership
  readonly admit: <B, E2, R>(work: Effect.Effect<B, E2, R>) => Effect.Effect<B, E2 | Busy, R>
  readonly startExclusive: (work: Effect.Effect<A, E>) => Effect.Effect<A, E | Busy>
  // kilocode_change end
  readonly cancel: Effect.Effect<void>
  readonly dispose: Effect.Effect<void> // kilocode_change - retire a scoped ownership reference
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
    pending?: () => boolean // kilocode_change - include queued recovery in exclusive admission
    key?: string // kilocode_change - one ownership cell per session across instances
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  const ownership = KiloRunner.ownership(() => new Busy(), opts?.key) // kilocode_change
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  // kilocode_change start - settle ownership before publishing completion to waiters
  const finishRun = (
    id: number,
    done: Deferred.Deferred<A, E | Cancelled>,
    exit: Exit.Exit<A, E>,
    settled: () => void, // kilocode_change
  ) =>
    SynchronizedRef.modify(
      ref,
      (st) =>
        [
          Effect.gen(function* () {
            if (st._tag === "Running" && st.run.id === id) yield* idle
            yield* Effect.sync(settled) // kilocode_change - finalizers finish before publishing completion
            yield* complete(done, exit)
          }),
          st._tag === "Running" && st.run.id === id ? ({ _tag: "Idle" } as const) : st,
        ] as const,
    ).pipe(Effect.flatten)

  // kilocode_change end

  // kilocode_change start - do not let work publish busy before the Running state is committed
  const startRun = (work: Effect.Effect<A, E>, done: Deferred.Deferred<A, E | Cancelled>) => {
    const id = next()
    return KiloRunner.start({
      work: ownership.work(work), // kilocode_change
      scope,
      finish: (exit, settled) => finishRun(id, done, exit, settled),
      handle: (fiber) => ({ id, done, fiber }) satisfies RunHandle<A, E>,
      acquire: () => ownership.acquire(),
    })
  }
  // kilocode_change end

  // kilocode_change start - open work only after the Running state is committed
  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          return yield* KiloRunner.commit(startRun(st.run.work, st.run.done), Effect.void)
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)
  // kilocode_change end

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  // kilocode_change start - open work only after the Running state is committed
  const ensureRunning = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (ownership.exclusive) return [Effect.die(new Busy()), st] as const
        switch (st._tag) {
          case "Running":
          case "ShellThenRun":
            return [awaitDone(st.run.done), st] as const
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            return yield* KiloRunner.commit(startRun(work, done), awaitDone(done))
          }
        }
      }),
    ).pipe(Effect.flatten)

  const startShell = (
    work: Effect.Effect<A, E>,
    ready?: Latch.Latch,
    exclusive = false,
  ): Effect.Effect<A, E | Busy> => // kilocode_change
    SynchronizedRef.modifyEffect(
      ref,
      // kilocode_change end
      Effect.fnUntraced(function* (st) {
        // kilocode_change start - admission includes shared ownership and pending recovery.
        if (st._tag !== "Idle" || ownership.busy || opts?.pending?.()) {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        // kilocode_change end
        // kilocode_change start - reserve actual execution before forking; publish only after state commit
        const release = ownership.acquire(exclusive)
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const started = yield* KiloRunner.start({
          work: onBusy.pipe(Effect.andThen(ownership.work(work))),
          scope,
          child: !exclusive,
          acquire: () => release,
          finish: () => finishShell(id),
          handle: (fiber) => ({ id, cancelled, ready, fiber }) satisfies ShellHandle<A, E>,
        })
        const shell = started.run
        const fiber = shell.fiber
        return [
          Effect.gen(function* () {
            // kilocode_change end
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }).pipe((wait) => KiloRunner.open(started.ready, wait)), // kilocode_change
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.uninterruptible, Effect.flatten) // kilocode_change - claim and fork cannot be interrupted apart

  const cancel = SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "ShellThenRun":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
    }
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle" || ownership.busy || Boolean(opts?.pending?.()) // kilocode_change
    },
    ensureRunning,
    startShell,
    admit: ownership.admit, // kilocode_change
    startExclusive: (work) => startShell(work, undefined, true), // kilocode_change
    cancel: ownership.cancel(cancel), // kilocode_change - abort admitted preparation and detached helpers too
    dispose: ownership.dispose(cancel), // kilocode_change
  }
}

export * as Runner from "./runner"
