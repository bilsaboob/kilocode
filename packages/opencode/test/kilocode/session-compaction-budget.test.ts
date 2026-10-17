import { describe, expect, test } from "bun:test"
import { APICallError, streamText, wrapLanguageModel } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as TestClock from "effect/testing/TestClock"
import { KiloCompactionBudget as Budget } from "@/kilocode/session/compaction-budget"
import { KiloCompactionState } from "@/kilocode/session/compaction-state"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import { KiloSessionRecovery } from "@/kilocode/session/recovery"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { PartTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))
const model = ProviderTest.model()
const fixture = Effect.gen(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({})
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "user",
    agent: "build",
    model: { modelID: model.id, providerID: model.providerID },
    time: { created: Date.now() },
    format: { type: "json_schema", retryCount: 0, schema: { type: "object", required: ["answer"] } },
    system: "Original contract",
    tools: { bash: false },
  })
  const input = { sessionID: chat.id, messageID: user.id }
  yield* Budget.admit(input)
  return { session, user, input }
})

function dispatch() {
  return Effect.gen(function* () {
    const hook = yield* Budget.dispatcher
    if (!hook) throw new Error("missing compaction scope")
    hook.model()
    hook.transport()
    return hook
  })
}

describe("compaction process budget settings", () => {
  test("uses finite defaults and strictly validates bounded startup JSON", () => {
    expect(Budget.defaults).toEqual({ requests: 12, milliseconds: 900_000 })
    expect(Budget.parse()).toEqual(Budget.defaults)
    expect(Budget.parse('{"requests":1,"milliseconds":1}')).toEqual({ requests: 1, milliseconds: 1 })
    expect(Budget.parse(JSON.stringify(Budget.bounds))).toEqual(Budget.bounds)
    for (const raw of [
      "",
      "null",
      "[]",
      "{}",
      "no",
      '{"requests":12}',
      ...[0, -1, 1.5, "12", null, 1001].map((requests) => JSON.stringify({ requests, milliseconds: 900_000 })),
      ...[0, -1, 1.5, "12", null, 86_400_001].map((milliseconds) => JSON.stringify({ requests: 12, milliseconds })),
      '{"requests":12,"milliseconds":900000,"unlimited":true}',
      '{"requests":1e309,"milliseconds":1}',
    ])
      expect(() => Budget.parse(raw)).toThrow("[COMPACTION_RESOURCE_LIMIT]")
  })
})

it.instance("same-message admission and replay identities retain frozen quota and exact source contract", () =>
  Effect.gen(function* () {
    const { session, user, input } = yield* fixture
    yield* Budget.run(input, dispatch())
    const first = Budget.inspect(input)!
    const before = process.env.KILO_COMPACTION_BUDGET
    try {
      process.env.KILO_COMPACTION_BUDGET = '{"requests":999,"milliseconds":1}'
      expect((yield* Budget.admit(input)).limits).toEqual(Budget.defaults)
      expect(Budget.settings()).toEqual(Budget.defaults)
    } finally {
      if (before === undefined) delete process.env.KILO_COMPACTION_BUDGET
      else process.env.KILO_COMPACTION_BUDGET = before
    }
    const alias = yield* session.updateMessage({ ...user, id: MessageID.ascending() })
    yield* Budget.bind({ sessionID: user.sessionID, messageID: alias.id, source: user.id })
    yield* Budget.run({ ...input, messageID: alias.id }, dispatch())
    expect(Budget.inspect(input)?.requests).toBe(first.requests + 1)
    expect(Budget.inspect({ ...input, messageID: alias.id })).toEqual(Budget.inspect(input))
    const saved = yield* MessageV2.get(input)
    expect(saved.info).toEqual(user)
    expect(saved.parts.every(Budget.internal)).toBe(true)
    const projected = yield* MessageV2.toModelMessagesEffect([saved], model)
    expect(JSON.stringify(projected)).not.toContain("kilo_compaction_budget")
  }),
)

