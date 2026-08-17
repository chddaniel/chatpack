# @chatpack/adapter-memory

## 0.8.1

### Patch Changes

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

### Patch Changes

- Updated dependencies [9287d75]
  - @chatpack/core@0.10.0

## 0.5.0

### Minor Changes

- a9e6dd7: Invite links and join requests for group conversations (ADR 0019).

  Growing a group previously meant `addParticipants`, which needs the other
  person's user id up front. Two new paths don't:

  - **Invite links** - an admin mints a code with an optional expiry and use cap,
    anyone holding it previews the group and redeems it.
  - **Join requests** - someone with no code asks to join; an admin approves or
    denies from a pending queue.

  Eight new `chat.api` methods and routes: `createInvite`, `listInvites`,
  `revokeInvite`, `getInvitePreview`, `acceptInvite`, `requestToJoin`,
  `listJoinRequests`, `resolveJoinRequest`.

  Storage support is an **optional capability**: `StorageAdapter.invites` is a
  nine-method namespace, all-or-nothing. Adapters that omit it are unaffected -
  the routes answer `501 INVITES_UNSUPPORTED` and nothing else changes. Both
  first-party adapters implement it; `@chatpack/adapter-drizzle` adds two tables
  (`chatpack_conversation_invites`, `chatpack_join_requests`) as pure additions,
  no column changes or index swaps on existing tables.

  A fourth permission hook, `canInvite`, gates minting; it defaults to the same
  membership test as `canRead`. No new transport event types - redeeming an
  invite publishes the existing `participant.added`, so `TransportEvent` stays at
  four members and existing subscribers need no changes.

  New error codes: `INVITE_NOT_FOUND` / `JOIN_REQUEST_NOT_FOUND` (404),
  `ALREADY_PARTICIPANT` (409), `INVITE_EXPIRED` (410), `INVITE_LIMIT_EXCEEDED`
  (422), `INVITES_UNSUPPORTED` (501).

### Patch Changes

- Updated dependencies [a9e6dd7]
  - @chatpack/core@0.9.0

## 0.4.2

### Patch Changes

- Updated dependencies [06b4e67]
  - @chatpack/core@0.8.0

## 0.4.1

### Patch Changes

- Fix an unresolvable `@chatpack/core` dependency. 0.4.0 was published with the
  literal `workspace:^` protocol string in its manifest instead of a real semver
  range, so `npm install @chatpack/adapter-memory@0.4.0` failed outright with
  `EUNSUPPORTEDPROTOCOL`. 0.4.0 is deprecated on the registry; there are no code
  changes here, only the corrected dependency range.

## 0.4.0

### Minor Changes

