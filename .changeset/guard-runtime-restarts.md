---
"@kilocode/cli": minor
"@kilocode/sdk": minor
---

Expose process runtime provenance and bounded quiescence leases for guarded restarts. Reject manual compaction while a session is preparing, running, retrying, or settling, without cancelling active work.

Prevent aborted preparation from starting queued work, and retain restart ownership until the old process and its pending lifecycle operation have stopped.

Report effective startup compaction request and time limits in server health diagnostics.

Keep credential-readiness queries passive without initializing cold workspaces or contacting organization services.
