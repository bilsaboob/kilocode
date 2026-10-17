import { Context, Effect, Exit, Fiber, Latch, Scope } from "effect"
import { KiloRuntime } from "@/kilocode/runtime/control"

export namespace KiloRunner {
  const Owner = Context.Reference<object | undefined>("@kilocode/RunnerOwner", { defaultValue: () => undefined })
  type Cell = { preparing: number; executing: number; closing: number; exclusive: boolean; owner: object; refs: number }
  const cells = new Map<string, Cell>()
  export const start = <A, E, R>(input: {
    work: Effect.Effect<A, E>
    scope: Scope.Scope
    finish: (exit: Exit.Exit<A, E>, settled: () => void) => Effect.Effect<void>
    handle: (fiber: Fiber.Fiber<A, E>) => R
    acquire?: () => () => void
    child?: boolean
  }) =>
    Effect.gen(function* () {
      const release = input.acquire?.() ?? KiloRuntime.enter()
      let held = true
      const settled = () => {
        if (!held) return
        held = false
        release()
      }
      const ready = yield* Latch.make()
      const work = ready.whenOpen(input.work).pipe(
        Effect.interruptible,
        Effect.onExit((exit) => input.finish(exit, settled)),
        Effect.ensuring(Effect.sync(settled)),
      )
      const fiber = yield* input.child ? Effect.forkChild(work) : Effect.forkIn(work, input.scope)
      return { run: input.handle(fiber), ready }
    }).pipe(Effect.uninterruptible)

  export function ownership<E>(busy: () => E, key?: string) {
    const state: Cell = (key === undefined ? undefined : cells.get(key)) ?? {
      preparing: 0,
      executing: 0,
      closing: 0,
      exclusive: false,
      owner: {},
      refs: 0,
    }
    if (key !== undefined) cells.set(key, state)
    state.refs++
    let closed = false
    let retired = false
    const prune = () => {
      if (
        key !== undefined &&
        state.refs === 0 &&
        state.preparing === 0 &&
        state.executing === 0 &&
        state.closing === 0 &&
        cells.get(key) === state
      )
        cells.delete(key)
    }
    const fibers = new Map<Fiber.Fiber<unknown, unknown>, number>()
    // Cancellation remains local to this runner; only the session ownership cell spans instances.
    const cancel = (work: Effect.Effect<void>) =>
      Effect.withFiber((caller) =>
        Effect.suspend(() => {
          state.closing++
          const targets = [...fibers.keys()].filter((fiber) => fiber !== caller)
          return Effect.all([work, ...targets.map(Fiber.interrupt)], { concurrency: "unbounded", discard: true }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                state.closing--
                prune()
              }),
            ),
          )
        }),
      ).pipe(Effect.uninterruptible)
    return {
      get busy() {
        return closed || state.preparing !== 0 || state.executing !== 0 || state.closing !== 0
      },
      get exclusive() {
        return closed || state.exclusive
      },
      acquire(only = false) {
        if (closed || state.exclusive) throw busy()
        const release = KiloRuntime.enter()
        state.executing++
        if (only) state.exclusive = true
        return () => {
          state.executing--
          if (only) state.exclusive = false
          release()
          prune()
        }
      },
      work<A, E2, R>(work: Effect.Effect<A, E2, R>) {
        return work.pipe(Effect.provideService(Owner, state.owner))
      },
      cancel,
      dispose(work: Effect.Effect<void>) {
        return Effect.sync(() => {
          closed = true
        }).pipe(
          Effect.andThen(cancel(work)),
          Effect.ensuring(
            Effect.sync(() => {
              if (retired) return
              retired = true
              state.refs--
              prune()
            }),
          ),
          Effect.uninterruptible,
        )
      },
      admit<A, E2, R>(work: Effect.Effect<A, E2, R>) {
        return KiloRuntime.work(
          Effect.acquireUseRelease(
            Effect.withFiber((fiber) => {
              const current = Context.getReferenceUnsafe(fiber.context, Owner)
              if (closed || state.closing || (state.exclusive && current !== state.owner)) return Effect.fail(busy())
              state.preparing++
              fibers.set(fiber, (fibers.get(fiber) ?? 0) + 1)
              return Effect.succeed(fiber)
            }),
            () => work.pipe(Effect.provideService(Owner, state.owner)),
            (fiber) =>
              Effect.sync(() => {
                state.preparing--
                const count = fibers.get(fiber)! - 1
                if (count === 0) fibers.delete(fiber)
                else fibers.set(fiber, count)
                prune()
              }),
          ),
        )
      },
    }
  }

  export const open = <A, E, R>(ready: Latch.Latch, work: Effect.Effect<A, E, R>) =>
    ready.open.pipe(Effect.uninterruptible, Effect.andThen(work))

  export const commit = <A, E, R>(start: Effect.Effect<{ run: R; ready: Latch.Latch }>, after: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const started = yield* start
      return [open(started.ready, after), { _tag: "Running", run: started.run } as const] as const
    })
}
