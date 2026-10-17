import { Effect } from "effect"
import { Database, eq } from "@/storage/db"
import { MessageTable, PartTable } from "@/session/session.sql"
import type { MessageID, PartID, SessionID } from "@/session/schema"

export namespace KiloSessionIdentity {
  export class Conflict extends Error {
    override readonly name = "SessionIdentityConflict"
    constructor() {
      super("Message or part ID is already owned by another request")
    }
  }

  const initial = new WeakMap<object, { commit?: () => void }>()

  export function create<T extends { id: MessageID }, E, R>(
    info: T,
    write: (value: T) => Effect.Effect<unknown, E, R>,
    commit?: () => void,
  ): Effect.Effect<T, E, R> {
    return Effect.suspend(() => {
      // Private object identity survives the legacy transaction callback bridge;
      // insert-only intent is never a caller-supplied or persisted JSON field.
      const value = { ...info }
      initial.set(value, { commit })
      return Effect.suspend(() => write(value)).pipe(
        Effect.as(info),
        Effect.ensuring(Effect.sync(() => initial.delete(value))),
      )
    })
  }

  export function persisted(info: object) {
    const commit = initial.get(info)?.commit
    if (commit) Database.effect(commit)
  }

  export function message(
    db: Database.TxOrDb,
    input: { id: MessageID; sessionID: SessionID; role?: "user" | "assistant" },
    sessionID = input.sessionID,
  ) {
    if (sessionID !== input.sessionID) throw new Conflict()
    const row = db.select().from(MessageTable).where(eq(MessageTable.id, input.id)).get()
    if (
      row &&
      (row.session_id !== sessionID || (input.role !== undefined && row.data.role !== input.role) || initial.has(input))
    )
      throw new Conflict()
    return row
  }

  export function part(
    db: Database.TxOrDb,
    input: { id: PartID; messageID: MessageID; sessionID: SessionID },
    sessionID = input.sessionID,
  ) {
    if (sessionID !== input.sessionID) throw new Conflict()
    message(db, { id: input.messageID, sessionID })
    const row = db.select().from(PartTable).where(eq(PartTable.id, input.id)).get()
    if (row && (row.session_id !== sessionID || row.message_id !== input.messageID)) throw new Conflict()
    return row
  }

  export function prompt(input: { sessionID: SessionID; messageID?: MessageID; parts?: readonly { id?: PartID }[] }) {
    Database.use((db) => {
      if (input.messageID && message(db, { id: input.messageID, sessionID: input.sessionID, role: "user" })) return
      const ids = new Set<PartID>()
      for (const item of input.parts ?? []) {
        if (!item.id) continue
        if (ids.has(item.id) || db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.id, item.id)).get())
          throw new Conflict()
        ids.add(item.id)
      }
    })
  }
}
