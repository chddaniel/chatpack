# ADR 0002 - Deterministic pair key prevents duplicate DMs

- Status: accepted
- Date: 2026-07-22
- Amended: 2026-08-06 (groups landed - see the note under Consequences)

## Context

v0 is 1:1-only, and "find-or-create a direct conversation" is the entry point
of the whole API (MVP §2). If two users can end up with two conversations
between them (e.g. both call create at the same time), every downstream
feature - listing, unread counts, notifications - silently degrades.

## Decision

Core computes a deterministic **pair key** for every direct conversation: the
two user ids sorted lexicographically and joined with `":"`
(`pairKeyFor("bob", "alice") === "alice:bob"`, see
`packages/core/src/chatpack.ts`).

Storage adapters must treat `pairKey` as the uniqueness key for direct
conversations, and `getOrCreateDirectConversation` must be idempotent under
concurrency (for SQL adapters: a unique index on `pair_key` plus
insert-on-conflict-select).

## Consequences

- Duplicate-DM prevention is enforced by data shape, not by application-level
  "check then insert" races.
- The pair key is derived purely from user ids - no extra lookups needed.
- When groups land, group conversations simply won't carry a pair key; the
  1:1 path is unaffected (MVP §8).

> **Amendment (2026-08-06, groups shipped - ADR 0017).** The prediction above
> held: groups carry `pairKey: null` and the DM path is unchanged. One
> consequence needs restating precisely, because "a unique index on `pair_key`"
> is no longer sufficient advice. The index must be **partial**
> (`WHERE pair_key IS NOT NULL`) or the second null-keyed group collides - and in
> Postgres a partial index is only matched by `ON CONFLICT` when the insert
> **repeats the predicate**, so the DM upsert carries the same `WHERE` clause.
> The uniqueness rule is therefore "one conversation per pair key **among
> direct conversations**", not "globally unique `pair_key` column".

## Alternatives considered

- **Check-then-create in core:** racy without a transaction; pushes locking
  into core, which owns no database.
- **Hashing the pair:** obscures debugging for zero benefit at these key sizes.
