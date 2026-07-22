# ADR 0003 — Per-conversation monotonic `seq` as the message sort key

- Status: accepted
- Date: 2026-07-22

## Context

MVP §8 requires that "messages carry a monotonic sort key (`created_at` +
tiebreaker, or a sequence) so a client can reconcile SSE events against
fetched history deterministically." Timestamps alone collide: two messages in
the same millisecond have no defined order, and clock skew across processes
makes `created_at` unreliable as a total order.

## Decision

Every message gets a **strictly increasing integer `seq`, scoped per
conversation**, assigned by the storage adapter at insert time (in-memory: a
counter; Postgres later: a sequence or `max(seq)+1` inside the insert
transaction).

`seq` — not `createdAt` — is the ordering contract:

- `listMessages` returns newest-first by descending `seq`.
- Pagination cursors point at message positions in `seq` order.
- (M3) SSE gap-fill replays "everything after seq X".

`createdAt` remains for display purposes only.

## Consequences

- Deterministic, gap-free client reconciliation: history + live events merge
  by `seq` with no ambiguity.
- Editing or soft-deleting never reorders history (`seq` is immutable).
- Adapters carry a small obligation: `seq` must be strictly increasing and
  never reused within a conversation. This is documented on
  `StorageAdapter.addMessage`.
