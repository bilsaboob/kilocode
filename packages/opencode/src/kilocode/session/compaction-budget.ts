import { APICallError, type LanguageModelMiddleware } from "ai"
import { Clock, Context, Effect, Cause, Exit } from "effect"
import z from "zod"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { MessageTable, PartTable } from "@/session/session.sql"
import type { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { Database, and, eq, sql } from "@/storage/db"
import { KiloCompactionState } from "./compaction-state"
import { KiloSessionPromptQueue } from "./prompt-queue"
import { KiloSessionRecovery } from "./recovery"

const startup = process.env.KILO_COMPACTION_BUDGET
const key = "kilo_compaction_budget"
const link = "kilo_compaction_root"

export namespace KiloCompactionBudget {
  export const defaults = Object.freeze({ requests: 12, milliseconds: 900_000 })
  export const bounds = Object.freeze({ requests: 1_000, milliseconds: 86_400_000 })
  const Limits = z
    .object({
      requests: z.number().int().positive().max(bounds.requests),
      milliseconds: z.number().int().positive().max(bounds.milliseconds),
    })
    .strict()
  const Ledger = z
    .object({
      version: z.literal(1),
      root: z.string(),
      limits: Limits,
      requests: z.number().int().nonnegative().max(bounds.requests),
      milliseconds: z.number().finite().nonnegative(),
      active: z.object({ id: z.string(), observed: z.number().finite(), deadline: z.number().finite() }).nullable(),
      reservations: z
        .array(
          z.object({
            id: z.number().int().positive(),
            interval: z.string(),
            at: z.number().finite(),
            status: z.enum(["reserved", "settled"]),
          }),
        )
        .max(bounds.requests),
    })
    .strict()
  export type State = z.infer<typeof Ledger>
  type Input = { sessionID: SessionID; messageID: MessageID }
  type Lease = Input & { id: string; clock: Clock.Clock; observed: bigint; closed: boolean }
  const Active = Context.Reference<Lease | undefined>("kilo/CompactionBudget", { defaultValue: () => undefined })
  const Text = z.object({
    type: z.literal("text"),
    text: z.string(),
    ignored: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })

  export function error(reason: string) {
    return new APICallError({
      message: `[COMPACTION_RESOURCE_LIMIT] ${reason}. Original history and reported spending are preserved; this resource budget does not authorize another editing attempt.`,
      url: "",
      requestBodyValues: {},
      isRetryable: false,
    })
  }

  function detail(value: unknown) {
    if (!value || typeof value !== "object") return undefined
    const message = "message" in value ? value.message : undefined
    const data = "data" in value ? value.data : undefined
    if (typeof message === "string") return message
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message
    return undefined
  }

  export function blocked(value: unknown) {
    return detail(value)?.includes("[COMPACTION_RESOURCE_LIMIT]") === true
  }

  export function parse(raw?: string) {
    if (raw === undefined) return { ...defaults }
    if (raw.length > 512) throw error("Invalid process compaction budget")
    const decoded = z
      .string()
      .transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid JSON" })
          return z.NEVER
        }
      })
      .pipe(Limits)
      .safeParse(raw)
    if (!decoded.success) throw error("Invalid process compaction budget")
    return decoded.data
  }

  // Capture process startup configuration, not mutable per-request environment.
  export function settings() {
    return parse(startup)
  }

  export function external(parts: readonly unknown[]) {
    return parts.every((part) => {
      if (
        !part ||
        typeof part !== "object" ||
        !("metadata" in part) ||
        !part.metadata ||
        typeof part.metadata !== "object"
      )
        return true
      return !Object.keys(part.metadata).some(
        (name) => name === "kilo_compaction" || name.startsWith("kilo_compaction_"),
      )
    })
  }

  export function mutable(input: { messageID: MessageID; partID?: PartID }) {
    return Database.use((tx) =>
      external(
        tx
          .select()
          .from(PartTable)
          .where(input.partID ? eq(PartTable.id, input.partID) : eq(PartTable.message_id, input.messageID))
          .all()
          .map((row) => row.data),
      ),
    )
  }

  function parts(tx: Database.TxOrDb, input: Input) {
    const message = tx
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get()
    if (!message || message.data.role !== "user") throw error("The logical prompt budget source is missing")
    return tx
      .select()
      .from(PartTable)
      .where(and(eq(PartTable.message_id, input.messageID), eq(PartTable.session_id, input.sessionID)))
      .all()
      .flatMap((row) => {
        if (row.data.type !== "text") return []
        const parsed = Text.safeParse(row.data)
        if (!parsed.success) throw error("The logical prompt metadata is invalid")
        return [{ ...row, data: parsed.data }]
      })
  }

  function locate(
    tx: Database.TxOrDb,
    input: Input,
    seen = new Set<string>(),
  ): { input: Input; row?: typeof PartTable.$inferSelect; state?: State } {
    if (seen.has(input.messageID)) throw error("The logical prompt budget binding is cyclic")
    seen.add(input.messageID)
    const all = parts(tx, input)
    const rows = all.filter((part) => part.data.type === "text" && Object.hasOwn(part.data.metadata ?? {}, key))
    const links = all.filter((part) => part.data.type === "text" && Object.hasOwn(part.data.metadata ?? {}, link))
    if (rows.length > 1 || links.length > 1 || (rows.length && links.length))
      throw error("The logical prompt budget binding is ambiguous")
    const row = rows[0]
    if (row) {
      if (row.data.type !== "text" || !row.data.ignored) throw error("The logical prompt budget receipt is invalid")
      const parsed = Ledger.safeParse(row.data.metadata?.[key])
      if (
        !parsed.success ||
        parsed.data.root !== input.messageID ||
        parsed.data.requests !== parsed.data.reservations.length
      )
        throw error("The logical prompt budget receipt is invalid")
      return { input, row, state: parsed.data }
    }
    const pointer = links[0]
    if (pointer) {
      if (
        pointer.data.type !== "text" ||
        !pointer.data.ignored ||
        typeof pointer.data.metadata?.[link] !== "string" ||
        !pointer.data.metadata[link].startsWith("msg")
      )
        throw error("The logical prompt budget binding is invalid")
      const found = locate(tx, { ...input, messageID: MessageID.make(pointer.data.metadata[link]) }, seen)
      if (!found.state) throw error("The logical prompt budget receipt is missing")
      return found
    }
    // Followup identities can survive a detached projection or a backend reentry.
    const followup = all.find(
      (part) => part.data.type === "text" && part.data.ignored && part.data.metadata?.kilo_compaction_followup,
    )
    if (followup?.data.type === "text") {
      const id = followup.data.metadata?.kilo_compaction_followup
      if (typeof id !== "string" || !id.startsWith("msg")) throw error("The followup budget source is invalid")
      const target = tx
        .select()
        .from(MessageTable)
        .where(and(eq(MessageTable.id, MessageID.make(id)), eq(MessageTable.session_id, input.sessionID)))
        .get()
      if (!target || target.data.role !== "assistant") throw error("The followup budget source is missing")
      return locate(tx, { ...input, messageID: target.data.parentID }, seen)
    }
    return { input }
  }

  function save(tx: Database.TxOrDb, input: Input, state: State, row?: typeof PartTable.$inferSelect) {
    const data = { type: "text" as const, text: "", ignored: true, metadata: { [key]: state } }
    if (row) tx.update(PartTable).set({ data }).where(eq(PartTable.id, row.id)).run()
    else
      tx.insert(PartTable)
        .values({ id: PartID.ascending(), message_id: input.messageID, session_id: input.sessionID, data })
        .run()
  }

  function frozen(tx: Database.TxOrDb, input: Input, initial = false) {
    const found = locate(tx, input)
    if (found.state) return { ...found, state: found.state }
    if (
      !initial &&
      tx
        .select()
        .from(PartTable)
        .where(and(eq(PartTable.message_id, found.input.messageID), eq(PartTable.session_id, found.input.sessionID)))
        .all()
        .some((part) => {
          if (part.data.type === "compaction") return true
          const text = Text.safeParse(part.data)
          return text.success && KiloSessionRecovery.marked(text.data)
        })
    )
      throw error("The compaction or recovery prompt has no durable logical prompt binding")
    const state: State = {
      version: 1,
      root: found.input.messageID,
      limits: settings(),
      requests: 0,
      milliseconds: 0,
      active: null,
      reservations: [],
    }
    save(tx, found.input, state)
    return { ...found, state }
  }

  export function admit(input: Input) {
    return Effect.sync(() =>
      Database.transaction(
        (tx) => {
          const state = frozen(tx, input).state
          if (
            state.root !== input.messageID &&
            !parts(tx, input).some((row) => Object.hasOwn(row.data.metadata ?? {}, link))
          ) {
            const data = { type: "text" as const, text: "", ignored: true, metadata: { [link]: state.root } }
            tx.insert(PartTable)
              .values({ id: PartID.ascending(), message_id: input.messageID, session_id: input.sessionID, data })
              .run()
          }
          return state
        },
        { behavior: "immediate" },
      ),
    )
  }

  export function inspect(input: Input) {
    return Database.use((tx) => locate(tx, input).state)
  }

  export function resume(input: { sessionID: SessionID; messages: MessageV2.WithParts[] }) {
    return Database.transaction(
      (tx) => {
        // SQLite insertion order is not supplied by the client and is unchanged by part edits.
        // Select the current row first; never search backwards for a more convenient valid receipt.
        const latest = tx
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(
            and(
              eq(MessageTable.session_id, input.sessionID),
              sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
            ),
          )
          .orderBy(sql`${MessageTable}.rowid desc`)
          .get()
        if (!latest) throw error("Manual recovery has no persisted current prompt")
        const current = input.messages.find((message) => message.info.id === latest.id)
        if (!current || current.info.role !== "user" || current.info.sessionID !== input.sessionID)
          throw error("The current recovery prompt cannot be verified")
        if (KiloCompactionState.visible([current], input.messages).length !== 1)
          throw error("The current recovery publication is incomplete")
        const found = locate(tx, { sessionID: input.sessionID, messageID: latest.id })
        if (!found.state) throw error("The current recovery prompt has no protected admission binding")
        if (found.state.active || found.state.reservations.some((item) => item.status !== "settled"))
          throw error("The current recovery prompt has unsettled compaction reservations")
        const root = input.messages.find((message) => message.info.id === found.state!.root)?.info
        if (!root || root.role !== "user" || root.sessionID !== input.sessionID)
          throw error("The admitted recovery source is missing")
        return root
      },
      { behavior: "immediate" },
    )
  }

  export function bind(input: Input & { source: MessageID }) {
    return Effect.sync(() =>
      Database.transaction(
        (tx) => {
          const origin = frozen(tx, { ...input, messageID: input.source }, input.source === input.messageID)
          const target = locate(tx, input)
          if (target.state) {
            if (target.state.root !== origin.state.root) throw error("The logical prompt budget cannot be replaced")
            return
          }
          if (input.messageID === origin.state.root) return
          const data = { type: "text" as const, text: "", ignored: true, metadata: { [link]: origin.state.root } }
          tx.insert(PartTable)
            .values({
              id: PartID.ascending(),
              message_id: input.messageID,
              session_id: input.sessionID,
              data,
            })
            .run()
        },
        { behavior: "immediate" },
      ),
    )
  }

  export function internal(part: unknown) {
    const parsed = Text.safeParse(part)
    return (
      parsed.success &&
      !!parsed.data.ignored &&
      (Object.hasOwn(parsed.data.metadata ?? {}, key) || Object.hasOwn(parsed.data.metadata ?? {}, link))
    )
  }

  export function source(input: {
    sessionID: SessionID
    messageID?: MessageID
    messages: MessageV2.WithParts[]
    source?: string
  }) {
    const id = input.source ?? KiloSessionPromptQueue.active(input.sessionID)
    if (id) {
      const info = input.messages.find((item) => item.info.id === id)?.info
      if (!info || info.role !== "user") throw error("The logical prompt budget source is missing")
      return info
    }
    const info = KiloCompactionState.visible(input.messages).findLast(
      (item) =>
        item.info.role === "user" &&
        item.info.id !== input.messageID &&
        !item.parts.some((part) => part.type === "compaction"),
    )?.info
    return info?.role === "user" ? info : undefined
  }

  export function inherit(input: Input & { messages: MessageV2.WithParts[]; source?: string }) {
    return bind({ ...input, source: source(input)?.id ?? input.messageID })
  }

  function update(
    lease: Lease,
    change: { reserve?: boolean; close?: boolean; settled?: boolean; exhausted?: boolean } = {},
  ) {
    if (lease.closed) throw error("The compaction interval has already closed")
    const observed = lease.clock.currentTimeNanosUnsafe()
    const reason = Database.transaction(
      (tx) => {
        const found = locate(tx, lease)
        const state = found.state
        if (!state?.active || state.active.id !== lease.id)
          throw error("An unfinished compaction reservation cannot be safely recovered")
        const now = lease.clock.currentTimeMillisUnsafe()
        // Wall timestamps are diagnostic; only monotonic elapsed time is charged.
        state.milliseconds += Math.max(0, Number(observed - lease.observed) / 1_000_000)
        if (change.exhausted) state.milliseconds = Math.max(state.milliseconds, state.limits.milliseconds)
        state.active.observed = Math.max(now, state.active.observed)
        const reason =
          state.milliseconds >= state.limits.milliseconds
            ? "Cumulative active compaction time is exhausted"
            : change.reserve && state.requests >= state.limits.requests
              ? "Cumulative summarizer dispatch count is exhausted"
              : undefined
        if (change.reserve && !reason) {
          state.requests++
          state.reservations.push({ id: state.requests, interval: lease.id, at: now, status: "reserved" })
        }
        if (change.close) {
          if (change.settled)
            for (const item of state.reservations) if (item.interval === lease.id) item.status = "settled"
          state.active = null
        }
        // Commit observed time even when the next dispatch is denied. Never refund a reservation.
        save(tx, found.input, state, found.row)
        return reason
      },
      { behavior: "immediate" },
    )
    lease.observed = observed
    if (change.close) lease.closed = true
    if (reason && !change.close && !change.exhausted) throw error(reason)
  }

  export const check = Effect.gen(function* () {
    const lease = yield* Active
    if (lease) update(lease)
  })

  // One dispatcher per LLM attempt. The model boundary conservatively reserves
  // even if auth fails before I/O; transport retries consume additional quota.
  export const dispatcher = Effect.gen(function* () {
    const lease = yield* Active
    if (!lease) return undefined
    let credit = false
    return {
      model(this: void) {
        update(lease, { reserve: true })
        credit = true
      },
      transport(this: void) {
        update(lease, { reserve: !credit })
        credit = false
      },
    }
  })

  export function middleware(hook: { model(): void } | undefined): LanguageModelMiddleware {
    return {
      specificationVersion: "v3",
      async wrapStream({ doStream }) {
        hook?.model()
        return doStream()
      },
      async wrapGenerate({ doGenerate }) {
        hook?.model()
        return doGenerate()
      },
    }
  }

  export function run<A, E, R>(
    input: Input,
    work: Effect.Effect<A, E, R>,
    settled: (value: A) => boolean = () => true,
  ) {
    return Effect.gen(function* () {
      const inherited = yield* Active
      if (inherited) {
        if (inherited.sessionID !== input.sessionID || inspect(input)?.root !== inspect(inherited)?.root)
          throw error("A compaction worker changed its logical prompt")
        return yield* work.pipe(Effect.interruptible)
      }
      const clock = yield* Clock.Clock
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const id = crypto.randomUUID()
          const observed = clock.currentTimeNanosUnsafe()
          const remaining = Database.transaction(
            (tx) => {
              const found = frozen(tx, input)
              const state = found.state
              if (state.active || state.reservations.some((item) => item.status !== "settled"))
                throw error("An unfinished compaction reservation cannot be safely recovered")
              if (state.requests >= state.limits.requests)
                throw error("Cumulative summarizer dispatch count is exhausted")
              if (state.milliseconds >= state.limits.milliseconds)
                throw error("Cumulative active compaction time is exhausted")
              const remaining = state.limits.milliseconds - state.milliseconds
              const now = clock.currentTimeMillisUnsafe()
              state.active = { id, observed: now, deadline: now + remaining }
              // Re-read after initial insertion so the ledger remains a single row.
              save(tx, found.input, state, locate(tx, found.input).row)
              return remaining
            },
            { behavior: "immediate" },
          )
          return {
            sessionID: input.sessionID,
            messageID: input.messageID,
            id,
            clock,
            observed,
            closed: false,
            remaining,
          }
        }),
        (lease) =>
          work.pipe(
            Effect.provideService(Active, lease),
            Effect.timeoutOrElse({
              duration: Math.max(
                0,
                lease.remaining - Number(clock.currentTimeNanosUnsafe() - lease.observed) / 1_000_000,
              ),
              orElse: () =>
                Effect.sync(() => update(lease, { exhausted: true })).pipe(
                  Effect.andThen(Effect.die(error("Cumulative active compaction time is exhausted"))),
                ),
            }),
            Effect.interruptible,
          ),
        // Interrupting the waiter is not proof that an external transport finished.
        (lease, exit) =>
          Effect.sync(() => update(lease, { close: true, settled: Exit.isSuccess(exit) && settled(exit.value) })),
      )
    })
  }

  export function process(
    input: { session: Session.Interface; parent?: MessageV2.Info },
    work: Effect.Effect<"continue" | "stop">,
  ) {
    const parent = input.parent
    if (!parent || parent.role !== "user") return work
    return run({ sessionID: parent.sessionID, messageID: parent.id }, work, (result) => result === "continue").pipe(
      Effect.catchCauseIf(
        (cause) => blocked(Cause.squash(cause)),
        (cause) =>
          Effect.gen(function* () {
            const messages = yield* input.session.messages({ sessionID: parent.sessionID }).pipe(Effect.orDie)
            const target = messages.findLast(
              (item) =>
                item.info.role === "assistant" &&
                item.info.parentID === parent.id &&
                item.info.summary &&
                !KiloCompactionState.target(item),
            )
            if (target && KiloCompactionState.bound(target, messages)) return "continue" as const
            const ctx = yield* InstanceState.context
            const info: MessageV2.Assistant =
              target?.info.role === "assistant"
                ? target.info
                : {
                    id: MessageID.ascending(),
                    sessionID: parent.sessionID,
                    parentID: parent.id,
                    role: "assistant",
                    agent: "compaction",
                    mode: "compaction",
                    summary: true,
                    modelID: parent.model.modelID,
                    providerID: parent.model.providerID,
                    variant: parent.model.variant,
                    path: { cwd: ctx.directory, root: ctx.worktree },
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    time: { created: Date.now() },
                  }
            info.error = { name: "APIError", data: { message: detail(Cause.squash(cause))!, isRetryable: false } }
            info.finish = "error"
            info.time.completed = Date.now()
            yield* input.session.updateMessage(info)
            return "stop" as const
          }),
      ),
    )
  }

  export function progress(
    state: { attempts: number; progress?: string },
    messages: MessageV2.WithParts[],
    user: MessageV2.User,
  ) {
    const latest = KiloCompactionState.progress(messages, user.id)
    return latest && latest.id !== state.progress ? { attempts: 0, progress: latest.id } : state
  }
}
