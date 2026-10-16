import { createHash } from "node:crypto"
import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"

const log = Log.create({ service: "db.contention" })
const delays = [100, 200, 400, 800, 1600]
let sequence = 0

type NotPromise<T> = ReturnType<typeof Database.transaction<T>>

function busy(err: unknown): { code: string; errno: number } | undefined {
  // Drizzle can wrap the native SQLite error. Never classify by message text.
  for (let depth = 0; depth < 4 && err && typeof err === "object"; depth++) {
    const value = err as { code?: unknown; errno?: unknown; errcode?: unknown; cause?: unknown }
    const errno = value.errno ?? value.errcode
    if (
      (value.code === "SQLITE_BUSY" || value.code === "ERR_SQLITE_ERROR") &&
      typeof errno === "number" &&
      (errno & 0xff) === 5
    ) {
      return { code: value.code, errno }
    }
    err = value.cause
  }
}

export function transaction<T>(
  callback: (tx: Database.TxOrDb) => NotPromise<T>,
  options: { behavior: "immediate"; operation: string },
): Effect.Effect<NotPromise<T>> {
  return Effect.gen(function* () {
    // Initialization/migrations are deliberately outside the retry boundary.
    const db = Database.Client()
    const timeout = db.get<{ timeout: number }>("PRAGMA busy_timeout")!.timeout
    const sqlite: { readonly inTransaction?: boolean; readonly isTransaction?: boolean } = db.$client
    const nested = sqlite.inTransaction ?? sqlite.isTransaction ?? true
    const started = performance.now()
    const identity = {
      pid: process.pid,
      database: createHash("sha256").update(Database.getPath()).digest("hex").slice(0, 16),
      operation: options.operation,
      id: ++sequence,
      behavior: options.behavior,
      timeout,
      limit: delays.length + 1,
    }

    for (let attempt = 1; ; attempt++) {
      let entered = false
      let pending = false
      let failure: unknown
      const restore = () => {
        if (!pending) return
        db.run(`PRAGMA busy_timeout = ${timeout}`)
        pending = false
      }

      try {
        // Keep the first native wait. Further acquisition attempts fail fast;
        // restore the connection setting before user code or any async yield.
        if (attempt > 1) {
          db.run("PRAGMA busy_timeout = 0")
          pending = true
        }
        const result = Database.transaction<T>((tx) => {
          entered = true
          restore()
          return callback(tx)
        }, options)
        if (attempt > 1) {
          log.info("sqlite transaction recovered", {
            ...identity,
            attempt,
            wait: Math.round(performance.now() - started),
          })
        }
        return result
      } catch (err) {
        failure = err
      } finally {
        restore()
      }

      const error = busy(failure)
      if (!error) throw failure
      const delay = delays[attempt - 1]
      // Callback, commit, deferred effects and nested failures are never replayed.
      const retry = !entered && !nested && delay !== undefined
      log.warn("sqlite transaction contention", {
        ...identity,
        ...error,
        attempt,
        wait: Math.round(performance.now() - started),
        entered,
        nested,
        retry,
        delay: retry ? delay : undefined,
        exhausted: !entered && !nested && !retry,
      })
      if (!retry) throw failure
      yield* Effect.sleep(delay)
    }
  })
}
