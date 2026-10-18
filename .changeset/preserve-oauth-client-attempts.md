---
"@kilocode/cli": patch
"kilo-code": patch
---

Refresh terminal and editor clients after authentication-only changes without disposing all sessions. Preserve each provider sign-in attempt so cancelled or delayed callbacks cannot complete a newer login attempt.
