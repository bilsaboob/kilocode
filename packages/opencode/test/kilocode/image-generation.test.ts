import { describe, expect, test } from "bun:test"
import {
  CODEX_IMAGE_EDIT_ENDPOINT,
  CODEX_IMAGE_ENDPOINT,
  CODEX_IMAGE_MODEL,
  CodexImageGenerationError,
  generateCodexImage,
  type CodexImageFetch,
} from "../../src/kilocode/image-generation"

describe("Codex image generation", () => {
  test("uses the subscription image proxy with GPT Image 2", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher: CodexImageFetch = async (input, init) => {
      requests.push({ url: String(input), init })
      return Response.json({
        created: 123,
        size: "1254x1254",
        quality: "medium",
        background: "opaque",
        data: [{ b64_json: "cG5n" }],
      })
    }

    const result = await generateCodexImage(fetcher, { prompt: "  Design a dashboard  " })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(CODEX_IMAGE_ENDPOINT)
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      model: CODEX_IMAGE_MODEL,
      prompt: "Design a dashboard",
      background: "auto",
      quality: "auto",
      size: "auto",
    })
    expect(result).toEqual({
      model: CODEX_IMAGE_MODEL,
      created: 123,
      size: "1254x1254",
      quality: "medium",
      background: "opaque",
      mediaType: "image/png",
      dataBase64: "cG5n",
    })
  })

  test("uses the subscription edit proxy for image references", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher: CodexImageFetch = async (input, init) => {
      requests.push({ url: String(input), init })
      return Response.json({ created: 123, data: [{ b64_json: "cG5n" }] })
    }

    await generateCodexImage(fetcher, {
      prompt: "Match this reference",
      images: [{ mediaType: "image/png", dataBase64: "cmVm" }],
    })

    expect(requests[0].url).toBe(CODEX_IMAGE_EDIT_ENDPOINT)
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      model: CODEX_IMAGE_MODEL,
      prompt: "Match this reference",
      images: [{ image_url: "data:image/png;base64,cmVm" }],
      background: "auto",
      quality: "auto",
      size: "auto",
    })
  })

  test("forwards validated high-quality custom dimensions", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher: CodexImageFetch = async (input, init) => {
      requests.push({ url: String(input), init })
      return Response.json({ created: 123, data: [{ b64_json: "cG5n" }] })
    }

    await generateCodexImage(fetcher, { prompt: "Dashboard", quality: "high", size: "1920x1088" })

    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      model: CODEX_IMAGE_MODEL,
      prompt: "Dashboard",
      background: "auto",
      quality: "high",
      size: "1920x1088",
    })
    await expect(generateCodexImage(fetcher, { prompt: "Dashboard", size: "1920x1080" })).rejects.toThrow(
      "multiples of 16",
    )
    expect(requests).toHaveLength(1)
  })

  test("surfaces Codex errors and missing image data", async () => {
    const rejected: CodexImageFetch = async () =>
      Response.json({ error: { message: "image generation request was rate limited" } }, { status: 429 })
    await expect(generateCodexImage(rejected, { prompt: "Dashboard" })).rejects.toEqual(
      new CodexImageGenerationError("Codex image generation failed: image generation request was rate limited", 429),
    )

    const empty: CodexImageFetch = async () => Response.json({ created: 123, data: [] })
    await expect(generateCodexImage(empty, { prompt: "Dashboard" })).rejects.toThrow(
      "Codex image generation returned no image data",
    )
  })
})
