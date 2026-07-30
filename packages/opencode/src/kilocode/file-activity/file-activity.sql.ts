import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@/session/session.sql"
import type { MessageID, PartID, SessionID } from "@/session/schema"
import type { Action, Tool } from "./index"

export const FileActivityTable = sqliteTable(
  "kilo_session_file_activity",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().$type<MessageID>().notNull(),
    part_id: text().$type<PartID>().notNull(),
    call_id: text().notNull(),
    tool: text().$type<Tool>().notNull(),
    path: text().notNull(),
    action: text().$type<Action>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.part_id, table.path, table.action] }),
    index("kilo_session_file_activity_session_time_idx").on(
      table.session_id,
      table.time_created,
      table.message_id,
      table.part_id,
    ),
  ],
)
