export namespace KiloContextMedia {
  export class Unsupported extends Error {}

  const limit = 64 * 1024 * 1024
  const types = new Set([
    "image",
    "file",
    "media",
    "image-data",
    "image-url",
    "file-data",
    "file-url",
    "file-id",
    "image-file-id",
  ])
  const formats: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }

  function mime(value: string | undefined) {
    const name = value?.split(";")[0].trim().toLowerCase()
    return name === "image/jpg" ? "image/jpeg" : name
  }

  function decode(value: unknown, declared?: string) {
    if (value instanceof URL) value = value.href
    if (typeof value === "string") {
      if (/^(?:https?|file|blob):/i.test(value))
        throw new Unsupported("Cannot bound remote or referenced media context size")
      if (value.startsWith("data:")) {
        const separator = value.indexOf(",")
        const header = value.slice(5, separator).split(";")
        if (separator < 0 || header.at(-1)?.toLowerCase() !== "base64")
          throw new Unsupported("Unsupported inline media encoding")
        const actual = mime(header[0])
        if (declared && actual && declared !== actual) throw new Unsupported("Inline media MIME declarations disagree")
        declared ??= actual
        value = value.slice(separator + 1)
      }
      const encoded = String(value).replace(/\s/g, "")
      if (encoded.length > Math.ceil(limit / 3) * 4)
        throw new Unsupported("Inline media exceeds the local estimation byte limit")
      if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1)
        throw new Unsupported("Invalid inline media encoding")
      const bytes = Buffer.from(encoded, "base64")
      if (bytes.byteLength > limit) throw new Unsupported("Inline media exceeds the local estimation byte limit")
      return { bytes, declared }
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      if (value.byteLength > limit) throw new Unsupported("Inline media exceeds the local estimation byte limit")
      const bytes =
        value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value)
      return { bytes, declared }
    }
    throw new Unsupported("The inline media representation cannot be estimated")
  }

  function dimensions(bytes: Buffer) {
    const fail = (): never => {
      throw new Unsupported("Cannot read supported inline image dimensions")
    }
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      let offset = 8
      let width = 0
      let height = 0
      let pixels = false
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset)
        const end = offset + length + 12
        if (end > bytes.length) return fail()
        const kind = bytes.toString("ascii", offset + 4, offset + 8)
        if (kind === "IHDR") {
          if (offset !== 8 || length !== 13) return fail()
          width = bytes.readUInt32BE(offset + 8)
          height = bytes.readUInt32BE(offset + 12)
        }
        if (["acTL", "fcTL", "fdAT"].includes(kind)) throw new Unsupported("Cannot bound animated image context")
        if (kind === "IDAT") pixels = true
        if (kind === "IEND") {
          if (length || !width || !height || !pixels) return fail()
          return { width, height, format: "png" }
        }
        offset = end
      }
      return fail()
    }
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
      let offset = 2
      let found: { width: number; height: number; format: string } | undefined
      while (offset < bytes.length) {
        if (bytes[offset++] !== 255) return fail()
        while (bytes[offset] === 255) offset++
        if (offset >= bytes.length) return fail()
        const marker = bytes[offset++]
        if (marker === 217) return found ?? fail()
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue
        if (offset + 2 > bytes.length) return fail()
        const length = bytes.readUInt16BE(offset)
        if (length < 2 || offset + length > bytes.length) return fail()
        if (marker === 218) return found ?? fail()
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
          if (length < 8 || found) return fail()
          found = { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), format: "jpeg" }
        }
        offset += length
      }
      return fail()
    }
    if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
      const width = bytes.readUInt16LE(6)
      const height = bytes.readUInt16LE(8)
      let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0)
      let frames = 0
      const blocks = () => {
        while (offset < bytes.length) {
          const length = bytes[offset++]
          if (!length) return
          offset += length
          if (offset > bytes.length) fail()
        }
        fail()
      }
      while (offset < bytes.length) {
        const marker = bytes[offset++]
        if (marker === 59) return frames === 1 ? { width, height, format: "gif" } : fail()
        if (marker === 33) {
          if (offset >= bytes.length) return fail()
          offset++
          blocks()
          continue
        }
        if (marker !== 44 || offset + 9 > bytes.length) return fail()
        if (++frames > 1) throw new Unsupported("Cannot bound animated image context")
        if (
          bytes.readUInt16LE(offset) + bytes.readUInt16LE(offset + 4) > width ||
          bytes.readUInt16LE(offset + 2) + bytes.readUInt16LE(offset + 6) > height
        )
          return fail()
        const flags = bytes[offset + 8]
        offset += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0)
        if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return fail()
        offset++
        blocks()
      }
      return fail()
    }
    if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
      const end = bytes.readUInt32LE(4) + 8
      if (end > bytes.length || end < 20) return fail()
      let offset = 12
      let canvas: { width: number; height: number } | undefined
      let found: { width: number; height: number } | undefined
      while (offset + 8 <= end) {
        const kind = bytes.toString("ascii", offset, offset + 4)
        const length = bytes.readUInt32LE(offset + 4)
        const start = offset + 8
        if (start + length > end) return fail()
        if (kind === "ANIM" || kind === "ANMF") throw new Unsupported("Cannot bound animated image context")
        if (kind === "VP8X") {
          if (length !== 10 || canvas || found) return fail()
          if (bytes[start] & 2) throw new Unsupported("Cannot bound animated image context")
          canvas = { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1 }
        }
        if (kind === "VP8 ") {
          if (length < 10 || found || bytes.toString("hex", start + 3, start + 6) !== "9d012a") return fail()
          found = { width: bytes.readUInt16LE(start + 6) & 16383, height: bytes.readUInt16LE(start + 8) & 16383 }
        }
        if (kind === "VP8L") {
          if (length < 5 || found || bytes[start] !== 47) return fail()
          const value = bytes.readUInt32LE(start + 1)
          found = { width: (value & 16383) + 1, height: ((value >>> 14) & 16383) + 1 }
        }
        offset = start + length + (length & 1)
      }
      if (!found || offset !== end || (canvas && (canvas.width !== found.width || canvas.height !== found.height)))
        return fail()
      return { ...found, format: "webp" }
    }
    return fail()
  }

  export async function prepare(input: unknown) {
    const seen = new WeakSet<object>()
    let tokens = 0
    let images = 0

    async function visit(value: unknown, depth: number, opaque = false): Promise<unknown> {
      if (depth > 128) throw new Unsupported("Request structure is too deeply nested to estimate safely")
      if (value === null || typeof value !== "object") return value
      if (value instanceof URL) return value.href
      if (value instanceof Date) return value.toJSON()
      if (value instanceof Uint8Array || value instanceof ArrayBuffer)
        throw new Unsupported("Unclassified binary context cannot be estimated")
      if (seen.has(value)) throw new Unsupported("Cyclic context cannot be estimated")
      seen.add(value)
      try {
        if (Array.isArray(value)) {
          const result: unknown[] = []
          for (const item of value) result.push(await visit(item, depth + 1, opaque))
          return result
        }
        const item = value as Record<string, unknown>
        const kind = typeof item.type === "string" ? item.type : ""
        if (!opaque && types.has(kind)) {
          const keys = ["image", "data", "url"].filter((key) => item[key] !== undefined)
          if (keys.length !== 1) throw new Unsupported("Referenced or ambiguous media context cannot be estimated")
          const key = keys[0]
          const declared = mime(
            [item.mediaType, item.mimeType, item.mime].find((value): value is string => typeof value === "string"),
          )
          const data = decode(item[key], declared)
          const text =
            data.declared?.startsWith("text/") || ["application/json", "application/xml"].includes(data.declared ?? "")
          if (text && !kind.startsWith("image") && kind !== "media") {
            try {
              return { ...item, [key]: new TextDecoder("utf-8", { fatal: true }).decode(data.bytes) }
            } catch {
              throw new Unsupported("Inline text file is not valid UTF-8")
            }
          }
          if (data.declared && !Object.values(formats).includes(data.declared))
            throw new Unsupported("This media type has no supported local context estimator")
          const metadata = dimensions(data.bytes)
          const width = metadata.width
          const height = metadata.height
          if (!width || !height || !Number.isSafeInteger(width * height))
            throw new Unsupported("Cannot bound animated or invalid image context")
          const actual = metadata.format && formats[metadata.format]
          if (!actual || (data.declared && actual !== data.declared))
            throw new Unsupported("Inline image format does not match its MIME declaration")

          // Do not charge base64 transport bytes as language tokens or assume
          // provider downscaling. This is a conservative estimate, not a tokenizer.
          const patches = Math.ceil(width / 32) * Math.ceil(height / 32)
          tokens += Math.ceil((4096 + 4 * patches) * 1.3)
          images++
          if (!Number.isSafeInteger(tokens)) throw new Unsupported("Image context estimate exceeds the supported range")
          const result: Record<string, unknown> = {}
          for (const [name, field] of Object.entries(item)) {
            Object.defineProperty(result, name, {
              value: name === key ? `[inline ${actual} ${width}x${height}]` : await visit(field, depth + 1),
              enumerable: true,
              writable: true,
              configurable: true,
            })
          }
          return result
        }
        const result: Record<string, unknown> = {}
        for (const [name, field] of Object.entries(item)) {
          const literal =
            opaque ||
            ["tools", "options", "providerOptions", "providerMetadata", "inputSchema"].includes(name) ||
            (kind === "tool-call" && name === "input") ||
            (["json", "error-json"].includes(kind) && name === "value")
          Object.defineProperty(result, name, {
            value: await visit(field, depth + 1, literal),
            enumerable: true,
            writable: true,
            configurable: true,
          })
        }
        return result
      } finally {
        seen.delete(value)
      }
    }

    const value = await visit(input, 0)
    return { value, tokens, images }
  }
}
