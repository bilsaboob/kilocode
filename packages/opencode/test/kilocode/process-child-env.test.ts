import { describe, expect } from "bun:test"
import path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundProcess } from "@/kilocode/background-process"
import { ChildEnv } from "@/kilocode/process/child-env"
import { Plugin } from "@/plugin"
import { Pty } from "@/pty"
import { MessageID, SessionID } from "@/session/schema"
import { Shell } from "@/shell/shell"
import { Tool } from "@/tool/tool"
import { ShellTool } from "@/tool/shell"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const keys = [
  "ZEN_KNOWLEDGE_TOOL_URL",
  "ZEN_KNOWLEDGE_TOOL_TOKEN",
  "ZEN_MEMORY_TOOL_URL",
  "ZEN_MEMORY_TOOL_TOKEN",
] as const
const marker = "child-env::end"
const shell = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
)
const it = testEffect(Layer.mergeAll(shell, Pty.defaultLayer, Bus.layer))
const ctx = {
  sessionID: SessionID.make("ses_child_env"),
  messageID: MessageID.make("msg_child_env"),
  callID: "call_child_env",
  agent: "code",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} satisfies Tool.Context

function secrets() {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
      for (const key of keys) process.env[key] = `secret-${key.toLowerCase()}`
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const key of keys) {
          const value = previous[key]
          if (value === undefined) delete process.env[key]
          if (value !== undefined) process.env[key] = value
        }
      }),
  )
}

function quote(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`
}

function script(dir: string) {
  return Effect.promise(async () => {
    const file = path.join(dir, "child-env.mjs")
    await Bun.write(
      file,
      `const keys = ${JSON.stringify(keys)}
console.log("child-env:" + keys.filter((key) => Object.hasOwn(process.env, key)).join(",") + ":end")
await new Promise((resolve) => setTimeout(resolve, 1_000))
`,
    )
    const command = `${quote(process.execPath)} ${quote(file)}`
    return { file, direct: command, command: Shell.ps(Shell.acceptable()) ? `& ${command}` : command }
  })
}

describe("Zen child environment isolation", () => {
  it.instance(
    "scrubs shell, PTY, and background-process children",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* secrets()
        const input = yield* script(test.directory)

        const clean = ChildEnv.scrub({ keep: "yes", ...Object.fromEntries(keys.map((key) => [key, "secret"])) })
        expect(clean).toEqual({ keep: "yes" })

        const info = yield* ShellTool
        const tool = yield* info.init()
        const output = yield* tool.execute({ command: input.command, description: "inspect child environment" }, ctx)
        expect(output.output).toContain(marker)

        const pty = yield* Pty.Service
        const terminal = yield* pty.create({ title: "child env" })
        const chunks: string[] = []
        const received = Promise.withResolvers<void>()
        yield* pty.connect(terminal.id, {
          readyState: 1,
          send: (data) => {
            if (typeof data !== "string") return
            chunks.push(data)
            if (chunks.join("").includes(marker)) received.resolve()
          },
          close: () => {},
        })
        const command = Shell.ps(terminal.command) ? `& ${input.direct}` : input.direct
        yield* pty.write(terminal.id, command + (process.platform === "win32" ? "\r" : "\n"))
        yield* Effect.promise(() => received.promise).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new Error(`PTY child did not produce output: ${JSON.stringify(chunks)}`)),
          }),
        )
        expect(chunks.join("")).toContain(marker)
        yield* pty.remove(terminal.id)

        const background = yield* Effect.promise(() =>
          BackgroundProcess.start({
            sessionID: ctx.sessionID,
            command: input.command,
            cwd: test.directory,
            ready: { pattern: marker, timeout: 5_000 },
          }),
        )
        expect(background.output).toContain(marker)
        yield* Effect.promise(() => BackgroundProcess.stopSession(ctx.sessionID))
      }),
    15_000,
  )
})
