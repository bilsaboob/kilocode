import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { inspectCodexPNG } from "../../src/kilocode/image-generation-25"

const help = `Compare the existing GPT Image 2 route with the experimental GPT Image 2.5 arms.

Usage (from packages/opencode):
  bun script/kilocode/compare-codex-images.ts --input spec.json --url http://127.0.0.1:4096 --out ./comparison
  bun script/kilocode/compare-codex-images.ts --input spec.json --url http://127.0.0.1:4096 --out ./comparison --run

Spec example:
  {"prompt":"A ceramic teapot","sizes":["1024x1024","1536x1024"],"quality":"high","background":"opaque"}

Options:
  --input <file>       JSON spec; prompt and 1-8 unique sizes are required.
  --url <origin>       Kilo server origin (default http://127.0.0.1:4096).
  --out <new dir>      Must not exist; its parent must already exist.
  --directory <dir>    Server directory context (default current directory).
  --run               Explicitly authorize generation. Otherwise dry-run only.
  --help              Print this help without reading input or making requests.

Sizes: auto or WIDTHxHEIGHT, multiples of 16, max edge 3840, ratio <= 3,
655360-8294400 pixels. Quality: auto/low/medium/high. Background: auto/opaque.
Optional images: up to 5 {mediaType,dataBase64} references (no URLs).
Unknown spec fields are rejected; all arms receive identical shared settings.

Each size makes 3 sequential calls: gpt-image-2 at /codex/image/generate,
then gpt-image-2.5-flare and gpt-image-2.5-sunburst at /codex/image/generate-2.5.
Dry runs make zero calls and create no artifacts. Actual cost is unknown;
--run may consume quota or incur charges. There are no retries or fallbacks.
The first failure stops the run. Redirects are not followed. Network failures
can mean a charged request completed remotely; do not blindly repeat a run.

Existing KILO_SERVER_USERNAME (default kilo) / KILO_SERVER_PASSWORD enable
Basic auth. Never put credentials, query parameters, or fragments in --url.
Use HTTPS for non-local servers. Credentials and image base64 are not logged.

PNGs and manifest-NNN.json snapshots are created exclusively, never replaced.
The highest complete JSON snapshot is the latest checkpoint; pending/running rows
after interruption are not proof that a generation was uncharged. Requested,
reported, and independently inspected PNG properties remain separate.
Prompt/reference fingerprints are saved instead of their contents. Baseline
bridge model labels are not evidence of an upstream effective model.
`

class Failure extends Error {}

type Entry = {
  id: string
  endpoint: string
  requested: { model: string; size: string; quality: string; background: string }
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  warnings: string[]
  started?: string
  durationMs?: number
  httpStatus?: number
  reported?: Record<string, string | number>
  response?: Record<string, unknown>
  image?: ReturnType<typeof inspectCodexPNG>
  file?: string
  error?: { stage: string; message: string }
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value }
  return undefined
}

function fields(value: unknown, keys: string[]) {
  const source = object(value) ?? {}
  return Object.fromEntries(
    keys.flatMap((key) => {
      const item = source[key]
      return typeof item === "string" || (typeof item === "number" && Number.isFinite(item)) ? [[key, item]] : []
    }),
  ) as Record<string, string | number>
}

function counters(value: unknown, depth = 0): Record<string, unknown> | undefined {
  const source = object(value)
  if (!source || depth > 2) return undefined
  const result: Record<string, unknown> = Object.fromEntries(
    ["input_tokens", "output_tokens", "total_tokens", "text_tokens", "image_tokens", "cached_tokens"].flatMap((key) =>
      typeof source[key] === "number" && Number.isFinite(source[key]) ? [[key, source[key]]] : [],
    ),
  )
  for (const key of ["input_tokens_details", "output_tokens_details"]) {
    const item = counters(source[key], depth + 1)
    if (item) result[key] = item
  }
  return Object.keys(result).length ? result : undefined
}

