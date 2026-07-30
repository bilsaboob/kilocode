import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FileActivity } from "@/kilocode/file-activity"
import { MessageV2 } from "@/session/message-v2"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const env = Layer.mergeAll(Session.defaultLayer, FileActivity.defaultLayer, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

const slash = (value: string) => value.replaceAll("\\", "/")

describe("session file activity", () => {
  it.instance("projects completed deterministic tool parts", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const activity = yield* FileActivity.Service
      const session = yield* sessions.create({ title: "activity" })
      const message = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user",
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: 1 },
      })

      const read = {
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: session.id,
        type: "tool" as const,
        callID: "call-read",
        tool: "read",
        state: {
          status: "pending" as const,
          input: { filePath: "src/main.ts" },
          raw: "",
        },
      }
      yield* sessions.updatePart(read)
      expect(yield* activity.list(session.id)).toEqual([])

      yield* sessions.updatePart({
        ...read,
        state: {
          status: "completed",
          input: read.state.input,
          title: "src/main.ts",
          output: "contents",
          metadata: { loaded: [path.join(test.directory, "AGENTS.md")] },
          time: { start: 1, end: 2 },
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: session.id,
        type: "tool",
        callID: "call-write",
        tool: "write",
        state: {
          status: "completed",
          input: { filePath: "new.ts", content: "new" },
          title: "new.ts",
          output: "written",
          metadata: { filepath: path.join(test.directory, "new.ts"), exists: false },
          time: { start: 2, end: 3 },
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: session.id,
        type: "tool",
        callID: "call-edit",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "src/main.ts", oldString: "old", newString: "new" },
          title: "src/main.ts",
          output: "edited",
          metadata: { filediff: { file: path.join(test.directory, "src/main.ts") } },
          time: { start: 3, end: 4 },
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: session.id,
        type: "tool",
        callID: "call-patch",
        tool: "apply_patch",
        state: {
          status: "completed",
          input: { patchText: "patch" },
          title: "patched",
          output: "patched",
          metadata: {
            files: [
              { filePath: path.join(test.directory, "added.ts"), type: "add" },
              { filePath: path.join(test.directory, "old.ts"), type: "move", movePath: "moved.ts" },
              { filePath: path.join(test.directory, "deleted.ts"), type: "delete" },
            ],
          },
          time: { start: 4, end: 5 },
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: session.id,
        type: "tool",
        callID: "call-bash",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo ignored" },
          title: "bash",
          output: "ignored",
          metadata: {},
          time: { start: 5, end: 6 },
        },
      })

      const rows = yield* activity.list(session.id)
      expect(rows.map((row) => [row.tool, row.action, row.path])).toEqual([
        ["read", "read", slash(path.join(test.directory, "AGENTS.md"))],
        ["read", "read", slash(path.join(test.directory, "src/main.ts"))],
        ["write", "created", slash(path.join(test.directory, "new.ts"))],
        ["edit", "modified", slash(path.join(test.directory, "src/main.ts"))],
        ["apply_patch", "created", slash(path.join(test.directory, "added.ts"))],
        ["apply_patch", "deleted", slash(path.join(test.directory, "deleted.ts"))],
        ["apply_patch", "created", slash(path.join(test.directory, "moved.ts"))],
        ["apply_patch", "deleted", slash(path.join(test.directory, "old.ts"))],
      ])
      expect(rows.every((row) => row.sessionID === session.id && row.messageID === message.id)).toBe(true)

      yield* sessions.updatePart({
        ...read,
        state: {
          status: "completed",
          input: read.state.input,
          title: "src/main.ts",
          output: "contents",
          metadata: { loaded: [path.join(test.directory, "AGENTS.md")] },
          time: { start: 1, end: 2 },
        },
      })
      expect(yield* activity.list(session.id)).toHaveLength(rows.length)

      const other = yield* sessions.create({ title: "other" })
      expect(yield* activity.list(other.id)).toEqual([])

      Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run())
      expect(yield* activity.list(session.id)).toEqual([])
    }),
  )
})
