import fs from "fs/promises"
import ignore, { type Ignore } from "ignore"
import path from "path"
import { glob } from "glob"
import { FileIgnore } from "../../file/ignore"

const files = [".gitignore", ".kilocodeignore"] as const

export type IgnoreMatcher = Pick<Ignore, "ignores"> & {
  reload?(): Promise<void>
}

type Scope = {
  dir: string
  rules: Ignore
}

function notFound(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false
  }
  return "code" in err && err.code === "ENOENT"
}

async function read(file: string): Promise<string | undefined> {
  return fs.readFile(file, "utf8").catch((err) => {
    if (notFound(err)) {
      return undefined
    }
    throw err
  })
}

function normalize(file: string): string {
  const slash = file.replaceAll("\\", "/")
  const suffix = slash.endsWith("/") ? "/" : ""
  const rel = slash.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "")
  return rel ? rel + suffix : ""
}

function matches(scopes: Scope[], file: string): boolean {
  const rel = normalize(file)
  if (!rel || path.isAbsolute(file) || rel === ".." || rel.startsWith("../")) return false

  let ignored = false
  for (const scope of scopes) {
    if (scope.dir && rel !== scope.dir && !rel.startsWith(scope.dir + "/")) continue
    const local = scope.dir ? rel.slice(scope.dir.length + 1) : rel
    if (!local) continue
    const result = scope.rules.test(local)
    if (result.ignored) ignored = true
    if (result.unignored) ignored = false
  }
  return ignored
}

async function load(root: string): Promise<Scope[]> {
  const found = await Promise.all(
    files.map((name) =>
      glob(`**/${name}`, {
        cwd: root,
        absolute: false,
        nodir: true,
        dot: true,
        ignore: FileIgnore.PATTERNS,
      }),
    ),
  )
  const groups = new Map<string, Set<string>>()
  for (const file of found.flat()) {
    const rel = normalize(file)
    if (!rel || FileIgnore.match(rel)) continue
    const dir = normalize(path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel))
    const names = groups.get(dir) ?? new Set<string>()
    names.add(path.posix.basename(rel))
    groups.set(dir, names)
  }

  const dirs = [...groups.keys()].sort((a, b) => {
    const depth = a.split("/").filter(Boolean).length - b.split("/").filter(Boolean).length
    return depth || a.localeCompare(b)
  })
  const scopes: Scope[] = []

  for (const dir of dirs) {
    if (dir && matches(scopes, dir + "/")) continue

    const rules = ignore()
    for (const name of files) {
      if (!groups.get(dir)?.has(name)) continue
      const txt = await read(path.join(root, dir, name))
      if (txt?.trim()) rules.add(txt)
      rules.add(name)
    }
    scopes.push({ dir, rules })
  }

  return scopes
}

export async function loadIgnore(root: string): Promise<IgnoreMatcher> {
  let scopes = await load(root)
  return {
    ignores(file) {
      return matches(scopes, file)
    },
    async reload() {
      scopes = await load(root)
    },
  }
}
