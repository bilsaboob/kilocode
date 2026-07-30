import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { and, asc, eq, inArray, ne } from "drizzle-orm"
import type { TxOrDb } from "@/storage/db"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { FileActivityTable } from "./file-activity.sql"

export const Action = Schema.Literals(["read", "created", "modified", "deleted"]).annotate({
  identifier: "KiloFileActivityAction",
})
export type Action = typeof Action.Type

export const Tool = Schema.Literals(["read", "write", "edit", "apply_patch"]).annotate({
  identifier: "KiloFileActivityTool",
})
export type Tool = typeof Tool.Type

export const Info = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: PartID,
  callID: Schema.String,
  tool: Tool,
  path: Schema.String,
  action: Action,
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
}).annotate({ identifier: "KiloFileActivity" })
export type Info = typeof Info.Type

type Entry = { path: string; action: Action }
type CompletedPart = Omit<MessageV2.ToolPart, "state"> & { state: MessageV2.ToolStateCompleted }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolve(value: unknown, dir: string) {
  if (typeof value !== "string" || value.length === 0) return
  const file = path.isAbsolute(value) ? path.normalize(value) : path.resolve(dir, value)
  return file.replaceAll("\\", "/")
}

function read(part: CompletedPart, dir: string): Entry[] {
  const values = [part.state.input.filePath]
  const loaded = part.state.metadata.loaded
  if (Array.isArray(loaded)) values.push(...loaded)
  return values.flatMap((value) => {
    const file = resolve(value, dir)
    return file ? [{ path: file, action: "read" as const }] : []
  })
}

function write(part: CompletedPart, dir: string): Entry[] {
  const file = resolve(part.state.metadata.filepath, dir)
  const exists = part.state.metadata.exists
  if (!file || typeof exists !== "boolean") return []
  return [{ path: file, action: exists ? "modified" : "created" }]
}

function edit(part: CompletedPart, dir: string): Entry[] {
  const diff = part.state.metadata.filediff
  if (!record(diff)) return []
  const file = resolve(diff.file, dir)
  return file ? [{ path: file, action: "modified" }] : []
}

function patch(part: CompletedPart, dir: string): Entry[] {
  const files = part.state.metadata.files
  if (!Array.isArray(files)) return []
  return files.flatMap((value): Entry[] => {
    if (!record(value)) return []
    const file = resolve(value.filePath, dir)
    if (!file) return []
    if (value.type === "add") return [{ path: file, action: "created" }]
    if (value.type === "update") return [{ path: file, action: "modified" }]
    if (value.type === "delete") return [{ path: file, action: "deleted" }]
    if (value.type !== "move") return []
    const target = resolve(value.movePath, dir)
    if (!target) return []
    return [
      { path: file, action: "deleted" },
      { path: target, action: "created" },
    ]
  })
}

const extractors = { read, write, edit, apply_patch: patch } satisfies Record<
  Tool,
  (part: CompletedPart, dir: string) => Entry[]
>

export function project(db: TxOrDb, part: MessageV2.Part) {
  if (part.type !== "tool" || part.state.status !== "completed") return
  if (!Object.hasOwn(extractors, part.tool)) return
  const completed = part as CompletedPart
  const tool = part.tool as Tool
  const session = db
    .select({ directory: SessionTable.directory })
    .from(SessionTable)
    .where(eq(SessionTable.id, part.sessionID))
    .get()
  if (!session) return
  const rows = extractors[tool](completed, session.directory).map((entry) => ({
    session_id: part.sessionID,
    message_id: part.messageID,
    part_id: part.id,
    call_id: part.callID,
    tool,
    path: entry.path,
    action: entry.action,
    time_created: completed.state.time.end,
  }))
  if (rows.length === 0) return
  db.insert(FileActivityTable).values(rows).onConflictDoNothing().run()
}

export interface Interface {
  readonly list: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/FileActivity") {}

export const list = Effect.fn("FileActivity.list")((sessionID: SessionID) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(FileActivityTable)
        .where(eq(FileActivityTable.session_id, sessionID))
        .orderBy(
          asc(FileActivityTable.time_created),
          asc(FileActivityTable.message_id),
          asc(FileActivityTable.part_id),
          asc(FileActivityTable.path),
          asc(FileActivityTable.action),
        )
        .all()
        .map((row) => ({
          sessionID: row.session_id,
          messageID: row.message_id,
          partID: row.part_id,
          callID: row.call_id,
          tool: row.tool,
          path: row.path,
          action: row.action,
          time: { created: row.time_created },
        })),
    ),
  ),
)

export const shared = Effect.fn("FileActivity.shared")(function* (sessionID: SessionID, paths: string[]) {
  if (paths.length === 0) return new Map<string, SessionID[]>()
  const rows = Database.use((db) =>
    db
      .select({ path: FileActivityTable.path, sessionID: FileActivityTable.session_id })
      .from(FileActivityTable)
      .where(
        and(
          inArray(FileActivityTable.path, [...new Set(paths)]),
          ne(FileActivityTable.session_id, sessionID),
          ne(FileActivityTable.action, "read"),
        ),
      )
      .all(),
  )
  const result = new Map<string, SessionID[]>()
  for (const row of rows) {
    const sessions = result.get(row.path) ?? []
    if (!sessions.includes(row.sessionID)) sessions.push(row.sessionID)
    result.set(row.path, sessions)
  }
  return result
})

export const layer = Layer.succeed(Service, Service.of({ list }))

export const defaultLayer = layer

export * as FileActivity from "."