- 1c92af5: Add group conversations: membership, admin roles, and rename (ADR 0017).

  DMs and groups are now one `Conversation` shape told apart by `type`
  (`"direct" | "group"`). A group holds 1..256 participants, carries `pairKey:
null` and an optional `name`, and gives each participant a `role` of `"admin"`
  or `"member"`. DMs are unchanged: still find-or-create, still exactly two
  participants, and both of them are admins.

  Five server-API methods and five routes are new - `createGroupConversation`
  (`POST /conversations/group`), `addParticipants` and `removeParticipant`
  (`POST`/`DELETE /conversations/:id/participants`), `setParticipantRole`
  (`PATCH /conversations/:id/participants/:userId`), and `updateConversation`
  (`PATCH /conversations/:id`). Every one of them returns the complete
  conversation, so replace your cached copy rather than merging. Group creation is
  never find-or-create: calling it twice with the same members makes two groups.

  Core owns the policy, so adapters never re-check it: only admins may add,
  remove others, rename, or change roles (403 `NOT_CONVERSATION_ADMIN`); anyone
  may remove themselves; a group always keeps at least one admin (409
  `LAST_ADMIN_REMAINING`); the cap is 256 participants (422
  `GROUP_LIMIT_EXCEEDED`); and a group-only call aimed at a DM is 409
  `NOT_GROUP_CONVERSATION`.

  Membership changes fan out over the existing SSE stream as a new
  `ConversationEvent` category - `participant.added`, `participant.removed`, and
  `conversation.updated` - carrying `actorId`, `affectedUserIds`, and the full
  conversation. Like reactions they have no `seq`, so their frames carry no `id:`
  line and `Last-Event-ID` gap-fill skips them; refetch on stream reopen. A
  removed participant receives their own `participant.removed` as the last event
  for that conversation. `TransportEvent` is now a four-member union, with an
  `isConversationEvent` guard alongside the existing ones.

  `afterMessageMutation` gains `recipientIds` - every participant except the
  sender, so push notifications reach a whole group. `otherParticipantId` still
  works but is **deprecated and will be removed at 1.0**: it is single-valued, so
  in a group it resolves to the first non-sender and everyone else gets nothing.

  The `StorageAdapter` contract grows the same five methods, and they are
  **required** rather than optional like `searchMessages` - a custom adapter will
  not typecheck until it implements them. **Existing Drizzle databases must re-run
  the migration**, which adds `type` and `name` to `chatpack_conversations`, adds
  `role` to `chatpack_conversation_participants`, makes `pair_key` nullable, and
  replaces the total unique index on `pair_key` with a partial one (`WHERE
pair_key IS NOT NULL`) so unlimited null-keyed groups can coexist. Existing rows
  need no backfill of their own: every pre-group conversation is a DM, and the
  migration promotes its participants to `admin` to match how DMs are created now.

  `@chatpack/client` reads groups today - `type`, `name`, `role`, unread counts,
  messages, and `message.*` events all flow through unchanged - but does not yet
  wrap the five mutations or subscribe to `participant.*`; call those routes with
  `fetch` and refetch afterwards.

### Patch Changes

- Updated dependencies [1c92af5]
  - @chatpack/core@0.7.0

## 0.3.1

### Patch Changes

- 76ec258: Add case-insensitive, ranked message search across participant conversations.
  Search is available through the server API and `GET /search/messages` when the
  configured storage adapter provides the optional search capability. Memory and
  Drizzle share canonical punctuation-separated token matching; existing Drizzle
  databases must run the exported search-token backfill once after migration.
- Updated dependencies [76ec258]
- Updated dependencies [99e22c4]
  - @chatpack/core@0.6.0

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

## 0.2.1

### Patch Changes

- Updated dependencies [d652d01]
  - @chatpack/core@0.4.0

## 0.2.0

### Minor Changes

