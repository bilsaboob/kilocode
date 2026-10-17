import { AsyncLocalStorage } from "node:async_hooks"
import { createServer } from "node:http"
import * as Log from "@opencode-ai/core/util/log"

export namespace OAuthBrowser {
  type Request = { url: string; method?: string; origin?: string }
  type Reply = { status: number; headers: Record<string, string>; body: string }
  type Handler = (request: Request) => Reply
  type Listener = { close: () => Promise<void> }
  export type Options = {
    listen?: (handle: Handler, address: URL) => Promise<Listener>
    timer?: (expire: () => void, ms: number) => () => void
  }
  type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
  const context = new AsyncLocalStorage<AbortSignal | undefined>()
  const log = Log.create({ service: "oauth.browser" })
  const message = {
    stale: "This authorization response is not active. Please use the latest sign-in window.",
    denied: "Authorization was not completed. Please try signing in again.",
    missing: "The authorization response is incomplete. Please try signing in again.",
    timeout: "Authorization timed out. Please try signing in again.",
    cancelled: "Authorization cancelled.",
    replaced: "Authorization was replaced by a newer sign-in attempt.",
    exchange: "Authorization could not be completed. Please try signing in again.",
    listener: "The local authorization callback could not start.",
  }

  export function escape(value: string) {
    return value.replace(
      /[&<>"']/g,
      (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!,
    )
  }

  export function run<T>(signal: AbortSignal | undefined, callback: () => Promise<T>) {
    return context.run(signal, callback)
  }

  function timer(expire: () => void, ms: number) {
    const timeout = setTimeout(expire, ms)
    timeout.unref()
    return () => clearTimeout(timeout)
  }

  function listen(handle: Handler, address: URL): Promise<Listener> {
    const server = createServer((req, res) => {
      const reply = handle({
        url: req.url ?? "/",
        method: req.method,
        origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      })
      res.writeHead(reply.status, reply.headers)
      res.end(reply.body)
    })
    return new Promise((resolve, reject) => {
      const fail = () => {
        server.close(() => log.warn("oauth listener failed to start"))
        reject(new Error(message.listener))
      }
      server.once("error", fail)
      server.listen(Number(address.port), address.hostname, () => {
        server.removeListener("error", fail)
        server.on("error", () => log.warn("oauth listener error"))
        resolve({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
      })
    })
  }

  export function create<T>(cfg: {
    redirect: string
    success: string
    error: (message: string) => string
    origins?: ReadonlySet<string>
  }) {
    type Attempt = {
      owner: object
      state: string
      signal: AbortSignal
      waiting: boolean
      consuming: boolean
      code?: string
      socket?: Socket
      closed?: Promise<void>
      exchange?: (code: string, signal: AbortSignal) => Promise<T>
      send: () => void
      finish: (outcome: Outcome<T>) => void
    }
    type Socket = { owner?: Attempt; ready: Promise<Listener> }
    const address = new URL(cfg.redirect)
    let current: Attempt | undefined
    let socket: Socket | undefined
    let closing = Promise.resolve()

    function release(attempt: Attempt) {
      if (current === attempt) current = undefined
      const owned = attempt.socket
      if (!owned || socket !== owned || owned.owner !== attempt) return attempt.closed ?? Promise.resolve()
      socket = undefined
      owned.owner = undefined
      closing = owned.ready
        .then((listener) => listener.close())
        .catch(() => {
          log.warn("oauth listener cleanup completed after a listener failure")
        })
      attempt.closed = closing
      return closing
    }

    function handle(request: Request, listener: Socket): Reply {
      const headers: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      }
      if (request.origin && cfg.origins?.has(request.origin))
        Object.assign(headers, {
          "Access-Control-Allow-Origin": request.origin,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Private-Network": "true",
          Vary: "Origin",
        })
      const error = (status: number, text: string): Reply => ({ status, headers, body: cfg.error(text) })
      if (request.method === "OPTIONS" && cfg.origins) return { status: 204, headers, body: "" }
      if (request.method && request.method !== "GET") return error(405, message.stale)
      const url = URL.parse(request.url, address)
      if (!url) return error(400, message.stale)
      if (url.pathname !== address.pathname && url.pathname !== "/cancel")
        return { status: 404, headers, body: "Not found" }
      const attempt = current
      const states = url.searchParams.getAll("state")
      // A response must own both the pending attempt and the exact listener before it can settle anything.
      if (
        socket !== listener ||
        !attempt ||
        listener.owner !== attempt ||
        !attempt.waiting ||
        !attempt.exchange ||
        states.length !== 1 ||
        !states[0] ||
        states[0] !== attempt.state
      )
        return error(400, message.stale)
      if (url.pathname === "/cancel") {
        attempt.finish({ ok: false, error: new DOMException(message.cancelled, "AbortError") })
        return error(200, message.cancelled)
      }
      if (url.searchParams.has("error")) {
        attempt.finish({ ok: false, error: new Error(message.denied) })
        return error(200, message.denied)
      }
      const codes = url.searchParams.getAll("code")
      if (codes.length !== 1 || !codes[0]) {
        attempt.finish({ ok: false, error: new Error(message.missing) })
        return error(400, message.missing)
      }
      attempt.waiting = false
      attempt.code = codes[0]
      attempt.send()
      return { status: 200, headers, body: cfg.success }
    }

    return {
      begin(state: string, owner: object, opts: Options = {}) {
        const prior = current
        const abort = new AbortController()
        const result = Promise.withResolvers<Outcome<T>>()
        let done = false
        let sent = false
        let cancel = () => {}
        const attempt: Attempt = {
          owner,
          state,
          signal: abort.signal,
          waiting: true,
          consuming: false,
          socket,
          send() {
            if (done || sent || !attempt.consuming || !attempt.code) return
            sent = true
            const code = attempt.code
            attempt.code = undefined
            void Promise.resolve()
              .then(() => {
                abort.signal.throwIfAborted()
                return attempt.exchange!(code, abort.signal)
              })
              .then(
                (value) => attempt.finish({ ok: true, value }),
                () => attempt.finish({ ok: false, error: new Error(message.exchange) }),
              )
          },
          finish(outcome) {
            if (done) return
            done = true
            attempt.waiting = false
            attempt.code = undefined
            attempt.exchange = undefined
            cancel()
            if (!outcome.ok) abort.abort(outcome.error)
            result.resolve(outcome)
            void release(attempt)
          },
        }
        current = attempt
        if (socket) socket.owner = attempt
        // Publish the new owner before rejecting its predecessor, whose finalizer may run immediately.
        prior?.finish({ ok: false, error: new Error(message.replaced) })
        cancel = (opts.timer ?? timer)(
          () => attempt.finish({ ok: false, error: new Error(message.timeout) }),
          5 * 60_000,
        )
        return {
          async start(exchange: NonNullable<Attempt["exchange"]>) {
            if (current !== attempt || done) throw new Error(message.replaced)
            attempt.exchange = exchange
            if (!socket) {
              const opened: Socket = {
                owner: attempt,
                ready: closing.then(() => (opts.listen ?? listen)((request) => handle(request, opened), address)),
              }
              socket = opened
            }
            attempt.socket = socket
            try {
              await socket.ready
            } catch {
              attempt.finish({ ok: false, error: new Error(message.listener) })
              throw new Error(message.listener)
            }
            if (current !== attempt || done) throw new Error(message.replaced)
          },
          async wait() {
            const signal = context.getStore()
            const stopped = () => attempt.finish({ ok: false, error: signal!.reason })
            signal?.addEventListener("abort", stopped, { once: true })
            if (signal?.aborted) stopped()
            // The backend callback consumes its durable authorization ticket before entering this waiter.
            attempt.consuming = true
            attempt.send()
            try {
              const outcome = await result.promise
              if (!outcome.ok) throw outcome.error
              return outcome.value
            } finally {
              signal?.removeEventListener("abort", stopped)
            }
          },
          close() {
            attempt.finish({ ok: false, error: new DOMException(message.cancelled, "AbortError") })
            return release(attempt)
          },
        }
      },
      dispose(owner: object) {
        if (!current) return closing
        if (current.owner !== owner) return Promise.resolve()
        const attempt = current
        attempt.finish({ ok: false, error: new DOMException(message.cancelled, "AbortError") })
        return release(attempt)
      },
    }
  }
}