it.instance("parallel reservations cannot overspend and failed work never refunds dispatches", () =>
  Effect.gen(function* () {
    const { input } = yield* fixture
    const results = yield* Budget.run(
      input,
      Effect.forEach(Array.from({ length: 15 }), () => dispatch().pipe(Effect.exit), { concurrency: 3 }),
    )
    expect(results.filter(Exit.isSuccess)).toHaveLength(12)
    expect(results.filter(Exit.isFailure)).toHaveLength(3)
    const state = Budget.inspect(input)!
    expect(state.requests).toBe(12)
    expect(state.reservations.map((item) => item.id)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
    expect(state.reservations.every((item) => item.status === "settled")).toBe(true)
    const again = yield* Budget.run(input, dispatch()).pipe(Effect.exit)
    expect(Exit.isFailure(again) && Budget.blocked(Cause.squash(again.cause))).toBe(true)
    expect(Budget.inspect(input)?.requests).toBe(12)
  }),
)

it.instance("later queued prompts cannot become the running compaction's quota source", () =>
  Effect.gen(function* () {
    const { session, user, input } = yield* fixture
    const later = yield* session.updateMessage({ ...user, id: MessageID.ascending() })
    const marker = yield* session.updateMessage({ ...user, id: MessageID.ascending() })
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: user.sessionID,
      messageID: marker.id,
      type: "compaction",
      auto: true,
    })
    const target = { sessionID: user.sessionID, messageID: marker.id }
    yield* KiloSessionPromptQueue.enqueue(
      user.sessionID,
      user.id,
      Effect.gen(function* () {
        yield* Budget.inherit({ ...target, messages: yield* session.messages({ sessionID: user.sessionID }) })
        yield* Budget.run(target, dispatch())
      }),
      Effect.void,
    )
    expect(Budget.inspect(target)?.root).toBe(user.id)
    expect(Budget.inspect(input)?.requests).toBe(1)
    expect(Budget.inspect({ ...input, messageID: later.id })).toBeUndefined()
  }),
)

it.instance("manual execution source uses durable insertion order, never clock/ID order or edited classification", () =>
  Effect.gen(function* () {
    const { session, user, input } = yield* fixture
    const current = yield* session.updateMessage({
      ...user,
      id: MessageID.make(`msg_000_${crypto.randomUUID()}`),
      time: { created: user.time.created - 10_000 },
    })
    const part = yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: user.sessionID,
      messageID: current.id,
      type: "text",
      text: "resume",
      ignored: true,
      synthetic: true,
      metadata: { session_resume: true, auto_resume: true },
    })
    yield* session.updatePart({ ...part, metadata: {} })
    yield* Budget.admit({ ...input, messageID: current.id })
    yield* session.updatePart({ ...part })
    const messages = yield* session.messages({ sessionID: user.sessionID })
    expect(Budget.resume({ sessionID: user.sessionID, messages }).id).toBe(current.id)
    const alias = yield* session.updateMessage({ ...user, id: MessageID.ascending() })
    yield* Budget.bind({ sessionID: user.sessionID, messageID: alias.id, source: current.id })
    expect(
      Budget.resume({ sessionID: user.sessionID, messages: yield* session.messages({ sessionID: user.sessionID }) }).id,
    ).toBe(current.id)
    const pending = yield* session.updateMessage({ ...user, id: MessageID.ascending() })
    expect(() => Budget.resume({ sessionID: user.sessionID, messages })).toThrow("[COMPACTION_RESOURCE_LIMIT]")
    const fresh = yield* session.messages({ sessionID: user.sessionID })
    expect(() => Budget.resume({ sessionID: user.sessionID, messages: fresh })).toThrow("[COMPACTION_RESOURCE_LIMIT]")
    expect(Budget.inspect({ ...input, messageID: pending.id })).toBeUndefined()
  }),
)

it.instance("a late SDK or transport callback cannot dispatch after compaction closes", () =>
  Effect.gen(function* () {
    const { input } = yield* fixture
    expect(yield* Budget.dispatcher).toBeUndefined()
    const hook = yield* Budget.run(input, dispatch())
    expect(() => hook.model()).toThrow("[COMPACTION_RESOURCE_LIMIT]")
    expect(() => hook.transport()).toThrow("[COMPACTION_RESOURCE_LIMIT]")
    expect(Budget.inspect(input)?.requests).toBe(1)
  }),
)

it.instance("a crash between marker creation and root binding cannot grant a fresh quota", () =>
  Effect.gen(function* () {
    const { session, user, input } = yield* fixture
    yield* Budget.run(input, dispatch())
    const marker = yield* session.updateMessage({ ...user, id: MessageID.ascending() })
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: user.sessionID,
      messageID: marker.id,
      type: "compaction",
      auto: true,
    })
    const target = { sessionID: user.sessionID, messageID: marker.id }
    const admission = yield* Budget.admit(target).pipe(Effect.exit)
    expect(Exit.isFailure(admission) && Budget.blocked(Cause.squash(admission.cause))).toBe(true)
    const reentry = yield* Budget.run(target, dispatch()).pipe(Effect.exit)
    expect(Exit.isFailure(reentry) && Budget.blocked(Cause.squash(reentry.cause))).toBe(true)
    expect(Budget.inspect(target)).toBeUndefined()
    expect(Budget.inspect(input)?.requests).toBe(1)
  }),
)