function spec(value: unknown) {
  const input = object(value)
  if (!input || Object.keys(input).some((key) => !["prompt", "sizes", "quality", "background", "images"].includes(key)))
    throw new Failure("Spec must be an object containing only prompt, sizes, quality, background, and images.")
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Failure("Spec prompt must be nonempty.")
  if (!Array.isArray(input.sizes) || input.sizes.length < 1 || input.sizes.length > 8)
    throw new Failure("Spec sizes must contain 1-8 unique sizes (at most 24 calls).")
  const sizes = input.sizes.map((value: unknown) => {
    if (typeof value !== "string") throw new Failure("Each size must be auto or WIDTHxHEIGHT.")
    if (value.trim() === "auto") return "auto"
    const match = /^(\d+)x(\d+)$/.exec(value.trim())
    if (!match) throw new Failure("Each size must be auto or WIDTHxHEIGHT.")
    const width = Number(match[1])
    const height = Number(match[2])
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width % 16 ||
      height % 16 ||
      Math.max(width, height) > 3840 ||
      Math.max(width, height) / Math.min(width, height) > 3 ||
      width * height < 655_360 ||
      width * height > 8_294_400
    )
      throw new Failure("Sizes require multiples of 16, max edge 3840, ratio <= 3, and 655360-8294400 pixels.")
    return `${width}x${height}`
  })
  if (new Set(sizes).size !== sizes.length) throw new Failure("Spec sizes must be unique.")
  const quality = input.quality === undefined ? "auto" : input.quality
  const background = input.background === undefined ? "auto" : input.background
  if (typeof quality !== "string" || !["auto", "low", "medium", "high"].includes(quality))
    throw new Failure("Comparison quality must be auto, low, medium, or high.")
  if (typeof background !== "string" || !["auto", "opaque"].includes(background))
    throw new Failure("Comparison background must be auto or opaque.")
  if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 5))
    throw new Failure("Spec images must be an array of at most five references.")
  const images = (input.images as unknown[] | undefined)?.map((value) => {
    const image = object(value)
    if (
      !image ||
      Object.keys(image).some((key) => !["mediaType", "dataBase64"].includes(key)) ||
      typeof image.mediaType !== "string" ||
      !/^image\/[a-z0-9.+-]+$/i.test(image.mediaType) ||
      typeof image.dataBase64 !== "string" ||
      !image.dataBase64 ||
      Buffer.from(image.dataBase64, "base64").toString("base64") !== image.dataBase64
    )
      throw new Failure("Each reference requires an image mediaType and canonical, nonempty dataBase64 (no URLs).")
    return { mediaType: image.mediaType, dataBase64: image.dataBase64 }
  })
  return { prompt: input.prompt, sizes, quality, background, images }
}

