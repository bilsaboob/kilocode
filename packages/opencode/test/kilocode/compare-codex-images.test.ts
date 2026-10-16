import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { compare } from "../../script/kilocode/compare-codex-images"
import { tmpdir } from "../fixture/fixture"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFioAAAAASUVORK5CYII="
const secret = "comparison-password-secret"
const username = "comparison-user-secret"
const auth = `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`
const env = { KILO_SERVER_USERNAME: username, KILO_SERVER_PASSWORD: secret }
const prompt = "  Private ceramic teapot prompt  "
const input = {
  prompt,
  sizes: ["1024x1024", "1920x1088"],
  quality: "high",
  background: "opaque",
  images: [{ mediaType: "image/png", dataBase64: png }],
}

async function fixture(value: unknown = input) {
  return tmpdir({
    init: async (dir) => {
      const file = join(dir, "spec.json")
      await writeFile(file, JSON.stringify(value))
      const out = join(dir, "comparison")
      return { file, out, args: ["--input", file, "--out", out] }
    },
  })
}

async function latest(dir: string) {
  const names = (await readdir(dir)).filter((name) => name.startsWith("manifest-")).sort()
  return Bun.file(join(dir, names.at(-1)!)).json()
}

function baseline() {
  return {
    model: "gpt-image-2",
    created: 123,
    size: "640x1024",
    quality: "low",
    background: "auto",
    mediaType: "image/png",
    dataBase64: png,
  }
}