it.instance("logical recovery needs a trusted binding before a new UserID can inherit quota", () =>
  Effect.gen(function* () {
    const { session, user, input } = yield* fixture
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: user.sessionID,
      messageID: user.id,
      type: "text",
      text: "The original task",
    })
    yield* Budget.run(input, dispatch())
    const resumed = yield* session.updateMessage({ ...user, id: MessageID.ascending() })
    const anchor = KiloSessionRecovery.anchor({
      sessionID: user.sessionID,
      resumeMessageID: resumed.id,
      messages: [yield* MessageV2.get(input)],
    })
    const part: MessageV2.TextPart = {
      id: PartID.ascending(),
      sessionID: user.sessionID,
      messageID: resumed.id,
      type: "text",
      text: "resume",
      synthetic: true,
    }
    for (const item of KiloSessionRecovery.parts([part], "automatic", anchor, 1))
      yield* session.updatePart({ ...part, ...item, type: "text" })
    const target = { sessionID: user.sessionID, messageID: resumed.id }
    const unbound = yield* Budget.admit(target).pipe(Effect.exit)
    expect(Exit.isFailure(unbound) && Budget.blocked(Cause.squash(unbound.cause))).toBe(true)
    expect(Budget.inspect(target)).toBeUndefined()
    yield* Budget.bind({ ...target, source: user.id })
    expect((yield* Budget.admit(target)).requests).toBe(1)
    yield* Budget.run(target, dispatch())
    expect((yield* Budget.admit(target)).requests).toBe(2)
    expect(Budget.inspect(target)).toEqual(Budget.inspect(input))
    expect(Budget.inspect(target)?.root).toBe(user.id)
    const invalid = yield* session.updateMessage({ ...resumed, id: MessageID.ascending() })
    yield* session.updatePart({
      ...part,
      id: PartID.ascending(),
      messageID: invalid.id,
      metadata: { session_resume: true, resume_kind: "automatic" },
    })
    const exit = yield* Budget.admit({ ...input, messageID: invalid.id }).pipe(Effect.exit)
    expect(Exit.isFailure(exit) && Budget.blocked(Cause.squash(exit.cause))).toBe(true)
    const plain = yield* session.updateMessage({ ...user, id: MessageID.ascending() })
    yield* session.updatePart({
      ...part,
      id: PartID.ascending(),
      messageID: plain.id,
      synthetic: false,
      text: "A separate task",
      metadata: { anchor_user_message_id: user.id },
    })
    const separate = yield* Budget.admit({ ...input, messageID: plain.id }).pipe(Effect.exit)
    expect(Exit.isFailure(separate) && Budget.blocked(Cause.squash(separate.cause))).toBe(true)
    expect(Budget.inspect({ ...input, messageID: plain.id })).toBeUndefined()
    expect(Budget.inspect(input)?.requests).toBe(2)
  }),
)

it.instance("model retries and additional transport dispatches share the same durable cap", () =>
  Effect.gen(function* () {
    const { input } = yield* fixture
    yield* Budget.run(
      input,
      Effect.gen(function* () {
        const hook = yield* dispatch()
        expect(Budget.inspect(input)?.requests).toBe(1)
        hook.transport()
        hook.transport()
        expect(Budget.inspect(input)?.requests).toBe(3)
        hook.model()
        hook.transport()
        expect(Budget.inspect(input)?.requests).toBe(4)
      }),
    )
    const failed = yield* Budget.run(input, dispatch().pipe(Effect.andThen(Effect.fail("fixture failure")))).pipe(
      Effect.exit,
    )
    expect(Exit.isFailure(failed)).toBe(true)
    expect(Budget.inspect(input)?.requests).toBe(5)
  }),
)

