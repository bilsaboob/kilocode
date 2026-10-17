import { expect, test } from "bun:test"
import type { Auth } from "@/auth"
import { refreshOAuth } from "@/kilocode/auth/refresh"
import type { AuthStore } from "@/kilocode/auth/store"
import { KiloRuntime } from "@/kilocode/runtime/control"

test("production OAuth refresh excludes quiescence through its persistence barrier", async () => {
  const baseline = KiloRuntime.quiesce(KiloRuntime.info.id)
  KiloRuntime.release(baseline.runtimeID, baseline.token)
  const started = Promise.withResolvers<void>()
  const network = Promise.withResolvers<void>()
  const saving = Promise.withResolvers<void>()
  const persisted = Promise.withResolvers<void>()
  const auth: Auth.Oauth = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 0 }
  const snapshot: AuthStore.Snapshot = {
    store: "runtime-memory-fixture",
    source: "disk",
    provider: "openai",
    epoch: crypto.randomUUID(),
    loginGeneration: crypto.randomUUID(),
    tokenRevision: 0,
    fingerprint: "fixture",
    value: auth,
  }
  // This is an in-memory adapter for the real refresh coordinator; no auth files, locks or provider requests exist.
  const store = {
    run: <A>(work: () => A) => work(),
    snapshot: async () => snapshot,
    check: async () => snapshot,
    exchange: async (_snapshot: AuthStore.Snapshot, work: () => Promise<AuthStore.Snapshot>) => work(),
    commit: async (current: AuthStore.Snapshot, value: Auth.Info) => {
      saving.resolve()
      await persisted.promise
      return { ...current, value, tokenRevision: current.tokenRevision + 1 }
    },
    adopt: async (current: AuthStore.Snapshot) => current.value!,
  } as unknown as ReturnType<typeof AuthStore.create>
  let calls = 0
  const input = {
    provider: "openai",
    auth,
    store,
    expired: () => true,
    refresh: async () => {
      calls++
      started.resolve()
      await network.promise
      return { ...auth, access: "fixture-rotated", expires: 1 }
    },
  }
  const active = () => {
    try {
      const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
      KiloRuntime.release(lease.runtimeID, lease.token)
      return false
    } catch (error) {
      if (!(error instanceof KiloRuntime.Conflict)) throw error
      return error.reason === "active"
    }
  }
  const flight = refreshOAuth(input)
  await started.promise
  const refreshing = active()
  network.resolve()
  await saving.promise
  const committing = active()
  persisted.resolve()
  await flight
  const lease = KiloRuntime.quiesce(KiloRuntime.info.id)
  let refused = false
  try {
    await refreshOAuth(input).catch((error) => {
      if (!(error instanceof KiloRuntime.Conflict)) throw error
      refused = error.reason === "leased"
    })
  } finally {
    KiloRuntime.release(lease.runtimeID, lease.token)
  }
  expect({ refreshing, committing, refused, calls }).toEqual({
    refreshing: true,
    committing: true,
    refused: true,
    calls: 1,
  })
})
