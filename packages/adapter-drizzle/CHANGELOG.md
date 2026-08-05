# @chatpack/adapter-drizzle

## 0.4.1

### Patch Changes

- 76ec258: Add case-insensitive, ranked message search across participant conversations.
  Search is available through the server API and `GET /search/messages` when the
  configured storage adapter provides the optional search capability. Memory and
  Drizzle share canonical punctuation-separated token matching; existing Drizzle
  databases must run the exported search-token backfill once after migration.
- Updated dependencies [76ec258]
- Updated dependencies [99e22c4]
  - @chatpack/core@0.6.0

## 0.4.0

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

## 0.3.1

### Patch Changes

- Updated dependencies [d652d01]
  - @chatpack/core@0.4.0

## 0.3.0

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

## 0.2.2

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

## 0.2.1

### Patch Changes

- Updated dependencies [3261865]
  - @chatpack/core@0.2.0

## 0.2.0

### Minor Changes

- 1bb1f38: Add `migrationStatements` export - the quick-start DDL as individual statements for drivers that execute one statement per call (Neon HTTP, Vercel Postgres, Cloudflare D1). `migrationSql` is unchanged and now derived from the same array, so the two can never drift.

### Patch Changes

- Updated dependencies [1bb1f38]
  - @chatpack/core@0.1.6

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
