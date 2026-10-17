import { spawn } from "node:child_process"
import path from "node:path"

export function worker(input: {
  root: string
  state: string
  role: "refresh" | "hold" | "set" | "service" | "logout" | "relogin"
  stale?: boolean
  provider?: string
  url?: string
}) {
  const proc = spawn(
    process.execPath,
    [path.join(import.meta.dir, "codex-auth-refresh-worker.ts"), JSON.stringify(input)],
    {
      cwd: path.join(import.meta.dir, "../../.."),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  )
  const seen = new Set<string>()
  const waiting = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const errors: Buffer[] = []
  proc.stderr!.on("data", (data) => errors.push(Buffer.from(data)))
  proc.on("message", (message) => {
    if (typeof message !== "string") throw new Error("Invalid auth fixture signal")
    seen.add(message)
    waiting.get(message)?.resolve()
  })
  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code === 0) return resolve()
      const error = new Error(`Auth fixture exited ${code}: ${Buffer.concat(errors).toString()}`)
      for (const promise of waiting.values()) promise.reject(error)
      reject(error)
    })
  })
  return {
    proc,
    done,
    wait(event: string) {
      if (seen.has(event)) return Promise.resolve()
      const promise = waiting.get(event) ?? Promise.withResolvers<void>()
      waiting.set(event, promise)
      return promise.promise
    },
    start() {
      proc.send("start")
    },
    [Symbol.dispose]() {
      if (proc.exitCode === null) proc.kill()
    },
  }
}
