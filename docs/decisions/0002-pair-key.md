# ADR 0002 — Deterministic pair key prevents duplicate DMs

- Status: accepted
- Date: 2026-07-22

## Context

v0 is 1:1-only, and "find-or-create a direct conversation" is the entry point
of the whole API (MVP §2). If two users can end up with two conversations
between them (e.g. both call create at the same time), every downstream
feature — listing, unread counts, notifications — silently degrades.

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
- The pair key is derived purely from user ids — no extra lookups needed.
- When groups land, group conversations simply won't carry a pair key; the
  1:1 path is unaffected (MVP §8).

## Alternatives considered

- **Check-then-create in core:** racy without a transaction; pushes locking
  into core, which owns no database.
- **Hashing the pair:** obscures debugging for zero benefit at these key sizes.
