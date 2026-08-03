---
"@chatpack/core": minor
"@chatpack/adapter-memory": minor
"@chatpack/adapter-drizzle": minor
"@chatpack/client": minor
---

Message reactions and quote-replies (ADR 0013).

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
