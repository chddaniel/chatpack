# @chatpack/client

## 0.5.0

### Minor Changes

- cdca3dd: Client group support (ADR 0017 follow-up). The five group mutations are now
  wrapped as typed methods: `conversations.createGroup` (never find-or-create;
  the caller becomes the first admin), `conversations.addParticipants`,
  `conversations.removeParticipant` (pass your own id to leave),
  `conversations.setParticipantRole`, and `conversations.update` (rename;
  `name: null` clears the title).

  The client also subscribes to `participant.added`, `participant.removed`, and
  `conversation.updated` and applies them to the cache: renames and role changes
  merge in place without reordering the list, being added to a group fetches and
  prepends it, and being removed drops the conversation from every cache surface
  (your own `participant.removed` is the only signal you get). Polling clients
  converge on the next tick, treating a thread poll's `FORBIDDEN_READ` as the
  removal signal.

  Server error codes are now passed through exhaustively - `MESSAGE_REJECTED`,
  `SEARCH_UNSUPPORTED`, and the four group codes (`NOT_CONVERSATION_ADMIN`,
  `NOT_GROUP_CONVERSATION`, `LAST_ADMIN_REMAINING`, `GROUP_LIMIT_EXCEEDED`)
  previously flattened to `HTTP_ERROR`; the mapping is exhaustive over core's
  `ChatpackErrorCode`, so a future code fails typecheck instead of silently
  degrading. New exports: `isConversationChatEvent`, `ConversationChatEvent`,
  `ClientConversationSnapshot`, and the four mutation input types.

## 0.4.3

### Patch Changes

- Updated dependencies [06b4e67]
  - @chatpack/core@0.8.0

## 0.4.2

### Patch Changes

- 1c92af5: Re-render conversations when their name or membership changes. The cache
  compared only read-state fields, on the assumption that a conversation's
  participants never change - true for DMs, wrong for groups. A rename or a role
  change made elsewhere would never reach a polling client, which kept rendering
  the stale title and roles indefinitely. The comparison now covers `name` and the
  participant set (membership, roles, and per-participant read-state).
- Updated dependencies [1c92af5]
  - @chatpack/core@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [76ec258]
- Updated dependencies [99e22c4]
  - @chatpack/core@0.6.0

## 0.4.0

### Minor Changes

- bf8a1d8: Add a polling fallback for platforms where SSE can't work - serverless function
  timeouts, buffering proxies, React Native without `EventSource`. Previously the
  client reported `closed` and stopped updating; now it refetches on an interval
  instead.

  ```ts
  createChatClient({
    realtime: {
      mode: "auto", // "auto" (default) | "sse" | "poll"
      intervalMs: 5000, // default 5000, clamped to a 1000ms floor
    },
  });
  ```

  `auto` opens the stream and polls only if it can't open or drops, stopping the
  moment it reopens - a serverless deploy needs no configuration. `sse` keeps the
  previous stream-only behaviour. `poll` skips the doomed attempt entirely. The new
  `"polling"` realtime status means connected-but-degraded, and `realtime.pollNow()`
  runs one refresh on demand.

  A tick refetches page one of the conversations list **and** the 3 most recently
  used threads, at the same `limit` the host last requested, and only for surfaces
  already loaded. It re-reads the existing list routes rather than asking for
  messages after a `seq`: only sending allocates a `seq`, so an edit, a delete and
  every reaction change would be invisible to an incremental poll. Ticks never
  overlap, hidden tabs don't poll, a failed tick changes nothing and never touches
  `isPending`, and polled pages merge rather than replace - so an idle interval
  notifies no subscribers and causes no re-renders.

  Typing, presence and receipts are unavailable while polling: ephemeral events are
  never stored, so there is nothing to poll for.

  No server change - the fallback is entirely client-side. See ADR 0016.

## 0.3.0

### Minor Changes

