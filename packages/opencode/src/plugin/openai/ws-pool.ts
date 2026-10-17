import WebSocket from "ws"
import * as Log from "@opencode-ai/core/util/log"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { OpenAIWebSocket } from "./ws"
import { AuthRequest } from "@/kilocode/auth/request" // kilocode_change
import { AuthSource } from "@/kilocode/auth/source" // kilocode_change
import { AuthOutcome } from "@/kilocode/auth/outcome" // kilocode_change

export const TITLE_HEADER = "x-kilo-title"

const log = Log.create({ service: "plugin.openai.ws" })

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
  streamRetries?: number
}

interface PoolEntry {
  socket?: WebSocket
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  streamFailures: number
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"

export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = new Map<string, PoolEntry>()
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge = options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options?.streamRetries ?? 5
  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeout, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref()
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const guard = AuthRequest.bound(init) // kilocode_change
    await guard?.check() // kilocode_change
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    const internalHeaders = OpenAIWebSocket.normalizeHeaders(init?.headers)
    const httpInit = withoutInternalHeaders(init)
    // kilocode_change start - account only the actual fallback HTTP request.
    const http = async () =>
      AuthRequest.fetch(
        httpFetch,
        input,
        guard ? { ...httpInit, headers: await guard.headers(httpInit?.headers) } : httpInit,
      )
    // kilocode_change end

    if (init?.method !== "POST" || !new URL(url).pathname.endsWith("/responses")) {
      return http() // kilocode_change
    }

    const body = (() => {
      try {
        if (typeof init?.body !== "string") return undefined
        const parsed = JSON.parse(init.body)
        return typeof parsed === "object" && parsed !== null ? parsed : undefined
      } catch {
        return undefined
      }
    })()
    if (!body?.stream) return http() // kilocode_change
    if (internalHeaders[TITLE_HEADER] === "true") {
      log.debug("http fallback", { reason: "title" })
      return http() // kilocode_change
    }

    const sessionID = internalHeaders["x-session-affinity"] ?? internalHeaders["session-id"]
    if (!sessionID) {
      log.debug("http fallback", { reason: "missing_session" })
      return http() // kilocode_change
    }
    const key = `${sessionID}:${guard?.expected.authority ?? AuthSource.connection(url, internalHeaders)}:conversation` // kilocode_change

    const entry = pool.get(key) ?? { lastUsedAt: Date.now(), busy: false, fallback: false, streamFailures: 0 }
    pool.set(key, entry)

