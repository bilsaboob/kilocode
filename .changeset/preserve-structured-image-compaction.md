---
"@kilocode/cli": patch
---

Preserve complete structured image requests across safe compaction, including their output schema, instructions, tool restrictions, and original attachments. Stop with an actionable error instead of silently dropping required evidence or replaying an unsafe oversized request.

Keep structured-output formats readable after session storage, and report incomplete provider responses instead of silently completing without a result.
