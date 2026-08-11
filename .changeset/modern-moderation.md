---
"@chatpack/core": minor
"@chatpack/adapter-memory": minor
"@chatpack/adapter-drizzle": minor
"@chatpack/client": minor
---

Add optional durable moderation controls: blocks, conversation mutes, abuse
reports with evidence snapshots, timed or permanent Chatpack bans, moderator
report workflow, and typed REST/client surfaces.

Ban enforcement is opt-in through configuration rather than adapter capability.
Bans are checked before routing and on every SSE heartbeat only when the
`moderation` option is configured - by default whenever `canModerate` is set,
since `banUser` is the only way to mint a ban. An app that never configures
`moderation` pays no ban lookups even on an adapter that supports them. Pass
`moderation: { enforceBans: true }` when ban rows are written outside Chatpack,
or `false` to keep the moderator tools without per-request enforcement.

`ModerationStorage.createBan` must decide in one statement whether a user already
has an active ban and return that ban instead of inserting a second. Both
first-party adapters now do, so two moderators banning the same person at the
same moment leave exactly one active row - otherwise the duplicate keeps
enforcing after the visible ban is revoked.
