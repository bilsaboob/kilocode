import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import {
  CODEX_IMAGE_EDIT_ENDPOINT,
  CODEX_IMAGE_ENDPOINT,
  generateCodexImage,
} from "../../src/kilocode/image-generation"
import {
  CodexImage25Error,
  CodexImage25Request,
  CodexImage25Response,
  generateCodexImage25,
  inspectCodexPNG,
} from "../../src/kilocode/image-generation-25"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNc8AAAAASUVORK5CYII="
const models = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const
const result = () => Response.json({ created: 123, size: "1x1", data: [{ b64_json: png }] })

function payload(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body")
  return JSON.parse(init.body)
}

describe("experimental Codex GPT Image 2.5", () => {
  for (const model of models) {
    test.each(["auto", "1024x1024", "2048x2048", "3840x2160", "2160x3840"])(
      `${model} forwards requested size %s without substituting a model`,
      async (size) => {
        const requests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = []
        const output = await generateCodexImage25(
          async (url, init) => {
            requests.push({ url, init })
            return result()
          },
          { model, prompt: "  Preserve the frame and its colors.  ", size, quality: "high", background: "opaque" },
        )

        expect(requests).toHaveLength(1)
        expect(requests[0].url).toBe(CODEX_IMAGE_ENDPOINT)
        expect(payload(requests[0].init)).toEqual({
          model,
          prompt: "Preserve the frame and its colors.",
          size,
          quality: "high",
          background: "opaque",
        })
        const headers = new Headers(requests[0].init?.headers)
        expect(headers.get("originator")).toBe("kilo")
        expect(headers.get("x-codex-image-turn-id")).toBe(output.diagnostics.turnID)
        expect(output.requested).toEqual({ model, size, quality: "high", background: "opaque" })
        expect(output.reported.model).toBeUndefined()
        expect(output.reported.effectiveModel).toBeUndefined()
        expect(output.image).toEqual({
          width: 1,
          height: 1,
          bytes: Buffer.from(png, "base64").length,
          sha256: createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"),
        })
        expect(output.warnings.some((warning) => warning.includes("did not report a model"))).toBe(true)
        expect(output.warnings.some((warning) => warning.includes("Requested size"))).toBe(size !== "auto")
        expect(Schema.is(CodexImage25Response)(output)).toBe(true)
      },
    )
  }

  test("edits the supplied references and keeps provider claims separate from PNG dimensions", async () => {
    const requests: RequestInit[] = []
    const output = await generateCodexImage25(
      async (url, init) => {
        expect(url).toBe(CODEX_IMAGE_EDIT_ENDPOINT)
        requests.push(init ?? {})
        return Response.json(
          {
            model: "gpt-image-2",
            effective_model: "server-model",
            model_snapshot: "server-snapshot",
            size: "2048x2048",
            quality: "low",
            background: "opaque",
            output_format: "png",
            usage: { total_tokens: 10 },
            data: [{ b64_json: png, generation_id: "generation-123" }],
          },
          { headers: { "x-request-id": "outer-123", "x-codex-imagegen-request-id": "image-123" } },
        )
      },
      {
        model: "gpt-image-2.5-sunburst",
        prompt: "Remove only the background",
        size: "1024x1024",
        quality: "max",
        background: "transparent",
        images: [{ mediaType: "image/png", dataBase64: png }],
      },
    )

    expect(payload(requests[0]).images).toEqual([{ image_url: `data:image/png;base64,${png}` }])
    expect(output.requested.quality).toBe("max")
    expect(output.reported).toEqual({
      model: "gpt-image-2",
      effectiveModel: "server-model",
      modelSnapshot: "server-snapshot",
      size: "2048x2048",
      quality: "low",
      background: "opaque",
      outputFormat: "png",
    })
    expect(output.diagnostics).toMatchObject({
      requestID: "outer-123",
      imagegenRequestID: "image-123",
      generationID: "generation-123",
    })
    expect(output.image.width).toBe(1)
    expect(output.created).toBeUndefined()
    expect(output.usage).toEqual({ total_tokens: 10 })
    expect(output.warnings.some((warning) => warning.includes("Provider-reported size"))).toBe(true)
    expect(output.warnings.some((warning) => warning.includes("Requested quality"))).toBe(true)
    expect(output.warnings.some((warning) => warning.includes("Requested background"))).toBe(true)
    expect(output.warnings.some((warning) => warning.includes("Provider-reported model"))).toBe(true)
  })

  test("treats null provider metadata as unknown without discarding a returned PNG", async () => {
    const output = await generateCodexImage25(
      async () =>
        Response.json({
          created: null,
          model: null,
          effective_model: null,
          model_snapshot: null,
          size: null,
          quality: null,
          background: null,
          output_format: null,
          data: [{ b64_json: png, generation_id: null }],
        }),
      { model: models[0], prompt: "Frame" },
    )
    expect(output.reported.model).toBeUndefined()
    expect(output.created).toBeUndefined()
    expect(output.diagnostics.generationID).toBeUndefined()
    expect(output.image.width).toBe(1)
    expect(output.warnings.some((warning) => warning.includes("did not report a model"))).toBe(true)
  })

  test("does not broaden or change the old endpoint request and response contracts", async () => {
    const requests: Array<Record<string, unknown>> = []
    const fetcher = async (_: RequestInfo | URL, init?: RequestInit) => {
      requests.push(payload(init))
      return result()
    }
    await generateCodexImage25(fetcher, { model: models[0], prompt: "Same prompt", quality: "xhigh" })
    const output = await generateCodexImage(fetcher, { prompt: "Same prompt" })
    expect(requests.map((request) => request.model)).toEqual([models[0], "gpt-image-2"])
    expect(output).toEqual({
      model: "gpt-image-2",
      created: 123,
      size: "1x1",
      quality: undefined,
      background: undefined,
      mediaType: "image/png",
      dataBase64: png,
    })
  })

  test("requires an explicit supported model and validates experimental options", () => {
    const accepts = (input: unknown) => Schema.is(CodexImage25Request)(input)
    expect(accepts({ prompt: "Frame" })).toBe(false)
    expect(accepts({ prompt: "Frame", model: "gpt-image-2" })).toBe(false)
    expect(accepts({ prompt: "Frame", model: "unknown" })).toBe(false)
    expect(accepts({ prompt: "Frame", model: models[0], quality: "xhigh", background: "transparent" })).toBe(true)
    expect(accepts({ prompt: "Frame", model: models[0], quality: "ultra" })).toBe(false)
    expect(
      accepts({
        prompt: "Frame",
        model: models[0],
        images: Array.from({ length: 6 }, () => ({ mediaType: "image/png", dataBase64: png })),
      }),
    ).toBe(false)
  })

  test.each(["1920x1080", "3840x3840", "1024x256", "640x640", "0x1024", "large", "Infinityx1024"])(
    "rejects invalid size %s before any upstream request",
    async (size) => {
      let calls = 0
      expect(
        await generateCodexImage25(
          async () => {
            calls++
            return result()
          },
          {
            model: models[0],
            prompt: "Frame",
            size,
          },
        ).catch((cause: unknown) => cause),
      ).toMatchObject({ status: 400 })
      expect(calls).toBe(0)
    },
  )

  test("rejects empty prompts and invalid references rather than silently switching to generation", async () => {
    const fetcher = async () => {
      throw new Error("unexpected upstream request")
    }
    expect(
      await generateCodexImage25(fetcher, { model: models[0], prompt: "   " }).catch((cause: unknown) => cause),
    ).toMatchObject({
      status: 400,
    })
    expect(
      await generateCodexImage25(fetcher, {
        model: models[0],
        prompt: "Frame",
        images: [{ mediaType: "text/plain", dataBase64: "test" }],
      }).catch((cause: unknown) => cause),
    ).toMatchObject({ status: 400 })
  })

  test("preserves upstream errors and request IDs without retry or fallback", async () => {
    let calls = 0
    const failure = await generateCodexImage25(
      async () => {
        calls++
        return Response.json(
          { error: { message: "model not supported" } },
          {
            status: 403,
            headers: { "x-request-id": "failed-request" },
          },
        )
      },
      { model: models[0], prompt: "Frame" },
    ).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(CodexImage25Error)
    expect(failure).toMatchObject({ status: 403, diagnostics: { requestID: "failed-request" } })
    expect(calls).toBe(1)
  })

  test("marks ambiguous transport failures and does not retry", async () => {
    let calls = 0
    const failure = await generateCodexImage25(
      async () => {
        calls++
        throw new Error("connection lost")
      },
      { model: models[0], prompt: "Frame" },
    ).catch((cause: unknown) => cause)
    expect(failure).toMatchObject({ message: expect.stringContaining("submission may have reached the provider") })
    if (!(failure instanceof CodexImage25Error)) throw new Error("Expected an experimental bridge error")
    expect(failure.diagnostics?.upstreamStatus).toBeUndefined()
    expect(calls).toBe(1)
  })

  test.each(["not JSON", "null", JSON.stringify({ data: [] }), JSON.stringify({ data: [{ b64_json: "cG5n" }] })])(
    "rejects malformed successful response %s",
    async (body) => {
      expect(
        await generateCodexImage25(async () => new Response(body), {
          model: models[0],
          prompt: "Frame",
        }).catch((cause: unknown) => cause),
      ).toMatchObject({ status: 502, diagnostics: { upstreamStatus: 200 } })
    },
  )

  test("passes cancellation into the upstream transport", async () => {
    const controller = new AbortController()
    controller.abort()
    await generateCodexImage25(
      async (_, init) => {
        expect(init?.signal?.aborted).toBe(true)
        return result()
      },
      { model: models[0], prompt: "Frame" },
      controller.signal,
    )
  })

  test("PNG inspection rejects corrupt base64 and zero-sized headers", () => {
    expect(() => inspectCodexPNG(`${png}!`)).toThrow()
    const bytes = Buffer.from(png, "base64")
    bytes.writeUInt32BE(0, 16)
    expect(() => inspectCodexPNG(bytes.toString("base64"))).toThrow()
  })
})
