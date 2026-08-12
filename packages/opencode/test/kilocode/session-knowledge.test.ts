import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionKnowledge } from "@/kilocode/session/knowledge"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)
const full = {
  scopes: [
    { kind: "knowledge_reference" as const, knowledgeBaseID: "kb_alpha", snapshotID: "kbs_one" },
    { kind: "knowledge_reference" as const, knowledgeBaseID: "kb_beta", snapshotID: "kbs_two" },
  ],
  grant: "opaque-grant",
}
const project = {
  kind: "project_target_index" as const,
  projectID: "prj_alpha",
  rootIdentity: "piroot_0123456789abcdef",
}

describe("session Knowledge", () => {
  it.effect("injects conditional target/reference guidance without grants", () =>
    Effect.sync(() => {
      expect(KiloSessionPrompt.knowledgeGuidance(undefined)).toBeUndefined()
      expect(KiloSessionPrompt.knowledgeGuidance({ scopes: full.scopes })).toBeUndefined()
      const guidance = KiloSessionPrompt.knowledgeGuidance(full)
      expect(guidance).toContain("kb_alpha @ kbs_one")
      expect(guidance).toContain("target workspace")
      expect(guidance).toContain("zen_discover_knowledge")
      expect(guidance).not.toContain(full.grant)
    }),
  )

  it.effect("validates exact portable scopes and opaque grants", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(SessionKnowledge.Info)
      expect(decode(full)).toEqual(full)
      expect(decode({ scopes: [{ knowledgeBaseID: "kb_legacy", snapshotID: "kbs_legacy" }] })).toEqual({
        scopes: [{ knowledgeBaseID: "kb_legacy", snapshotID: "kbs_legacy" }],
      })
      expect(decode({ scopes: [project], grant: "project-grant" })).toEqual({
        scopes: [project],
        grant: "project-grant",
      })
      expect(() => decode({ scopes: [{ knowledgeBaseID: "bad id" }], grant: "opaque-grant" })).toThrow()
      expect(() => decode({ scopes: [{ ...project, rootIdentity: "bad identity" }], grant: "opaque-grant" })).toThrow()
      expect(() => decode({ scopes: [{ knowledgeBaseID: "kb_alpha" }], grant: "line\nbreak" })).toThrow()
    }),
  )

  it.instance("persists first-class scopes in metadata and preserves unrelated metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({
        title: "scoped",
        metadata: { keep: true, [SessionKnowledge.key]: { grant: "must-not-log" } },
        knowledge: full,
      })
      const row = Database.use((db) =>
        db.select({ metadata: SessionTable.metadata }).from(SessionTable).where(eq(SessionTable.id, root.id)).get(),
      )

      expect(row?.metadata).toEqual({ keep: true, [SessionKnowledge.key]: full })
      expect(root.metadata).toEqual({ keep: true })
      expect(root.knowledge).toEqual(full)
      expect((yield* sessions.get(root.id)).knowledge).toEqual(full)
      expect((yield* sessions.list()).find((item) => item.id === root.id)?.knowledge).toEqual(full)

      yield* sessions.setMetadata({ sessionID: root.id, metadata: { changed: true } })
      expect(yield* sessions.get(root.id)).toMatchObject({ metadata: { changed: true }, knowledge: full })

      yield* sessions.setMetadata({ sessionID: root.id, knowledge: { scopes: [full.scopes[0]] } })
      expect(yield* sessions.get(root.id)).toMatchObject({
        metadata: { changed: true },
        knowledge: { scopes: [full.scopes[0]], grant: full.grant },
      })

      yield* sessions.setMetadata({ sessionID: root.id, knowledge: { scopes: [] } })
      expect(yield* sessions.get(root.id)).toMatchObject({ metadata: { changed: true }, knowledge: { scopes: [] } })
    }),
  )

  it.instance("inherits, narrows, and explicitly clears child scopes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", knowledge: full })
      const inherited = yield* sessions.create({ parentID: root.id, title: "inherited" })
      const narrowed = yield* sessions.create({
        parentID: root.id,
        title: "narrowed",
        knowledge: { scopes: [full.scopes[1]] },
      })
      const cleared = yield* sessions.create({ parentID: root.id, title: "cleared", knowledge: { scopes: [] } })

      expect(inherited.knowledge).toEqual(full)
      expect(narrowed.knowledge).toEqual({ scopes: [full.scopes[1]], grant: full.grant })
      expect(cleared.knowledge).toEqual({ scopes: [] })
    }),
  )

  it.instance("inherits and explicitly clears fork scopes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "source", knowledge: full })
      const inherited = yield* sessions.fork({ sessionID: root.id })
      const narrowed = yield* sessions.fork({
        sessionID: root.id,
        knowledge: { scopes: [full.scopes[0]] },
      })
      const cleared = yield* sessions.fork({ sessionID: root.id, knowledge: { scopes: [] } })

      expect(inherited.knowledge).toEqual(full)
      expect(narrowed.knowledge).toEqual({ scopes: [full.scopes[0]], grant: full.grant })
      expect(cleared.knowledge).toEqual({ scopes: [] })
    }),
  )

  it.effect("strips malformed reserved metadata and grants from log payloads", () =>
    Effect.sync(() => {
      expect(SessionKnowledge.split({ keep: true, [SessionKnowledge.key]: { scopes: "invalid" } })).toEqual({
        metadata: { keep: true },
        knowledge: undefined,
      })
      expect(JSON.stringify(SessionKnowledge.logged({ knowledge: full }))).not.toContain(full.grant)
    }),
  )

  it.effect("authorizes exact Project identity and keeps mixed guidance origin-qualified", () =>
    Effect.sync(() => {
      const mixed = { scopes: [...full.scopes, project], grant: "mixed-grant" }
      expect(SessionKnowledge.authorizeProject(mixed, project)).toBe("mixed-grant")
      expect(() => SessionKnowledge.authorizeProject(mixed, { ...project, projectID: "prj_other" })).toThrow(
        "outside this session's Project scope",
      )
      expect(() => SessionKnowledge.authorizeProject({ scopes: [project] }, project)).toThrow("not authorized")
      expect(SessionKnowledge.visible("zen_discover_knowledge", { scopes: [project], grant: "project-grant" })).toBe(
        true,
      )
      expect(SessionKnowledge.visible("zen_discover_knowledge", { scopes: [project] })).toBe(false)
      const guidance = KiloSessionPrompt.knowledgeGuidance(mixed)
      expect(guidance).toContain("target Project Intelligence")
      expect(guidance).toContain("external Wiki references")
      expect(guidance).toContain(project.projectID)
      expect(guidance).not.toContain(project.rootIdentity)
      expect(guidance).not.toContain(mixed.grant)
    }),
  )

  it.instance("prevents child and fork scope expansion while preserving Project inheritance", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const mixed = { scopes: [full.scopes[0], project], grant: "mixed-grant" }
      const root = yield* sessions.create({ title: "project root", knowledge: mixed })
      const inherited = yield* sessions.create({ parentID: root.id, title: "reviewer" })
      const guessed = yield* sessions.create({
        parentID: root.id,
        title: "guessed",
        knowledge: {
          scopes: [
            { ...project, projectID: "prj_other" },
            { ...full.scopes[0], knowledgeBaseID: "kb_other" },
          ],
        },
      })
      const fork = yield* sessions.fork({ sessionID: root.id })

      expect(inherited.knowledge).toEqual(mixed)
      expect(fork.knowledge).toEqual(mixed)
      expect(guessed.knowledge).toEqual({ scopes: [] })
      expect(SessionKnowledge.effective(guessed.knowledge)).toEqual([])

      yield* sessions.setMetadata({
        sessionID: guessed.id,
        knowledge: { scopes: [project], grant: "fresh-project-grant" },
      })
      expect((yield* sessions.get(guessed.id)).knowledge).toEqual({ scopes: [] })

      yield* sessions.setMetadata({
        sessionID: inherited.id,
        knowledge: {
          scopes: [{ ...project, projectID: "prj_other" }],
          grant: "fresh-project-grant",
        },
      })
      expect((yield* sessions.get(inherited.id)).knowledge).toEqual({ scopes: [] })
    }),
  )
})