it.instance("the real AI SDK retry boundary cannot issue a thirteenth summarizer request", () =>
  Effect.gen(function* () {
    const { input } = yield* fixture
    let calls = 0
    const errors: unknown[] = []
    yield* Budget.run(
      input,
      Effect.gen(function* () {
        const hook = yield* Budget.dispatcher
        const language: LanguageModelV3 = {
          specificationVersion: "v3",
          provider: "fixture",
          modelId: "fixture",
          supportedUrls: {},
          doGenerate: async () => {
            throw new Error("unexpected generate")
          },
          doStream: async () => {
            calls++
            throw new APICallError({
              message: "fixture transient transport failure",
              url: "https://fixture.invalid",
              requestBodyValues: {},
              statusCode: 503,
              responseHeaders: { "retry-after-ms": "0" },
              isRetryable: true,
            })
          },
        }
        yield* Effect.promise(async (signal) => {
          const result = streamText({
            model: wrapLanguageModel({ model: language, middleware: Budget.middleware(hook) }),
            prompt: "Summarize the fixture",
            maxRetries: 20,
            abortSignal: signal,
            onError: ({ error }) => {
              errors.push(error)
            },
          })
          await result.consumeStream()
        })
      }),
    )
    expect(calls).toBe(12)
    expect(errors.some(Budget.blocked)).toBe(true)
    expect(Budget.inspect(input)?.requests).toBe(12)
  }),
)

it.effect("parallel workers accrue wall time once, productive idle time is excluded, and deadline interrupts", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const { input } = yield* fixture
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let count = 0
      const first = yield* Budget.run(
        input,
        Effect.forEach(
          [1, 2, 3],
          () =>
            Effect.gen(function* () {
              yield* dispatch()
              if (++count === 3) yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(release)
            }),
          { concurrency: 3 },
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* TestClock.adjust(100)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      expect(Budget.inspect(input)?.milliseconds).toBe(100)
      yield* TestClock.adjust(5_000_000)
      expect(Budget.inspect(input)?.milliseconds).toBe(100)
      const started = yield* Deferred.make<void>()
      const next = yield* Budget.run(
        input,
        dispatch().pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust(899_900)
      const exit = yield* Fiber.await(next)
      expect(Exit.isFailure(exit) && Budget.blocked(Cause.squash(exit.cause))).toBe(true)
      expect(Budget.inspect(input)).toMatchObject({ requests: 4, milliseconds: 900_000, active: null })
      expect(Exit.isFailure(yield* Budget.run(input, dispatch()).pipe(Effect.exit))).toBe(true)
    }),
  ),
)

it.effect("Stop retains consumed requests and active time; an unfinished crash reservation fails closed", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const { input } = yield* fixture
      const ready = yield* Deferred.make<void>()
      const fiber = yield* Budget.run(
        input,
        dispatch().pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      const crashed = Budget.inspect(input)!
      yield* TestClock.adjust(73)
      yield* Fiber.interrupt(fiber)
      expect(Budget.inspect(input)).toMatchObject({ requests: 1, milliseconds: 73, active: null })
      expect(Budget.inspect(input)?.reservations[0].status).toBe("reserved")
      expect(Exit.isFailure(yield* Budget.run(input, dispatch()).pipe(Effect.exit))).toBe(true)
      expect(Budget.inspect(input)?.requests).toBe(1)
      // Restore the actual pre-finalizer receipt to model a process loss, not an orderly Stop.
      Database.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(PartTable)
            .where(eq(PartTable.message_id, input.messageID))
            .all()
            .find((row) => Budget.internal(row.data))!
          const data = { type: "text" as const, text: "", ignored: true, metadata: { kilo_compaction_budget: crashed } }
          tx.update(PartTable).set({ data }).where(eq(PartTable.id, row.id)).run()
        },
        { behavior: "immediate" },
      )
      const exit = yield* Budget.run(input, dispatch()).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("unfinished compaction reservation")
      expect(Budget.inspect(input)).toEqual(crashed)
    }),
  ),
)

it.effect("interrupting a waiter cannot settle an unresolved external dispatch", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const { input } = yield* fixture
      const ready = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<void>()
      let finished = false
      let aborted = false
      const fiber = yield* Budget.run(
        input,
        dispatch().pipe(
          Effect.andThen(
            Effect.promise((signal) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true
                },
                { once: true },
              )
              ready.resolve()
              return pending.promise.then(() => {
                finished = true
              })
            }),
          ),
        ),
      ).pipe(Effect.uninterruptible, Effect.forkChild)
      yield* Effect.promise(() => ready.promise)
      yield* TestClock.adjust(200)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(aborted).toBe(true)
      expect(finished).toBe(false)
      const reentry = yield* Budget.run(input, dispatch()).pipe(Effect.exit)
      expect(Exit.isFailure(reentry) && Budget.blocked(Cause.squash(reentry.cause))).toBe(true)
      expect(Budget.inspect(input)).toMatchObject({ requests: 1, milliseconds: 200, active: null })
      expect(Budget.inspect(input)?.reservations[0].status).toBe("reserved")
      pending.resolve()
      yield* Effect.promise(() => pending.promise)
      expect(Budget.inspect(input)?.reservations[0].status).toBe("reserved")
    }),
  ),
)