describe("Codex image comparison", () => {
  test("help documents opt-in execution without reading files or sending requests", async () => {
    const logs: string[] = []
    expect(
      await compare(["--help"], {
        env: {},
        log: (text) => logs.push(text),
        fetch: async () => {
          throw new Error("Must not fetch")
        },
      }),
    ).toBe(0)
    expect(logs.join("\n")).toContain("--run")
    expect(logs.join("\n")).toContain("manifest-NNN.json")
    expect(logs.join("\n")).toContain("KILO_SERVER_PASSWORD")
  })

  test("dry run prints a stable sanitized matrix and makes no requests or artifacts", async () => {
    await using tmp = await fixture()
    const logs: string[] = []
    let calls = 0
    const result = await compare(tmp.extra.args, {
      env,
      log: (text) => logs.push(text),
      fetch: async () => {
        calls++
        throw new Error("Must not fetch")
      },
    })
    expect(result).toBe(0)
    expect(calls).toBe(0)
    expect(await readdir(tmp.path)).toEqual(["spec.json"])
    const plan = JSON.parse(logs[0])
    expect(plan.mode).toBe("dry-run")
    expect(plan.executed).toBe(0)
    expect(plan.calls).toBe(6)
    expect(plan.cost).toContain("Unknown")
    expect(plan.prompt).toEqual({ chars: prompt.length, sha256: createHash("sha256").update(prompt).digest("hex") })
    expect(plan.images[0]).toEqual({
      mediaType: "image/png",
      bytes: Buffer.from(png, "base64").length,
      sha256: createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"),
    })
    expect(
      plan.requests.map((row: { endpoint: string; requested: { model: string; size: string } }) => [
        row.endpoint,
        row.requested.model,
        row.requested.size,
      ]),
    ).toEqual([
      ["/codex/image/generate", "gpt-image-2", "1024x1024"],
      ["/codex/image/generate-2.5", "gpt-image-2.5-flare", "1024x1024"],
      ["/codex/image/generate-2.5", "gpt-image-2.5-sunburst", "1024x1024"],
      ["/codex/image/generate", "gpt-image-2", "1920x1088"],
      ["/codex/image/generate-2.5", "gpt-image-2.5-flare", "1920x1088"],
      ["/codex/image/generate-2.5", "gpt-image-2.5-sunburst", "1920x1088"],
    ])
    for (const value of [prompt, png, secret, username, auth, auth.slice(6), "dataBase64", "Authorization"])
      expect(logs.join("\n")).not.toContain(value)
  })

  test.each([
    { ...input, sizes: [] },
    { ...input, sizes: Array(9).fill("auto") },
    { ...input, sizes: ["1024x1024", "01024x1024"] },
    ...["1920x1080", "0x1024", "4096x1024", "3072x3072", "3072x768", "512x512", "url", "AUTO"].map((size) => ({
      ...input,
      sizes: [size],
    })),
    { ...input, quality: "xhigh" },
    { ...input, quality: null },
    { ...input, background: "transparent" },
    { ...input, background: null },
    { ...input, model: "arbitrary-model" },
    { ...input, images: Array(6).fill(input.images[0]) },
    { ...input, images: [{ mediaType: "image/png", dataBase64: "https://example.invalid/image.png" }] },
  ])("rejects invalid or unbounded specs before side effects (%#)", async (value) => {
    await using tmp = await fixture(value)
    let calls = 0
    expect(
      await compare([...tmp.extra.args, "--run"], {
        env: {},
        log: () => {},
        fetch: async () => {
          calls++
          return Response.json(baseline())
        },
      }),
    ).toBe(1)
    expect(calls).toBe(0)
    expect(await readdir(tmp.path)).toEqual(["spec.json"])
  })

  test("runs identical shared payloads sequentially and separates PNG facts from metadata", async () => {
    await using tmp = await fixture()
    const logs: string[] = []
    const seen: Array<{
      url: URL
      headers: Headers
      body: Record<string, unknown>
      checkpoint: Awaited<ReturnType<typeof latest>>
    }> = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const body = await request.json()
        seen.push({ url, headers: request.headers, body, checkpoint: await latest(tmp.extra.out) })
        if (url.pathname === "/codex/image/generate") return Response.json(baseline())
        return Response.json({
          requested: { model: body.model, size: body.size, quality: body.quality, background: body.background },
          reported: {
            model: body.model,
            ...(body.model === "gpt-image-2.5-sunburst"
              ? { effectiveModel: "upstream-other-model", modelSnapshot: "upstream-snapshot" }
              : {}),
            size: "640x1024",
            quality: "low",
            background: "auto",
            outputFormat: "png",
            Authorization: auth,
          },
          image: { width: 2048, height: 2048, bytes: 999, sha256: "0".repeat(64), dataBase64: png },
          diagnostics: {
            endpoint: "https://inline:credential@example.invalid/images",
            turnID: "turn",
            requestID: "request",
            imagegenRequestID: "imagegen",
            generationID: "generation",
            durationMs: 42,
            upstreamStatus: 200,
            Authorization: auth,
          },
          created: 123,
          mediaType: "image/png",
          dataBase64: png,
          warnings: [`Echoed ${secret} ${username} ${auth} ${png} ${prompt}`],
          usage: {
            input_tokens: 12,
            input_tokens_details: { image_tokens: 4, text_tokens: 8 },
            debug: auth,
            dataBase64: png,
          },
          credentials: auth,
        })
      },
    })
    const args = [...tmp.extra.args, "--url", server.url.origin, "--directory", tmp.path, "--run"]
    expect(await compare(args, { env, log: (text) => logs.push(text) })).toBe(0)
    expect(seen).toHaveLength(6)
    for (const [index, request] of seen.entries()) {
      expect(request.headers.get("authorization")).toBe(auth)
      expect(request.url.searchParams.get("directory")).toBe(tmp.path)
      expect(request.checkpoint.requests[index].status).toBe("running")
      expect(
        request.checkpoint.requests.slice(0, index).every((row: { status: string }) => row.status === "completed"),
      ).toBe(true)
      expect(
        request.checkpoint.requests.slice(index + 1).every((row: { status: string }) => row.status === "pending"),
      ).toBe(true)
      const model = [undefined, "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"][index % 3]
      expect(request.url.pathname).toBe(model ? "/codex/image/generate-2.5" : "/codex/image/generate")
      expect(request.body).toEqual({
        prompt,
        images: input.images,
        quality: input.quality,
        background: input.background,
        size: input.sizes[Math.floor(index / 3)],
        ...(model ? { model } : {}),
      })
    }
    const manifest = await latest(tmp.extra.out)
    expect(manifest.status).toBe("completed")
    expect(manifest.requests[0].response.bridge.model).toBe("gpt-image-2")
    expect(manifest.requests[0].reported).not.toHaveProperty("model")
    expect(manifest.requests[0].reported).not.toHaveProperty("effectiveModel")
    expect(manifest.requests[1].reported).not.toHaveProperty("effectiveModel")
    expect(manifest.requests[2].reported.effectiveModel).toBe("upstream-other-model")
    expect(manifest.requests[2].reported.modelSnapshot).toBe("upstream-snapshot")
    expect(manifest.requests[1].response.image.width).toBe(2048)
    expect(manifest.requests[1].response.diagnostics).toMatchObject({
      turnID: "turn",
      requestID: "request",
      imagegenRequestID: "imagegen",
      generationID: "generation",
      durationMs: 42,
      upstreamStatus: 200,
    })
    expect(manifest.requests[1].response.usage).toEqual({
      input_tokens: 12,
      input_tokens_details: { text_tokens: 8, image_tokens: 4 },
    })
    for (const row of manifest.requests) {
      expect(row.image).toEqual({
        width: 1,
        height: 1,
        bytes: Buffer.from(png, "base64").length,
        sha256: createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"),
      })
      expect(Buffer.from(await Bun.file(join(tmp.extra.out, row.file)).arrayBuffer())).toEqual(
        Buffer.from(png, "base64"),
      )
      expect(row.httpStatus).toBe(200)
      expect(row.durationMs).toBeGreaterThanOrEqual(0)
      expect(row.warnings).toContain("PNG dimensions differ from requested size.")
      expect(row.warnings).toContain("PNG dimensions differ from reported size.")
      expect(row.warnings).toContain("Reported quality differs from requested quality.")
    }
    expect(manifest.requests[1].warnings).toContain("Independently inspected PNG differs from bridge image metadata.")
    expect(manifest.requests[2].warnings).toContain("Reported effectiveModel differs from requested model.")
    const names = await readdir(tmp.extra.out)
    expect(names.filter((name) => name.endsWith(".png"))).toHaveLength(6)
    expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(13)
    const snapshots = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => Bun.file(join(tmp.extra.out, name)).text()),
    )
    for (const value of [
      prompt,
      png,
      secret,
      username,
      auth,
      auth.slice(6),
      "dataBase64",
      "Authorization",
      "inline:credential",
    ])
      expect([...logs, ...snapshots].join("\n")).not.toContain(value)
    expect(await compare(args, { env, log: (text) => logs.push(text) })).toBe(1)
    expect(seen).toHaveLength(6)
    expect(await readdir(tmp.extra.out)).toEqual(names)
    expect(await latest(tmp.extra.out)).toEqual(manifest)
  })

  test.each([401, 403, 429, 500, 307])(
    "records HTTP %i and skips every remaining arm without retries or redirects",
    async (status) => {
      await using tmp = await fixture({ prompt: "teapot", sizes: ["auto"] })
      const logs: string[] = []
      let calls = 0
      expect(
        await compare([...tmp.extra.args, "--run"], {
          env: { KILO_SERVER_PASSWORD: secret },
          log: (text) => logs.push(text),
          fetch: async (_, init) => {
            calls++
            expect(init.redirect).toBe("manual")
            expect(new Headers(init.headers).get("authorization")).toBe(
              `Basic ${Buffer.from(`kilo:${secret}`).toString("base64")}`,
            )
            return Response.json({ error: secret }, { status, headers: { Location: "https://elsewhere.invalid" } })
          },
        }),
      ).toBe(1)
      expect(calls).toBe(1)
      const manifest = await latest(tmp.extra.out)
      expect(manifest.status).toBe("failed")
      expect(manifest.requests.map((row: { status: string }) => row.status)).toEqual(["failed", "skipped", "skipped"])
      expect(manifest.requests[0].httpStatus).toBe(status)
      expect(manifest.requests[0].error.stage).toBe("response")
      expect(manifest.requests[0].file).toBeUndefined()
      expect([...logs, JSON.stringify(manifest)].join("\n")).not.toContain(secret)
    },
  )

  test("records an ambiguous network failure without leaking exception text or retrying", async () => {
    await using tmp = await fixture()
    const logs: string[] = []
    let calls = 0
    expect(
      await compare([...tmp.extra.args, "--run"], {
        env,
        log: (text) => logs.push(text),
        fetch: async () => {
          calls++
          throw new Error(`socket reset ${auth} https://user:password@example.invalid`)
        },
      }),
    ).toBe(1)
    expect(calls).toBe(1)
    const manifest = await latest(tmp.extra.out)
    expect(manifest.requests[0].error).toEqual({
      stage: "network",
      message: "Network/timeout failure; remote outcome is unknown. No retries were made.",
    })
    expect(manifest.requests[0].httpStatus).toBeUndefined()
    expect(manifest.requests.slice(1).every((row: { status: string }) => row.status === "skipped")).toBe(true)
    for (const value of [auth, secret, "user:password", "socket reset"])
      expect([...logs, JSON.stringify(manifest)].join("\n")).not.toContain(value)
  })

  test("retains safe upstream failure status and diagnostics without persisting error text", async () => {
    await using tmp = await fixture({ prompt: "a", sizes: ["auto"] })
    const logs: string[] = []
    let calls = 0
    expect(
      await compare([...tmp.extra.args, "--run"], {
        env,
        log: (text) => logs.push(text),
        fetch: async () => {
          calls++
          return Response.json(
            {
              message: secret,
              upstreamStatus: 429,
              diagnostics: {
                endpoint: "/images",
                turnID: "turn",
                requestID: "request",
                durationMs: 123,
                upstreamStatus: 429,
                Authorization: auth,
              },
              dataBase64: png,
            },
            { status: 502 },
          )
        },
      }),
    ).toBe(1)
    expect(calls).toBe(1)
    const manifest = await latest(tmp.extra.out)
    expect(manifest.status).toBe("failed")
    expect(manifest.requests[0].httpStatus).toBe(502)
    expect(manifest.requests[0].response).toEqual({
      upstreamStatus: 429,
      diagnostics: { endpoint: "/images", turnID: "turn", requestID: "request", durationMs: 123, upstreamStatus: 429 },
    })
    expect([...logs, JSON.stringify(manifest)].join("\n")).not.toContain(secret)
    expect(JSON.stringify(manifest)).not.toContain("dataBase64")
  })

  test.each(["json", "png", "empty", "mediaType"])(
    "fails fast on invalid %s responses and saves no PNG",
    async (kind) => {
      await using tmp = await fixture()
      let calls = 0
      expect(
        await compare([...tmp.extra.args, "--run"], {
          env: {},
          log: () => {},
          fetch: async () => {
            calls++
            if (kind === "json") return new Response("not JSON")
            return Response.json({
              ...baseline(),
              ...(kind === "png"
                ? { dataBase64: "bm90IGEgcG5n" }
                : kind === "empty"
                  ? { dataBase64: "" }
                  : { mediaType: "image/jpeg" }),
            })
          },
        }),
      ).toBe(1)
      expect(calls).toBe(1)
      expect((await latest(tmp.extra.out)).requests[0].status).toBe("failed")
      expect((await readdir(tmp.extra.out)).some((name) => name.endsWith(".png"))).toBe(false)
    },
  )

  test("never overwrites a PNG created concurrently", async () => {
    await using tmp = await fixture()
    const file = join(tmp.extra.out, "001-gpt-image-2-1024x1024.png")
    let calls = 0
    expect(
      await compare([...tmp.extra.args, "--run"], {
        env: {},
        log: () => {},
        fetch: async () => {
          calls++
          await writeFile(file, "keep", { flag: "wx" })
          return Response.json(baseline())
        },
      }),
    ).toBe(1)
    expect(calls).toBe(1)
    expect(await Bun.file(file).text()).toBe("keep")
    const manifest = await latest(tmp.extra.out)
    expect(manifest.requests[0].error.stage).toBe("artifact")
    expect(manifest.requests[0].file).toBeUndefined()
  })

  test("refuses even an empty existing output directory before POST", async () => {
    await using tmp = await fixture()
    await mkdir(tmp.extra.out)
    let calls = 0
    expect(
      await compare([...tmp.extra.args, "--run"], {
        env: {},
        log: () => {},
        fetch: async () => {
          calls++
          return Response.json(baseline())
        },
      }),
    ).toBe(1)
    expect(calls).toBe(0)
    expect(await readdir(tmp.extra.out)).toEqual([])
  })

  test.each([
    "http://inline:password@localhost:4096",
    "http://localhost:4096?token=password",
    "http://localhost:4096/#password",
    "file:///private",
  ])("rejects unsafe origins without echoing values (%#)", async (url) => {
    await using tmp = await fixture()
    const logs: string[] = []
    let calls = 0
    expect(
      await compare([...tmp.extra.args, "--url", url, "--run"], {
        env: {},
        log: (text) => logs.push(text),
        fetch: async () => {
          calls++
          return Response.json(baseline())
        },
      }),
    ).toBe(1)
    expect(calls).toBe(0)
    expect(logs.join("\n")).not.toContain("password")
    expect(logs.join("\n")).not.toContain(url)
    expect(await readdir(tmp.path)).toEqual(["spec.json"])
  })
})
