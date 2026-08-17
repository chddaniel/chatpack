# @chatpack/client

## 0.8.1

### Patch Changes

- df5bed6: Preserve the new `USER_NOT_FOUND` server error code in structured client errors.
- Updated dependencies [df5bed6]
- Updated dependencies [676ca9e]
  - @chatpack/core@0.13.0

## 0.8.0

### Minor Changes

- 7803136: Add message mentions (ADR 0023) and message forwarding (ADR 0024).

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

### Patch Changes

- 5d6f1c8: Add the community links (Discord, X, docs, Discussions) to every package README and to
  `llms.txt`, so the fastest way to reach the maintainers is on the npm page of whichever
  package you installed. No code changes.
- Updated dependencies [5d6f1c8]
- Updated dependencies [7803136]
  - @chatpack/core@0.12.0

## 0.7.2

### Patch Changes

- Credit the project's co-owners by name rather than GitHub handle in package
  `contributors` metadata and the credits surfaces: DanielCH and DavidCH.
- ac8fb5b: Harden moderation client responses with typed action inputs, validated pagination
  and delete envelopes, and focused structured-error coverage for blocks, mutes,
  reports, and moderator bans.
- Updated dependencies
  - @chatpack/core@0.11.2

## 0.7.1

### Patch Changes

- Fill in the `author` and `contributors` metadata, which was empty on every
  published package. Yeabsra Habtu is credited as author (principal author of the
  library), with chddaniel, Ikem Peter and chhddavid as contributors. Registry
  maintainers and publish rights are unchanged. No runtime or API changes —
  package metadata only, so authorship shows up on npm and in registry mirrors.
- Updated dependencies
  - @chatpack/core@0.11.1

## 0.7.0

### Minor Changes

- 4008cb5: Add typed client actions for invite links, join requests, and public channels.
  Channel settings are also available through group creation and update actions.
- 172259f: Add optional durable moderation controls: blocks, conversation mutes, abuse
  reports with evidence snapshots, timed or permanent Chatpack bans, moderator
  report workflow, and typed REST/client surfaces.

  Ban enforcement is opt-in through configuration rather than adapter capability.
  Bans are checked before routing and on every SSE heartbeat only when the
  `moderation` option is configured - by default whenever `canModerate` is set,
  since `banUser` is the only way to mint a ban. An app that never configures
  `moderation` pays no ban lookups even on an adapter that supports them. Pass
  `moderation: { enforceBans: true }` when ban rows are written outside Chatpack,
  or `false` to keep the moderator tools without per-request enforcement.

  `ModerationStorage.createBan` must decide in one statement whether a user already
  has an active ban and return that ban instead of inserting a second. Both
  first-party adapters now do, so two moderators banning the same person at the
  same moment leave exactly one active row - otherwise the duplicate keeps
  enforcing after the visible ban is revoked.

### Patch Changes

- Updated dependencies [172259f]
  - @chatpack/core@0.11.0

## 0.6.0

### Minor Changes

- db082b7: Add participant-scoped message search actions and React hooks to the client.

  Bundle TypeScript in the CLI and refresh generated clients for the current Chatpack API. The
  compiler bundle raises the package tarball from about 93 KB to 2.1 MB while avoiding the roughly
  40 MB TypeScript runtime install.

### Patch Changes

- 9287d75: Public channels (ADR 0020): a browsable directory of public groups, with
  per-channel open or approval-gated joining.

  A channel is **not a new conversation type**. `Conversation` gains two fields -
  `visibility` (`"private"` | `"public"`, default `"private"`) and `joinPolicy`
  (`"open"` | `"approval"`, default `"approval"`) - and a group with
  `visibility: "public"` is what Chatpack calls a channel. Everything else about it
  is group behavior, so `type === "group"` checks in your code keep working.

  Two new API methods and two new routes:

  - `chat.api.listPublicConversations` / `GET /channels?limit&cursor` - the
    directory, browsable by any signed-in user, returning thin `ChannelPreview`
    objects (`{ conversationId, name, participantCount, joinPolicy,
lastActivityAt, alreadyParticipant, requestPending }`). A participant **count**,
    never member ids, for the same reason `InvitePreview` works that way.
  - `chat.api.joinConversation` / `POST /conversations/:id/join` - self-service
    entry, returning the same discriminated union as accepting an invite:
    `"joined"` when the policy is `"open"`, `"pending"` (with `inviteCode: null`)
    when it's `"approval"`.

  Both fields are set at creation (`POST /conversations/group`) or flipped later
  through `PATCH /conversations/:id`, which is now a real patch over
  `{ name?, visibility?, joinPolicy? }` - sending only `visibility` keeps the name,
  and a PATCH with nothing in it is `400 INVALID_INPUT`. Publishing a group is
  gated by `canManage`, deliberately **not** `canInvite`: handing one person a link
  is a smaller act than listing a room for everyone.

  Two boundaries worth knowing:

  - **Discoverable is not readable.** The permission layer is untouched, so
    `getConversation` and the message routes still answer `403 FORBIDDEN_READ` for a
    non-member of a public channel. Reading a channel means joining it.
  - **A public group defaults to `"approval"`.** Between a stranger in the room and
    a stranger in a queue, only one is recoverable.

  No new SSE event types: joining publishes the existing `participant.added` (with
  the joiner as their own `actorId`) and flipping the fields publishes
  `conversation.updated`.

  **Storage.** The directory is a new optional capability - a `channels` namespace
  with one method, independent of `invites` - and a missing namespace answers
  `501 CHANNELS_UNSUPPORTED`. The `visibility` / `joinPolicy` **columns**, however,
  ride the required 19-method contract, and core refuses to set a non-default value
  without the namespace: an adapter written before this release would otherwise
  accept `visibility: "public"`, drop it, and leave you with a channel nobody can
  find. Both first-party adapters implement everything; the Drizzle migration adds
  the two columns `NOT NULL` with the closed defaults (no backfill needed) plus a
  partial index `WHERE visibility = 'public'`.

  `@chatpack/client` gains the two new server error codes for exhaustive narrowing;
  the channel routes have no wrappers yet - call them with `fetch`.

- Updated dependencies [9287d75]
  - @chatpack/core@0.10.0

## 0.5.1

### Patch Changes

- a9e6dd7: Recognize the six invite/join-request error codes (ADR 0019) as server errors
  rather than transport failures, so `error.code` narrows correctly when you call
  those routes with `fetch` alongside the client. No wrappers for the routes
  themselves yet.
- Updated dependencies [a9e6dd7]
  - @chatpack/core@0.9.0

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
