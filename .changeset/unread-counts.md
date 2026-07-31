---
"@chatpack/core": minor
"@chatpack/adapter-memory": minor
"@chatpack/adapter-drizzle": minor
---

Unread message counts. Every conversation object the API returns (create,
list, get - server-side and HTTP) now carries the viewer's `unreadCount`:
messages newer than their read-state, excluding the viewer's own messages;
soft-deleted messages count (they render as tombstones). `markRead` is now
monotonic - marking a message older than the current read-state is a silent
no-op, so read-state can never regress.

**BREAKING for custom storage adapters:** the `StorageAdapter` contract
gains a tenth required method, `countUnread({ userId, conversationIds })`,
returning `{ [conversationId]: count }` - batched, one call per page. See
the skeleton + invariant 10 in llms.txt Part 2 (or the custom-adapter docs
page) for the exact semantics and a reference SQL query. The official
memory and Drizzle adapters implement it (no schema change - existing
Postgres deployments need no migration).

New exports: `ConversationWithUnread` (domain type), `CountUnreadInput`
(adapter input). ADR 0009 records the design.
