# @chatpack/core

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

## 0.2.1

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

## 0.2.0

### Minor Changes

- 3261865: Real-time trio: typing indicators, presence, and live delivery/read ticks as opt-in in-core plugins (ADR 0008).

  New:

  - **Ephemeral events** - a new transport primitive for fire-and-forget live signals that are never stored and never replayed on reconnect. Their SSE frames carry no `id:` field, so `Last-Event-ID` message gap-fill is unaffected.
  - **Plugin seam** - `chatpack({ plugins: [...] })` accepts `ChatpackPlugin` objects with `handleRequest` (extra routes), `onStreamOpen`/`onStreamClose`, `onMarkRead`, and `onEventDelivered` hooks. Notification hooks are fire-and-forget: a throwing plugin never breaks a request.
  - **`@chatpack/core/plugins`** subpath export with three first-party plugins:
    - `typing()` - `POST /conversations/:id/typing`, publishes `typing.started`/`typing.stopped` to the other participant.
    - `presence()` - the SSE connection is the heartbeat; publishes `presence.online`/`presence.offline` to conversation partners (multi-tab safe, configurable offline grace period) and serves `GET /presence?userIds=…` restricted to users the caller shares a conversation with.
    - `receipts()` - ephemeral `receipt.delivered` (to the sender, when a recipient's live stream receives the message) and `receipt.read` (to the other participant, on mark-read). Durable `lastReadMessageId` is unchanged.

  Breaking (custom `Transport` authors only): `Transport.publish`/`subscribe` now carry `TransportEvent = ChatEvent | EphemeralEvent` instead of `ChatEvent`. Discriminate with the new `isEphemeralEvent()` guard. Transports that just fan events out keep working unchanged.

## 0.1.7

### Patch Changes

- 9113ad1: Docs-only: add a task-oriented "Which API do I call?" table (server method and
  HTTP route side by side, plus a pagination-vs-gap-fill warning) and a
  request-flow diagram to the README.

## 0.1.6

### Patch Changes

- 1bb1f38: Docs: hybrid auth recipe (bearer for REST, cookie for `/stream`), explicit HTTP-envelope vs bare `chat.api.*` return-shape clarification, and `getConversation` throw behavior called out (README + TSDoc).

## 0.1.5

### Patch Changes

- 2e9b12a: Docs: document the custom storage adapter contract precisely - adapter-defined
  cursor encodings, the real-`Date`-instances rule, and adapter-generated ids -
  in the StorageAdapter TSDoc and README, and point adapter authors at the
  reference schema (`migrationSql`/`chatpackSchema`) and the new root `llms.txt`
  agent guide (invariants, reference SQL, skeleton, pitfalls, and a "verify your
  adapter" checklist). Also fixes the `Conversation.id`/`Message.id` TSDoc,
  which wrongly claimed core generates ids (adapters do).

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

## 0.1.1

### Patch Changes

- Documentation: the quickstart and `@chatpack/core` README now include curl-able
  HTTP examples with real request/response JSON, and the REST route table
  documents request bodies, query params, and response envelopes for every
  endpoint (verified against the handler source). No code changes.

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
