import type { Flock } from "@opencode-ai/core/util/flock"
import type { Auth } from "@/auth"
import { refreshOAuth } from "@/kilocode/auth/refresh"
import { AuthStaleError, type AuthStore } from "@/kilocode/auth/store"
import { AuthOutcome } from "@/kilocode/auth/outcome"
import { codexExpiring } from "./codex-expiry"

export class CodexAuthExpiredError extends AuthOutcome.Failure {
  constructor() {
    super("refresh-rejected")
    this.name = "CodexAuthExpiredError"
  }
}

type Tokens = {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

export async function refreshCodexAuth(input: {
  auth: Auth.Oauth
  store?: ReturnType<typeof AuthStore.create>
  refresh: (refresh: string, signal: AbortSignal) => Promise<Tokens>
  account: (tokens: Tokens) => string | undefined
  lock?: Flock.Options
  timeout?: number
}) {
  const account = input.auth.accountId
  return refreshOAuth({
    ...input,
    provider: "openai",
    expired: (auth) => {
      if (account && auth.accountId !== account) throw new AuthStaleError()
      return codexExpiring(auth)
    },
    rejected: (err) =>
      AuthOutcome.known(err)?.reason === "refresh-rejected" ? new CodexAuthExpiredError() : undefined,
    refresh: async (base) => {
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
        input.timeout ?? 30_000,
      )
      const tokens = await input
        .refresh(base.refresh, controller.signal)
        .catch((error) => AuthOutcome.exchange(controller.signal.aborted ? controller.signal.reason : error))
        .finally(() => clearTimeout(timer))
      if (!tokens.refresh_token || !tokens.access_token) throw new AuthOutcome.Failure("exchange-uncertain")
      const account = input.account(tokens)
      if (base.accountId && account && account !== base.accountId) throw new AuthStaleError()
      const id = account || base.accountId
      return {
        type: "oauth",
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        ...(id && { accountId: id }),
      }
    },
  })
}
