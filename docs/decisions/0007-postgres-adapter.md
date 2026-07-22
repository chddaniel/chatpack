# ADR 0007: Postgres adapter — atomic seq via `UPDATE ... RETURNING`, PGlite for tests

- **Status:** accepted
- **Date:** 2026-07-22
- **Milestone:** M4

## Context

M4 brings the first real database behind the `StorageAdapter` interface
(ADR 0001): Drizzle ORM on Postgres. Two implementation questions matter more
than all the others combined:

1. How is the per-conversation monotonic `seq` (ADR 0003) assigned **safely
   under concurrency**? The in-memory adapter could just do `nextSeq++`
   because JavaScript is single-threaded; Postgres has genuinely concurrent
   writers.
2. How do we test against **real Postgres semantics** without making every
   contributor (and CI) run Docker?

## Decision

### Atomic seq: a counter column bumped with `UPDATE ... RETURNING`

`chatpack_conversations.last_seq` holds the latest assigned seq. `addMessage`
executes:

```sql
UPDATE chatpack_conversations
SET last_seq = last_seq + 1, last_activity_at = now
WHERE id = $conversationId
RETURNING last_seq;
```

Postgres row-locks the conversation row for the duration of the `UPDATE`, so
concurrent senders serialize: each gets a distinct, strictly increasing value,
with no retry loops and no extra round-trips. A unique index on
`(conversation_id, seq)` backstops the invariant at the schema level.

Alternatives rejected:

- **`MAX(seq) + 1` at insert** — racy without `SERIALIZABLE` isolation or
  explicit locking; needs retry loops.
- **Postgres sequences per conversation** — unbounded object creation, awkward
  DDL at runtime.
- **One global sequence** — workable, but per-conversation gaps confuse
  gap-fill debugging and leak cross-conversation volume information.

The same `UPDATE` also maintains `last_activity_at`, which gives
`listConversations` its most-recently-active ordering with a plain indexed
keyset query — no `MAX(messages.created_at)` join.

### Idempotent find-or-create: `ON CONFLICT (pair_key) DO NOTHING`

The unique index on `pair_key` (ADR 0002) is the arbiter. Creation inserts
with `ON CONFLICT DO NOTHING` and re-selects: zero rows returned means a
concurrent (or earlier) call won, and both calls converge on the same
conversation. Tested with 8 parallel `getOrCreateConversation` calls.

### Tests: PGlite (real Postgres in WASM), not Docker

The integration suite runs the **entire core engine** against the adapter on
[PGlite](https://pglite.dev) — actual Postgres compiled to WASM, in-process.
This exercises the real behaviors the adapter depends on (unique-index
conflicts, `ON CONFLICT`, atomic `UPDATE ... RETURNING`, `jsonb`,
`timestamptz`) with zero external services, identically on a contributor's
laptop and in GitHub CI.

The adapter itself only uses the dialect-agnostic Drizzle query builder, so
the same code runs on node-postgres, postgres.js, PGlite, and Neon. The
example server's `DATABASE_URL` mode is verified against a real Postgres 15
server as the M4 DoD ("example app runs on Postgres").

### Drizzle stays a peer dependency

`drizzle-orm` is a `peerDependency` (`>=0.40 <1`): the developer's app already
owns a Drizzle instance and we must not duplicate or version-skew it. The
schema is exported (`chatpackSchema`) so developers fold it into their own
`drizzle-kit` migration flow; `migrationSql` (idempotent DDL) exists for
examples, tests, and quick starts.

## Consequences

- **Good:** concurrency-safe ordering with one SQL statement; the invariant is
  enforced twice (row lock + unique index).
- **Good:** contributors run the full Postgres suite with `pnpm test` — no
  Docker, no services in CI.
- **Good:** `users` remain id-only strings; no FK into a users table
  (MVP §8 — we never own users).
- **Trade-off:** every send does two statements (bump + insert) instead of
  one. Acceptable: both hit primary keys, and correctness beats a
  micro-optimization. They are not wrapped in an explicit transaction — a
  crash between them leaves only an unused seq (a gap), which the contract
  allows ("strictly increasing", not "gapless").
- **Trade-off:** table names are prefixed (`chatpack_*`) rather than
  configurable — avoids schema-injection surface and keeps v0 simple; a
  naming option can be added later without breaking the interface.
