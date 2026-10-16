import { Schema } from "effect"
import { createHash } from "node:crypto"
import {
  CODEX_IMAGE_EDIT_ENDPOINT,
  CODEX_IMAGE_ENDPOINT,
  CodexImageGenerationError,
  type CodexImageFetch,
} from "./image-generation"

const Model = Schema.Literals(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"])
const Quality = Schema.Literals(["auto", "low", "medium", "high", "xhigh", "max"])
const Background = Schema.Literals(["auto", "opaque", "transparent"])

export const CodexImage25Request = Schema.Struct({
  model: Model,
  prompt: Schema.String.check(Schema.isMinLength(1)),
  quality: Schema.optional(Quality),
  background: Schema.optional(Background),
  size: Schema.optional(Schema.String),
  images: Schema.optional(
    Schema.Array(
      Schema.Struct({
        mediaType: Schema.String,
        dataBase64: Schema.String,
      }),
    ).check(Schema.isMaxLength(5)),
  ),
})

const Diagnostics = Schema.Struct({
  endpoint: Schema.String,
  turnID: Schema.String,
  requestID: Schema.optional(Schema.String),
  imagegenRequestID: Schema.optional(Schema.String),
  generationID: Schema.optional(Schema.String),
  upstreamStatus: Schema.optional(Schema.Number),
  durationMs: Schema.Number,
})

export const CodexImage25Response = Schema.Struct({
  requested: Schema.Struct({ model: Model, size: Schema.String, quality: Quality, background: Background }),
  reported: Schema.Struct({
    model: Schema.optional(Schema.String),
    effectiveModel: Schema.optional(Schema.String),
    modelSnapshot: Schema.optional(Schema.String),
    size: Schema.optional(Schema.String),
    quality: Schema.optional(Schema.String),
    background: Schema.optional(Schema.String),
    outputFormat: Schema.optional(Schema.String),
  }),
  image: Schema.Struct({ width: Schema.Number, height: Schema.Number, bytes: Schema.Number, sha256: Schema.String }),
  diagnostics: Diagnostics,
  created: Schema.optional(Schema.Number),
  mediaType: Schema.Literal("image/png"),
  dataBase64: Schema.String,
  usage: Schema.optional(Schema.Unknown),
  warnings: Schema.Array(Schema.String),
})

const OptionalText = Schema.optional(Schema.NullOr(Schema.String))
const Payload = Schema.Struct({
  created: Schema.optional(Schema.NullOr(Schema.Number)),
  model: OptionalText,
  effective_model: OptionalText,
  model_snapshot: OptionalText,
  size: OptionalText,
  quality: OptionalText,
  background: OptionalText,
  output_format: OptionalText,
  usage: Schema.optional(Schema.Unknown),
  data: Schema.Array(Schema.Struct({ b64_json: Schema.String, generation_id: OptionalText })).check(
    Schema.isMinLength(1),
  ),
})

export class CodexImage25Error extends CodexImageGenerationError {
  constructor(
    message: string,
    status: number,
    readonly diagnostics?: typeof Diagnostics.Type,
  ) {
    super(message, status)
    this.name = "CodexImage25Error"
  }
}

// Read PNG header dimensions independently of the provider's claimed output size.
export function inspectCodexPNG(base64: string) {
  const encoded = base64.trim()
  const data = Buffer.from(encoded, "base64")
  if (
    data.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "") ||
    data.length < 45 ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.readUInt32BE(8) !== 13 ||
    data.subarray(12, 16).toString("ascii") !== "IHDR" ||
    data.subarray(-8, -4).toString("ascii") !== "IEND" ||
    data.readUInt32BE(16) === 0 ||
    data.readUInt32BE(20) === 0
  )
    throw new CodexImage25Error("Codex image generation did not return a PNG with readable dimensions.", 502)

  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  }
}

