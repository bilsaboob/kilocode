const blocked = [
  "ZEN_KNOWLEDGE_TOOL_URL",
  "ZEN_KNOWLEDGE_TOOL_TOKEN",
  "ZEN_MEMORY_TOOL_URL",
  "ZEN_MEMORY_TOOL_TOKEN",
] as const

export namespace ChildEnv {
  export function scrub<T extends Record<string, string | undefined>>(input: T): T {
    const result: Record<string, string | undefined> = { ...input }
    for (const key of blocked) delete result[key]
    return result as T
  }

  // bun-pty merges its explicit env over the native parent's environment.
  // Its spawn call is synchronous, so remove credentials for that boundary.
  export function isolated<T>(fn: () => T): T {
    const previous = blocked.map((key) => [key, process.env[key]] as const)
    for (const key of blocked) delete process.env[key]
    try {
      return fn()
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        if (value !== undefined) process.env[key] = value
      }
    }
  }
}
