---
"@kilocode/cli": minor
"@kilocode/sdk": minor
"@kilocode/kilo-gateway": patch
---

Expose passive credential readiness and preserve each request's selected authentication authority across renewal, continuations, and account changes without interrupting unrelated providers.

Refresh organization modes after sign-in, organization changes, and logout without restarting healthy workspace instances.

Stop automatic reuse of rotating credentials when an exchange outcome is uncertain, including across cooperating backend processes.

Keep stale browser sign-in callbacks from disrupting a newer attempt, and return redacted, inert authorization error pages.
