import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect } from "effect"

export namespace KiloRuntime {
  export class Conflict extends Error {
    constructor(readonly reason: "active" | "changed" | "leased") {
      super(
        reason === "active"
          ? "Runtime work is still active or settling"
          : reason === "changed"
            ? "Runtime identity or quiescence lease changed"
            : "Runtime is reserved for a guarded restart",
      )
      this.name = "RuntimeConflict"
    }
  }

  export function make(input: { id: string; version: string; now?: () => number; ttl?: number }) {
    const now = input.now ?? Date.now
    const ttl = Math.min(30_000, Math.max(1, input.ttl ?? 15_000))
    let active = 0
    let lease: { runtimeID: string; token: string; expiresAt: number } | undefined
    const current = () => {
      if (lease && lease.expiresAt <= now()) lease = undefined
      return lease
    }
    const enter = () => {
      if (current()) throw new Conflict("leased")
      active++
      let held = true
      return () => {
        if (!held) return
        held = false
        active--
      }
    }
    const work = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(enter),
        () => effect,
        (release) => Effect.sync(release),
      )
    const track = async <A>(run: () => Promise<A>): Promise<A> => {
      const release = enter()
      try {
        return await run()
      } finally {
        release()
      }
    }
    const child = <A extends { once(event: "close", listener: () => void): unknown }>(spawn: () => A): A => {
      const release = enter()
      try {
        const proc = spawn()
        // An exit/status update can precede output-stream and OS-handle settlement.
        proc.once("close", release)
        return proc
      } catch (error) {
        release()
        throw error
      }
    }
    return {
      info: Object.freeze({
        id: input.id,
        version: input.version,
        capabilities: Object.freeze([
          "zen-context-policy-v1",
          "auth-authority-v1",
          "auth-readiness-v1",
          "usage-measurement-v1",
          "runtime-quiesce-v1",
          "compaction-ownership-v1",
          "compaction-budget-v1",
        ]),
      }),
      enter,
      work,
      track,
      child,
      quiesce(runtimeID: string) {
        if (runtimeID !== input.id) throw new Conflict("changed")
        if (current()) throw new Conflict("leased")
        if (active !== 0) throw new Conflict("active")
        lease = { runtimeID, token: crypto.randomUUID(), expiresAt: now() + ttl }
        return { ...lease }
      },
      release(runtimeID: string, token: string) {
        if (runtimeID !== input.id || current()?.token !== token) throw new Conflict("changed")
        lease = undefined
        return true
      },
    }
  }

  // One identity and admission gate per process, never per workspace or service layer.
  const process = make({ id: crypto.randomUUID(), version: InstallationVersion })
  export const { info, enter, work, track, child, quiesce, release } = process
}
