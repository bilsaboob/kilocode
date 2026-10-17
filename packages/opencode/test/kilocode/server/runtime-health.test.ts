import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const cwd = path.resolve(import.meta.dir, "../../..")
// Inert child processes exercise module-startup capture. The real WebHandler runs without listening on a socket.
const script = `
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected fixture network request") }
  const { Layer } = await import("effect")
  const { HttpRouter } = await import("effect/unstable/http")
  const { HttpApi, HttpApiBuilder, HttpApiGroup } = await import("effect/unstable/httpapi")
  const { KiloRuntimeHttp } = await import("./src/kilocode/server/httpapi/runtime.ts")
  const { GlobalApi } = await import("./src/server/routes/instance/httpapi/groups/global.ts")
  const health = GlobalApi.groups.global.endpoints.health
  if (health.name !== "health") throw new Error("Unexpected health endpoint")
  const api = HttpApi.make("startup-health-fixture").add(HttpApiGroup.make("global").add(health))
  const routes = HttpApiBuilder.layer(api).pipe(Layer.provide(HttpApiBuilder.group(api, "global", (handlers) =>
    handlers.handle("health", KiloRuntimeHttp.health),
  )))
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
  const get = async () => {
    const response = await handler(new Request("http://fixture.invalid/global/health"))
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  try {
    const startup = process.env.KILO_COMPACTION_BUDGET
    process.env.KILO_COMPACTION_BUDGET = process.env.FIXTURE_BUDGET_AFTER
    const before = await get()
    if (startup === undefined) delete process.env.KILO_COMPACTION_BUDGET
    else process.env.KILO_COMPACTION_BUDGET = startup
    const after = await get()
    process.stdout.write(JSON.stringify({ before, after, calls }))
  } finally {
    await dispose()
  }
`

for (const input of [
  {
    name: "defaults",
    startup: undefined,
    after: '{"requests":2,"milliseconds":2000}',
    budget: { requests: 12, milliseconds: 900_000 },
  },
  {
    name: "valid override",
    startup: '{"requests":3,"milliseconds":2500}',
    after: "not-json",
    budget: { requests: 3, milliseconds: 2500 },
  },
  { name: "malformed JSON", startup: "not-json", after: '{"requests":12,"milliseconds":900000}', budget: undefined },
  {
    name: "invalid limits",
    startup: '{"requests":0,"milliseconds":900000}',
    after: '{"requests":12,"milliseconds":900000}',
    budget: undefined,
  },
]) {
  test(`health reports frozen startup budget: ${input.name}`, async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/TOKEN|SECRET|CREDENTIAL|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|^(KILO|OPENCODE)_CONFIG|^KILO_AUTH|^ZEN_/i.test(
            key,
          ),
      ),
    )
    const { stdout } = await execute(process.execPath, ["--conditions=browser", "--eval", script], {
      cwd,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...env,
        BUN_BE_BUN: "1",
        KILO_DB: ":memory:",
        KILO_COMPACTION_BUDGET: input.startup,
        FIXTURE_BUDGET_AFTER: input.after,
      },
    })
    const result = JSON.parse(stdout)
    expect(result.calls).toBe(0)
    expect(result.after).toEqual(result.before)
    if (!input.budget) {
      expect(result.before.status).toBe(500)
      expect(result.before.body?.healthy).not.toBe(true)
      expect(result.before.body?.compactionBudget).toBeUndefined()
      return
    }
    expect(result.before.status).toBe(200)
    expect(result.before.body.healthy).toBe(true)
    expect(result.before.body.compactionBudget).toEqual(input.budget)
    expect(Object.keys(result.before.body.compactionBudget).sort()).toEqual(["milliseconds", "requests"])
    expect(result.before.body.runtime.capabilities).toContain("compaction-budget-v1")
  }, 15_000)
}
