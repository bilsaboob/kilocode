import { afterEach, describe, expect, test } from "bun:test"
import { NamedError } from "@opencode-ai/core/util/error"
import { KiloSessionRecovery } from "../../src/kilocode/session/recovery"
import { MessageError } from "../../src/session/message-error"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessions = [SessionID.make("ses_recovery_a"), SessionID.make("ses_recovery_b")]

afterEach(() => {
  for (const sessionID of sessions) KiloSessionRecovery.reset(sessionID)
})

function user(sessionID: SessionID, text: string, opts?: { auto?: boolean; token?: number }) {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "code",
      model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.6-sol"), variant: "high" },
      system: "project context",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID,
        type: "text",
        text,
        metadata: opts?.auto ? { auto_resume: true, recovery_token: opts.token } : undefined,
      },
    ],
  } as MessageV2.WithParts
}

function assistant(input: {
  sessionID: SessionID
  parentID: MessageID
  error?: MessageV2.Assistant["error"]
  finish?: string
}) {
  return {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    parentID: input.parentID,
    role: "assistant",
    mode: "code",
    agent: "code",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "gpt-5.6-sol",
    providerID: "openai",
    time: { created: Date.now(), completed: Date.now() },
    error: input.error,
    finish: input.finish,
  } as MessageV2.Assistant
}

function failure(sessionID = sessions[0], text = "Implement the session recovery state machine") {
  const prompt = user(sessionID, text)
  const reply = assistant({
    sessionID,
    parentID: prompt.info.id,
    error: new MessageV2.APIError({
      message: "An error occurred while processing your request.",
      isRetryable: true,
      responseBody: '{"error":{"code":"server_error"}}',
    }).toObject(),
  })
  return { prompt, reply, messages: [prompt, { info: reply, parts: [] }] as MessageV2.WithParts[] }
}

function auto(sessionID: SessionID, token: number) {
  return user(sessionID, "Continue", { auto: true, token }).parts
}

