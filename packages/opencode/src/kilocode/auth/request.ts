import { randomUUID } from "node:crypto"
import type { Auth } from "@/auth"
import { AuthSource } from "./source"
import { AuthOutcome } from "./outcome"
import { AuthStore } from "./store"
import { HEADER_ORGANIZATIONID } from "@kilocode/kilo-gateway"

export namespace AuthRequest {
  export const header = "x-kilo-auth-request"
  const marker = Symbol("kilo.auth.request")
  const delegated = Symbol("kilo.auth.delegated")
  type Fetch = (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  const active = new Map<string, ReturnType<typeof create>>()

  function headers(selected: AuthSource.Selected, value: HeadersInit | undefined, wire = true) {
    const headers = new Headers(value)
    headers.delete(header)
    const fields = AuthSource.fields.filter((name) => headers.has(name))
    if (selected.headers) {
      if (
        fields.some((name) => selected.headers?.[name] !== headers.get(name)) ||
        Object.entries(selected.headers).some(([name, value]) => headers.get(name) !== value)
      )
        throw new AuthOutcome.Failure("source-unmanaged")
    } else if (
      selected.credential?.type === "api" &&
      selected.snapshot.providerID !== "kilo" &&
      selected.snapshot.managed
    ) {
      const key = selected.credential.key
      if (fields.some((name) => headers.get(name)?.replace(/^(Bearer|Token)\s+/i, "") !== key))
        throw new AuthOutcome.Failure("source-unmanaged")
    }
    if (selected.snapshot.providerID === "kilo" && selected.credential) {
      const organization = headers.get(HEADER_ORGANIZATIONID)
      if (organization !== null && organization !== selected.organization)
        throw new AuthOutcome.Failure("authority-changed", selected.snapshot.providerID, selected.snapshot.source)
      const credential = selected.credential
      if (credential.type === "oauth" || credential.type === "api")
        headers.set("authorization", `Bearer ${credential.type === "oauth" ? credential.access : credential.key}`)
      if (selected.organization) headers.set(HEADER_ORGANIZATIONID, selected.organization)
    }
    if (selected.credential?.type === "oauth" && ["openai", "xai"].includes(selected.snapshot.providerID)) {
      headers.set("authorization", `Bearer ${selected.credential.access}`)
      if (selected.snapshot.providerID === "openai" && selected.credential.accountId)
        headers.set("chatgpt-account-id", selected.credential.accountId)
    }
    if (
      wire &&
      selected.credential?.type === "oauth" &&
      !["openai", "xai", "kilo"].includes(selected.snapshot.providerID)
    ) {
      const values = [selected.credential.access, selected.credential.refresh].filter(Boolean)
      if (!fields.length) throw new AuthOutcome.Failure("source-unmanaged")
      if (
        fields.some(
          (name) => !values.some((value) => headers.get(name) === value || headers.get(name) === `Bearer ${value}`),
        )
      )
        throw new AuthOutcome.Failure("authority-changed")
    }
    return headers
  }

  export function create(input: {
    expected: AuthSource.Snapshot
    resolve: () => Promise<AuthSource.Selected>
    observe?: (reason: AuthOutcome.Reason) => Promise<void>
    signal?: AbortSignal
    dispatch?: () => void
    unsupported?: () => never
  }) {
    input = { ...input, expected: AuthSource.seal(input.expected) }
    const id = randomUUID()
    const controller = new AbortController()
    let failure: AuthOutcome.Failure | undefined
    let reported: AuthOutcome.Reason | undefined
    const report = async (reason: AuthOutcome.Reason) => {
      if (reported === reason) return
      reported = reason
      await input.observe?.(reason)
    }
    let resource: Error | undefined
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
    const check = async () => {
      if (input.signal?.aborted) throw input.signal.reason
      if (resource) throw resource
      if (failure) throw failure
      if (input.expected.runtime && input.expected.runtime !== AuthSource.runtime)
        throw new AuthOutcome.Failure("unverifiable")
      const selected = await input.resolve().catch((error) => {
        if (AuthOutcome.control(error)) throw error
        throw AuthOutcome.known(error) ?? new AuthOutcome.Failure("storage-unavailable")
      })
      AuthSource.assert(input.expected, selected.snapshot)
      if (selected.reason === "exchange-uncertain" || selected.reason === "refresh-rejected")
        throw new AuthOutcome.Failure(selected.reason, selected.snapshot.providerID, selected.snapshot.source)
      return selected
    }
    const fail = async (error: unknown) => {
      if (input.signal?.aborted) throw input.signal.reason
      if (AuthOutcome.control(error) && !failure) throw error
      const known = failure ?? AuthOutcome.known(error)
      const value =
        known &&
        (known.providerID
          ? known
          : new AuthOutcome.Failure(known.reason, input.expected.providerID, input.expected.source))
      if (value) {
        failure = value
        await report(value.reason)
      }
      throw value ?? error
    }
    const reserve = () => {
      try {
        input.dispatch?.()
      } catch (error) {
        resource = error instanceof Error ? error : new Error(String(error))
        controller.abort(resource)
        throw resource
      }
    }
    const guard = {
      id,
      signal,
      expected: input.expected,
      error: () => (input.signal?.aborted ? undefined : (resource ?? failure)),
      check: () => check().catch(fail),
      credential: async () => AuthStore.detach((await check().catch(fail)).credential),
      report,
      deny: (reason: AuthOutcome.Reason) => fail(new AuthOutcome.Failure(reason)),
      headers: async (value: HeadersInit | undefined) => {
        try {
          return headers(await check(), value)
        } catch (error) {
          return fail(error)
        }
      },
      async send() {
        await check().catch(fail)
        reserve()
      },
      async forward(fetch: Fetch, request: RequestInfo | URL, init?: RequestInit) {
        if (input.dispatch && fetch !== globalThis.fetch && !Reflect.get(fetch, delegated)) {
          try {
            input.unsupported?.()
            throw new Error("Unverified model transport")
          } catch (error) {
            resource = error instanceof Error ? error : new Error(String(error))
            controller.abort(resource)
            throw resource
          }
        }
        return guard.fetch(fetch, request, init)
      },
      async fetch(fetch: Fetch, request: RequestInfo | URL, init?: RequestInit) {
        try {
          const selected = await check()
          if (selected.snapshot.kind === "oauth" && fetch !== globalThis.fetch && !Reflect.get(fetch, delegated))
            throw new AuthOutcome.Failure("source-unmanaged")
          const original = new Headers(request instanceof Request ? request.headers : undefined)
          new Headers(init?.headers).forEach((value, key) => original.set(key, value))
          const options = {
            ...init,
            headers: headers(selected, original, !Reflect.get(fetch, delegated)),
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
            [marker]: guard,
          }
          if (!Reflect.get(fetch, delegated)) reserve()
          const response = await fetch(request, options)
          if (failure) {
            await response.body?.cancel()
            throw failure
          }
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel()
            throw new AuthOutcome.Failure("refresh-rejected")
          }
          await report(selected.reason)
          return response
        } catch (error) {
          return fail(error)
        }
      },
      async invalidate() {
        if (input.signal?.aborted || resource) {
          active.delete(id)
          return
        }
        try {
          await check()
        } catch (error) {
          if (AuthOutcome.control(error)) {
            controller.abort(error)
            active.delete(id)
            return
          }
          const value = AuthOutcome.known(error) ?? new AuthOutcome.Failure("authority-changed")
          failure = value
          controller.abort(value)
          await report(value.reason)
        }
      },
      close() {
        active.delete(id)
      },
    }
    active.set(id, guard)
    return Object.freeze(guard)
  }

