import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import { KilocodePaths } from "@/kilocode/server/httpapi/groups/kilocode"
import { SessionImportPaths } from "@/kilocode/server/httpapi/groups/session-import"
import { MessageID, PartID } from "@/session/schema"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler
  return (input: string, init?: RequestInit) =>
    handler(new Request(new URL(input, "http://localhost"), init), HttpApiServer.context)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("session file activity HttpApi", () => {
  test("returns projected activity for only the requested session", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const request = app()
    const headers = { "content-type": "application/json", "x-kilo-directory": tmp.path }
    const created = await request("/session", { method: "POST", headers, body: "{}" })
    expect(created.status).toBe(200)
    const session = (await created.json()) as { id: string }
    const messageID = MessageID.ascending()
    const partID = PartID.ascending()

    const message = await request(SessionImportPaths.message, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: messageID,
        sessionID: session.id,
        timeCreated: 1,
        data: {
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
        },
      }),
    })
    expect(message.status).toBe(200)

    const part = {
      id: partID,
      messageID,
      sessionID: session.id,
      type: "tool",
      callID: "call-http",
      tool: "write",
      state: {
        status: "completed",
        input: { filePath: "api.ts", content: "api" },
        title: "api.ts",
        output: "written",
        metadata: { filepath: `${tmp.path}/api.ts`, exists: false },
        time: { start: 1, end: 2 },
      },
    }
    const imported = await request(SessionImportPaths.part, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: partID, messageID, sessionID: session.id, timeCreated: 1, data: part }),
    })
    expect(imported.status).toBe(200)

    const updated = await request(`/session/${session.id}/message/${messageID}/part/${partID}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(part),
    })
    expect(updated.status).toBe(200)

    const response = await request(KilocodePaths.fileActivity.replace(":sessionID", session.id), { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      {
        sessionID: session.id,
        messageID,
        partID,
        callID: "call-http",
        tool: "write",
        path: `${tmp.path.replaceAll("\\", "/")}/api.ts`,
        action: "created",
        time: { created: 2 },
      },
    ])

    const missing = await request(KilocodePaths.fileActivity.replace(":sessionID", "ses_httpapi_missing"), { headers })
    expect(missing.status).toBe(404)
  })
})
