---
"@chatpack/core": minor
"@chatpack/adapter-memory": minor
"@chatpack/adapter-drizzle": minor
"@chatpack/client": minor
---

Add message mentions (ADR 0023) and message forwarding (ADR 0024).

**Mentions** are user ids you supply, never text Chatpack parses. `sendMessage`
and `editMessage` take an optional `mentions: string[]`, and every message reads
back a `mentions` array hydrated in one batched adapter call per page. Core
validates the set against current membership and refuses the whole call with
`400 MENTION_NOT_PARTICIPANT` rather than dropping an id, because a silent drop
looks exactly like a notification that fired. The cap is 256 per message. On edit,
omitting `mentions` leaves the stored set alone while `[]` clears it, so a
mentions-unaware client can't erase them; ids already stored stay valid even after
that person leaves, so fixing a typo never has to drop a legitimate mention. The
array is a **set** - de-duplicated and read back sorted by `(createdAt, userId)`,
not in the order you passed it. Chatpack notifies nobody and keeps no mention
inbox: `beforeMessageSend` sees the validated set and `afterMessageMutation`
reports `mentions` next to `recipientIds`, including on `delete`.

**Forwarding** copies a message into another conversation. `chat.api.forwardMessage`
and `POST /messages/:id/forward` write a new message into the target with the
forwarder as sender, the body verbatim, its own `seq`, and `forwardedFrom`
(`{ messageId, conversationId, senderId }`) frozen at forward time. Editing or
deleting the original never changes the copy. Requires read on the source and
write on the target; a tombstone is `409 MESSAGE_DELETED`. One hop only, and
deliberately no excerpt and no source conversation _name_ - whoever reads the copy
may have no access to where it came from. Reactions, the reply pointer, mentions,
metadata and `role` do not travel; a forward runs the hooks as `action: "send"`
with `forwardedFrom` populated, which is how you make something unforwardable.

`@chatpack/client` gains `messages.forward` (destination is `toConversationId`;
the wire field stays `conversationId` because the route already names the source),
`mentions` on `messages.send` / `messages.edit` preserving the
absent-versus-empty distinction, and cache echo for the copy in the target thread.

**Breaking for custom storage adapters:** the required `StorageAdapter` method
count goes from nineteen to twenty-one - `setMessageMentions` (a total replace
that must delete every row on an empty set and must not re-stamp a surviving row's
`createdAt`) and `listMentionsByMessageIds` (batched, ascending
`(createdAt, userId)`). Forwarding adds no methods: three nullable columns on the
messages table, deliberately without a foreign key. Both first-party adapters
implement them, and the Drizzle migration is idempotent - one new table plus three
`ADD COLUMN IF NOT EXISTS` and a partial index.
