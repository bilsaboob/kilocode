import type { Hooks, PluginInput } from "@kilocode/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OAUTH_DUMMY_KEY } from "../../auth"
import os from "os"
import { setTimeout as sleep } from "node:timers/promises"
import { OAuthBrowser } from "@/kilocode/plugin/oauth-browser" // kilocode_change
import { refreshCodexAuth } from "@/kilocode/provider/codex-refresh" // kilocode_change
import { CodexModels } from "@/kilocode/provider/codex-models" // kilocode_change
import { AuthStaleError, type AuthStore } from "@/kilocode/auth/store" // kilocode_change
import { AuthOutcome } from "@/kilocode/auth/outcome" // kilocode_change
import { codexExpiring } from "@/kilocode/provider/codex-expiry" // kilocode_change
import { AuthRequest } from "@/kilocode/auth/request" // kilocode_change
import { KiloContextPolicy } from "@/kilocode/session/context-policy" // kilocode_change
import { OpenAIWebSocketPool } from "./ws-pool"

const log = Log.create({ service: "plugin.codex" })

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
const ALLOWED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  // kilocode_change start - additional codex models supported by Kilo
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2-codex",
  // kilocode_change end
])

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "kilo", // kilocode_change
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface CodexAuthPluginOptions {
  browser?: OAuthBrowser.Options // kilocode_change - isolated listener/timer fixtures
  store?: ReturnType<typeof AuthStore.create> // kilocode_change - use real isolated stores in fixtures
  issuer?: string
  codexApiEndpoint?: string
  experimentalWebSockets?: boolean
}

// kilocode_change start - token exchange cancellation belongs to its browser attempt
async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    signal,
    // kilocode_change end
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

// kilocode_change start
async function refreshAccessToken(refreshToken: string, issuer = ISSUER, signal?: AbortSignal): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `kilo/${InstallationVersion}` },
    // kilocode_change end
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  // kilocode_change start - bounded typed outcomes never expose provider text
  const value = await AuthOutcome.response(response)
  if (typeof value.refresh_token !== "string" || !value.refresh_token)
    throw new AuthOutcome.Failure("exchange-uncertain")
  return value as unknown as TokenResponse
  // kilocode_change end
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <!-- kilocode_change start -->
    <title>Kilo - Codex Authorization Successful</title>
    <!-- kilocode_change end -->
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <!-- kilocode_change start -->
      <p>You can close this window and return to Kilo.</p>
      <!-- kilocode_change end -->
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <!-- kilocode_change start -->
    <title>Kilo - Codex Authorization Failed</title>
    <!-- kilocode_change end -->
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${OAuthBrowser.escape(error)}</div> <!-- kilocode_change -->
    </div>
  </body>
</html>`

// kilocode_change start - callback state and listener ownership are inseparable
const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`
const browser = OAuthBrowser.create<TokenResponse>({ redirect: redirectUri, success: HTML_SUCCESS, error: HTML_ERROR })
// kilocode_change end

