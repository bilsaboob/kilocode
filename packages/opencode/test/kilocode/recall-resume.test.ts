import { describe, expect, test } from "bun:test"
import { resumeScope } from "../../src/tool/recall"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"

function user(sessionID: SessionID, resume: boolean) {
  const messageID = MessageID.ascending()
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "code",
      model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("test") },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID,
        sessionID,
        type: "text",
        text: resume ? "resume where interrupted" : "research prior sessions",
        ...(resume ? { metadata: { session_resume: true, resume_kind: "manual" } } : {}),
      },
    ],
  } as MessageV2.WithParts
}

describe("local recall resume scope", () => {
  test("blocks another session and allows the current session during resume", () => {
    const sessionID = SessionID.make("ses_current")
    const ctx = { sessionID, messages: [user(sessionID, true)] }
    expect(resumeScope(ctx)).toEqual({ active: true, allowed: true })
    expect(resumeScope(ctx, sessionID)).toEqual({ active: true, allowed: true })
    expect(resumeScope(ctx, "ses_other")).toEqual({ active: true, allowed: false })
  })

  test("keeps normal cross-session recall outside resume", () => {
    const sessionID = SessionID.make("ses_current")
    expect(resumeScope({ sessionID, messages: [user(sessionID, false)] }, "ses_other")).toEqual({
      active: false,
      allowed: true,
    })
  })
})