it.effect("wall-clock rollback cannot refund active duration or reopen an expired deadline", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const { input } = yield* fixture
      const clock = yield* Clock.Clock
      let wall = 10_000
      let frozen: bigint | undefined
      const adjusted: Clock.Clock = {
        currentTimeMillisUnsafe: () => wall,
        currentTimeMillis: Effect.sync(() => wall),
        currentTimeNanosUnsafe: () => frozen ?? clock.currentTimeNanosUnsafe(),
        currentTimeNanos: Effect.sync(() => frozen ?? clock.currentTimeNanosUnsafe()),
        sleep: (duration) => clock.sleep(duration),
      }
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const first = yield* Budget.run(
        input,
        dispatch().pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.provideService(Clock.Clock, adjusted), Effect.forkChild)
      yield* Deferred.await(ready)
      wall = -1_000_000
      yield* TestClock.adjust(300)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      expect(Budget.inspect(input)?.milliseconds).toBe(300)
      frozen = clock.currentTimeNanosUnsafe()
      const started = yield* Deferred.make<void>()
      const next = yield* Budget.run(
        input,
        dispatch().pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
      ).pipe(Effect.provideService(Clock.Clock, adjusted), Effect.forkChild)
      yield* Deferred.await(started)
      wall = -9_000_000
      yield* TestClock.adjust(899_700)
      expect(Exit.isFailure(yield* Fiber.await(next))).toBe(true)
      expect(Budget.inspect(input)?.milliseconds).toBeGreaterThanOrEqual(900_000)
      const reentry = yield* Budget.run(input, dispatch()).pipe(Effect.exit)
      expect(Exit.isFailure(reentry) && Budget.blocked(Cause.squash(reentry.cause))).toBe(true)
      expect(Budget.inspect(input)?.requests).toBe(2)
    }),
  ),
)

it.instance("only completed productive ordinary steps rearm the separate failed-loop guard", () =>
  Effect.gen(function* () {
    const { user } = yield* fixture
    const info: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID: user.sessionID,
      parentID: user.id,
      role: "assistant",
      agent: "build",
      mode: "build",
      path: { cwd: "", root: "" },
      providerID: model.providerID,
      modelID: model.id,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, completed: 2 },
      finish: "stop",
    }
    const part: MessageV2.TextPart = {
      id: PartID.ascending(),
      messageID: info.id,
      sessionID: user.sessionID,
      type: "text",
      text: "Completed ordinary work",
    }
    const state = { attempts: 3, progress: "prior-step" }
    expect(Budget.progress(state, [{ info: { ...info, summary: true }, parts: [part] }], user)).toEqual(state)
    expect(Budget.progress(state, [{ info: { ...info, time: { created: 1 } }, parts: [part] }], user)).toEqual(state)
    expect(Budget.progress(state, [{ info, parts: [] }], user)).toEqual(state)
    const next = Budget.progress(state, [{ info, parts: [part] }], user)
    expect(next).toEqual({ attempts: 0, progress: info.id })
    expect(Budget.progress({ ...next, attempts: 3 }, [{ info, parts: [part] }], user).attempts).toBe(3)
    const tool: MessageV2.ToolPart = {
      id: PartID.ascending(),
      messageID: info.id,
      sessionID: user.sessionID,
      type: "tool",
      tool: "write",
      callID: "once",
      state: { status: "running", input: {}, time: { start: 1 } },
    }
    expect(Budget.progress(state, [{ info, parts: [part, tool] }], user)).toEqual(state)
    expect(
      Budget.progress(
        state,
        [
          {
            info,
            parts: [
              part,
              { ...tool, state: { status: "error", input: {}, error: "fixture failure", time: { start: 1, end: 2 } } },
            ],
          },
        ],
        user,
      ),
    ).toEqual(state)
    expect(KiloCompactionState.successful(info)).toBe(true)
  }),
)