- 146e966: Message reactions and quote-replies (ADR 0013).

  Two new routes and two new `chat.api` methods, plus one new field on send:

  ```ts
  // quote-reply: a flat pointer at one earlier message in the same conversation
  await chat.api.sendMessage({ userId, conversationId, body: "agreed", replyToMessageId });

  // react / un-react - both idempotent, both return the FULL reaction set
  await chat.api.addReaction({ userId, messageId, emoji: "👍" });
  await chat.api.removeReaction({ userId, messageId, emoji: "👍" });
  ```

  ```
  POST   /messages/:id/reactions   { emoji }  → { message }
  DELETE /messages/:id/reactions   { emoji }  → { message }
  ```

  Every message now carries three new fields:

  - `replyToMessageId: string | null` - stored verbatim, validated at send time
    (must be a live message in the same conversation) and immutable afterwards.
  - `replyTo` - a **read-only, per-request** preview of the quoted parent
    (`{ id, senderId, excerpt, deleted }`, excerpt capped at 140 chars). Hydrated
    from one batched adapter lookup per page, never denormalized - edit the parent
    and every reply's quote bar follows.
  - `reactions` - `[{ emoji, count, userIds }]`, grouped and earliest-first.
    `userIds` is safe to expose because conversations are 1:1.

  Reaction writes are **idempotent**: `(messageId, userId, emoji)` is unique, so
  reacting twice is a no-op and un-reacting what you never reacted to is a no-op -
  neither is an error. `emoji` is any non-empty string up to 32 characters
  (`"👍"`, `":shipit:"`, `"custom_1234"`); `""` or longer is `INVALID_INPUT`. The
  emoji travels in the request **body** on `DELETE` too, since arbitrary keys
  don't survive a path segment. Reacting requires write permission on the
  conversation.

  **A reaction is not a message.** It has no `seq`, never advances `lastSeq` or
  `lastActivityAt`, never reorders the conversation list, and never bumps
  `unreadCount`. Consequently `reaction.added` / `reaction.removed` are a **third
  transport category**: durable-backed, but their SSE frames carry **no `id:`
  line** (emitting one would rewind `Last-Event-ID` and replay messages the client
  already has) and they are **not gap-filled** on reconnect. Refetch the thread
  when the stream reopens to pick up reactions applied while offline. The payload
  is `{ type, message, actorId, emoji }`, where `message.reactions` is the
  complete set after the change - replace that field, don't merge into it.

  Replies are quote-replies, **not threads**: no thread ids, no per-thread reply
  counts, no nested pagination. That remains a non-goal.

  `@chatpack/client` gains `messages.react` / `messages.unreact`, the
  `replyToMessageId` option on `messages.send`, and an exported
  `isReactionChatEvent` narrowing helper. Reaction events merge only the
  `reactions` field of one cached message, so a stale `body` in a payload can't
  clobber the cache, and a reaction on a message outside the loaded page is
  dropped rather than spliced into a paginated list.

  ### Breaking for custom storage adapters and custom transports
  - **`StorageAdapter` grew from 10 to 14 methods.** Implement
    `getMessagesByIds`, `addReaction`, `removeReaction`, and
    `listReactionsByMessageIds`. The batched lookups must tolerate misses and
    return `[]` for `[]` input without touching the database; reaction writes must
    be idempotent, return nothing, and never touch `lastSeq` / `lastActivityAt`.
    Full contract in Part 2 of `llms.txt`.
  - **`TransportEvent` has three members** (`ChatEvent | ReactionEvent |
EphemeralEvent`), so `!isEphemeralEvent(e)` no longer means "this is a
    message" - use the newly exported `isMessageEvent(e)`. Plugin
    `onEventDelivered` still only ever receives a `ChatEvent`.
  - **Postgres deployments must re-run the migration before upgrading.**
    `@chatpack/adapter-drizzle` added the `chatpack_message_reactions` table plus
    a `reply_to_message_id` column on `chatpack_messages`. Every statement is
    `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, so re-running the whole script
    is safe and preserves existing data and `seq` counters.

### Patch Changes

- Updated dependencies [146e966]
  - @chatpack/core@0.5.0

## 0.2.0

### Minor Changes

- e3ab183: Make the conversations list react to realtime events.

  `message.created` now updates the cached conversation list, not just the open
  thread: the conversation moves to the front (matching the server's
  most-recently-active ordering), its `unreadCount` increments, and a conversation
  missing from the loaded list is fetched once and prepended. `message.updated`
  and `message.deleted` deliberately do not reorder, and redelivered events never
  double-count. `conversations.markRead` clears `unreadCount` locally when the
  marked message is the newest one cached.

  Adds an optional `userId` client option - a cache hint, never authentication -
  so the viewer's own messages are not counted as unread. Without it, the client
  infers the id from the first message it sends.

  `useConversations` and `useMessages` now open the realtime stream themselves, so
  a conversation list live-updates without mounting `useRealtimeStatus`. The
  subscribe-and-refetch workaround previously needed for live lists is obsolete.

  Also hardens `realtime.connect()`: a runtime without a global `EventSource`
  (SSR, React Native, some test renderers) now reports a `NETWORK_ERROR` stream
  error instead of throwing inside the effect that mounted a hook.

## 0.1.1

### Patch Changes

- Updated dependencies [d652d01]
  - @chatpack/core@0.4.0

## 0.1.0

### Minor Changes

- c47d3f4: Add the first-party framework-agnostic Chatpack client, React hooks, and client
  adapters for typing, presence, and receipts.
