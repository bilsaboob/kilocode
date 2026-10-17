import { Context, Effect, Fiber, Layer, ManagedRuntime } from "effect"
import { AsyncLocalStorage } from "node:async_hooks"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import type { Flock } from "@opencode-ai/core/util/flock"

// This bridge captures the *calling* Effect context, not the service layer's
// construction context. Sandbox profile and mutation runner survive every await,
// including lock acquisition, heartbeat, release, and temporary-file cleanup.
export namespace AuthIO {
  const scopes = new AsyncLocalStorage<Promise<Interface>>()
  export const layer = Layer.mergeAll(AppFileSystem.defaultLayer, EffectFlock.defaultLayer)
  export const make = Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const flock = yield* EffectFlock.Service
    const context = yield* Effect.context()
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(context)))
    return {
      context,
      read: (file: string) =>
        run(
          fs
            .readFileString(file)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined))),
        ),
      mkdir: (dir: string) => run(fs.ensureDir(dir)),
      realpath: (dir: string) => run(fs.realPath(dir)),
      write: (file: string, value: string) => run(fs.writeFileString(file, value, { flag: "wx", mode: 0o600 })),
      rename: (from: string, to: string) => run(fs.rename(from, to)),
      remove: (file: string) => run(fs.remove(file, { force: true })),
      lock: <A>(key: string, dir: string, body: () => Promise<A>, options?: Flock.Options): Promise<A> => {
        const scope = scopes.getStore()
        return run(
          flock.withLock(
            Effect.tryPromise({
              // Effect's scheduler is not an async-local carrier. Restore the
              // operation scope explicitly when it calls back into Promise code.
              try: () => (scope ? scopes.run(scope, body) : body()),
              catch: (err) => err,
            }),
            key,
            dir,
            {
              ...options,
              reclaim: false,
            },
          ),
        )
      },
    }
  })
  export type Interface = Effect.Success<typeof make>

  let runtime: ManagedRuntime.ManagedRuntime<AppFileSystem.Service | EffectFlock.Service, never> | undefined
  export function current(fallback?: Interface): Promise<Interface> {
    // Sample an explicit caller only at entry, before any await. Continuations
    // inherit the pinned operation, never the older credential-read fallback.
    const context = Fiber.getCurrent()?.context
    const inherited = scopes.getStore() ?? (fallback && Promise.resolve(fallback))
    if (!context && inherited) return inherited
    const load = (owner?: Interface) => {
      runtime ??= ManagedRuntime.make(layer)
      return runtime.runPromise(
        context
          ? Effect.gen(function* () {
              const base = yield* Effect.context<AppFileSystem.Service | EffectFlock.Service>()
              return yield* make.pipe(Effect.provide(Context.merge(owner?.context ?? base, context)))
            })
          : make,
      )
    }
    return inherited ? inherited.then(load) : load()
  }

  export function scope<A>(driver: () => Promise<Interface>, body: () => Promise<A>): Promise<A> {
    const io = driver()
    // Start the body synchronously so credential validation/copy still precedes
    // its first await. Observe both promises even if validation rejects early.
    const result = scopes.run(io, async () => body())
    return Promise.all([io, result]).then(([, value]) => value)
  }

  export function pinned() {
    const io = scopes.getStore()
    if (!io) throw new Error("Auth IO requires an operation scope")
    return io
  }
}
