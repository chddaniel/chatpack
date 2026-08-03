# ADR 0013: Reactions and quote-replies

- **Status:** accepted
- **Date:** 2026-08-03
- **Milestone:** v0.next (reactions + replies)

## Context

`docs/MVP.md` §5 lists "threads, reactions" as explicit non-goals. This ADR
deliberately reverses half of that: **reactions and quote-replies ship;
threads still do not.** The distinction is the whole point of the decision.

- A **quote-reply** is a pointer: one message names an earlier message in the
  same conversation. The transcript stays a single flat, `seq`-ordered list.
- A **thread** is a second axis of ordering: a message becomes a container
  with its own reply list, its own unread count, its own pagination. That is
  the thing MVP §5 says no to, and it stays out.

Reactions were grouped with threads in §5 because both were assumed to need
new ordering machinery. Reactions do not - they are a set attached to a
message, with no bearing on `seq`.

Design questions this ADR settles:

1. How does a reply reference its parent, and who resolves the reference?
2. Reactions are durable, but SSE gap-fill replays by message `seq`
   (ADR 0006). A reaction on an old message produces no new `seq`. How does a
   reconnecting client catch up?
3. What is a valid reaction key?
4. Where do reaction events sit relative to the durable/ephemeral split
   (ADR 0008)?

## Decision

### 1. Replies are a stored id plus a core-hydrated preview

`Message` gains one stored field:

```ts
replyToMessageId: string | null;
```

The API additionally returns a **read-only, non-stored** preview:

```ts
interface MessageReference {
  id: string;
  senderId: string;
  /** First 140 chars of the parent body, with "…" when truncated. */
  excerpt: string;
  /** True when the parent is a soft-delete tombstone. */
  deleted: boolean;
}
```

carried on the API message shape
`MessageWithDetails = Message & { replyTo: MessageReference | null; reactions: ReactionSummary[] }`.

**Core hydrates, adapters store.** Storing only the id and letting clients
look the parent up themselves breaks the moment the parent is outside the
loaded page - which is the common case, since the thing you reply to scrolls
away. Denormalizing a copy of the parent body into the reply row would go
stale on every edit. So the id is stored and the preview is resolved per
request, exactly the ADR 0009 split that gave `ConversationWithUnread` its
`unreadCount`: `Message` stays the storage shape, adapters and permission
hooks never see the decoration.

Hydration costs **one batched storage call per page**, via a new adapter
method `getMessagesByIds`. Keeping the excerpt rule in core (rather than
having each adapter self-join) means every adapter produces byte-identical
previews.

Validation and semantics:

- The parent must exist **in the same conversation**, else
  `MESSAGE_NOT_FOUND` - the same wording `markRead` already uses, so a
  cross-conversation probe cannot confirm that a message exists somewhere
  the caller cannot read.
- **Replying to a tombstone is allowed** (`replyTo.deleted = true`, empty
  excerpt). The parent can be deleted between render and send; rejecting
  that would be a race the sender cannot win.
- **Deleting a parent does not touch its replies.** The reply keeps its
  pointer and renders a "message deleted" quote.
- **Replying to a reply is flat.** There is no nesting, no depth limit, and
  no thread root - the pointer is one hop and clients render one quote bar.
- `replyToMessageId` is **immutable**: `editMessage` only ever changes the
  body, so a reply cannot be re-targeted.

### 2. Reactions are durable, and reconnect recovers by refetch

A fourth table (`chatpack_message_reactions`), unique on
`(message_id, user_id, emoji)`, and four new adapter methods. Both writes are
**idempotent** - reacting twice is one reaction, un-reacting nothing is a
no-op - and both **return the message's complete reaction set afterwards**,
so core never needs a second round trip and every event it publishes is a
full snapshot rather than a delta.

Core aggregates rows into a viewer-independent summary:

```ts
interface ReactionSummary {
  emoji: string;
  count: number;
  /** Who reacted, earliest first. At most two ids - Chatpack is 1:1. */
  userIds: string[];
}
```

`userIds` is safe to expose in full precisely because v0 is 1:1: the array
holds at most two entries, so the client can render "you reacted" without a
viewer-relative field and without a second request. (A groups milestone
would have to revisit this - see Consequences.)

