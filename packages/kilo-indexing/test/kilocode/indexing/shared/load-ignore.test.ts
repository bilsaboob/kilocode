import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { loadIgnore } from "../../../../src/indexing/shared/load-ignore"

describe("loadIgnore", () => {
  let root = ""

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "index-ignore-"))
  })

  afterEach(async () => {
    if (!root) {
      return
    }
    await rm(root, { recursive: true, force: true })
  })

  test("loads root .kilocodeignore in addition to root .gitignore", async () => {
    await writeFile(path.join(root, ".gitignore"), "dist/\n")
    await writeFile(path.join(root, ".kilocodeignore"), "secret/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("dist/out.ts")).toBe(true)
    expect(ig.ignores("secret/key.ts")).toBe(true)
    expect(ig.ignores("src/app.ts")).toBe(false)
  })

  test("preserves existing .gitignore-only behavior when .kilocodeignore is absent", async () => {
    await writeFile(path.join(root, ".gitignore"), "coverage/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("coverage/index.html")).toBe(true)
    expect(ig.ignores("src/app.ts")).toBe(false)
  })

  test("ignores the ignore files themselves", async () => {
    await writeFile(path.join(root, ".gitignore"), "dist/\n")
    await writeFile(path.join(root, ".kilocodeignore"), "secret/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores(".gitignore")).toBe(true)
    expect(ig.ignores(".kilocodeignore")).toBe(true)
  })

  test("applies nested ignore files relative to their directory", async () => {
    const pkg = path.join(root, "packages", "app")
    await mkdir(pkg, { recursive: true })
    await writeFile(path.join(pkg, ".gitignore"), "/generated/\n*.secret\n!keep.secret\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("packages/app/generated/client.ts")).toBe(true)
    expect(ig.ignores("packages/app/private.secret")).toBe(true)
    expect(ig.ignores("packages/app/keep.secret")).toBe(false)
    expect(ig.ignores("packages/other/generated/client.ts")).toBe(false)
    expect(ig.ignores("generated/client.ts")).toBe(false)
  })

  test("does not load ignore files inside a parent-ignored directory", async () => {
    const pkg = path.join(root, "packages", "ignored")
    await mkdir(pkg, { recursive: true })
    await writeFile(path.join(root, ".gitignore"), "packages/ignored/\n")
    await writeFile(path.join(pkg, ".gitignore"), "!keep.ts\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("packages/ignored/keep.ts")).toBe(true)
  })

  test("reloads rules added after startup", async () => {
    const ig = await loadIgnore(root)
    await writeFile(path.join(root, ".gitignore"), "generated/\n")

    expect(ig.ignores("generated/client.ts")).toBe(false)
    await ig.reload?.()
    expect(ig.ignores("generated/client.ts")).toBe(true)
  })
})
