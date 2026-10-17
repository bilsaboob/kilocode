import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { KiloRuntime } from "@/kilocode/runtime/control"
import { KiloSessionRecovery } from "@/kilocode/session/recovery"
import { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { BackgroundJob } from "@/background/job"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/kilocode/instance"
import { it, pollWithTimeout, testEffect } from "../lib/effect"

let observed: SessionStatus.Info = { type: "idle" }
const state = testEffect(
  SessionRunState.layer.pipe(
    Layer.provide([
      Layer.mock(BackgroundJob.Service)({ list: () => Effect.succeed([]) }),
      Layer.mock(SessionStatus.Service)({ get: () => Effect.sync(() => observed), set: () => Effect.void }),
    ]),
    Layer.provideMerge(
      Layer.succeed(InstanceRef, {
        directory: "runtime-fixture",
        worktree: "runtime-fixture",
        project: {},
      } as InstanceContext),
    ),
  ),
)

describe("process runtime admission", () => {
  it.live(
    "session ownership spans runners without cross-instance cancellation or stale-lock reuse",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const key = "ses_runtime_shared_owner"
      const first = Runner.make<string>(scope, { key })
      const second = Runner.make<string>(scope, { key })
      yield* Effect.addFinalizer(() => first.dispose)
      yield* Effect.addFinalizer(() => second.dispose)
      const entered = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const preparing = yield* second
        .admit(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect(Exit.isFailure(yield* first.startExclusive(Effect.succeed("wrong")).pipe(Effect.exit))).toBe(true)
      yield* first.dispose
      expect(second.busy).toBe(true)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(preparing)
      yield* second.dispose
      let writes = 0
      expect(
        Exit.isFailure(
          yield* first
            .admit(
              Effect.sync(() => {
                writes++
              }),
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(writes).toBe(0)
      const fresh = Runner.make<string>(scope, { key })
      yield* Effect.addFinalizer(() => fresh.dispose)
      expect(yield* fresh.startExclusive(Effect.succeed("fresh"))).toBe("fresh")
    }),
  )
  state.live(
    "manual ownership fails closed for busy, retry, offline, and unknown status without touching markers",
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const id = SessionID.make("ses_runtime_status")
      const result = { info: {}, parts: [] } as unknown as MessageV2.WithParts
      let writes = 0
      const work = Effect.sync(() => {
        writes++
        return result
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          observed = { type: "idle" }
        }),
      )
      for (const type of ["busy", "retry", "offline", "future-status"]) {
        observed = { type } as SessionStatus.Info
        expect(Exit.isFailure(yield* run.startExclusive(id, Effect.succeed(result), work).pipe(Effect.exit))).toBe(true)
      }
      expect(writes).toBe(0)
      observed = { type: "idle" }
      yield* run.startExclusive(id, Effect.succeed(result), work)
      expect(writes).toBe(1)
    }),
  )
  it.live(
    "queued recovery owns admission until reset and cannot wake into a lease",
    Effect.gen(function* () {
      const id = SessionID.make("ses_runtime_retry")
      yield* Effect.addFinalizer(() => Effect.sync(() => KiloSessionRecovery.reset(id)))
      const decision = KiloSessionRecovery.finish({
        sessionID: id,
        message: { finish: "error" } as MessageV2.Assistant,
        messages: [],
      })
      if (decision?.action !== "resume") throw new Error("fixture did not queue recovery")
      const ready = yield* Deferred.make<void>()
      let calls = 0
      const fiber = KiloSessionRecovery.fork(
        id,
        decision.token,
        Deferred.await(ready).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (KiloSessionRecovery.claim(id, decision.token)) calls++
            }),
          ),
        ),
        Effect.runFork,
      )!
      yield* Effect.addFinalizer(() => Fiber.interrupt(fiber))
      const runner = Runner.make<string>(yield* Scope.Scope, { pending: () => KiloSessionRecovery.pending(id) })
      expect(runner.busy).toBe(true)
      expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
      expect(Exit.isFailure(yield* runner.startExclusive(Effect.succeed("must not compact")).pipe(Effect.exit))).toBe(
        true,
      )
      KiloSessionRecovery.reset(id)
      expect(runner.busy).toBe(false)
      const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
      yield* Effect.addFinalizer(() => Effect.sync(() => KiloRuntime.release(lease.runtimeID, lease.token)))
      yield* Deferred.succeed(ready, undefined)
      yield* Fiber.join(fiber)
      expect(calls).toBe(0)
    }),
  )
  test("fake child process claims survive exit until handles close, and leases prevent spawning", () => {
    const gate = KiloRuntime.make({ id: "child", version: "test" })
    let calls = 0
    const spawn = () => {
      calls++
      return new EventEmitter()
    }
    const child = gate.child(spawn)
    child.emit("exit")
    expect(() => gate.quiesce("child")).toThrow("active")
    child.emit("close")
    const lease = gate.quiesce("child")
    expect(() => gate.child(spawn)).toThrow("reserved")
    expect(calls).toBe(1)
    gate.release(lease.runtimeID, lease.token)
    expect(() =>
      gate.child(() => {
        throw new Error("fake spawn failed")
      }),
    ).toThrow("fake spawn failed")
    const next = gate.quiesce("child")
    gate.release(next.runtimeID, next.token)
  })
  test("identity is shared, leases cannot be stolen, and expiry recovers a lost client", () => {
    let now = 100
    const gate = KiloRuntime.make({ id: "fixture", version: "test", now: () => now, ttl: 20 })
    expect(KiloRuntime.info.id).toBe(KiloRuntime.info.id)
    expect(gate.info.id).not.toBe(KiloRuntime.info.id)
    expect(() => gate.quiesce("other")).toThrow("changed")
    const release = gate.enter()
    expect(() => gate.quiesce("fixture")).toThrow("active")
    release()
    release()
    const lease = gate.quiesce("fixture")
    expect(() => gate.enter()).toThrow("reserved")
    expect(() => gate.quiesce("fixture")).toThrow("reserved")
    expect(() => gate.release("fixture", "wrong")).toThrow("changed")
    now = lease.expiresAt
    const next = gate.quiesce("fixture")
    expect(next.token).not.toBe(lease.token)
    expect(() => gate.release("fixture", lease.token)).toThrow("changed")
    gate.release("fixture", next.token)
    gate.enter()()
  })

  test("tracks promise renewal through persistence, not merely its caller", async () => {
    const gate = KiloRuntime.make({ id: "renewal", version: "test" })
    const pending = Promise.withResolvers<void>()
    let calls = 0
    const task = gate.track(async () => {
      calls++
      await pending.promise
    })
    expect(() => gate.quiesce("renewal")).toThrow("active")
    pending.resolve()
    await task
    const lease = gate.quiesce("renewal")
    await expect(
      gate.track(async () => {
        calls++
      }),
    ).rejects.toThrow("reserved")
    expect(calls).toBe(1)
    gate.release("renewal", lease.token)
  })

  it.live(
    "a detached runner remains active after its HTTP waiter is interrupted",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const runner = Runner.make<string>(scope)
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const waiter = yield* runner
        .ensureRunning(
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish)), Effect.as("done")),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(waiter)
      expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
      yield* Deferred.succeed(finish, undefined)
      yield* pollWithTimeout(
        Effect.sync(() => !runner.busy || undefined),
        "runner did not settle",
      )
      const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
      KiloRuntime.release(lease.runtimeID, lease.token)
    }),
  )

  it.live(
    "preparation and exclusive compaction cannot both mutate",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const runner = Runner.make<string>(scope)
      const entered = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      let markers = 0
      const prompt = yield* runner
        .admit(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const denied = yield* runner
        .startExclusive(
          Effect.sync(() => {
            markers++
            return "compact"
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect(markers).toBe(0)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(prompt)
      const compacted = yield* Deferred.make<void>()
      const close = yield* Deferred.make<void>()
      const compact = yield* runner
        .startExclusive(
          Effect.gen(function* () {
            markers++
            yield* Deferred.succeed(compacted, undefined)
            yield* Deferred.await(close)
            return "compact"
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(compacted)
      yield* Fiber.interrupt(compact)
      expect(runner.busy).toBe(true)
      expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
      let prompts = 0
      const rejected = yield* runner
        .admit(
          Effect.sync(() => {
            prompts++
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      expect(prompts).toBe(0)
      yield* Deferred.succeed(close, undefined)
      yield* pollWithTimeout(
        Effect.sync(() => !runner.busy || undefined),
        "exclusive work did not settle",
      )
      expect(markers).toBe(1)
    }),
  )

  it.live(
    "cancellation retains ownership until uninterruptible finalizers settle",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const runner = Runner.make<string>(scope, { onInterrupt: Effect.succeed("cancelled") })
      const started = yield* Deferred.make<void>()
      const settling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* runner
        .ensureRunning(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(settling, undefined).pipe(Effect.andThen(Deferred.await(release)))),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const cancel = yield* runner.cancel.pipe(Effect.forkChild)
      yield* Deferred.await(settling)
      expect(runner.state._tag).toBe("Idle")
      expect(runner.busy).toBe(true)
      expect(Exit.isFailure(yield* runner.startExclusive(Effect.succeed("wrong")).pipe(Effect.exit))).toBe(true)
      expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(cancel)
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "all runner instances and queued shell work share the process gate",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const first = Runner.make<string>(scope)
      const second = Runner.make<string>(scope)
      const shell = yield* Deferred.make<void>()
      const retry = yield* Deferred.make<void>()
      const running = yield* first.startShell(Deferred.await(shell).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.sync(() => first.busy || undefined),
        "shell did not start",
      )
      const queued = yield* first.ensureRunning(Deferred.await(retry).pipe(Effect.as("retry"))).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.sync(() => first.state._tag === "ShellThenRun" || undefined),
        "run did not queue",
      )
      expect(second.busy).toBe(false)
      expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
      yield* Deferred.succeed(shell, undefined)
      yield* Fiber.join(running)
      expect(() => KiloRuntime.quiesce(KiloRuntime.info.id)).toThrow("active")
      yield* Deferred.succeed(retry, undefined)
      yield* Fiber.join(queued)
      yield* pollWithTimeout(
        Effect.sync(() => !first.busy || undefined),
        "queued work did not settle",
      )
      const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
      const blocked = yield* second.ensureRunning(Effect.succeed("must not run")).pipe(Effect.exit)
      expect(Exit.isFailure(blocked)).toBe(true)
      KiloRuntime.release(lease.runtimeID, lease.token)
    }),
  )
})