export async function CodexAuthPlugin(input: PluginInput, options: CodexAuthPluginOptions = {}): Promise<Hooks> {
  const owner = {} // kilocode_change - disposal cannot cancel another plugin instance's browser attempt
  const discovery = options.store ? CodexModels.create(Date.now, options.store) : CodexModels.catalog // kilocode_change
  const issuer = options.issuer ?? ISSUER
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT
  let websocketFetchInstalled = false
  const websocketFetches: Array<ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>> = []

  return {
    async dispose() {
      for (const websocketFetch of websocketFetches) websocketFetch.close()
      websocketFetches.length = 0
      await browser.dispose(owner) // kilocode_change
    },
    provider: {
      id: "openai",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models

        // kilocode_change start
        const profile = KiloContextPolicy.configured()
        const auth = ctx.auth
        const catalog = profile
          ? () =>
              discovery.load({
                auth,
                endpoint: codexApiEndpoint,
                refresh: (auth) =>
                  refreshCodexAuth({
                    auth,
                    store: options.store,
                    refresh: (token, signal) => refreshAccessToken(token, issuer, signal),
                    account: extractAccountId,
                  }),
              })
          : undefined
        const limits = await catalog?.()
        // kilocode_change end
        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => {
              if (ALLOWED_MODELS.has(model.api.id)) return true
              const match = model.api.id.match(/^gpt-(\d+\.\d+)/)
              return match ? parseFloat(match[1]) > 5.4 : false
            })
            .map(([modelID, model]) => [
              modelID,
              {
                ...model,
                // kilocode_change start
                ...(limits &&
                  catalog && { codex: CodexModels.bind(CodexModels.lookup(limits, model.api.id), catalog) }),
                // kilocode_change end
                cost: {
                  input: 0,
                  output: 0,
                  cache: { read: 0, write: 0 },
                },
                limit: model.id.includes("gpt-5.5")
                  ? {
                      context: 400_000,
                      input: 272_000,
                      output: 128_000,
                    }
                  : model.limit,
              },
            ]),
        )
      },
    },
    auth: {
      provider: "openai",
      async loader(getAuth) {
        const auth = await getAuth()
        const websocketFetch = options.experimentalWebSockets
          ? OpenAIWebSocketPool.createWebSocketFetch({ httpFetch: fetch })
          : undefined
        if (websocketFetch) {
          websocketFetches.push(websocketFetch)
          websocketFetchInstalled = true
        }
        if (auth.type !== "oauth") return websocketFetch ? { fetch: websocketFetch } : {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          // kilocode_change start - defer accounting to the physical transport.
          fetch: AuthRequest.delegate(async (requestInput: RequestInfo | URL, init?: RequestInit) => {
            // kilocode_change end
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            let currentAuth = await AuthRequest.credential(init, getAuth) // kilocode_change - detached request view, never cached loader authority
            if (!currentAuth) throw new AuthStaleError() // kilocode_change
            if (currentAuth.type !== "oauth")
              return websocketFetch ? websocketFetch(requestInput, init) : AuthRequest.fetch(fetch, requestInput, init) // kilocode_change

            // kilocode_change start - expiry margin and coalescing belong to the revision-aware store.
            if (codexExpiring(currentAuth)) {
              log.info("refreshing codex access token")
              await AuthRequest.bound(init)?.report("refreshing") // kilocode_change
              currentAuth = await refreshCodexAuth({
                auth: currentAuth,
                store: options.store,
                refresh: (token, signal) =>
                  refreshAccessToken(token, issuer, init?.signal ? AbortSignal.any([signal, init.signal]) : signal),
                account: extractAccountId,
              })
              // kilocode_change end
            }
            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string } // kilocode_change

            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            if (authWithAccount.accountId) {
              headers.set("ChatGPT-Account-Id", authWithAccount.accountId)
            }

            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
            const url =
              parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
                ? new URL(codexApiEndpoint)
                : parsed

            const requestInit = {
              ...init,
              headers,
            }
            if (websocketFetch && parsed.pathname.endsWith("/responses")) return websocketFetch(url, requestInit)
            return AuthRequest.fetch(fetch, url, OpenAIWebSocketPool.withoutInternalHeaders(requestInit)) // kilocode_change
          }), // kilocode_change
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          // kilocode_change start - install attempt ownership before any async browser preparation
          authorize: async () => {
            const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
            const attempt = browser.begin(state, owner, options.browser)
            try {
              const pkce = await generatePKCE()
              await attempt.start((code, signal) => exchangeCodeForTokens(code, redirectUri, pkce, signal))
              return {
                url: buildAuthorizeUrl(redirectUri, pkce, state),
                instructions: "Complete authorization in your browser. This window will close automatically.",
                method: "auto" as const,
                callback: async () => {
                  try {
                    const tokens = await attempt.wait()
                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  } finally {
                    await attempt.close()
                  }
                },
              }
            } catch (error) {
              await attempt.close()
              throw error
            }
          },
          // kilocode_change end
        },
        {
          label: "ChatGPT Pro/Plus (headless)",
          type: "oauth",
          authorize: async () => {
            const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `opencode/${InstallationVersion}`,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${InstallationVersion}`,
                    },
                    body: JSON.stringify({
                      device_auth_id: deviceData.device_auth_id,
                      user_code: deviceData.user_code,
                    }),
                  })

                  if (response.ok) {
                    const data = (await response.json()) as {
                      authorization_code: string
                      code_verifier: string
                    }

                    const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${ISSUER}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })

                    if (!tokenResponse.ok) {
                      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    }

                    const tokens: TokenResponse = await tokenResponse.json()

                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" as const }
                  }

                  await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers["session-id"] = input.sessionID
      // Temporary fetch-layer hack: title generation currently shares the conversation
      // session ID, so the OpenAI plugin marks it for HTTP fallback until transport
      // context can be passed directly instead of smuggled through headers.
      if (websocketFetchInstalled && input.agent === "title") output.headers[OpenAIWebSocketPool.TITLE_HEADER] = "true"
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "openai") return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
  }
}
