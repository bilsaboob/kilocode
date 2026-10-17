import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { z } from "zod"
import { Global } from "@opencode-ai/core/global"
import type { Flock } from "@opencode-ai/core/util/flock"
import { Auth } from "@/auth"
import { AuthIO } from "./io"
import { AuthOutcome } from "./outcome"

export class AuthSourceError extends Error {
  constructor() {
    super(
      "Credentials supplied by KILO_AUTH_CONTENT cannot be renewed or conditionally changed. Update the auth source instead.",
    )
    this.name = "AuthSourceError"
  }
}

export class AuthStaleError extends Error {
  constructor() {
    super("Authentication changed while this operation was in progress. Reload the provider before trying again.")
    this.name = "AuthStaleError"
  }
}

export class AuthStorageError extends Error {
  constructor() {
    super("Authentication storage could not be read or updated safely. No renewed credentials were accepted.")
    this.name = "AuthStorageError"
  }
}

export namespace AuthStore {
  const entry = z.object({
    loginGeneration: z.string().uuid(),
    tokenRevision: z.number().int().nonnegative().safe(),
    fingerprint: z.string(),
    tombstone: z.boolean(),
    attemptRevision: z.number().int().nonnegative().safe().optional(),
    attempt: z
      .object({ id: z.string().uuid(), method: z.number().int().nonnegative(), consumed: z.boolean() })
      .optional(),
  })
  const metadata = z.object({
    version: z.literal(1),
    epoch: z.string().uuid(),
    exchanges: z
      .preprocess(
        (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : null),
        z.array(
          z.tuple([
            z.string(),
            z.object({
              key: z.string(),
              reason: z.enum(["refreshing", "exchange-uncertain", "refresh-rejected"]),
            }),
          ]),
        ),
      )
      .transform((entries) => Object.fromEntries(entries))
      .optional(),
    providers: z
      .preprocess(
        (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : null),
        z.array(z.tuple([z.string(), entry])),
      )
      .transform((entries): Record<string, z.infer<typeof entry>> => Object.fromEntries(entries)),
  })
  type Metadata = z.infer<typeof metadata>
  export type Snapshot = Readonly<{
    store: string
    source: "disk" | "env"
    provider: string
    epoch: string
    loginGeneration: string
    tokenRevision: number
    fingerprint: string
    value: Auth.Info | undefined
  }>
  export type Attempt = Readonly<{
    snapshot: Snapshot
    id: string
    method: number
    revision: number
    targets: Readonly<Record<string, { generation: string; attemptRevision: number }>>
  }>
  const bindings = new WeakMap<object, Snapshot>()

  export function detach(value: Auth.Info | undefined) {
    if (!value) return undefined
    const copy = structuredClone(value)
    const snapshot = bindings.get(value)
    if (snapshot) bindings.set(copy, snapshot)
    return copy
  }
  const owners = new WeakMap<Snapshot, AuthIO.Interface>()

  export const normalize = (provider: string) => provider.replace(/\/+$/, "")

  function canonical<A>(values: Record<string, A>) {
    const result: Record<string, A> = Object.create(null)
    for (const [key, value] of Object.entries(values)) {
      const provider = normalize(key)
      if (!Object.hasOwn(result, provider) || key === provider) result[provider] = value
    }
    return result
  }

