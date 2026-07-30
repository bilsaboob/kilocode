import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as KiloAgent from "@/kilocode/agent"
import * as KiloSkill from "@/kilocode/skill-remove"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { HeapSnapshot } from "@/kilocode/cli/heap-snapshot"
import { InstanceStore } from "@/project/instance-store"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Skill } from "@/skill"
import { RemoveAgentPayload, RemoveSkillPayload } from "../groups/kilocode"
import { FileActivity } from "@/kilocode/file-activity"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import * as SessionError from "@/server/routes/instance/httpapi/handlers/session-errors"

export const kilocodeHandlers = HttpApiBuilder.group(InstanceHttpApi, "kilocode", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const skills = yield* Skill.Service
    const config = yield* Config.Service
    const store = yield* InstanceStore.Service
    const activity = yield* FileActivity.Service
    const sessions = yield* Session.Service

    const heapSnapshot = Effect.fn("KilocodeHttpApi.heapSnapshot")(function* () {
      return yield* Effect.sync(() => HeapSnapshot.write())
    })

    const removeSkill = Effect.fn("KilocodeHttpApi.removeSkill")(function* (ctx: {
      payload: typeof RemoveSkillPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const entries = yield* skills.all()
      yield* Effect.tryPromise({
        try: () => KiloSkill.remove(ctx.payload.location, entries),
        catch: () => new HttpApiError.BadRequest({}),
      })
      yield* store.dispose(instance)
      return true
    })

    const removeAgent = Effect.fn("KilocodeHttpApi.removeAgent")(function* (ctx: {
      payload: typeof RemoveAgentPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const agent = yield* agents.get(ctx.payload.name)
      const dirs = yield* config.directories()
      yield* EffectBridge.fromPromise(() =>
        KiloAgent.remove({ name: ctx.payload.name, agent, dirs, directory: instance.directory }),
      )
      yield* store.dispose(instance)
      return true
    })

    const fileActivity = Effect.fn("KilocodeHttpApi.fileActivity")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* SessionError.mapStorageNotFound(sessions.get(ctx.params.sessionID))
      return yield* activity.list(ctx.params.sessionID)
    })

    return handlers
      .handle("heapSnapshot", heapSnapshot)
      .handle("removeSkill", removeSkill)
      .handle("removeAgent", removeAgent)
      .handle("fileActivity", fileActivity)
  }),
)
