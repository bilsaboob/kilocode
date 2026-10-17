import { expect, test } from "bun:test"
import ts from "typescript"
import { createRoot } from "solid-js"
import { useAuthRefresh } from "../../src/kilocode/tui/auth-refresh"

for (const [file, count] of [
  ["../../src/cli/cmd/tui/component/dialog-provider.tsx", 2],
  ["../../src/kilocode/components/dialog-kilo-auto-method.tsx", 1],
] as const) {
  test(`${file} binds every OAuth callback to the displayed authorization`, async () => {
    const text = await Bun.file(new URL(file, import.meta.url)).text()
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const callbacks: ts.ObjectLiteralExpression[] = []
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "sdk.client.provider.oauth.callback") {
        const payload = node.arguments[0]
        expect(ts.isObjectLiteralExpression(payload)).toBe(true)
        if (ts.isObjectLiteralExpression(payload)) callbacks.push(payload)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(callbacks).toHaveLength(count)
    for (const payload of callbacks) {
      const fields = Object.fromEntries(
        payload.properties
          .filter(ts.isPropertyAssignment)
          .map((field) => [field.name.getText(source), field.initializer.getText(source)]),
      )
      expect(fields).toMatchObject({
        providerID: "props.providerID",
        method: "props.index",
        attemptID: "props.authorization.attemptID",
      })
    }
  })
}

for (const file of [
  "../../src/cli/cmd/tui/component/dialog-provider.tsx",
  "../../src/kilocode/components/dialog-kilo-auto-method.tsx",
  "../../src/kilocode/components/dialog-kilo-organization.tsx",
  "../../src/kilocode/kilo-commands.tsx",
]) {
  test(`${file} refreshes auth state without disposing instances`, async () => {
    const text = await Bun.file(new URL(file, import.meta.url)).text()
    expect(text).not.toMatch(/\.(?:instance|global)\s*\.\s*dispose\s*\(/)
    expect(text).toMatch(/auth\.refresh\(\)|sync\.bootstrap\(\{ fatal: false \}\)/)
  })
}

test("TUI auth refresh preserves client bootstrap for repeated logins and suppresses a retired dialog", async () => {
  const calls: unknown[] = []
  const root = createRoot((dispose) => ({
    dispose,
    auth: useAuthRefresh({
      bootstrap: async (input) => {
        calls.push(input)
      },
    }),
  }))
  expect(await root.auth.refresh()).toBe(true)
  expect(await root.auth.refresh()).toBe(true)
  root.dispose()
  expect(root.auth.current()).toBe(false)
  expect(await root.auth.refresh()).toBe(false)
  expect(calls).toEqual([{ fatal: false }, { fatal: false }])
})

test("delayed refresh of a cancelled TUI login cannot continue over its replacement", async () => {
  const pending = Promise.withResolvers<void>()
  const old = createRoot((dispose) => ({ dispose, auth: useAuthRefresh({ bootstrap: () => pending.promise }) }))
  const result = old.auth.refresh()
  old.dispose()
  const current = createRoot((dispose) => ({ dispose, auth: useAuthRefresh({ bootstrap: async () => {} }) }))
  try {
    expect(await current.auth.refresh()).toBe(true)
    pending.resolve()
    expect(await result).toBe(false)
    expect(old.auth.current()).toBe(false)
    expect(current.auth.current()).toBe(true)
  } finally {
    current.dispose()
  }
})

test("TUI refresh reports current failures but ignores a retired dialog's late failure", async () => {
  const pending = Promise.withResolvers<void>()
  const root = createRoot((dispose) => ({ dispose, auth: useAuthRefresh({ bootstrap: () => pending.promise }) }))
  const result = root.auth.refresh()
  root.dispose()
  pending.reject(new Error("retired refresh"))
  expect(await result).toBe(false)
  const current = createRoot((dispose) => ({
    dispose,
    auth: useAuthRefresh({
      bootstrap: async () => {
        throw new Error("current refresh")
      },
    }),
  }))
  try {
    await expect(current.auth.refresh()).rejects.toThrow("current refresh")
  } finally {
    current.dispose()
  }
})
