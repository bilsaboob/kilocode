import { expect, spyOn } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { KiloCompactionBudget as Budget } from "@/kilocode/session/compaction-budget"
import { KiloCompactionState as State } from "@/kilocode/session/compaction-state"
import { KiloSessionIdentity as Identity } from "@/kilocode/session/identity"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { ProviderTest } from "../fake/provider"
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
    model: { providerID: model.providerID, modelID: model.id, variant: "pinned" },
    system: "Original task contract",
    tools: { bash: false },
    format: { type: "json_schema", schema: { type: "object", required: ["answer"] }, retryCount: 0 },
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: user.id,
    type: "text",
    text: "Original task",
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: user.id,
    type: "file",
    mime: "image/png",
    filename: "original.png",
    url: "data:image/png;base64,fixture",
  })
  const input = { sessionID: chat.id, messageID: user.id }
  yield* Budget.admit(input)
  yield* Budget.run(
    input,
    Effect.gen(function* () {
      const hook = yield* Budget.dispatcher
      hook!.model()
      hook!.transport()
    }),
  )
  const answer = yield* session.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    parentID: user.id,
    role: "assistant",
    agent: "build",
    mode: "build",
    providerID: model.providerID,
    modelID: model.id,
    path: { cwd: "", root: "" },
    finish: "stop",
    time: { created: Date.now(), completed: Date.now() },
    cost: 0.25,
    tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: answer.id,
    type: "text",
    text: "Original answer",
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: answer.id,
    type: "step-finish",
    reason: "stop",
    cost: answer.cost,
    tokens: answer.tokens,
  })
  return {
    session,
    chat,
    user,
    answer,
    input,
    packet: yield* MessageV2.get(input),
    reply: yield* MessageV2.get({ ...input, messageID: answer.id }),
    budget: Budget.inspect(input),
    cost: (yield* session.get(chat.id)).cost,
  }
})

it.instance("rejected initial publication preserves older user/assistant packets and receipts", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const other = yield* f.session.create({})
    const removed: MessageID[] = []
    const wrapped = {
      ...f.session,
      removeMessage: (input: Parameters<Session.Interface["removeMessage"]>[0]) => {
        removed.push(input.messageID)
        return f.session.removeMessage(input)
      },
    }
    for (const sessionID of [f.chat.id, other.id])
      for (const id of [f.user.id, f.answer.id]) {
        const exit = yield* State.publish({
          session: wrapped,
          message: { ...f.user, id, sessionID },
          target: f.answer.id,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof Identity.Conflict).toBe(true)
        expect(yield* MessageV2.get(f.input)).toEqual(f.packet)
        expect(yield* MessageV2.get({ ...f.input, messageID: f.answer.id })).toEqual(f.reply)
        expect(Budget.inspect(f.input)).toEqual(f.budget)
        expect((yield* f.session.get(f.chat.id)).cost).toBe(f.cost)
      }
    expect(removed).toEqual([])
  }),
)

it.instance("a competing insert after publication starts is not owned by its rejected create", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const pending = { ...f.user, id: MessageID.ascending(), time: { created: Date.now() } }
    const ready = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    const removed: MessageID[] = []
    const wrapped = {
      ...f.session,
      updateMessage: <T extends MessageV2.Info>(info: T) =>
        Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(f.session.updateMessage(info)),
        ),
      removeMessage: (input: Parameters<Session.Interface["removeMessage"]>[0]) => {
        removed.push(input.messageID)
        return f.session.removeMessage(input)
      },
    }
    const fiber = yield* State.publish({ session: wrapped, message: pending, target: f.answer.id }).pipe(
      Effect.forkChild,
    )
    yield* Deferred.await(ready)
    yield* f.session.updateMessage({ ...pending, system: "The competing request owns this ID" })
    yield* f.session.updatePart({
      id: PartID.ascending(),
      sessionID: f.chat.id,
      messageID: pending.id,
      type: "text",
      text: "The other request's packet",
    })
    yield* Budget.admit({ ...f.input, messageID: pending.id })
    const saved = yield* MessageV2.get({ ...f.input, messageID: pending.id })
    yield* Deferred.succeed(release, undefined)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof Identity.Conflict).toBe(true)
    expect(removed).toEqual([])
    expect(yield* MessageV2.get({ ...f.input, messageID: pending.id })).toEqual(saved)
    expect(yield* MessageV2.get(f.input)).toEqual(f.packet)
  }),
)

it.instance("reusing a successful publication effect cannot delete its already-persisted row", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const message = { ...f.user, id: MessageID.ascending(), time: { created: Date.now() } }
    const removed: MessageID[] = []
    const wrapped = {
      ...f.session,
      removeMessage: (input: Parameters<Session.Interface["removeMessage"]>[0]) => {
        removed.push(input.messageID)
        return f.session.removeMessage(input)
      },
    }
    const publish = State.publish({ session: wrapped, message, target: f.answer.id })
    expect(yield* publish).toEqual(message)
    const saved = yield* MessageV2.get({ ...f.input, messageID: message.id })
    expect(saved.parts).toEqual([
      expect.objectContaining({ type: "text", ignored: true, metadata: { kilo_compaction_followup: f.answer.id } }),
    ])
    const exit = yield* publish.pipe(Effect.exit)
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof Identity.Conflict).toBe(true)
    expect(removed).toEqual([])
    expect(yield* MessageV2.get({ ...f.input, messageID: message.id })).toEqual(saved)
    expect(yield* MessageV2.get(f.input)).toEqual(f.packet)
    expect(Budget.inspect(f.input)).toEqual(f.budget)
  }),
)

for (const mode of ["before", "row-error", "stage-error", "stage-commit-error", "rollback"] as const) {
  it.instance(`publication cleanup uses durable creation evidence at ${mode}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const message = { ...f.user, id: MessageID.ascending(), time: { created: Date.now() } }
      const failure = new Error(`fixture ${mode}`)
      const removed: MessageID[] = []
      if (mode === "rollback") {
        const persisted = Identity.persisted
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            spyOn(Identity, "persisted").mockImplementation((info) => {
              persisted(info)
              if ("id" in info && info.id === message.id) throw failure
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
      }
      const wrapped = {
        ...f.session,
        updateMessage: <T extends MessageV2.Info>(info: T) => {
          if (mode === "before") return Effect.die(failure)
          return f.session
            .updateMessage(info)
            .pipe(Effect.tap(() => (mode === "row-error" ? Effect.die(failure) : Effect.void)))
        },
        updatePart: <T extends MessageV2.Part>(part: T) => {
          if (mode === "stage-error") return Effect.die(failure)
          return f.session
            .updatePart(part)
            .pipe(Effect.tap(() => (mode === "stage-commit-error" ? Effect.die(failure) : Effect.void)))
        },
        removeMessage: (input: Parameters<Session.Interface["removeMessage"]>[0]) => {
          removed.push(input.messageID)
          return f.session.removeMessage(input)
        },
      }
      const exit = yield* State.publish({ session: wrapped, message, target: f.answer.id }).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
      expect(removed).toEqual(mode === "before" || mode === "rollback" ? [] : [message.id])
      expect(Exit.isFailure(yield* MessageV2.get({ ...f.input, messageID: message.id }).pipe(Effect.exit))).toBe(true)
      expect(yield* MessageV2.get(f.input)).toEqual(f.packet)
      expect(yield* MessageV2.get({ ...f.input, messageID: f.answer.id })).toEqual(f.reply)
      expect(Budget.inspect(f.input)).toEqual(f.budget)
      expect((yield* f.session.get(f.chat.id)).cost).toBe(f.cost)
    }),
  )
}
