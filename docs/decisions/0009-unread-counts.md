# ADR 0009: Unread counts computed from read-state at query time

- **Status:** accepted
- **Date:** 2026-07-31
- **Milestone:** v0.next (unread counts)

## Context

Chatpack has stored durable read-state since M1 (`markRead` →
`Participant.lastReadMessageId`) but never computed anything from it. Every
chat UI needs the unread badge, and without server support a consumer must
fetch message pages and count client-side - wasteful, and inexact past one
page. The ingredients were already durable: per-conversation monotonic
`Message.seq` (ADR 0003) and per-participant `lastReadMessageId`.

Design questions this ADR settles:

1. What exactly counts as "unread"?
2. Does core or the adapter compute it (ADR 0001 boundary)?
3. Does read-state need a schema change (`last_read_seq`)?
4. What stops the count from going _up_ without new messages?

## Decision

**1. The invariant.** For viewer `u` in conversation `c`:

> `unreadCount` = messages in `c` with
> `seq > seq(lastReadMessageId)` (0 when `null`) **and** `senderId !== u`.

- **Own messages never count.** Sending does not advance the sender's
  read-state, so without this exclusion your own just-sent messages would
  read as unread. Excluding at count time is one predicate; auto-advancing
  read-state on send would cost a write per message and change markRead
  semantics.
- **Tombstones count.** Soft-deleted messages keep their `seq` and are
  returned in lists as renderable tombstones - the badge matches what the
  client shows.
- **All roles count** (`user`/`assistant`/`system`): assistant messages must
  light the badge in the AI-chat use case, and core never behaves
  differently based on role.

**2. Adapters compute; core decorates.** A tenth required `StorageAdapter`
method, batched to avoid N+1:

```ts
countUnread(input: { userId: string; conversationIds: string[] })
  : Promise<Record<string, number>>;
```

Counting is persistence mechanics (an indexed range count in SQL, a Map walk
in memory) - exactly the adapter's side of the ADR 0001 split. Core cannot do
it efficiently: `lastReadMessageId` is an id, not a seq, and the contract has
no count primitive; a core fallback via `listMessagesAfterSeq` would be
N+1 and capped at `limit`. Making the method **required** (not optional with
a degraded fallback) keeps semantics exact everywhere; pre-1.0 the break is
allowed and goes through changesets (ADR 0001).

Core decorates every conversation the API returns
(`getOrCreateConversation`, `listConversations`, `getConversation`) as
`ConversationWithUnread = Conversation & { unreadCount: number }`. The
`Conversation` domain type stays viewer-independent - adapters and permission
hooks never see the field.

**3. No schema change.** `lastReadMessageId` stays the only stored
read-state; adapters resolve id → seq at query time (LEFT JOIN +
`COALESCE(seq, 0)` in SQL; a Map lookup in memory). The unique
`(conversation_id, seq)` index the Drizzle adapter already has makes each
range count an index scan, one batched `GROUP BY` query per page. A
`last_read_seq` column would only buy O(1) math at the cost of an ALTER
TABLE for every existing deployment - and the adapter ships hand-written
`migrationSql` with no migration framework.

**4. markRead is now monotonic.** Core silently ignores a `markRead` whose
message `seq` is ≤ the current read-state's seq: no storage write, no plugin
notify. Read-state can no longer regress, so unread counts only grow from new
messages. Silent (not an error) because stale replays are expected under
at-least-once delivery - an out-of-order retry after reconnect is normal
client behavior, not a fault.

## Consequences

- **Breaking for custom adapters** (the contract grows nine → ten methods).
  Called out in the core changeset; llms.txt Part 2, the skeleton adapter,
  and the verification checklist all gained the new method.
- `unreadCount` is exact, viewer-relative, and always present on API
  conversation objects - HTTP responses gained the field with no new route.
- No SSE/plugin surface changed. Ephemeral read _receipts_ (ADR 0008) remain
  unrelated: `unreadCount` derives from the durable field and survives
  restarts and serverless deploys.
- Clients wanting a live badge without re-fetching can increment locally on
  `message.created` (when `senderId !== me`) and reset on their own markRead.
