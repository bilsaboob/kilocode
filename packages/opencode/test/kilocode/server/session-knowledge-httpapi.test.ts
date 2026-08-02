import { afterEach, describe, expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { Server } from "@/server/server"
import { disposeAllInstances, provideTestInstance, tmpdir } from "../../fixture/fixture"

afterEach(disposeAllInstances)

describe("session Knowledge HTTP API", () => {
  test("round-trips create, update, and fork scopes through the generated SDK", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const client = createKiloClient({
          baseUrl: "http://localhost",
          directory: tmp.path,
          fetch: ((request: Request) => Server.Default().app.fetch(request)) as unknown as typeof fetch,
        })
        const knowledge = {
          scopes: [{ knowledgeBaseID: "kb_alpha", snapshotID: "kbs_one" }],
          grant: "opaque-grant",
        }
        const { data: root } = await client.session.create(
          { directory: tmp.path, title: "scoped", metadata: { keep: true }, knowledge },
          { throwOnError: true },
        )
        expect(root).toMatchObject({ metadata: { keep: true }, knowledge })

        const { data: narrowed } = await client.session.update(
          {
            sessionID: root.id,
            directory: tmp.path,
            metadata: { changed: true },
            knowledge: { scopes: knowledge.scopes },
          },
          { throwOnError: true },
        )
        expect(narrowed).toMatchObject({ metadata: { changed: true }, knowledge })

        const { data: updated } = await client.session.update(
          {
            sessionID: root.id,
            directory: tmp.path,
            knowledge: { scopes: [] },
          },
          { throwOnError: true },
        )
        expect(updated).toMatchObject({ metadata: { changed: true }, knowledge: { scopes: [] } })

        const { data: inherited } = await client.session.fork(
          { sessionID: root.id, directory: tmp.path },
          { throwOnError: true },
        )
        expect(inherited.knowledge).toEqual({ scopes: [] })

        const { data: restored } = await client.session.fork(
          { sessionID: root.id, directory: tmp.path, knowledge },
          { throwOnError: true },
        )
        expect(restored.knowledge).toEqual(knowledge)
      },
    })
  })
})
