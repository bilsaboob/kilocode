import type { Auth } from "@/auth"

export function codexExpiring(auth: Pick<Auth.Oauth, "access" | "expires">, now = Date.now()) {
  return !auth.access || auth.expires <= now + 60_000
}
