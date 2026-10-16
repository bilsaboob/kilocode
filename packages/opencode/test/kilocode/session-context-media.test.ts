import { expect, test } from "bun:test"
import { KiloContextMedia } from "../../src/kilocode/session/context-media"
import { png } from "./fixture/context-image"

function image(bytes: Buffer, mediaType = "image/png") {
  return { type: "image", image: `data:${mediaType};base64,${bytes.toString("base64")}` }
}

test("screenshot estimates depend on geometry rather than base64 compression size", async () => {
  const compressed = image(png(1920, 1072, 9))
  const large = image(png(1920, 1072, 0))
  expect(large.image.length).toBeGreaterThan(2_000_000)
  const first = await KiloContextMedia.prepare({ messages: [{ role: "user", content: [compressed] }] })
  const next = await KiloContextMedia.prepare({ messages: [{ role: "user", content: [large] }] })
  expect(next.tokens).toBe(first.tokens)
  expect(next.tokens).toBe(15_933)
  expect(next.images).toBe(1)
  expect(JSON.stringify(next.value).length).toBeLessThan(256)
  expect(large.image.length).toBeGreaterThan(2_000_000)
})

test("normal 1x and 2x prototype evidence remains bounded without removing any original image", async () => {
  const one = image(png(1920, 1072))
  const two = image(png(3840, 2144))
  const body = { messages: [{ role: "user", content: [one, two, one, two, one, two] }] }
  const before = JSON.stringify(body)
  const result = await KiloContextMedia.prepare(body)
  expect(result.images).toBe(6)
  expect(result.tokens).toBe((15_933 + 47_133) * 3)
  expect(result.tokens).toBeLessThan(300_000)
  expect(JSON.stringify(body)).toBe(before)
})

test("handles image URLs, binary parts and tool-result image-data consistently", async () => {
  const bytes = png(64, 32)
  const source = image(bytes)
  const values = [
    source,
    { type: "image", image: new URL(source.image) },
    { type: "image", image: bytes, mediaType: "image/png" },
    {
      type: "file",
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      mediaType: "image/png",
    },
    { type: "image-data", data: bytes.toString("base64"), mediaType: "image/png" },
    { type: "media", data: bytes.toString("base64"), mimeType: "image/png" },
  ]
  for (const value of values) {
    const result = await KiloContextMedia.prepare({ output: { type: "content", value: [value] } })
    expect(result.images).toBe(1)
    expect(result.tokens).toBe(5_336)
  }
})

test("supports JPEG, WebP and a nonanimated GIF", async () => {
  for (const [mediaType, buffer] of [
    [
      "image/jpeg",
      Buffer.from(
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8q3dpGLMSzE5JJySaKKK68X/vFT/E/wAyY7I//9k=",
        "base64",
      ),
    ],
    ["image/webp", Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=", "base64")],
    ["image/gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")],
  ] as const) {
    const result = await KiloContextMedia.prepare(image(buffer, mediaType))
    expect(result.images).toBe(1)
    expect(result.tokens).toBe(5_330)
  }
})

test("leaves textual evidence intact, including literal data URL text", async () => {
  const input = {
    messages: [{ role: "user", content: [{ type: "text", text: "data:image/png;base64,AAAA" }] }],
    tools: { test: { inputSchema: { type: "object" } } },
  }
  const result = await KiloContextMedia.prepare(input)
  expect(result.value).toEqual(input)
  expect(result.tokens).toBe(0)
  expect(result.images).toBe(0)
  const file = await KiloContextMedia.prepare({
    type: "file",
    data: Buffer.from("original text").toString("base64"),
    mediaType: "text/plain",
  })
  expect(file.value).toEqual({ type: "file", data: "original text", mediaType: "text/plain" })
})

test("rejects unbounded references, unsupported document formats and corrupt images", async () => {
  for (const part of [
    { type: "image", image: "https://example.invalid/image.png" },
    { type: "image", image: new URL("https://example.invalid/image.png") },
    { type: "image", image: "file:///private/image.png" },
    { type: "image-file-id", fileId: "file-unmeasured" },
    { type: "file", data: "JVBERg==", mediaType: "application/pdf" },
    { type: "image", image: "data:image/png;base64,AAAA" },
    { type: "image", image: "data:image/png;base64,!invalid!" },
    { type: "image", image: "data:image/svg+xml;base64,PHN2Zz4=" },
  ]) {
    await expect(KiloContextMedia.prepare(part)).rejects.toBeInstanceOf(KiloContextMedia.Unsupported)
  }
  await expect(KiloContextMedia.prepare(image(png(32, 32), "image/jpeg"))).rejects.toThrow("MIME declaration")
})

test("does not omit cyclic or unclassified binary payloads", async () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  await expect(KiloContextMedia.prepare(cyclic)).rejects.toThrow("Cyclic context")
  await expect(KiloContextMedia.prepare({ unknown: Buffer.from("binary") })).rejects.toThrow("Unclassified binary")
})

test("does not interpret tool arguments, JSON results or schema examples as vision parts", async () => {
  const data = { type: "image", data: "literal business data, not an image" }
  const input = {
    messages: [
      { role: "assistant", content: [{ type: "tool-call", input: data }] },
      { role: "tool", content: [{ type: "tool-result", output: { type: "json", value: data } }] },
    ],
    tools: { example: { inputSchema: { type: "object", examples: [data] } } },
  }
  const result = await KiloContextMedia.prepare(input)
  expect(result.value).toEqual(input)
  expect(result.images).toBe(0)
  expect(result.tokens).toBe(0)
})

test("keeps prototype-named JSON fields in the estimated text", async () => {
  const value: unknown = JSON.parse('{"__proto__":{"evidence":"must stay counted"},"constructor":"literal"}')
  const input = { messages: [{ role: "tool", content: [{ type: "tool-result", output: { type: "json", value } }] }] }
  const result = await KiloContextMedia.prepare(input)
  expect(JSON.stringify(result.value)).toBe(JSON.stringify(input))
  expect(result.tokens).toBe(0)
})
