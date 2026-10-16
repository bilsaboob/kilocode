import { describe, expect, spyOn } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import path from "node:path"
import { Cause, DateTime, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SessionEvent } from "@opencode-ai/core/session-event"
import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "../../../src/bus"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import * as Persistence from "../../../src/kilocode/storage/db"
import { SessionID } from "../../../src/session/schema"
import { Database, eq } from "../../../src/storage/db"
import { SyncEvent } from "../../../src/sync"
import { EventSequenceTable, EventTable } from "../../../src/sync/event.sql"
import { provideTmpdirInstance, tmpdir } from "../../fixture/fixture"
import { awaitWithTimeout, it, testEffect } from "../../lib/effect"

const options = { behavior: "immediate", operation: "test.persistence" } as const
const log = Log.create({ service: "db.contention" })
const sync = testEffect(
  Layer.mergeAll(
    SyncEvent.layer.pipe(
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: true })),
      Layer.provideMerge(Bus.layer),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

function fixture(journal = "WAL") {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      if (Database.getPath() !== ":memory:") throw new Error("Expected isolated test database")
      Database.close()
      const dir = await tmpdir()
      const previous = Flag.KILO_DB
      Flag.KILO_DB = path.join(dir.path, "contention.db")
      const db = Database.Client()
      db.run(`PRAGMA journal_mode = ${journal}`)
      db.run("PRAGMA busy_timeout = 10")
      db.run("CREATE TABLE contention (value TEXT NOT NULL UNIQUE)")
      const holder = new SQLite(Flag.KILO_DB)
      holder.run("PRAGMA busy_timeout = 0")
      return {
        db,
        holder,
        rows: () => db.all<{ value: string }>("SELECT value FROM contention"),
        async dispose() {
          holder.close()
          Database.close()
          Flag.KILO_DB = previous
          await dir[Symbol.asyncDispose]()
        },
      }
    }),
    (f) => Effect.promise(() => f.dispose()),
  )
}