  export type Guard = ReturnType<typeof create>

  // Only known forwarding adapters may defer accounting to their actual send.
  export function delegate<T extends Fetch>(fetch: T) {
    return Object.assign(fetch, { [delegated]: true })
  }

  export function fetch(fetch: Fetch, request: RequestInfo | URL, init?: RequestInit) {
    return bound(init)?.fetch(fetch, request, init) ?? fetch(request, init)
  }

  export function bound(init?: RequestInit): Guard | undefined {
    return init && (init as RequestInit & { [marker]?: Guard })[marker]
  }

  export async function credential(init: RequestInit | undefined, fallback: () => Promise<Auth.Info | undefined>) {
    const guard = bound(init)
    return guard ? guard.credential() : fallback()
  }

  export async function dispatch(fetch: Fetch, request: RequestInfo | URL, init?: RequestInit, providerID?: string) {
    const key = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined)).get(header)
    if (!key) return fetch(request, init)
    const guard = active.get(key)
    if (!guard) throw new AuthOutcome.Failure("unverifiable")
    if (providerID && guard.expected.providerID !== providerID) return guard.deny("authority-changed")
    return guard.forward(fetch, request, init)
  }

  export async function invalidate(providerID: string) {
    providerID = providerID.replace(/\/+$/, "")
    AuthSource.version.set(providerID, (AuthSource.version.get(providerID) ?? 0) + 1)
    await Promise.all(
      [...active.values()]
        .filter((guard) => guard.expected.providerID === providerID)
        .map((guard) => guard.invalidate()),
    )
  }
}
