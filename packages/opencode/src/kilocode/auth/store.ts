import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { z } from "zod"
import { Global } from "@opencode-ai/core/global"
import type { Flock } from "@opencode-ai/core/util/flock"
import { Auth } from "@/auth"
import { AuthIO } from "./io"

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
  })
  const metadata = z.object({
    version: z.literal(1),
    epoch: z.string().uuid(),
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
  const bindings = new WeakMap<object, Snapshot>()
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
          if (err instanceof AuthStaleError || err instanceof AuthSourceError || err instanceof AuthStorageError)
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

    async function write(provider: string, value: Auth.Info | undefined, expected?: Snapshot, explicit = true) {
      provider = normalize(provider)
      // Validate and detach every caller-owned field before any asynchronous IO.
      // A malformed renewal must not advance metadata or replace good credentials.
      value = value === undefined ? undefined : copy(value)
      if (expected && override() !== undefined) throw new AuthSourceError()
      return locked(async (store, io) => {
        if (expected && override() !== undefined) throw new AuthSourceError()
        const current = await state(store, io)
        if (expected) compare(expected, await capture(store, provider, current, io), true)
        const prior = current.meta.providers[provider]
        const revision = (prior?.tokenRevision ?? 0) + 1
        if (!Number.isSafeInteger(revision)) throw new AuthStorageError()
        current.meta.providers[provider] = {
          loginGeneration: explicit || !prior ? randomUUID() : prior.loginGeneration,
          tokenRevision: revision,
          fingerprint: fingerprint(value),
          tombstone: value === undefined,
        }
        for (const key of Object.keys(current.data)) {
          if (key.replace(/\/+$/, "") === provider) delete current.data[key]
        }
        if (value !== undefined) current.data[provider] = value
        // Invalidate old authority FIRST. If credentials fail, keep this revision advanced.
        // The fingerprint mismatch then fails closed until an explicit mutation repairs it.
        await atomic(io, current.sidecar, current.meta)
        current.dirty = false
        await atomic(io, store, current.data)
        return capture(store, provider, current, io)
      })
    }

    return {
      run,
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
            fn,
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