describe("safe persistence acquisition recovery", () => {
  it.live("recovers after a competing writer releases during nonblocking backoff", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const blocked = Promise.withResolvers<void>()
      const warn = log.warn
      using warnings = spyOn(log, "warn").mockImplementation((...args) => {
        warn(...args)
        blocked.resolve()
      })
      using recovered = spyOn(log, "info")
      f.holder.run("BEGIN IMMEDIATE")
      let calls = 0
      let effects = 0
      const fiber = yield* Persistence.transaction((tx) => {
        calls++
        expect(f.db.get<{ timeout: number }>("PRAGMA busy_timeout")).toEqual({ timeout: 10 })
        tx.run("INSERT INTO contention VALUES ('private query value')")
        Database.effect(() => effects++)
        return 42
      }, options).pipe(Effect.forkChild)

      yield* awaitWithTimeout(
        Effect.promise(() => blocked.promise),
        "writer never encountered contention",
      )
      expect(warnings.mock.calls).toHaveLength(1)
      expect(calls).toBe(0)
      expect(f.db.get<{ timeout: number }>("PRAGMA busy_timeout")).toEqual({ timeout: 10 })
      f.holder.run("COMMIT")
      expect(yield* Fiber.join(fiber)).toBe(42)
      expect(calls).toBe(1)
      expect(effects).toBe(1)
      expect(f.rows()).toEqual([{ value: "private query value" }])
      expect(recovered.mock.calls[0]?.[1]).toMatchObject({
        pid: process.pid,
        operation: options.operation,
        attempt: 2,
      })
      const metadata = warnings.mock.calls[0]?.[1]
      expect({ ...metadata }).toMatchObject({
        pid: process.pid,
        database: expect.stringMatching(/^[a-f0-9]{16}$/),
        operation: options.operation,
        id: expect.any(Number),
        limit: 6,
        code: "SQLITE_BUSY",
        errno: 5,
        attempt: 1,
        wait: expect.any(Number),
        entered: false,
        retry: true,
        exhausted: false,
      })
      expect(recovered.mock.calls[0]?.[1]?.id).toBe(metadata?.id)
      expect(JSON.stringify([warnings.mock.calls, recovered.mock.calls])).not.toContain("private query value")
      expect(JSON.stringify(metadata)).not.toContain(Flag.KILO_DB!)
    }),
  )

  it.live("exhausts a bounded retry budget without entering or publishing", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      using warnings = spyOn(log, "warn")
      f.holder.run("BEGIN IMMEDIATE")
      let calls = 0
      const exit = yield* Persistence.transaction(() => calls++, options).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "SQLITE_BUSY", errno: 5 })
      expect(calls).toBe(0)
      expect(f.rows()).toEqual([])
      expect(f.db.get<{ timeout: number }>("PRAGMA busy_timeout")).toEqual({ timeout: 10 })
      expect(warnings.mock.calls).toHaveLength(6)
      expect(warnings.mock.calls[5]?.[1]).toMatchObject({ attempt: 6, exhausted: true, retry: false, entered: false })
    }),
  )

  it.live("interrupts backoff without a later callback or changed connection timeout", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const blocked = Promise.withResolvers<void>()
      const warn = log.warn
      using warnings = spyOn(log, "warn").mockImplementation((...args) => {
        warn(...args)
        blocked.resolve()
      })
      f.holder.run("BEGIN IMMEDIATE")
      let calls = 0
      const fiber = yield* Persistence.transaction(() => calls++, options).pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        Effect.promise(() => blocked.promise),
        "writer never encountered contention",
      )
      expect(warnings.mock.calls).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      f.holder.run("COMMIT")
      expect(calls).toBe(0)
      expect(f.db.get<{ timeout: number }>("PRAGMA busy_timeout")).toEqual({ timeout: 10 })
    }),
  )

  it.live("does not retry callback contention and rolls back nested writes and effects", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      using warnings = spyOn(log, "warn")
      let calls = 0
      let effects = 0
      const exit = yield* Persistence.transaction((tx) => {
        calls++
        tx.run("INSERT INTO contention VALUES ('outer')")
        Database.transaction((nested) => {
          expect(nested).toBe(tx)
          nested.run("INSERT INTO contention VALUES ('inner')")
          Database.effect(() => effects++)
        })
        // A real SQLite busy error, but acquisition already succeeded.
        f.holder.run("BEGIN IMMEDIATE")
      }, options).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toBe(1)
      expect(effects).toBe(0)
      expect(f.rows()).toEqual([])
      expect(warnings.mock.calls).toHaveLength(1)
      expect(warnings.mock.calls[0]?.[1]).toMatchObject({ entered: true, retry: false, exhausted: false })
    }),
  )

  it.live("does not retry a nested deferred transaction's failed write acquisition", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      using warnings = spyOn(log, "warn")
      f.holder.run("BEGIN IMMEDIATE")
      let calls = 0
      const exit = yield* Effect.sync(() =>
        Database.transaction(() =>
          Effect.runSync(
            Persistence.transaction((tx) => {
              calls++
              tx.run("INSERT INTO contention VALUES ('nested')")
            }, options),
          ),
        ),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toBe(1)
      expect(f.rows()).toEqual([])
      expect(warnings.mock.calls).toHaveLength(1)
      expect(warnings.mock.calls[0]?.[1]).toMatchObject({ nested: true, entered: true, retry: false })
    }),
  )

  it.live("does not replay a transaction whose commit is blocked by a competing reader", () =>
    Effect.gen(function* () {
      const f = yield* fixture("DELETE")
      using warnings = spyOn(log, "warn")
      f.holder.run("BEGIN")
      f.holder.query("SELECT * FROM contention").all()
      let calls = 0
      let effects = 0
      const exit = yield* Persistence.transaction((tx) => {
        calls++
        tx.run("INSERT INTO contention VALUES ('uncommitted')")
        Database.effect(() => effects++)
      }, options).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toBe(1)
      expect(effects).toBe(0)
      expect(f.rows()).toEqual([])
      expect(warnings.mock.calls).toHaveLength(1)
      expect(warnings.mock.calls[0]?.[1]).toMatchObject({ entered: true, retry: false })
    }),
  )

  it.live("does not replay committed data when a deferred effect encounters contention", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      using warnings = spyOn(log, "warn")
      let calls = 0
      let effects = 0
      const exit = yield* Persistence.transaction((tx) => {
        calls++
        tx.run("INSERT INTO contention VALUES ('committed')")
        Database.effect(() => {
          effects++
          f.holder.run("BEGIN IMMEDIATE")
          f.db.run("INSERT INTO contention VALUES ('blocked effect')")
        })
      }, options).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toBe(1)
      expect(effects).toBe(1)
      expect(f.rows()).toEqual([{ value: "committed" }])
      expect(warnings.mock.calls).toHaveLength(1)
      expect(warnings.mock.calls[0]?.[1]).toMatchObject({ entered: true, retry: false })
    }),
  )

  it.live("propagates non-busy SQLite errors without retrying", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      using warnings = spyOn(log, "warn")
      let calls = 0
      const exit = yield* Persistence.transaction((tx) => {
        calls++
        tx.run("INSERT INTO contention VALUES (NULL)")
      }, options).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toBe(1)
      expect(f.rows()).toEqual([])
      expect(warnings.mock.calls).toHaveLength(0)
    }),
  )

  sync.live("persists and publishes each competing SyncEvent.run exactly once with consecutive sequences", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const service = yield* SyncEvent.Service
          const def = EventV2Bridge.toSyncDefinition(SessionEvent.Text.Delta)
          const sessionID = SessionID.make("ses_contention")
          const events: unknown[] = []
          const received = Promise.withResolvers<void>()
          const blocked = Promise.withResolvers<void>()
          const warn = log.warn
          using warnings = spyOn(log, "warn").mockImplementation((...args) => {
            warn(...args)
            if (warnings.mock.calls.length === 2) blocked.resolve()
          })
          const dispose = yield* bus.subscribeAllCallback((event) => {
            if (event.type !== def.type) return
            events.push(event)
            if (events.length === 2) received.resolve()
          })

          try {
            f.holder.run("BEGIN IMMEDIATE")
            const first = yield* service
              .run(def, { sessionID, timestamp: DateTime.makeUnsafe(1234), delta: "first" })
              .pipe(Effect.forkChild)
            const second = yield* service
              .run(def, { sessionID, timestamp: DateTime.makeUnsafe(1234), delta: "second" })
              .pipe(Effect.forkChild)
            yield* awaitWithTimeout(
              Effect.promise(() => blocked.promise),
              "sync writes never encountered contention",
            )
            expect(events).toHaveLength(0)
            expect(f.db.select().from(EventTable).all()).toEqual([])
            expect(warnings.mock.calls.map((entry) => entry[1]?.operation)).toEqual(["SyncEvent.run", "SyncEvent.run"])
            expect(new Set(warnings.mock.calls.map((entry) => entry[1]?.id)).size).toBe(2)
            f.holder.run("COMMIT")
            yield* Fiber.join(first)
            yield* Fiber.join(second)
            yield* awaitWithTimeout(
              Effect.promise(() => received.promise),
              "sync events were not published",
            )

            const rows = f.db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
            expect(rows).toHaveLength(2)
            expect(rows.map((row) => row.seq).sort()).toEqual([0, 1])
            expect(new Set(rows.map((row) => row.id)).size).toBe(2)
            expect(rows.map((row) => row.data.delta).sort()).toEqual(["first", "second"])
            expect(f.db.select().from(EventSequenceTable).get()?.seq).toBe(1)
            expect(events).toHaveLength(2)
          } finally {
            dispose()
          }
        }),
      )
    }),
  )
})