  function copy(value: Auth.Info) {
    const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Auth.Info)(value))
    if (!parsed) throw new AuthStorageError()
    const result = structuredClone(parsed)
    if (result.type === "api" && result.metadata) Object.freeze(result.metadata)
    return Object.freeze(result)
  }

  function fingerprint(value: unknown): string {
    return createHash("sha256")
      .update(
        JSON.stringify(value ?? null, (_, item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : item,
        ),
      )
      .digest("hex")
  }

  function override(): Record<string, Auth.Info> | undefined {
    if (!process.env.KILO_AUTH_CONTENT) return undefined
    try {
      const value = JSON.parse(process.env.KILO_AUTH_CONTENT)
      return value && typeof value === "object" ? canonical(value) : value
    } catch {
      // Preserve the existing malformed-override fallback to disk.
      return undefined
    }
  }

  async function read(io: AuthIO.Interface, file: string): Promise<unknown> {
    try {
      const value = await io.read(file)
      return value === undefined ? undefined : JSON.parse(value)
    } catch {
      throw new AuthStorageError()
    }
  }

  async function atomic(io: AuthIO.Interface, file: string, value: unknown) {
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await io.write(temp, JSON.stringify(value, null, 2))
      await io.rename(temp, file)
    } catch {
      throw new AuthStorageError()
    } finally {
      await io.remove(temp)
    }
  }

  export function key(snapshot: Snapshot) {
    return fingerprint([
      snapshot.store,
      snapshot.source,
      normalize(snapshot.provider),
      snapshot.epoch,
      snapshot.loginGeneration,
      snapshot.tokenRevision,
      snapshot.fingerprint,
    ])
  }

  export function generation(snapshot: Snapshot) {
    return fingerprint([
      snapshot.store,
      snapshot.source,
      normalize(snapshot.provider),
      snapshot.epoch,
      snapshot.loginGeneration,
    ])
  }

  export function identity(value: Auth.Info) {
    const snapshot = bindings.get(value)
    return snapshot?.source === "disk"
      ? fingerprint([
          generation(snapshot),
          value.type,
          value.type === "oauth" ? value.accountId : undefined,
          value.type === "oauth" ? value.enterpriseUrl : undefined,
        ])
      : fingerprint(["external", value])
  }

  export function create(file = path.join(Global.Path.data, "auth.json"), options?: Flock.Options) {
    return build(file, options, AuthIO.current)
  }

  export const make = (file = path.join(Global.Path.data, "auth.json"), options?: Flock.Options) =>
    Effect.map(AuthIO.make, (io) => build(file, options, () => AuthIO.current(io)))

  export function from(auth: Auth.Info) {
    const snapshot = bindings.get(auth)
    const io = snapshot && owners.get(snapshot)
    return snapshot && io ? build(snapshot.store, undefined, () => AuthIO.current(io)) : disk
  }

  function build(file: string, options: Flock.Options | undefined, driver: () => Promise<AuthIO.Interface>) {
    const run = <A>(body: () => Promise<A>) => AuthIO.scope(driver, body)
    async function location(io: AuthIO.Interface) {
      try {
        await io.mkdir(path.dirname(file))
        return path.join(await io.realpath(path.dirname(file)), path.basename(file))
      } catch {
        throw new AuthStorageError()
      }
    }

    async function locked<T>(fn: (store: string, io: AuthIO.Interface) => Promise<T>) {
      const io = await AuthIO.pinned()
      const store = await location(io)
      // No lease-age takeover: even a suspended process may still own a disk transaction.
      // A crashed lock requires recovery; timing out is safer than two credential writers.
      return io
        .lock("auth-store", path.join(path.dirname(store), "auth-locks"), () => fn(store, io), options)
        .catch((err) => {
          if (
            err instanceof AuthStaleError ||
            err instanceof AuthSourceError ||
            err instanceof AuthStorageError ||
            err instanceof AuthOutcome.Failure ||
            AuthOutcome.control(err)
          )
            throw err
          throw new AuthStorageError()
        })
    }

    async function state(store: string, io: AuthIO.Interface) {
      const raw = await read(io, store)
      if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new AuthStorageError()
      const data = canonical((raw ?? {}) as Record<string, unknown>)
      const sidecar = path.join(path.dirname(store), "auth.revisions.json")
      const saved = await read(io, sidecar)
      if (saved !== undefined) {
        const parsed = metadata.safeParse(saved)
        if (!parsed.success) throw new AuthStorageError()
        const dirty = Object.keys(parsed.data.providers).some((provider) => provider !== normalize(provider))
        parsed.data.providers = canonical(parsed.data.providers)
        if (parsed.data.exchanges) parsed.data.exchanges = canonical(parsed.data.exchanges)
        return { data, meta: parsed.data, sidecar, dirty }
      }
      const meta: Metadata = { version: 1, epoch: randomUUID(), providers: Object.create(null) }
      for (const [provider, value] of Object.entries(data)) {
        meta.providers[provider] = {
          loginGeneration: randomUUID(),
          tokenRevision: 0,
          fingerprint: fingerprint(value),
          tombstone: false,
        }
      }
      await atomic(io, sidecar, meta)
      return { data, meta, sidecar, dirty: false }
    }

    async function capture(
      store: string,
      provider: string,
      current: Awaited<ReturnType<typeof state>>,
      io: AuthIO.Interface,
    ) {
      provider = normalize(provider)
      const raw = current.data[provider]
      const revision = current.meta.providers[provider]
      if (!revision) {
        current.meta.providers[provider] = {
          loginGeneration: randomUUID(),
          tokenRevision: 0,
          fingerprint: fingerprint(raw),
          tombstone: raw === undefined,
        }
        current.dirty = true
      }
      const item = current.meta.providers[provider]
      if (item.fingerprint !== fingerprint(raw) || item.tombstone !== (raw === undefined)) throw new AuthStorageError()
      const parsed = Schema.decodeUnknownOption(Auth.Info)(raw)
      const value = Option.getOrUndefined(parsed)
      if (raw !== undefined && !value) throw new AuthStorageError()
      if (current.dirty) {
        await atomic(io, current.sidecar, current.meta)
        current.dirty = false
      }
      const result: Snapshot = Object.freeze({
        store,
        source: "disk",
        provider,
        epoch: current.meta.epoch,
        ...item,
        value: value && Object.freeze(structuredClone(value)),
      })
      if (result.value) bindings.set(result.value, result)
      owners.set(result, io)
      return result
    }

    async function snapshot(provider: string, expected?: Auth.Info): Promise<Snapshot> {
      provider = normalize(provider)
      if (override() !== undefined) throw new AuthSourceError()
      const bound = expected && bindings.get(expected)
      if (bound) {
        if (bound.source !== "disk") throw new AuthSourceError()
        if (
          bound.store !== (await location(await AuthIO.pinned())) ||
          normalize(bound.provider) !== provider ||
          fingerprint(bound.value) !== fingerprint(expected)
        )
          throw new AuthStaleError()
        return bound
      }
      return locked(async (store, io) => {
        const result = await capture(store, provider, await state(store, io), io)
        if (expected && fingerprint(result.value) !== fingerprint(expected)) throw new AuthStaleError()
        if (expected) bindings.set(expected, result)
        return result
      })
    }

    function compare(expected: Snapshot, current: Snapshot, exact: boolean) {
      if (generation(expected) !== generation(current) || (exact && key(expected) !== key(current)))
        throw new AuthStaleError()
    }

    async function check(expected: Snapshot, exact = false) {
      const current = await snapshot(expected.provider)
      compare(expected, current, exact)
      return current
    }

    async function write(
      provider: string,
      value: Auth.Info | undefined,
      expected?: Snapshot,
      explicit = true,
      attempt?: Attempt,
      signal?: AbortSignal,
    ) {
      provider = normalize(provider)
      // Validate and detach every caller-owned field before any asynchronous IO.
      // A malformed renewal must not advance metadata or replace good credentials.
      value = value === undefined ? undefined : copy(value)
      // API-key replacement has no renewable account proof. It is an authority
      // change even when a conditional metadata writer performs the mutation.
      if (!explicit && expected?.value?.type === "api" && value?.type === "api" && value.key !== expected.value.key)
        explicit = true
      if (expected && override() !== undefined) throw new AuthSourceError()
      return locked(async (store, io) => {
        if (expected && override() !== undefined) throw new AuthSourceError()
        const current = await state(store, io)
        if (expected)
          compare(expected, await capture(store, attempt ? attempt.snapshot.provider : provider, current, io), !attempt)
        const prior = current.meta.providers[provider]
        if (attempt) {
          const source = current.meta.providers[normalize(attempt.snapshot.provider)].attempt
          if (source?.id !== attempt.id || source.method !== attempt.method || !source.consumed)
            throw new AuthStaleError()
          if (provider !== normalize(attempt.snapshot.provider)) {
            const original = attempt.targets[provider]
            if (
              original
                ? prior?.loginGeneration !== original.generation ||
                  (prior?.attemptRevision ?? 0) !== original.attemptRevision
                : prior !== undefined
            )
              throw new AuthStaleError()
          }
        }
        const revision = (prior?.tokenRevision ?? 0) + 1
        if (!Number.isSafeInteger(revision)) throw new AuthStorageError()
        current.meta.providers[provider] = {
          loginGeneration: explicit || !prior ? randomUUID() : prior.loginGeneration,
          tokenRevision: revision,
          fingerprint: fingerprint(value),
          tombstone: value === undefined,
          ...(prior?.attemptRevision !== undefined && { attemptRevision: prior.attemptRevision }),
          ...(!explicit && prior?.attempt && { attempt: prior.attempt }),
        }
        if (current.meta.exchanges) delete current.meta.exchanges[provider]
        for (const key of Object.keys(current.data)) {
          if (key.replace(/\/+$/, "") === provider) delete current.data[key]
        }
        if (value !== undefined) current.data[provider] = value
        // Invalidate old authority FIRST. If credentials fail, keep this revision advanced.
        // The fingerprint mismatch then fails closed until an explicit mutation repairs it.
        signal?.throwIfAborted()
        await atomic(io, current.sidecar, current.meta)
        current.dirty = false
        await atomic(io, store, current.data)
        return capture(store, provider, current, io)
      })
    }

    return {
      run,
      observe: (provider: string, passive = false) =>
        run(async () => {
          provider = normalize(provider)
          const env = override()
          if (env !== undefined) return { source: "env" as const, value: env?.[provider], snapshot: undefined }
          const load = async (file: string, io: AuthIO.Interface) => {
            const raw = await read(io, file)
            if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw)))
              throw new AuthStorageError()
            const data = canonical((raw ?? {}) as Record<string, unknown>)
            const value = data[provider] === undefined ? undefined : copy(data[provider] as Auth.Info)
            const saved = await read(io, path.join(path.dirname(file), "auth.revisions.json"))
            if (saved === undefined) return { source: "file" as const, value, snapshot: undefined }
            const parsed = metadata.safeParse(saved)
            if (!parsed.success) throw new AuthStorageError()
            const item = canonical(parsed.data.providers)[provider]
            if (!item) return { source: "file" as const, value, snapshot: undefined }
            if (item.fingerprint !== fingerprint(data[provider]) || item.tombstone !== (value === undefined))
              throw new AuthStorageError()
            const store = path.join(await io.realpath(path.dirname(file)), path.basename(file))
            const snapshot: Snapshot = Object.freeze({
              store,
              source: "disk",
              provider,
              epoch: parsed.data.epoch,
              ...item,
              value,
            })
            owners.set(snapshot, io)
            if (value) bindings.set(value, snapshot)
            const exchange = parsed.data.exchanges?.[provider]
            const issue = exchange?.key === key(snapshot) ? exchange.reason : undefined
            return { source: "file" as const, value, snapshot, issue }
          }
          // Dispatch readers join storage serialization; passive inspection never
          // creates metadata or locks and may honestly report an in-progress write.
          return passive ? load(file, await AuthIO.pinned()) : locked(load)
        }),
      begin: (provider: string, method: number) =>
        run(() =>
          locked(async (store, io) => {
            if (override() !== undefined) throw new AuthSourceError()
            provider = normalize(provider)
            if (!Number.isSafeInteger(method) || method < 0) throw new AuthStaleError()
            const current = await state(store, io)
            const snapshot = await capture(store, provider, current, io)
            const item = current.meta.providers[provider]
            const revision = (item.attemptRevision ?? 0) + 1
            if (!Number.isSafeInteger(revision)) throw new AuthStorageError()
            const id = randomUUID()
            const targets = Object.fromEntries(
              Object.entries(current.meta.providers).map(([provider, value]) => [
                provider,
                {
                  generation: value.loginGeneration,
                  attemptRevision: value.attemptRevision ?? 0,
                },
              ]),
            )
            current.meta.providers[provider] = {
              ...item,
              attemptRevision: revision,
              attempt: { id, method, consumed: false },
            }
            await atomic(io, current.sidecar, current.meta)
            return Object.freeze({ snapshot, id, method, revision, targets })
          }),
        ),
      attempt: (attempt: Attempt, consume = false) =>
        run(() =>
          locked(async (store, io) => {
            if (override() !== undefined) throw new AuthSourceError()
            const current = await state(store, io)
            const provider = normalize(attempt.snapshot.provider)
            compare(attempt.snapshot, await capture(store, provider, current, io), false)
            const value = current.meta.providers[provider].attempt
            if (!value || value.id !== attempt.id || value.method !== attempt.method || value.consumed)
              throw new AuthStaleError()
            if (consume) {
              value.consumed = true
              await atomic(io, current.sidecar, current.meta)
            }
          }),
        ),
      complete: (attempt: Attempt, value: Auth.Info, provider = attempt.snapshot.provider, signal?: AbortSignal) =>
        run(() => write(provider, value, attempt.snapshot, true, attempt, signal)),
      snapshot: (provider: string, expected?: Auth.Info) => run(() => snapshot(provider, expected)),
      check: (expected: Snapshot, exact = false) => run(() => check(expected, exact)),
      all: () =>
        run(async () => {
          const env = override()
          if (env !== undefined) {
            if (env && typeof env === "object") {
              for (const [provider, value] of Object.entries(env)) {
                if (!value || typeof value !== "object") continue
                bindings.set(
                  value,
                  Object.freeze({
                    store: file,
                    source: "env",
                    provider,
                    epoch: fingerprint(env),
                    loginGeneration: fingerprint(env),
                    tokenRevision: 0,
                    fingerprint: fingerprint(value),
                    value: Object.freeze(structuredClone(value)),
                  }),
                )
              }
            }
            return env
          }
          return locked(async (store, io) => {
            const current = await state(store, io)
            const result: Record<string, Auth.Info> = Object.create(null)
            for (const provider of Object.keys(current.data)) {
              if (Option.isNone(Schema.decodeUnknownOption(Auth.Info)(current.data[provider]))) continue
              const snap = await capture(store, provider, current, io)
              if (!snap.value) continue
              const value = structuredClone(snap.value)
              bindings.set(value, snap)
              result[provider] = value
            }
            return result
          })
        }),
      set: (provider: string, value: Auth.Info) =>
        run(async () => {
          await write(provider, value)
        }),
      remove: (provider: string) =>
        run(async () => {
          await write(provider, undefined)
        }),
      commit: (expected: Snapshot, value: Auth.Info, explicit = false) =>
        run(() => write(expected.provider, value, expected, explicit)),
      exchange: <T>(expected: Snapshot, fn: () => Promise<T>, options?: Flock.Options) =>
        run(async () => {
          const io = await AuthIO.pinned()
          return io.lock(
            `auth-refresh:${normalize(expected.provider)}`,
            path.join(path.dirname(expected.store), "auth-locks"),
            async () => {
              const provider = normalize(expected.provider)
              const receipt = await locked(async (store, io) => {
                if (override() !== undefined) throw new AuthSourceError()
                const current = await state(store, io)
                const snapshot = await capture(store, provider, current, io)
                compare(expected, snapshot, false)
                const revision = key(snapshot)
                const prior = current.meta.exchanges?.[provider]
                if (prior?.key === revision)
                  throw new AuthOutcome.Failure(
                    prior.reason === "refreshing" ? "exchange-uncertain" : prior.reason,
                    provider,
                    "file",
                  )
                current.meta.exchanges ??= Object.create(null)
                current.meta.exchanges![provider] = { key: revision, reason: "refreshing" }
                // A process may disappear after the provider consumes the token. Fence reuse before sending.
                await atomic(io, current.sidecar, current.meta)
                return revision
              })
              const settle = (reason?: "exchange-uncertain" | "refresh-rejected") =>
                locked(async (store, io) => {
                  const current = await state(store, io)
                  const prior = current.meta.exchanges?.[provider]
                  if (prior?.key !== receipt) return
                  if (reason) prior.reason = reason
                  else delete current.meta.exchanges![provider]
                  await atomic(io, current.sidecar, current.meta)
                })
              try {
                const result = await fn()
                await settle()
                return result
              } catch (error) {
                const reason = AuthOutcome.known(error)?.reason
                await settle(
                  reason === "exchange-unavailable"
                    ? undefined
                    : reason === "refresh-rejected"
                      ? "refresh-rejected"
                      : "exchange-uncertain",
                ).catch((failure) => {
                  if (AuthOutcome.control(error)) throw error
                  throw failure
                })
                throw error
              }
            },
            options,
          )
        }),
      adopt: (expected: Snapshot) =>
        run(async () => {
          const current = await check(expected, true)
          if (!current.value) throw new AuthStaleError()
          const value = structuredClone(current.value)
          bindings.set(value, current)
          return value
        }),
    }
  }

  export const disk = create()
}
