import { Schema } from "effect"

export const CODEX_IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations"
export const CODEX_IMAGE_EDIT_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/edits"
export const CODEX_IMAGE_MODEL = "gpt-image-2"

export const CodexImageRequest = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1)),
  quality: Schema.optional(Schema.Literals(["auto", "low", "medium", "high"])),
  size: Schema.optional(Schema.String),
  images: Schema.optional(
    Schema.Array(
      Schema.Struct({
        mediaType: Schema.String,
        dataBase64: Schema.String,
      }),
    ),
  ),
})

export const CodexImageResponse = Schema.Struct({
  model: Schema.String,
  created: Schema.Number,
  size: Schema.optional(Schema.String),
  quality: Schema.optional(Schema.String),
  background: Schema.optional(Schema.String),
  mediaType: Schema.String,
  dataBase64: Schema.String,
})

type ImagePayload = typeof CodexImageRequest.Type
type ImageResult = typeof CodexImageResponse.Type
export type CodexImageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class CodexImageGenerationError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message)
    this.name = "CodexImageGenerationError"
  }
}

export async function generateCodexImage(
  fetcher: CodexImageFetch,
  input: ImagePayload,
  abort?: AbortSignal,
): Promise<ImageResult> {
  const prompt = input.prompt.trim()
  if (!prompt) throw new CodexImageGenerationError("Image prompt is empty.", 400)
  const images = (input.images ?? []).filter((image) => image.mediaType.startsWith("image/") && image.dataBase64.trim())
  if (images.length > 5)
    throw new CodexImageGenerationError("Codex image generation accepts at most five reference images.", 400)
  const quality = input.quality ?? "auto"
  const size = imageSize(input.size)
  const endpoint = images.length ? CODEX_IMAGE_EDIT_ENDPOINT : CODEX_IMAGE_ENDPOINT
  const body = images.length
    ? {
        model: CODEX_IMAGE_MODEL,
        prompt,
        images: images.map((image) => ({
          image_url: `data:${image.mediaType};base64,${image.dataBase64.trim()}`,
        })),
        background: "auto",
        quality,
        size,
      }
    : {
        model: CODEX_IMAGE_MODEL,
        prompt,
        background: "auto",
        quality,
        size,
      }

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: abort ? AbortSignal.any([abort, AbortSignal.timeout(5 * 60 * 1000)]) : AbortSignal.timeout(5 * 60 * 1000),
  })
  const text = await response.text()
  if (!response.ok) {
    const message = imageErrorMessage(text) || response.statusText || `HTTP ${response.status}`
    throw new CodexImageGenerationError(`Codex image generation failed: ${message}`, response.status)
  }

  const value = imageResponse(text)
  const image = value.data?.[0]?.b64_json?.trim()
  if (!image) throw new CodexImageGenerationError("Codex image generation returned no image data.")

  return {
    model: CODEX_IMAGE_MODEL,
    created: typeof value.created === "number" ? value.created : Math.floor(Date.now() / 1000),
    size: stringValue(value.size),
    quality: stringValue(value.quality),
    background: stringValue(value.background),
    mediaType: "image/png",
    dataBase64: image,
  }
}

function imageSize(value: string | undefined) {
  const size = value?.trim() || "auto"
  if (size === "auto") return size
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match) throw new CodexImageGenerationError("Codex image size must be auto or WIDTHxHEIGHT.", 400)
  const width = Number(match[1])
  const height = Number(match[2])
  const pixels = width * height
  const ratio = Math.max(width, height) / Math.min(width, height)
  if (
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    Math.max(width, height) > 3840 ||
    ratio > 3 ||
    pixels < 655_360 ||
    pixels > 8_294_400
  )
    throw new CodexImageGenerationError(
      "Codex image size must use multiples of 16, fit within 3840px and a 3:1 aspect ratio, and contain 655360-8294400 pixels.",
      400,
    )
  return `${width}x${height}`
}

function imageResponse(text: string) {
  try {
    return JSON.parse(text) as {
      created?: unknown
      size?: unknown
      quality?: unknown
      background?: unknown
      data?: Array<{ b64_json?: string }>
    }
  } catch (cause) {
    throw new CodexImageGenerationError(`Codex image generation returned invalid JSON: ${errorMessage(cause)}`)
  }
}

function imageErrorMessage(text: string) {
  try {
    const value = JSON.parse(text) as { error?: string | { message?: string }; message?: string }
    if (typeof value.error === "string") return value.error
    if (value.error && typeof value.error.message === "string") return value.error.message
    if (typeof value.message === "string") return value.message
  } catch {
    return text.trim()
  }
  return text.trim()
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}