    if (entry.fallback) {
      log.debug("http fallback", { key, reason: "fallback_active" })
      return http() // kilocode_change
    }
    if (entry.busy) {
      log.debug("http fallback", { key, reason: "busy" })
      return http() // kilocode_change
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    try {
      await guard?.check() // kilocode_change - includes pooled connection reuse
      entry.socket = await socket(
        entry,
        options?.url ?? url,
        OpenAIWebSocket.normalizeHeaders(httpInit?.headers),
        connectTimeout,
        maxConnectionAge,
        init?.signal,
      )
      let resolveFirstEvent: (started: boolean) => void = () => {}
      let rejectFirstEvent: (error: Error) => void = () => {}
      const firstEvent = new Promise<boolean>((resolve, reject) => {
        resolveFirstEvent = resolve
        rejectFirstEvent = reject
      })
      const response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body,
        idleTimeout,
        signal: init?.signal ?? undefined,
        // kilocode_change start - check authority and reserve each physical response.create.
        check: async () => {
          await guard?.send()
        },
        // kilocode_change end
        onFirstEvent: () => resolveFirstEvent(true),
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          if (event.type !== "response.completed" && event.type !== "response.done") {
            log.warn("websocket terminal failure", { key, type: event.type })
            invalidate(entry)
          }
        },
        onConnectionInvalid: (error) => {
          log.warn("websocket invalidated", { key, error: error.message })
          entry.busy = false
          if (!entry.fallback) recordStreamFailure(entry)
          invalidate(entry)
          resolveFirstEvent(false)
        },
        onAbort: (error) => {
          log.debug("websocket aborted", { key })
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          invalidate(entry)
          rejectFirstEvent(error)
        },
        onRetryableTerminal: async (event) => {
          const error = connectionLimitError(event)
          if (!error) return undefined
          log.warn("websocket connection limit reached", { key })
          throw error
        },
      })
      if (await firstEvent) return response
      if (!entry.fallback) return response
      discard(response) // kilocode_change
      log.debug("http fallback", { key, reason: "websocket_retries_exhausted" })
      return http() // kilocode_change
    } catch (error) {
      // kilocode_change start - typed authority/resource failures cannot select paid fallback.
      if (guard?.error() || AuthOutcome.known(error)) {
        invalidate(entry)
        entry.busy = false
        throw guard?.error() ?? error
      }
      // kilocode_change end
      entry.busy = false
      entry.lastUsedAt = Date.now()
      if (OpenAIWebSocket.isAbortError(error)) {
        entry.streamFailures = 0
        invalidate(entry)
        throw error
      }

      recordStreamFailure(entry)
      log.warn("websocket setup failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
        fallback: entry.fallback ? "http" : undefined,
      })
      invalidate(entry)
      if (entry.fallback) return http() // kilocode_change
      return failedResponse(
        new ProviderError.ResponseStreamError(error instanceof Error ? error.message : String(error), {
          cause: error,
        }),
      )
    }
  }

  function recordStreamFailure(entry: PoolEntry) {
    entry.streamFailures++
    // Codex counts retries after the initial failed WebSocket attempt.
    if (entry.streamFailures > streamRetries) entry.fallback = true
  }

  function prune() {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.busy) continue
      if (now - entry.lastUsedAt < idleTimeout) continue
      log.debug("websocket idle prune", { key })
      invalidate(entry)
      pool.delete(key)
    }
  }

  function close() {
    log.debug("websocket pool close", { count: pool.size })
    clearInterval(pruneTimer)
    for (const entry of pool.values()) invalidate(entry)
    pool.clear()
  }

  return AuthRequest.delegate(Object.assign(websocketFetch, { close })) // kilocode_change - interception itself is not a model send
}

function connectionLimitError(event: Record<string, unknown>) {
  if (event.type !== "error" || !isRecord(event.error) || event.error.code !== CONNECTION_LIMIT_REACHED_CODE) return
  return new Error(typeof event.error.message === "string" ? event.error.message : CONNECTION_LIMIT_REACHED_CODE)
}

function failedResponse(error: ProviderError.ResponseStreamError) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

// kilocode_change start
function discard(response: Response) {
  void response.text().catch((error) => {
    log.debug("discard websocket response", { error: error instanceof Error ? error.message : String(error) })
  })
}
// kilocode_change end

async function socket(
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
  signal?: AbortSignal | null,
) {
  if (
    entry.socket?.readyState === WebSocket.OPEN &&
    entry.connectedAt &&
    Date.now() - entry.connectedAt < maxConnectionAge
  ) {
    return entry.socket
  }

  invalidate(entry)
  const next = await OpenAIWebSocket.connectResponsesWebSocket({
    url: OpenAIWebSocket.toWebSocketUrl(url),
    headers,
    timeout: connectTimeout,
    signal: signal ?? undefined,
  })
  entry.connectedAt = Date.now()
  return next
}

function invalidate(entry: PoolEntry) {
  if (entry.socket) {
    entry.socket.on("error", () => {})
    entry.socket.terminate()
    entry.socket = undefined
  }
  entry.connectedAt = undefined
}

export function withoutInternalHeaders<T extends { headers?: HeadersInit }>(init: T | undefined): T | undefined {
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    headers.delete(TITLE_HEADER)
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return { ...init, headers: init.headers.filter((item) => item[0].toLowerCase() !== TITLE_HEADER) }
  }

  return {
    ...init,
    headers: Object.fromEntries(Object.entries(init.headers).filter(([key]) => key.toLowerCase() !== TITLE_HEADER)),
  }
}

export * as OpenAIWebSocketPool from "./ws-pool"
