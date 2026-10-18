---
"@kilocode/cli": patch
---

Bound cumulative compaction requests and active time without stopping productive long-running tasks after three successful compactions. Preserve spent quota across retries and recovery, and stop safely without replacing original history when resources are exhausted.
