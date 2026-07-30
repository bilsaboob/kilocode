import { describe, expect, test } from "bun:test"
import { scope } from "../../src/kilocode/tool/zen-memory"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"

describe("zen_search_memory resume isolation", () => {
  test("forces the current session and excludes global memory", () => {
    const sessionID = SessionID.make("ses_resume_memory")
    const messageID = MessageID.ascending()
    const message = {
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
          text: "resume where interrupted",
          metadata: { session_resume: true, resume_kind: "manual" },
        },
      ],
    } as MessageV2.WithParts

    const result = scope(
      {
        query: "interrupted topic",
        projectID: "prj_current",
        sessionID: "ses_other",
        includeGlobal: true,
      },
      { sessionID, messages: [message] },
    )

    expect(result.sessionID).toBe(sessionID)
    expect(result.includeGlobal).toBe(false)
  })

  test("keeps normal memory search scope outside resume turns", () => {
    const result = scope(
      { query: "cross-session architecture", sessionID: "ses_other", includeGlobal: true },
      { sessionID: SessionID.make("ses_current"), messages: [] },
    )
    expect(result).toEqual({ query: "cross-session architecture", sessionID: "ses_other", includeGlobal: true })
  })
})