export async function compare(
  args: string[],
  io: {
    fetch?: (url: URL, init: RequestInit) => Promise<Response>
    env?: Record<string, string | undefined>
    log?: (text: string) => void
  } = {},
) {
  const log = io.log ?? console.log
  const env = io.env ?? process.env
  const username = env.KILO_SERVER_USERNAME ?? "kilo"
  const password = env.KILO_SERVER_PASSWORD
  const auth = password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : undefined
  const secrets = [env.KILO_SERVER_USERNAME, password, auth, auth?.slice(6)]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [value, encodeURIComponent(value)])
  const json = (value: unknown) =>
    JSON.stringify(
      value,
      (_, item) => {
        if (typeof item !== "string") return item
        const text = item.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
        return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), text)
      },
      2,
    ) + "\n"
  try {
    const opts = (() => {
      try {
        return parseArgs({
          args,
          options: {
            input: { type: "string" },
            url: { type: "string", default: "http://127.0.0.1:4096" },
            out: { type: "string" },
            directory: { type: "string" },
            run: { type: "boolean", default: false },
            help: { type: "boolean" },
          },
          strict: true,
          allowPositionals: false,
        }).values
      } catch {
        throw new Failure("Invalid arguments. Use --help for usage; option values are not logged.")
      }
    })()
    if (opts.help) {
      log(help)
      return 0
    }
    if (!opts.input || !opts.out) throw new Failure("--input and --out are required. Use --help for usage.")
    const url = (() => {
      try {
        return new URL(opts.url)
      } catch {
        throw new Failure("--url must be an HTTP(S) server origin.")
      }
    })()
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Failure("--url must be an HTTP(S) origin without credentials, paths, query parameters, or fragments.")
    if (auth && username.includes(":")) throw new Failure("KILO_SERVER_USERNAME cannot contain a colon.")
    const input = spec(
      await readFile(resolve(opts.input), "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => {
          throw new Failure("Cannot read --input as JSON; file contents are not logged.")
        }),
    )
    secrets.push(...(input.images ?? []).map((image) => image.dataBase64))
    const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
    const rows: Entry[] = input.sizes.flatMap((size, index) =>
      ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].map((model, arm) => ({
        id: String(index * 3 + arm + 1).padStart(3, "0"),
        endpoint: arm === 0 ? "/codex/image/generate" : "/codex/image/generate-2.5",
        requested: { model, size, quality: input.quality, background: input.background },
        status: "pending",
        warnings: [],
      })),
    )
    const plan = {
      server: url.origin,
      directory: resolve(opts.directory ?? process.cwd()),
      calls: rows.length,
      cost: "Unknown; generation may consume quota or incur charges. Dry run costs nothing.",
      prompt: { chars: input.prompt.length, sha256: digest(input.prompt) },
      images: (input.images ?? []).map((image) => {
        const bytes = Buffer.from(image.dataBase64, "base64")
        return { mediaType: image.mediaType, bytes: bytes.length, sha256: digest(bytes) }
      }),
      requests: rows,
    }
    log(json({ mode: opts.run ? "run" : "dry-run", executed: 0, ...plan }))
    if (!opts.run) return 0
    const out = resolve(opts.out)
    await mkdir(out, { mode: 0o700 }).catch(() => {
      throw new Failure("Cannot create --out: it must be a new directory with an existing parent. Nothing was sent.")
    })
    const manifest = { version: 1, status: "running", started: new Date().toISOString(), ...plan }
    const diagnostics = [
      "endpoint",
      "turnID",
      "requestID",
      "imagegenRequestID",
      "generationID",
      "durationMs",
      "upstreamStatus",
    ]
    let sequence = 0
    const save = () =>
      writeFile(join(out, `manifest-${String(sequence++).padStart(3, "0")}.json`), json(manifest), {
        flag: "wx",
        mode: 0o600,
      }).catch(() => {
        throw new Failure(
          "Cannot create a manifest checkpoint. Stopping; inspect the last snapshot before any new run.",
        )
      })
    await save()
    for (const row of rows) {
      row.status = "running"
      row.started = new Date().toISOString()
      await save()
      const started = performance.now()
      let stage = "network"
      try {
        const target = new URL(row.endpoint, url)
        target.searchParams.set("directory", plan.directory)
        const baseline = row.requested.model === "gpt-image-2"
        const response = await (io.fetch ?? fetch)(target, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
          redirect: "manual",
          signal: AbortSignal.timeout(6 * 60 * 1000),
          body: JSON.stringify({
            prompt: input.prompt,
            size: row.requested.size,
            quality: input.quality,
            background: input.background,
            ...(input.images ? { images: input.images } : {}),
            ...(baseline ? {} : { model: row.requested.model }),
          }),
        })
        row.httpStatus = response.status
        stage = "response"
        if (!response.ok) {
          const value = object(await response.json().catch(() => undefined))
          row.response = {
            ...fields(value, ["upstreamStatus"]),
            diagnostics: fields(value?.diagnostics, diagnostics),
          }
          throw new Failure(
            `HTTP ${response.status}; stopped without retry, redirect, or fallback. Error text omitted.`,
          )
        }
        const value = object(await response.json())
        if (!value || value.mediaType !== "image/png" || typeof value.dataBase64 !== "string" || !value.dataBase64)
          throw new Failure("Response must contain image/png dataBase64.")
        secrets.push(value.dataBase64)
        if (
          !baseline &&
          (!object(value.requested) || !object(value.reported) || !object(value.image) || !object(value.diagnostics))
        )
          throw new Failure("Experimental response is missing requested, reported, image, or diagnostics metadata.")
        row.reported = fields(baseline ? value : value.reported, [
          ...(baseline ? [] : ["model", "effectiveModel", "modelSnapshot", "outputFormat"]),
          "size",
          "quality",
          "background",
        ])
        row.response = {
          ...fields(value, ["created", "mediaType"]),
          ...(baseline
            ? { bridge: fields(value, ["model"]) }
            : {
                requested: fields(value.requested, ["model", "size", "quality", "background"]),
                image: fields(value.image, ["width", "height", "bytes", "sha256"]),
                diagnostics: fields(value.diagnostics, diagnostics),
                usage: counters(value.usage),
              }),
        }
        row.warnings = Array.isArray(value.warnings)
          ? value.warnings
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.replaceAll(input.prompt, "[prompt]"))
          : []
        if (baseline)
          row.warnings.push("Baseline bridge model is locally assigned; upstream model identity is unknown.")
        if (!baseline && !row.reported.model && !row.reported.effectiveModel && !row.reported.modelSnapshot)
          row.warnings.push("No upstream model identity was reported.")
        for (const key of ["model", "size", "quality", "background"] as const) {
          if (
            row.requested[key] !== "auto" &&
            row.reported[key] !== undefined &&
            row.reported[key] !== row.requested[key]
          )
            row.warnings.push(`Reported ${key} differs from requested ${key}.`)
          if (!baseline && object(value.requested)?.[key] !== row.requested[key])
            row.warnings.push(`Bridge requested ${key} differs from the sent ${key}.`)
        }
        if (row.reported.effectiveModel && row.reported.effectiveModel !== row.requested.model)
          row.warnings.push("Reported effectiveModel differs from requested model.")
        stage = "inspection"
        row.image = inspectCodexPNG(value.dataBase64)
        const size = `${row.image.width}x${row.image.height}`
        if (row.requested.size !== "auto" && row.requested.size !== size)
          row.warnings.push("PNG dimensions differ from requested size.")
        if (row.reported.size && row.reported.size !== "auto" && row.reported.size !== size)
          row.warnings.push("PNG dimensions differ from reported size.")
        if (!baseline && Object.entries(row.image).some(([key, value]) => object(row.response?.image)?.[key] !== value))
          row.warnings.push("Independently inspected PNG differs from bridge image metadata.")
        stage = "artifact"
        const file = `${row.id}-${row.requested.model}-${row.requested.size}.png`
        await writeFile(join(out, file), Buffer.from(value.dataBase64, "base64"), { flag: "wx", mode: 0o600 })
        row.file = file
        row.status = "completed"
      } catch (error) {
        row.status = "failed"
        row.error = {
          stage,
          message:
            error instanceof Failure
              ? error.message
              : stage === "network"
                ? "Network/timeout failure; remote outcome is unknown. No retries were made."
                : `Failed during ${stage}; details omitted to protect secrets. No retries were made.`,
        }
        for (const pending of rows.filter((item) => item.status === "pending")) pending.status = "skipped"
      }
      row.durationMs = Math.round(performance.now() - started)
      manifest.status =
        row.status === "failed" ? "failed" : rows.every((item) => item.status === "completed") ? "completed" : "running"
      await save()
      if (row.status === "failed") {
        log(json({ status: "failed", request: row.id, error: row.error, httpStatus: row.httpStatus, out }))
        return 1
      }
    }
    log(json({ status: "completed", calls: rows.length, out }))
    return 0
  } catch (error) {
    log(
      json({
        status: "failed",
        error:
          error instanceof Failure
            ? error.message
            : "Experiment failed; details omitted to protect secrets. No retries were made.",
      }),
    )
    return 1
  }
}

if (import.meta.main) process.exitCode = await compare(process.argv.slice(2))
