import { describe, expect, spyOn } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Log } from "@opencode-ai/core/util/log"
import { Effect, FileSystem, Layer, PlatformError, Stream } from "effect"
import { rename, writeFile } from "fs/promises"
import path from "path"
import { createInterface } from "readline"
import type { Readable } from "stream"
import { finished } from "stream/promises"
import * as Encoding from "../../src/kilocode/encoding"
import * as TextStream from "../../src/kilocode/text-stream"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer))

function track(fs: Pick<FileSystem.FileSystem, "stream" | "readFile">, release = Effect.void) {
  const state = { opened: 0, closed: 0, reads: 0 }
  return {
    state,
    fs: {
      stream: (filepath: string) =>
        Stream.unwrap(
          Effect.acquireRelease(
            Effect.sync(() => state.opened++),
            () => release.pipe(Effect.ensuring(Effect.sync(() => state.closed++))),
          ).pipe(Effect.as(fs.stream(filepath))),
        ),
      readFile: (filepath: string) => fs.readFile(filepath).pipe(Effect.tap(() => Effect.sync(() => state.reads++))),
    },
  }
}

async function collect(input: Readable) {
  const chunks: string[] = []
  for await (const chunk of input) chunks.push(String(chunk))
  return chunks.join("")
}

describe("text stream lifetime", () => {
  it.live("releases the Effect scope at EOF before returning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "text.txt")
      yield* fs.writeFileString(filepath, "first\nsecond\nthird\n")
      const tracked = track(fs)

      yield* Effect.promise(async () => {
        expect(await TextStream.withFallback(tracked.fs, filepath, collect)).toBe("first\nsecond\nthird\n")
        expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
      })
    }),
  )

  it.live("releases multiline EOF after a limited consumer drains the remaining lines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "lines.txt")
      yield* fs.writeFileString(filepath, "first\nsecond\nthird\n")
      const tracked = track(fs)

      yield* Effect.promise(async () => {
        const result = await TextStream.withFallback(tracked.fs, filepath, async (input) => {
          const lines = createInterface({ input, crlfDelay: Infinity })
          const kept: string[] = []
          let count = 0
          try {
            for await (const line of lines) {
              count++
              if (kept.length < 1) kept.push(line)
            }
          } finally {
            lines.close()
            input.destroy()
          }
          return { kept, count }
        })
        expect(result).toEqual({ kept: ["first"], count: 3 })
        expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
      })
    }),
  )

  it.live("allows repeated reads and immediate native replacements in the same process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "replace.txt")
      const replacement = path.join(dir, "replacement.txt")
      yield* fs.writeFileString(filepath, "version 0")
      const tracked = track(fs)

      yield* Effect.promise(async () => {
        for (let i = 0; i < 10; i++) {
          expect(await TextStream.withFallback(tracked.fs, filepath, collect)).toBe(`version ${i}`)
          expect(tracked.state.closed).toBe(i + 1)
          await writeFile(replacement, `version ${i + 1}`)
          await rename(replacement, filepath)
        }
        expect(tracked.state).toEqual({ opened: 10, closed: 10, reads: 0 })
      })
    }),
  )

  for (const mode of ["bytes", "lines", "return", "throw"] as const) {
    it.live(`awaits asynchronous finalization on early ${mode}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const started = Promise.withResolvers<void>()
        const closing = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const error = Object.freeze(new Error("consumer failed"))
        const tracked = track(
          {
            ...fs,
            stream: () =>
              Stream.concat(
                Stream.make(Buffer.from("first\nsecond\n")),
                Stream.fromEffect(Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never))),
              ),
          },
          Effect.promise(async () => {
            closing.resolve()
            await release.promise
          }),
        )

        yield* Effect.promise(async () => {
          let settled = false
          let input: Readable | undefined
          const pending = TextStream.withFallback(tracked.fs, "unused", async (stream) => {
            input = stream
            if (mode === "bytes") {
              for await (const text of stream) return String(text)
            }
            if (mode === "lines") {
              const lines = createInterface({ input: stream, crlfDelay: Infinity })
              try {
                for await (const line of lines) return line
              } finally {
                lines.close()
                stream.destroy()
              }
            }
            stream.resume()
            await started.promise
            if (mode === "throw") throw error
            return "returned"
          }).then(
            (value) => {
              settled = true
              return value
            },
            (error: unknown) => {
              settled = true
              return error
            },
          )
          await closing.promise
          try {
            expect(settled).toBe(false)
            expect(tracked.state.closed).toBe(0)
          } finally {
            release.resolve()
          }
          expect(await pending).toBe(
            mode === "throw" ? error : mode === "bytes" ? "first\nsecond\n" : mode === "lines" ? "first" : "returned",
          )
          expect(input?.closed).toBe(true)
          expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
        })
      }),
    )
  }

  it.live("closes an unused stream without acquiring a resource", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tracked = track(fs)
      yield* Effect.promise(async () => {
        let input: Readable | undefined
        expect(
          await TextStream.withFallback(tracked.fs, "unused", async (stream) => {
            input = stream
            return "unused"
          }),
        ).toBe("unused")
        expect(input?.closed).toBe(true)
        expect(tracked.state).toEqual({ opened: 0, closed: 0, reads: 0 })
      })
    }),
  )

  it.live("preserves producer I/O errors without retrying the buffered read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const error = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "read" })
      const tracked = track({
        ...fs,
        stream: () => Stream.concat(Stream.make(Buffer.from("first\n")), Stream.fail(error)),
      })
      yield* Effect.promise(async () => {
        await expect(TextStream.withFallback(tracked.fs, "unused", collect)).rejects.toBe(error)
        expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
      })
    }),
  )

  it.live("preserves actual missing-file errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tmpdirScoped()
      const tracked = track(fs)
      yield* Effect.promise(async () => {
        await expect(TextStream.withFallback(tracked.fs, path.join(dir, "missing.txt"), collect)).rejects.toMatchObject(
          {
            _tag: "PlatformError",
            reason: { _tag: "NotFound" },
          },
        )
        expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
      })
    }),
  )

  for (const mode of ["before", "during", "partial"] as const) {
    it.live(`finishes teardown on abort (${mode}) without decoding an incomplete tail`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const started = Promise.withResolvers<void>()
        const controller = new AbortController()
        const reason = new Error("cancelled")
        const tracked = track({
          ...fs,
          stream: () =>
            Stream.concat(
              mode === "partial" ? Stream.make(Buffer.from([0x61, 0xe2])) : Stream.empty,
              Stream.fromEffect(Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never))),
            ),
        })
        yield* Effect.promise(async () => {
          if (mode === "before") controller.abort(reason)
          let input: Readable | undefined
          const pending = TextStream.withFallback(
            tracked.fs,
            "unused",
            async (stream) => {
              input = stream
              return collect(stream)
            },
            controller.signal,
          )
          const outcome = pending.catch((error: unknown) => error)
          if (mode !== "before") {
            await started.promise
            controller.abort(reason)
          }
          expect(await outcome).toMatchObject({ name: "AbortError", code: "ABORT_ERR" })
          expect(input?.closed).toBe(true)
          expect(tracked.state).toEqual({
            opened: mode === "before" ? 0 : 1,
            closed: mode === "before" ? 0 : 1,
            reads: 0,
          })
        })
      }),
    )
  }

  it.live("interrupts a blocked pull when openUtf8 is destroyed directly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const started = Promise.withResolvers<void>()
      const tracked = track({
        ...fs,
        stream: () => Stream.fromEffect(Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never))),
      })
      yield* Effect.promise(async () => {
        const input = TextStream.openUtf8(tracked.fs, "unused")
        const closed = finished(input, { cleanup: true }).catch((error: unknown) => error)
        input.resume()
        await started.promise
        input.destroy()
        const error = await closed
        if (error) expect(error).toMatchObject({ code: "ERR_STREAM_PREMATURE_CLOSE" })
        expect(input.closed).toBe(true)
        expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
      })
    }),
  )

  for (const mode of ["midstream", "tail"] as const) {
    it.live(`closes invalid UTF-8 ${mode} before the one-time buffered fallback`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* tmpdirScoped()
        const filepath = path.join(dir, "invalid.txt")
        const bytes = Buffer.concat([
          Buffer.from("first\nsecond\n"),
          mode === "midstream" ? Buffer.from([0xff, 0x0a, 0x61]) : Buffer.from([0xe2, 0x82]),
        ])
        yield* fs.writeFile(filepath, bytes)
        const tracked = track({
          ...fs,
          stream: (file) => fs.stream(file, { chunkSize: 4 }),
          readFile: (file) =>
            Effect.sync(() => expect(tracked.state.closed).toBe(1)).pipe(Effect.andThen(fs.readFile(file))),
        })
        yield* Effect.promise(async () => {
          const inputs: Readable[] = []
          const text = await TextStream.withFallback(tracked.fs, filepath, async (input) => {
            inputs.push(input)
            return collect(input)
          })
          expect(text).toBe(Encoding.decode(bytes, Encoding.detect(bytes)))
          expect(inputs).toHaveLength(2)
          expect(inputs.every((input) => input.closed)).toBe(true)
          expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 1 })
        })
      }),
    )
  }

  for (const mode of ["return", "throw", "invalid"] as const) {
    it.live(`closes the buffered fallback after consumer ${mode} without another retry`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* tmpdirScoped()
        const filepath = path.join(dir, "legacy.txt")
        yield* fs.writeFile(filepath, Buffer.from([0xff]))
        const tracked = track(fs)
        const error =
          mode === "invalid" ? new TextStream.InvalidUtf8Error() : Object.freeze(new Error("consumer failed"))
        yield* Effect.promise(async () => {
          const inputs: Readable[] = []
          const pending = TextStream.withFallback(tracked.fs, filepath, async (input) => {
            inputs.push(input)
            if (inputs.length === 1) return collect(input)
            if (mode !== "return") throw error
            return "returned"
          })
          if (mode === "return") expect(await pending).toBe("returned")
          else await expect(pending).rejects.toBe(error)
          expect(inputs).toHaveLength(2)
          expect(inputs.every((input) => input.closed)).toBe(true)
          expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 1 })
        })
      }),
    )
  }

  for (const code of [undefined, "ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE"]) {
    it.live(`surfaces genuine finalizer failures on early return (${code ?? "no code"})`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const error = Object.assign(new Error("release failed"), { code })
        const tracked = track({ ...fs, stream: () => Stream.make(Buffer.from("first")) }, Effect.die(error))
        yield* Effect.promise(async () => {
          await expect(
            TextStream.withFallback(tracked.fs, "unused", async (input) => {
              for await (const chunk of input) return String(chunk)
            }),
          ).rejects.toBe(error)
          expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
        })
      }),
    )
  }

  it.live("does not mistake a child scope's EOF cleanup failure for normal EOF", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const error = new Error("child release failed")
      const tracked = track({
        ...fs,
        stream: () =>
          Stream.fromEffect(Effect.acquireRelease(Effect.succeed(Buffer.from("first")), () => Effect.die(error))).pipe(
            Stream.scoped,
          ),
      })
      yield* Effect.promise(async () => {
        await expect(TextStream.withFallback(tracked.fs, "unused", collect)).rejects.toBe(error)
        expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
      })
    }),
  )

  for (const mode of ["producer", "consumer"] as const) {
    it.live(`preserves ${mode} error identity and reports a simultaneous cleanup failure`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const started = Promise.withResolvers<void>()
        const error = Object.freeze(new Error(`${mode} failed`))
        const cleanup = new Error("release failed")
        const tracked = track(
          {
            ...fs,
            stream: () =>
              Stream.fromEffect(
                Effect.sync(() => started.resolve()).pipe(
                  Effect.andThen(mode === "producer" ? Effect.die(error) : Effect.never),
                ),
              ),
          },
          Effect.die(cleanup),
        )
        yield* Effect.promise(async () => {
          // Only observe diagnostics; the stream, resource, and failing finalizer are real Effects.
          const log = spyOn(Log.create({ service: "text-stream" }), "error").mockImplementation(() => {})
          try {
            await expect(
              TextStream.withFallback(tracked.fs, "unused", async (input) => {
                if (mode === "producer") return collect(input)
                input.resume()
                await started.promise
                throw error
              }),
            ).rejects.toBe(error)
            expect(log).toHaveBeenCalledWith("stream cleanup failed", { error: cleanup, cause: error })
          } finally {
            log.mockRestore()
          }
          expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
        })
      }),
    )
  }

  for (const mode of ["decoder", "consumer"] as const) {
    it.live(`does not hide cleanup failure behind an encoding fallback (${mode})`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const started = Promise.withResolvers<void>()
        const error = new Error("release failed")
        const tracked = track(
          {
            ...fs,
            stream: () =>
              mode === "decoder"
                ? Stream.make(Buffer.from([0xff]))
                : Stream.fromEffect(Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never))),
          },
          Effect.die(error),
        )
        yield* Effect.promise(async () => {
          await expect(
            TextStream.withFallback(tracked.fs, "unused", async (input) => {
              if (mode === "decoder") return collect(input)
              input.resume()
              await started.promise
              throw new TextStream.InvalidUtf8Error()
            }),
          ).rejects.toBe(error)
          expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
        })
      }),
    )
  }

  for (const [label, text, size] of [
    ["empty-file", "", 1],
    ["split UTF-8 and newline", "first\r\n\u00e9\u{1f4c1}\r\nlast", 1],
    ["UTF-8 BOM", "\uFEFFfirst\nlast", 3],
  ] as const) {
    it.live(`preserves ${label} decoding`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* tmpdirScoped()
        const filepath = path.join(dir, "text.txt")
        yield* fs.writeFileString(filepath, text)
        const tracked = track({ ...fs, stream: (file) => fs.stream(file, { chunkSize: size }) })
        yield* Effect.promise(async () => {
          expect(await TextStream.withFallback(tracked.fs, filepath, collect)).toBe(text.replace(/^\uFEFF/, ""))
          expect(tracked.state).toEqual({ opened: 1, closed: 1, reads: 0 })
        })
      }),
    )
  }
})