**Reconnect recovery is a refetch, not a replay.** `Last-Event-ID` gap-fill
is defined over message `seq` (ADR 0003, ADR 0006), and a reaction on a
three-day-old message produces no new `seq`. Two alternatives were rejected:

- _Bump the message's `seq` when it is reacted to._ Gap-fill would work for
  free, but `seq` would stop being a stable creation-order key - reacting
  would reorder the transcript and make message lists jump. ADR 0003's
  invariant is worth more than this convenience.
- _Give reactions their own monotonic counter and a second replay cursor._
  Exact, but it adds a parallel cursor protocol to the SSE contract plus an
  adapter method and index, for a payload that is cosmetic if briefly stale.

Instead: reaction events publish live, and a client whose stream **reopens
after having been open** refetches the message pages it has cached. The SSE
contract is untouched. The cost is bounded and honest: a reaction applied
while a client was offline appears on the next refetch rather than instantly.

### 3. A reaction key is any short non-empty string

Trimmed, non-empty, at most 32 characters. Not validated as a Unicode
emoji. Chatpack stays unopinionated about identity the same way `role` and
`metadata` are escape hatches: `":shipit:"`, `"custom_1234"`, and a
workspace's uploaded emoji id are all legitimate keys, and a
grapheme-property regex would block them while needing upkeep every Unicode
release. Whitespace is trimmed rather than preserved so `"👍"` and `"👍 "`
cannot become two separate buckets. Violations are `INVALID_INPUT`.

### 4. Reaction events are a third transport category

`TransportEvent` becomes `ChatEvent | ReactionEvent | EphemeralEvent`.
`ReactionEvent` is durable-backed, so it is not an `EphemeralEvent` - but its
SSE frame carries **no `id:` line**, exactly like an ephemeral frame, because
`Last-Event-ID` must keep meaning "the newest message `seq` I have seen"
(ADR 0006). An `id:` on a reaction frame would poison gap-fill.

Consequently `isEphemeralEvent` no longer partitions the union in two, and
a new `isMessageEvent` guard is what the handler and the plugin runtime
branch on. `PluginEventDeliveredContext.event` stays `ChatEvent`: plugins
observe **message** delivery only, so `receipts()` cannot mistake a reaction
for a message it should tick.

## Consequences

- **Breaking for custom adapters:** the contract grows ten → fourteen
  methods (`getMessagesByIds`, `addReaction`, `removeReaction`,
  `listReactionsByMessageIds`) and `AddMessageInput` gains
  `replyToMessageId`. Pre-1.0 this is allowed (ADR 0001) and goes through a
  changeset; llms.txt Part 2, the skeleton adapter, and the verification
  checklist all gained the new methods.
- **Postgres deployments need DDL:** one new table and its index, appended to
  `migrationStatements` (and so to `migrationSql`), plus a
  `reply_to_message_id` column on `chatpack_messages`. All statements are
  `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, so re-running is safe, but
  existing deployments **must** re-run the migration before upgrading.
- **Two new routes, no new error codes:** `POST` and `DELETE` on
  `/messages/:id/reactions`. Both return the full `{ message }` envelope so
  clients replace one cache entry. `PUT` was rejected despite being the
  better verb for an idempotent add: `ChatpackHandler` is re-exported by name
  in Next.js route files (`export const { GET, POST, PATCH, DELETE }`), so a
  new method would 405 in every already-mounted app until the consumer edited
  their route file.
- **Reacting requires write permission**, matching edit and delete - it is a
  mutation other participants see. A caller can only ever add or remove
  reactions attributed to themselves; the acting user id comes from the auth
  hook, never the request body.
- **Unread counts are unaffected.** A reaction is not a message: it does not
  light the badge, does not advance `lastActivityAt`, and does not reorder
  the conversation list.
- **No cap on distinct reactions per user per message.** Enforcing one would
  need a count on the write path, and the natural limit (32-char keys, 1:1
  conversations) makes abuse a same-app problem. Apps that care should rate
  limit the route; if this proves wrong it can be added without a shape
  change.
- **Groups would revisit `ReactionSummary.userIds`.** Returning every reactor
  id is fine for two participants and wrong for two hundred. The field is
  additive to remove behind a summary count + viewer-relative `me` flag when
  that milestone lands.
