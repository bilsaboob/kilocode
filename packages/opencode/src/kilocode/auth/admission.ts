import { Cause, Effect, Exit } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { MessageID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import type { SessionStatus } from "@/session/status"
import type { Bus } from "@/bus"
import { KiloAuth } from "./authority"
import { AuthOutcome } from "./outcome"

export namespace AuthAdmission {
  export const check = Effect.fn("AuthAdmission.check")(function* (input: {
    user: MessageV2.User
    auth: ReturnType<typeof KiloAuth.bind>
    sessions: Session.Interface
    status: SessionStatus.Interface
    bus: Bus.Interface
  }) {
    const user = input.user
    const result = yield* input.auth
      .request({
        snapshot: user.authAuthority,
        model: { providerID: user.model.providerID, id: user.model.modelID },
        sessionID: user.sessionID,
        messageID: user.id,
      })
      .pipe(Effect.exit)
    if (Exit.isSuccess(result)) {
      result.value.close()
      return true
    }
    const failure = AuthOutcome.known(Cause.squash(result.cause))
    if (!failure) return yield* Effect.failCause(result.cause)
    const ctx = yield* InstanceState.context
    const error = MessageV2.fromError(failure, { providerID: user.model.providerID })
    const now = Date.now()
    yield* input.sessions.updateMessage({
      id: MessageID.ascending(),
      parentID: user.id,
      sessionID: user.sessionID,
      role: "assistant",
      agent: user.agent,
      mode: user.agent,
      providerID: user.model.providerID,
      modelID: user.model.modelID,
      path: { cwd: ctx.directory, root: ctx.worktree },
      time: { created: now, completed: now },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "error",
      error,
    })
    yield* input.bus.publish(Session.Event.Error, { sessionID: user.sessionID, error })
    yield* input.status.set(user.sessionID, { type: "idle" })
    return false
  })
}
