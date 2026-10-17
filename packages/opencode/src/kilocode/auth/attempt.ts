import { Schema } from "effect"
import { Auth } from "@/auth"
import { AuthStore } from "./store"
import { AuthOutcome } from "./outcome"
import { AuthRequest } from "./request"
import { OAuthBrowser } from "../plugin/oauth-browser"

export namespace AuthAttempt {
  type Result =
    | { type: "failed" }
    | {
        type: "success"
        provider?: string
        key?: string
        refresh?: string
        access?: string
        expires?: number
        accountId?: string
        enterpriseUrl?: string
        metadata?: Record<string, string>
      }
  export async function invoke(input: {
    ticket: AuthStore.Attempt
    callback: () => Promise<Result>
    store?: ReturnType<typeof AuthStore.create>
    fallback?: { key: string; metadata?: Record<string, string> }
    signal?: AbortSignal
  }) {
    const store = input.store ?? AuthStore.disk
    return store.run(async () => {
      input.signal?.throwIfAborted()
      await store.attempt(input.ticket, true)
      input.signal?.throwIfAborted()
      const result = await OAuthBrowser.run(input.signal, input.callback).catch((error) => {
        input.signal?.throwIfAborted()
        return AuthOutcome.exchange(error)
      })
      input.signal?.throwIfAborted()
      if (result.type !== "success") throw new AuthOutcome.Failure("refresh-rejected")
      const provider = result.provider ?? input.ticket.snapshot.provider
      const value =
        typeof result.refresh === "string"
          ? {
              type: "oauth",
              refresh: result.refresh,
              access: result.access,
              expires: result.expires,
              ...(result.accountId !== undefined && { accountId: result.accountId }),
              ...(result.enterpriseUrl !== undefined && { enterpriseUrl: result.enterpriseUrl }),
            }
          : {
              type: "api",
              key: result.key ?? input.fallback?.key,
              ...((result.metadata || input.fallback?.metadata) && {
                metadata: { ...input.fallback?.metadata, ...result.metadata },
              }),
            }
      const auth = Schema.decodeUnknownOption(Auth.Info)(value)
      if (auth._tag === "None") throw new AuthOutcome.Failure("exchange-uncertain")
      if (
        (auth.value.type === "api" && !auth.value.key) ||
        (auth.value.type === "oauth" && (!auth.value.access || !auth.value.refresh))
      )
        throw new AuthOutcome.Failure("exchange-uncertain")
      await store
        .complete(input.ticket, auth.value, provider, input.signal)
        .finally(() => AuthRequest.invalidate(provider))
      return provider
    })
  }
}
