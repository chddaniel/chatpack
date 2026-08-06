---
"@chatpack/client": patch
---

Re-render conversations when their name or membership changes. The cache
compared only read-state fields, on the assumption that a conversation's
participants never change - true for DMs, wrong for groups. A rename or a role
change made elsewhere would never reach a polling client, which kept rendering
the stale title and roles indefinitely. The comparison now covers `name` and the
participant set (membership, roles, and per-participant read-state).