describe("automatic session recovery", () => {
  test("recognizes terminal interruptions without retrying user aborts or auth errors", () => {
    const base = failure()
    expect(KiloSessionRecovery.interrupted(base.reply)).toBe(true)
    expect(
      KiloSessionRecovery.interrupted(
        assistant({ sessionID: sessions[0], parentID: base.prompt.info.id, finish: "length" }),
      ),
    ).toBe(true)
    expect(
      KiloSessionRecovery.interrupted(
        assistant({
          sessionID: sessions[0],
          parentID: base.prompt.info.id,
          error: new MessageV2.ContextOverflowError({ message: "maximum context" }).toObject(),
        }),
      ),
    ).toBe(true)
    expect(
      KiloSessionRecovery.interrupted(
        assistant({
          sessionID: sessions[0],
          parentID: base.prompt.info.id,
          error: new MessageV2.APIError({
            message: "Connection reset by server while reading the response",
            isRetryable: false,
          }).toObject(),
        }),
      ),
    ).toBe(true)
    expect(
      KiloSessionRecovery.interrupted(
        assistant({
          sessionID: sessions[0],
          parentID: base.prompt.info.id,
          error: new MessageV2.APIError({
            message: "Maximum output token limit reached",
            isRetryable: false,
          }).toObject(),
        }),
      ),
    ).toBe(true)
    expect(
      KiloSessionRecovery.interrupted(
        assistant({
          sessionID: sessions[0],
          parentID: base.prompt.info.id,
          error: new MessageV2.APIError({ message: "Invalid API key", isRetryable: false }).toObject(),
        }),
      ),
    ).toBe(false)
    expect(
      KiloSessionRecovery.interrupted(
        assistant({
          sessionID: sessions[0],
          parentID: base.prompt.info.id,
          error: new NamedError.Unknown({ message: "unexpected transport failure" }).toObject(),
        }),
      ),
    ).toBe(true)
    expect(
      KiloSessionRecovery.interrupted(
        assistant({
          sessionID: sessions[0],
          parentID: base.prompt.info.id,
          error: new MessageV2.AbortedError({ message: "Aborted" }).toObject(),
        }),
      ),
    ).toBe(false)
    expect(
      KiloSessionRecovery.interrupted(
        assistant({
          sessionID: sessions[0],
          parentID: base.prompt.info.id,
          error: new MessageError.AuthError({ providerID: "openai", message: "Sign in" }).toObject(),
        }),
      ),
    ).toBe(false)
  })

  test("uses two immediate retries, a ten minute cooldown, then pauses", () => {
    const first = failure()
    expect(KiloSessionRecovery.begin(sessions[0], first.prompt.parts)).toBe("user")

    const one = KiloSessionRecovery.finish({ sessionID: sessions[0], message: first.reply, messages: first.messages })
    expect(one).toMatchObject({ action: "resume", count: 1, delay: 0 })
    if (!one || one.action !== "resume") throw new Error("expected first recovery")
    expect(KiloSessionRecovery.begin(sessions[0], auto(sessions[0], one.token))).toBe("auto")

    const two = KiloSessionRecovery.finish({ sessionID: sessions[0], message: first.reply, messages: first.messages })
    expect(two).toMatchObject({ action: "resume", count: 2, delay: 0 })
    if (!two || two.action !== "resume") throw new Error("expected second recovery")
    expect(KiloSessionRecovery.begin(sessions[0], auto(sessions[0], two.token))).toBe("auto")

    const three = KiloSessionRecovery.finish({ sessionID: sessions[0], message: first.reply, messages: first.messages })
    expect(three).toMatchObject({ action: "resume", count: 3, delay: KiloSessionRecovery.COOLDOWN })
    if (!three || three.action !== "resume") throw new Error("expected cooldown recovery")
    expect(KiloSessionRecovery.claim(sessions[0], three.token)).toBe(true)
    expect(KiloSessionRecovery.begin(sessions[0], auto(sessions[0], three.token))).toBe("auto")

    const four = KiloSessionRecovery.finish({ sessionID: sessions[0], message: first.reply, messages: first.messages })
    expect(four).toMatchObject({ action: "pause", count: 4 })
    expect(KiloSessionRecovery._state(sessions[0])?.paused).toBe(true)
  })

  test("keeps concurrent session retry state isolated", () => {
    const first = failure(sessions[0], "Session A topic")
    const second = failure(sessions[1], "Session B topic")
    const a1 = KiloSessionRecovery.finish({ sessionID: sessions[0], message: first.reply, messages: first.messages })
    const a2 = KiloSessionRecovery.finish({ sessionID: sessions[0], message: first.reply, messages: first.messages })
    const b1 = KiloSessionRecovery.finish({ sessionID: sessions[1], message: second.reply, messages: second.messages })

    expect(a1).toMatchObject({ count: 1, topic: "Session A topic" })
    expect(a2).toMatchObject({ count: 2, topic: "Session A topic" })
    expect(b1).toMatchObject({ count: 1, topic: "Session B topic" })
  })

  test("a successful continuation resets the consecutive error count", () => {
    const failed = failure()
    const first = KiloSessionRecovery.finish({
      sessionID: sessions[0],
      message: failed.reply,
      messages: failed.messages,
    })
    if (!first || first.action !== "resume") throw new Error("expected first recovery")
    const success = assistant({ sessionID: sessions[0], parentID: failed.prompt.info.id, finish: "stop" })

    expect(
      KiloSessionRecovery.finish({ sessionID: sessions[0], message: success, messages: failed.messages }),
    ).toBeUndefined()
    expect(KiloSessionRecovery.claim(sessions[0], first.token)).toBe(false)

    const next = KiloSessionRecovery.finish({
      sessionID: sessions[0],
      message: failed.reply,
      messages: failed.messages,
    })
    expect(next).toMatchObject({ action: "resume", count: 1 })
  })

  test("explicit user input cancels a pending cooldown and resets the count", () => {
    const failed = failure()
    KiloSessionRecovery.finish({ sessionID: sessions[0], message: failed.reply, messages: failed.messages })
    KiloSessionRecovery.finish({ sessionID: sessions[0], message: failed.reply, messages: failed.messages })
    const delayed = KiloSessionRecovery.finish({
      sessionID: sessions[0],
      message: failed.reply,
      messages: failed.messages,
    })
    if (!delayed || delayed.action !== "resume") throw new Error("expected cooldown recovery")

    const next = user(sessions[0], "User supplied a new direction")
    expect(KiloSessionRecovery.begin(sessions[0], next.parts)).toBe("user")
    expect(KiloSessionRecovery.claim(sessions[0], delayed.token)).toBe(false)
    expect(KiloSessionRecovery.valid(sessions[0], auto(sessions[0], delayed.token))).toBe(false)

    const again = KiloSessionRecovery.finish({ sessionID: sessions[0], message: failed.reply, messages: [next] })
    expect(again).toMatchObject({ action: "resume", count: 1, topic: "User supplied a new direction" })
  })

  test("preserves the originating session topic and model context", () => {
    const failed = failure(sessions[0], "Investigate the Codex connection reset without restarting completed work")
    const decision = KiloSessionRecovery.finish({
      sessionID: sessions[0],
      message: failed.reply,
      messages: failed.messages,
    })
    const source = KiloSessionRecovery.source(failed.messages, failed.reply)

    expect(decision?.topic).toBe("Investigate the Codex connection reset without restarting completed work")
    expect(source?.model.providerID).toBe(ProviderID.make("openai"))
    expect(source?.model.modelID).toBe(ModelID.make("gpt-5.6-sol"))
    expect(source?.model.variant).toBe("high")
    expect(source?.system).toBe("project context")
    expect(KiloSessionRecovery.text(decision?.topic ?? "")).toContain("existing chat history and tool results only")
  })
})
