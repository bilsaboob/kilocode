import type { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Log } from "@opencode-ai/core/util/log"
import { Cause, Effect, Exit, Pull, Scope, Stream } from "effect"
import { addAbortSignal, Readable } from "stream"
import { finished } from "stream/promises"
import * as Encoding from "./encoding"

/**
 * Encoding-aware text streaming for tools that walk a file line by line.
 * Optimistically stream as UTF-8; fall back to a buffered iconv decode only
 * when the bytes turn out not to be valid UTF-8.
 *
 *   import * as TextStream from "../kilocode/text-stream"
 */

/** Distinct class so {@link withFallback} can tell us apart from real I/O failures. */
export class InvalidUtf8Error extends Error {
  constructor() {
    super("invalid utf-8")
  }
}

type FileSystem = Pick<AppFileSystem.Interface, "readFile" | "stream">
const log = Log.create({ service: "text-stream" })

function decode(decoder: TextDecoder, bytes?: Uint8Array) {
  try {
    return decoder.decode(bytes, bytes ? { stream: true } : undefined)
  } catch {
    throw new InvalidUtf8Error()
  }
}

async function* chunks(fs: FileSystem, filepath: string, signal: AbortSignal) {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  // Own the scope: toAsyncIterable does not close it at EOF or accept a pull signal.
  const scope = Scope.makeUnsafe()
  let failure: { error: unknown } | undefined
  try {
    const opened = await Effect.runPromiseExit(Stream.toPull(fs.stream(filepath)).pipe(Scope.provide(scope)), {
      signal,
    })
    if (Exit.isFailure(opened)) {
      if (signal.aborted && Cause.hasInterruptsOnly(opened.cause)) return
      throw Cause.squash(opened.cause)
    }
    while (!signal.aborted) {
      const next = await Effect.runPromiseExit(opened.value, { signal })
      if (Exit.isFailure(next)) {
        if (Pull.isDoneCause(next.cause)) break
        if (signal.aborted && Cause.hasInterruptsOnly(next.cause)) return
        throw Cause.squash(next.cause)
      }
      for (const bytes of next.value) {
        if (signal.aborted) return
        const text = decode(decoder, bytes)
        if (text) yield text
      }
    }
    if (signal.aborted) return
    const tail = decode(decoder)
    if (tail) yield tail
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch((error) => {
      // Do not turn a failed teardown into a successful encoding fallback.
      if (!failure || failure.error instanceof InvalidUtf8Error) throw error
      log.error("stream cleanup failed", { error, cause: failure.error })
    })
  }
}

export function abortable(stream: Readable, signal?: AbortSignal) {
  return signal ? addAbortSignal(signal, stream) : stream
}

function utf8(fs: FileSystem, filepath: string, signal?: AbortSignal) {
  const controller = new AbortController()
  const iterator = chunks(fs, filepath, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
  let failure: { error: unknown } | undefined
  const reject = (error: unknown): never => {
    failure = { error }
    throw error
  }
  const input = abortable(
    Readable.from({
      [Symbol.asyncIterator]: () => ({
        next: () => iterator.next().catch(reject),
        return: async () => {
          // Interrupt a pending pull before queuing the generator's return().
          controller.abort()
          const result = await iterator.return().catch(reject)
          // A failed read-ahead may race destroy(); do not lose its finalizer error.
          if (failure) throw failure.error
          return result
        },
      }),
    }),
    signal,
  )
  return { input, failure: () => failure }
}

/** UTF-8 text stream backed by the injected filesystem service. */
export function openUtf8(fs: FileSystem, filepath: string, signal?: AbortSignal): Readable {
  return utf8(fs, filepath, signal).input
}

export function safeSlice(text: string, end: number) {
  const sliced = text.slice(0, end)
  const last = sliced.charCodeAt(sliced.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}

/** Whole-file decoded Readable; buffers legacy encodings only after UTF-8 streaming fails. */
export async function openDecoded(fs: FileSystem, filepath: string, signal?: AbortSignal): Promise<Readable> {
  const bytes = Buffer.from(await Effect.runPromise(fs.readFile(filepath), { signal }))
  return abortable(Readable.from([Encoding.decode(bytes, Encoding.detect(bytes))]), signal)
}

/**
 * Run `fn` against an optimistic UTF-8 stream; on {@link InvalidUtf8Error}
 * retry once against {@link openDecoded}. Other errors propagate.
 */
export async function withFallback<T>(
  fs: FileSystem,
  filepath: string,
  fn: (input: Readable) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  async function consume(input: Readable, source?: () => { error: unknown } | undefined) {
    const done = finished(input, { cleanup: true }).then(
      () => undefined,
      (error: unknown) => error,
    )
    const closed = input.closed ? Promise.resolve() : new Promise<void>((resolve) => input.once("close", resolve))
    let failure: { error: unknown } | undefined
    try {
      return await fn(input)
    } catch (error) {
      failure = { error }
      throw error
    } finally {
      input.destroy()
      await closed
      const ended = await done
      const fault = source?.()
      const error = fault ? fault.error : ended
      // A consumer may intentionally stop before EOF, including via Readable's iterator.
      const expected =
        !fault &&
        error instanceof Error &&
        "code" in error &&
        ((error.code === "ERR_STREAM_PREMATURE_CLOSE" && !input.errored) ||
          (error.code === "ABORT_ERR" && !signal?.aborted))
      if (error && !expected && error !== failure?.error) {
        if (!failure || failure.error instanceof InvalidUtf8Error) throw error
        log.error("stream cleanup failed", { error, cause: failure.error })
      }
    }
  }
  try {
    const opened = utf8(fs, filepath, signal)
    return await consume(opened.input, opened.failure)
  } catch (err) {
    if (!(err instanceof InvalidUtf8Error)) throw err
  }
  return consume(await openDecoded(fs, filepath, signal))
}