export async function generateCodexImage25(
  fetcher: CodexImageFetch,
  input: typeof CodexImage25Request.Type,
  abort?: AbortSignal,
): Promise<typeof CodexImage25Response.Type> {
  if (!Schema.is(CodexImage25Request)(input))
    throw new CodexImage25Error(
      "Invalid experimental image request; explicitly select a supported GPT Image 2.5 model.",
      400,
    )
  const prompt = input.prompt.trim()
  if (!prompt) throw new CodexImage25Error("Image prompt is empty.", 400)
  const images = input.images ?? []
  if (images.some((image) => !image.mediaType.startsWith("image/") || !image.dataBase64.trim()))
    throw new CodexImage25Error("Every reference must have an image media type and nonempty base64 data.", 400)

  const size = input.size?.trim() || "auto"
  if (size !== "auto") {
    const match = /^(\d+)x(\d+)$/.exec(size)
    const width = Number(match?.[1])
    const height = Number(match?.[2])
    if (
      !match ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width % 16 !== 0 ||
      height % 16 !== 0 ||
      Math.max(width, height) > 3840 ||
      Math.max(width, height) / Math.min(width, height) > 3 ||
      width * height < 655_360 ||
      width * height > 8_294_400
    )
      throw new CodexImage25Error(
        "Image size must be auto or WIDTHxHEIGHT using multiples of 16, at most 3840px, a 3:1 aspect ratio, and 655360-8294400 pixels.",
        400,
      )
  }

  const requested = {
    model: input.model,
    size,
    quality: input.quality ?? "auto",
    background: input.background ?? "auto",
  }
  const started = performance.now()
  const endpoint = images.length ? CODEX_IMAGE_EDIT_ENDPOINT : CODEX_IMAGE_ENDPOINT
  const turnID = crypto.randomUUID()
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", originator: "kilo", "x-codex-image-turn-id": turnID },
    body: JSON.stringify({
      ...requested,
      prompt,
      ...(images.length
        ? {
            images: images.map((image) => ({ image_url: `data:${image.mediaType};base64,${image.dataBase64.trim()}` })),
          }
        : {}),
    }),
    signal: abort ? AbortSignal.any([abort, AbortSignal.timeout(5 * 60 * 1000)]) : AbortSignal.timeout(5 * 60 * 1000),
  }).catch((cause: unknown) => {
    throw new CodexImage25Error(
      `Experimental Codex request failed; submission may have reached the provider. No retry was made: ${cause instanceof Error ? cause.message : String(cause)}`,
      502,
      { endpoint, turnID, durationMs: Math.round(performance.now() - started) },
    )
  })
  const diagnostics = {
    endpoint,
    turnID,
    upstreamStatus: response.status,
    requestID: response.headers.get("x-request-id") || undefined,
    imagegenRequestID: response.headers.get("x-codex-imagegen-request-id") || undefined,
    durationMs: 0,
  }
  const text = await response.text().catch((cause: unknown) => {
    throw new CodexImage25Error(
      `Unable to read the Codex response; no retry was made: ${cause instanceof Error ? cause.message : String(cause)}`,
      502,
      { ...diagnostics, durationMs: Math.round(performance.now() - started) },
    )
  })
  diagnostics.durationMs = Math.round(performance.now() - started)
  if (!response.ok)
    throw new CodexImage25Error(
      `Experimental Codex image request failed (HTTP ${response.status}): ${text.trim().slice(0, 2048) || response.statusText}`,
      response.status,
      diagnostics,
    )

  const value = (() => {
    try {
      return Schema.decodeUnknownSync(Payload)(JSON.parse(text))
    } catch {
      throw new CodexImage25Error("Codex image generation returned an invalid image response.", 502, diagnostics)
    }
  })()
  const dataBase64 = value.data[0].b64_json.trim()
  const image = (() => {
    try {
      return inspectCodexPNG(dataBase64)
    } catch (cause) {
      throw new CodexImage25Error(cause instanceof Error ? cause.message : String(cause), 502, diagnostics)
    }
  })()
  const reported = {
    model: value.model ?? undefined,
    effectiveModel: value.effective_model ?? undefined,
    modelSnapshot: value.model_snapshot ?? undefined,
    size: value.size ?? undefined,
    quality: value.quality ?? undefined,
    background: value.background ?? undefined,
    outputFormat: value.output_format ?? undefined,
  }
  const warnings = [
    "Experimental Codex model selection is unverified; provider-reported fields are not independent proof of model identity.",
  ]
  if (!reported.model && !reported.effectiveModel)
    warnings.push(
      "The provider did not report a model. The requested model must not be treated as the effective model.",
    )
  if ((reported.effectiveModel || reported.model) && (reported.effectiveModel || reported.model) !== requested.model)
    warnings.push(
      `Provider-reported model differs from the requested model: ${reported.effectiveModel || reported.model}.`,
    )
  const actual = `${image.width}x${image.height}`
  if (requested.size !== "auto" && requested.size !== actual)
    warnings.push(`Requested size ${requested.size} differs from PNG header dimensions ${actual}.`)
  if (reported.size && reported.size !== actual)
    warnings.push(`Provider-reported size ${reported.size} differs from PNG header dimensions ${actual}.`)
  if (requested.quality !== "auto" && reported.quality && requested.quality !== reported.quality)
    warnings.push(`Requested quality ${requested.quality} differs from provider-reported quality ${reported.quality}.`)
  if (requested.background !== "auto" && reported.background && requested.background !== reported.background)
    warnings.push(
      `Requested background ${requested.background} differs from provider-reported background ${reported.background}.`,
    )

  return {
    requested,
    reported,
    image,
    diagnostics: { ...diagnostics, generationID: value.data[0].generation_id ?? undefined },
    created: value.created ?? undefined,
    mediaType: "image/png",
    dataBase64,
    usage: value.usage,
    warnings,
  }
}
