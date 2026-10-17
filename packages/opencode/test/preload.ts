// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { afterAll } from "bun:test"
import { remove as cleanup } from "./kilocode/cleanup" // kilocode_change
// kilocode_change start - isolate inherited auth overrides before any source imports
const authContent = process.env.KILO_AUTH_CONTENT
delete process.env.KILO_AUTH_CONTENT
delete process.env.ZEN_KILO_CONTEXT_POLICY
delete process.env.KILO_COMPACTION_BUDGET
// Do not copy inherited provider secrets into fixture Env.Service instances.
for (const key of Object.keys(process.env)) {
  if (/TOKEN|SECRET|CREDENTIAL|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY/i.test(key)) delete process.env[key]
}
for (const key of [
  "KILO_CONFIG",
  "KILO_CONFIG_DIR",
  "KILO_CONFIG_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
])
  delete process.env[key]
// kilocode_change end

// Set XDG env vars FIRST, before any src/ imports
const dir = path.join(os.tmpdir(), "opencode-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  const { SessionExport } = await import("../src/kilocode/session-export") // kilocode_change
  const { Database } = await import("../src/storage/db")
  await SessionExport.shutdown() // kilocode_change
  Database.close()
  await cleanup(dir) // kilocode_change
  // kilocode_change start - restore only after isolated source cleanup finishes
  if (authContent === undefined) delete process.env.KILO_AUTH_CONTENT
  else process.env.KILO_AUTH_CONTENT = authContent
  // kilocode_change end
})

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["KILO_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")
process.env["KILO_EXPERIMENTAL_EVENT_SYSTEM"] = "true"
process.env["KILO_EXPERIMENTAL_WORKSPACES"] = "true"

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["KILO_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["KILO_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "kilo")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "21")

// Clear provider and server auth env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["LLM_GATEWAY_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]
delete process.env["KILO_SERVER_PASSWORD"]
delete process.env["KILO_SERVER_USERNAME"]

// Use in-memory sqlite
process.env["KILO_DB"] = ":memory:"

// Now safe to import from src/
const { Log } = await import("@opencode-ai/core/util/log")
const { initProjectors } = await import("../src/server/projectors")

void Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})

initProjectors()