- 0964bec: Unread message counts. Every conversation object the API returns (create,
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

### Patch Changes

- Updated dependencies [0964bec]
  - @chatpack/core@0.3.0

## 0.1.6

### Patch Changes

- AI-builder first-shot integration pass:

  - **Self-diagnosing 401** - the `UNAUTHENTICATED` body now names the exact
    failure: malformed auth-hook return shape (bare string / `{ userId }`),
    request with no `cookie` header (with the preview-iframe
    `SameSite=None; Secure; Partitioned` fix inline), or an unparsed/mismatched
    cookie name.
  - **llms.txt ships in every npm tarball** and was rewritten integration-first:
    hard rules (one handler, catch-all mount, real `chat.api.*` method list,
    server-generated conversation ids, single HMR-safe instance), 60-second
    wiring, per-framework mount recipes (Next.js, TanStack Start, Bun/Deno/
    Workers, Hono/Elysia, Express/Node), the iframe-proof demo-auth recipe, a
    deployment decision table, and curl verification steps. The adapter-author
    guide is preserved as Part 2.
  - **Docs**: iframe cookie recipe + TanStack Start mount + single-instance HMR
    guard in the core README; `@chatpack/next` surfaced in the root quickstart;
    stale "Drizzle adapter coming in v0" note fixed in adapter-memory.

- Updated dependencies
  - @chatpack/core@0.2.1

## 0.1.5

### Patch Changes

- Updated dependencies [3261865]
  - @chatpack/core@0.2.0

## 0.1.4

### Patch Changes

- a354af8: Docs-only release - third round of README improvements from external
  integration feedback:

  - Concrete cookie-based `auth` example replacing the `getSessionUser`
    pseudocode, with an explicit recommendation to use cookies (EventSource
    cannot send custom headers).
  - SSE browser examples are now TypeScript-correct (`MessageEvent` cast for
    custom event names) and include `onerror` handling for fatal vs
    retryable failures.
  - New note: `otherUserId` is not validated to exist (Chatpack has no users
    table) - validate recipient ids yourself.
  - New note: timestamps are `Date` server-side but ISO strings over HTTP.
  - `StorageAdapter` contract summarized as a method table in the core README.

  No code changes.

- Updated dependencies [a354af8]
  - @chatpack/core@0.1.4

## 0.1.3

### Patch Changes

- fa60bc7: Docs-only release - second round of README improvements from external
  integration feedback:

  - Documented allowed `role` values (`"user" | "assistant" | "system"`,
    default `"user"`; anything else is a 400).
  - Message ordering (newest first) is now stated in the REST response column
    and as an explicit note, not just the query column.
  - New deployment warning: the default in-process transport and
    `memoryAdapter` require one long-lived process - on serverless/edge
    (Workers, Lambda) use a database adapter and poll instead of `/stream`.
  - New browser-auth note: `EventSource` cannot send custom headers, so SSE
    auth must be cookie-based.
  - Install note about Bun's `minimumReleaseAge` supply-chain guard resolving
    older versions right after a release.

  No code changes.

- Updated dependencies [fa60bc7]
  - @chatpack/core@0.1.3

## 0.1.2

### Patch Changes

- 6133227: Docs-only release - README improvements from external integration feedback:

  - Install snippets now show npm/pnpm/bun variants and note that both
    `@chatpack/core` and a storage adapter are required.
  - Documented the `auth` hook return contract: `ChatpackUser | null`
    (an object with `id: string`); a bare string is treated as
    unauthenticated and produces `401`.
  - Full HTTP error status table including `401 UNAUTHENTICATED`,
    `404 NOT_FOUND` (unmatched route), and `500 INTERNAL_ERROR`.
  - Documented that `GET`/`POST`/`PATCH`/`DELETE`/`fetch` on the handler are
    all the same function, with generic mounting one-liners for Hono, Elysia,
    and Bun/Deno/Workers.
  - Explicit note that the API must be mounted on a catch-all route
    (`[...chatpack]` in Next.js) so sub-paths like `/stream` resolve.

  No code changes.

- Updated dependencies [6133227]
  - @chatpack/core@0.1.2

## 0.1.1

### Patch Changes

- Documentation: the quickstart and `@chatpack/core` README now include curl-able
  HTTP examples with real request/response JSON, and the REST route table
  documents request bodies, query params, and response envelopes for every
  endpoint (verified against the handler source). No code changes.
- Updated dependencies
  - @chatpack/core@0.1.1

## 0.1.0

### Minor Changes

- Initial public release - the complete Chatpack v0 MVP.

  - **`@chatpack/core`** - the chat engine: 1:1 conversations (find-or-create by
    pair key), text messages (send / list / edit / soft-delete), participant-only
    permissions with override hooks, durable read-state, a Web-standard HTTP
    handler (`chat.handler()`) exposing the whole REST API plus a `GET /stream`
    SSE endpoint with `Last-Event-ID` reconnect gap-fill, the `StorageAdapter`
    and `Transport` contracts, and anonymous opt-out telemetry
    (`telemetry: false` or `CHATPACK_TELEMETRY=0`).
  - **`@chatpack/adapter-memory`** - in-memory reference `StorageAdapter` for
    demos and tests.
  - **`@chatpack/adapter-drizzle`** - production Drizzle/Postgres adapter with
    atomic per-conversation `seq` assignment and race-safe conversation
    creation; tested against real Postgres (PGlite).
  - **`@chatpack/next`** - one-line Next.js App Router mounting via
    `toNextRouteHandlers(chat)`.

### Patch Changes

- Updated dependencies
  - @chatpack/core@0.1.0
