# @chatpack/client

Framework-agnostic Chatpack client with an optional React integration.

```sh
pnpm add @chatpack/client
```

```ts
import { createChatClient } from "@chatpack/client";

const chatClient = createChatClient({
  // Omit when the API is on the same origin.
  baseURL: "http://localhost:3000",
  credentials: "include",
});

const conversation = await chatClient.conversations.create({ otherUserId: "bob" });
if (conversation.error === null) {
  await chatClient.messages.send({
    conversationId: conversation.data.id,
    body: "Hello",
  });
}
```

Methods return `{ data, error }`. Expected HTTP and network failures do not
throw. The client uses the server's existing authentication. It never reads
cookies, manages sessions, or puts tokens in an SSE URL. Browser cookie
authentication is the recommended model because native `EventSource` cannot
send custom headers.

## React

React is optional:

```sh
pnpm add @chatpack/client react
```

```tsx
"use client";

import { createChatClient } from "@chatpack/client/react";

const chatClient = createChatClient();

export function ConversationList() {
  const { data, isPending } = chatClient.useConversations();
  if (isPending) return <p>Loading…</p>;
  return (
    <ul>
      {data?.conversations.map((item) => (
        <li key={item.id}>{item.id}</li>
      ))}
    </ul>
  );
}
```

The React adapter uses `useSyncExternalStore`, shares one per-client cache and
one lazy SSE connection, and has no state-library dependency.

Search is a paginated snapshot across every conversation visible to the signed-in
participant:

```tsx
const search = chatClient.useMessageSearch({ query: "release ready", limit: 20 });
await search.loadMore();
```

An empty or whitespace-only hook query stays idle with an empty page and sends
no request. The hook requests whenever `query` changes, so debounce text input
before passing it to the hook:

```tsx
const [query, setQuery] = useState("");
const [debouncedQuery, setDebouncedQuery] = useState(query);
useEffect(() => {
  const timer = setTimeout(() => setDebouncedQuery(query), 250);
  return () => clearTimeout(timer);
}, [query]);

const search = chatClient.useMessageSearch({ query: debouncedQuery, limit: 20 });
```

The client retains at most ten normalized query entries per instance.

## API

The framework-agnostic client mirrors the server routes from `@chatpack/core`:

| Client surface           | Core route or behavior                                        |
| ------------------------ | ------------------------------------------------------------- |
| `conversations.create`   | `POST /conversations`                                         |
| `conversations.list`     | `GET /conversations`                                          |
| `conversations.get`      | `GET /conversations/:id`                                      |
| `conversations.markRead` | `POST /conversations/:id/read`                                |
| `messages.list`          | `GET /conversations/:id/messages`                             |
| `messages.search`        | `GET /search/messages?q=...`                                  |
| `messages.send`          | `POST /conversations/:id/messages`                            |
| `messages.edit`          | `PATCH /messages/:id`                                         |
| `messages.delete`        | `DELETE /messages/:id`                                        |
| `messages.forward`       | `POST /messages/:id/forward`                                  |
| `messages.react`         | `POST /messages/:id/reactions`                                |
| `messages.unreact`       | `DELETE /messages/:id/reactions`                              |
| `invites`                | Invite creation, listing, preview, acceptance, and revocation |
| `joinRequests`           | Join-request creation, moderation queue, and resolution       |
| `channels`               | Public-channel directory and self-service joining             |
| `moderation`             | Blocks, mutes, reports, and bans (`/moderation/*`)            |
| `realtime`               | `GET /stream` with native reconnect and deduplication         |

Every request returns `{ data, error }`. The client passes browser credentials
to the server and never replaces the server's auth hook. The optional `userId`
option is a cache hint, not a credential: it keeps the viewer's own messages
from counting as unread. Omit it and the client infers the id from the first
message it sends.

## Message search

`messages.search({ query, limit, cursor })` and `useMessageSearch` return
participant-scoped, relevance-ranked pages. Matching is case-insensitive and
whole-token: every distinct query term must appear, so `deploy` does not match
`deployment`. Core and the storage adapter own tokenization, permission checks,
ranking, tombstone exclusion, and cursor encoding; the client only forwards the
request and preserves returned order.

Adapters may omit search. In that case the result carries
`error.code === "SEARCH_UNSUPPORTED"` and status 501. Search pages are snapshots,
not live-ranked collections: new messages are not inserted and existing hits
are not re-ranked. Edits and tombstones patch loaded hits in place, and losing
access to a conversation removes its hits so stale bodies are not retained.
Call `refetch()` after relevant message changes to recompute matches and rank.

## Replies and reactions

`messages.send` takes an optional `replyToMessageId`; every message comes back
with `replyToMessageId`, a read-only `replyTo` preview
(`{ id, senderId, excerpt, deleted }`) for the quote bar, `reactions`
(`[{ emoji, count, userIds }]`), `mentions` (`string[]`), and `forwardedFrom`
(`{ messageId, conversationId, senderId } | null`).

```ts
const sent = await chatClient.messages.send({ conversationId, body: "Hello" });
if (sent.error === null) {
  await chatClient.messages.send({
    conversationId,
    body: "Hi back",
    replyToMessageId: sent.data.id,
  });

  const reacted = await chatClient.messages.react({ messageId: sent.data.id, emoji: "👍" });
  reacted.data?.reactions; // [{ emoji: "👍", count: 1, userIds: ["bob"] }]
  await chatClient.messages.unreact({ messageId: sent.data.id, emoji: "👍" });
}
```

Both reaction calls are idempotent and return the message with its **complete**
reaction set, which goes straight into the cache. An `emoji` is any non-empty
string up to 32 characters - `""` or longer comes back as `INVALID_INPUT`, an
unknown `messageId` as `MESSAGE_NOT_FOUND`, both as results rather than throws.
These are quote-replies, not threads: a flat pointer at one earlier message in
the same conversation.

## Mentions and forwarding

`messages.send` and `messages.edit` take a `mentions` array of **user ids you
supply**. Chatpack never parses `body` for `@`, so populate your picker from
`conversation.participants` - a non-participant id comes back as
`MENTION_NOT_PARTICIPANT`, and the whole message is refused rather than the id
quietly dropped. `mentions` reads back **sorted**, so treat it as a set.

On edit the client preserves the absent-versus-empty distinction the API relies
on: omit `mentions` and the stored set is untouched, pass `[]` and it is cleared.

```ts
await chatClient.messages.send({ conversationId, body: "@bob look", mentions: ["bob"] });
await chatClient.messages.edit({ messageId, body: "typo fixed" }); // mentions untouched
await chatClient.messages.edit({ messageId, body: "never mind", mentions: [] }); // cleared

const forwarded = await chatClient.messages.forward({ messageId, toConversationId });
forwarded.data?.forwardedFrom; // { messageId, conversationId, senderId } - frozen
```

`messages.forward` resolves with the **copy** in the target conversation - a new
id, your id as sender, its own `seq` - and the cache treats it exactly like a
send, so the copy lands in the target thread and that conversation moves to the
front of the list. The destination is `toConversationId` in the input even though
the wire field is a plain `conversationId`, because the route already names the
source. Optional `role`, `mentions`, and `metadata` apply to the copy; nothing
travels from the original, and `mentions` is checked against the target.

## Realtime cache updates

Durable events keep both the open conversation and the conversations list
current. On `message.created` the conversation moves to the front of the cached
list and its `unreadCount` increments (never for the viewer's own messages).
A conversation missing from the list is fetched once and prepended.
`message.updated` and `message.deleted` do not reorder, matching server-side
activity ordering, and redelivered events never double-count.
`conversations.markRead` clears `unreadCount` locally when the marked message is
the newest one cached.

`reaction.added` and `reaction.removed` replace one cached message's `reactions`
and touch nothing else - no reorder, no unread bump, no change to the seq
baseline. The event carries the complete set, so applying it twice is harmless,
and only that field is merged, so a stale `body` in the payload can't clobber
what the cache holds. A reaction on a message outside the loaded page is
dropped rather than spliced into a paginated list. Reactions have no `seq`, so
they are **not** gap-filled on reconnect; one applied while disconnected
appears on the next refetch. Narrow with the exported
`isReactionChatEvent(event)` - each `ChatpackEvent` member has a _union_ of
literal `type` values, which TypeScript can't use to eliminate a member, so an
inline `event.type === "reaction.added"` check does not narrow.

## Polling fallback

Some platforms can't hold a long-lived connection: serverless functions time out
mid-response, proxies buffer `text/event-stream`, React Native has no
`EventSource`. Rather than reporting `closed` and going stale, the client
refetches on an interval - **on by default, so don't hand-roll one**.

```ts
const chatClient = createChatClient({
  realtime: {
    mode: "auto", // "auto" (default) | "sse" | "poll"
    intervalMs: 5000, // default 5000, clamped to a 1000ms floor
  },
});
```

`auto` opens the stream and polls only if it can't open or drops, stopping the
moment it reopens. `sse` never polls (the pre-0.4.0 behaviour); `poll` never
attempts a stream. While polling, status is `"polling"` - connected-but-degraded,
not an error. `realtime.pollNow()` runs one refresh immediately.

A tick refetches page one of the conversations list **and** the 3 most recently
used conversations. It uses the same `limit` as the last request and only
refreshes loaded surfaces. It re-reads the list routes rather than asking for
messages after a `seq`, because only sending allocates a `seq` - an edit, a
delete and every reaction change would be invisible to an incremental poll.
Ticks never overlap, a hidden tab doesn't poll, a failed tick changes nothing
and never touches `isPending`, and pages merge rather than replace, so an idle
interval notifies no subscribers and causes no re-renders.

Typing, presence and receipts don't work while polling: they're ephemeral and
never stored, so there is no endpoint to poll. `useTyping()` stays `null`.

## Plugins

First-party client counterparts are available from `@chatpack/client/plugins`:

```ts
import { typingClient, presenceClient, receiptsClient } from "@chatpack/client/plugins";
import { createChatClient } from "@chatpack/client";

const chatClient = createChatClient({
  plugins: [typingClient(), presenceClient(), receiptsClient()],
});

await chatClient.typing.start({ conversationId: "c1" });
```

Client plugins add namespaced actions and per-client state. Authentication and
server plugin route discovery remain outside this package.

## Scope

The package covers the public REST API, SSE message reconciliation with a
polling fallback, ephemeral event subscriptions, and React hooks. It does not
provide auth, uploads, optimistic state, persistence, or WebSocket transport.

**Groups (client 0.5.0+).** Group conversations come back from
`conversations.list` and `conversations.get` like any other - the conversation
type carries `type`, `name`, `pairKey: null`, and each participant's `role` -
and their messages, unread counts, and `message.*` events all flow through
unchanged. The five group mutations are wrapped: `conversations.createGroup`
(never find-or-create; the caller becomes the first admin),
`conversations.addParticipants`, `conversations.removeParticipant` (your own
id = leave), `conversations.setParticipantRole`, and `conversations.update`
(rename; `name: null` clears). The client subscribes to `participant.added` /
`participant.removed` / `conversation.updated` and applies them to the cache:
renames and role changes merge in place, being added to a group backfills it
into the list, and being removed drops the conversation from every cache
surface - the polling fallback converges the same way on its next tick,
treating a thread poll's `FORBIDDEN_READ` as the removal signal.

Group creation and updates also accept `visibility` (`"private"` or
`"public"`) and `joinPolicy` (`"approval"` or `"open"`) for public channels.

## Invites, join requests, and channels

The client wraps all invite, join-request, and public-channel routes:

```ts
const invite = await chatClient.invites.create({
  conversationId: groupId,
  expiresInSeconds: 3600,
  requiresApproval: true,
});

if (invite.error === null) {
  const accepted = await chatClient.invites.accept({ code: invite.data.code });
  if (accepted.error === null && accepted.data.status === "pending") {
    console.log("Waiting for approval", accepted.data.joinRequest.id);
  }
}

const channels = await chatClient.channels.list();
if (channels.error === null) {
  await chatClient.channels.join({ conversationId: channels.data.channels[0]!.conversationId });
}
```

`invites.accept` and `channels.join` return a status-discriminated result:
`"joined"` includes a conversation, while `"pending"` includes a join request.
Repeated pending requests return the existing request. Unknown or revoked invite
codes return `INVITE_NOT_FOUND` (404); expired or exhausted codes return
`INVITE_EXPIRED` (410). Resolving an already-resolved request returns
`JOIN_REQUEST_NOT_FOUND` (404). Adapters without the optional capabilities return
`INVITES_UNSUPPORTED` or `CHANNELS_UNSUPPORTED` (501) as structured results.

## Moderation

`chatClient.moderation.*` wraps all thirteen `/moderation/*` routes. Six of them
are self-service - any signed-in user may block, mute, and report:

```ts
await chatClient.moderation.blockUser({ targetUserId: "bob" });
await chatClient.moderation.muteConversation({ conversationId });
await chatClient.moderation.report({
  targetType: "message", // "user" | "message" | "conversation"
  targetId: messageId,
  reason: "harassment",
});
```

The complete action surface is:

| Action                                                               | Route                      | Access       |
| -------------------------------------------------------------------- | -------------------------- | ------------ |
| `blockUser` / `unblockUser` / `listBlockedUsers`                     | `/moderation/blocks`       | Self-service |
| `muteConversation` / `unmuteConversation` / `listMutedConversations` | `/moderation/mutes`        | Self-service |
| `report`                                                             | `POST /moderation/reports` | Self-service |
| `listReports` / `getReport` / `updateReport`                         | `/moderation/reports`      | Moderator    |
| `listBans` / `banUser` / `unbanUser`                                 | `/moderation/bans`         | Moderator    |

The other seven are for your moderators and return `NOT_MODERATOR` (403) unless
the server's `moderation.canModerate` hook admits the caller:

```ts
const queue = await chatClient.moderation.listReports({ status: "open" });
await chatClient.moderation.updateReport({ reportId, status: "triaged" });
await chatClient.moderation.banUser({ targetUserId: "troll", reason: "spam" });
await chatClient.moderation.unbanUser({ banId });
```

Blocks and mutes are idempotent, and a repeated report for the same target
returns the existing one. A mute is a hint for your own UI: unread counts and
SSE delivery are unchanged, so read `listMutedConversations` and suppress
notifications yourself. Every route answers `USER_BANNED` (403) for a banned
caller - including `/stream`, so a live subscription is closed at the next
heartbeat rather than instantly - and `MODERATION_UNSUPPORTED` (501) on an
adapter without the capability. The client returns these structured errors,
plus `DIRECT_INTERACTION_BLOCKED`, `REPORT_NOT_FOUND`, `BAN_NOT_FOUND`, and
`INVALID_INPUT`, in `{ data: null, error }`; expected failures do not throw.
Malformed successful moderation envelopes return `INVALID_RESPONSE` instead of
being exposed as unchecked `undefined` values. None of these actions touch the
query cache; refetch after a mutation that should change what the user sees.

## Source layout

- `src/index.ts` exports the framework-agnostic public API.
- `src/config.ts` defines fetch, headers, credentials, and EventSource injection.
- `src/client.ts` composes the public client and core resource methods.
- `src/request.ts` builds URLs, sends JSON, and maps response envelopes/errors.
- `src/errors.ts` defines the `{ data, error }` result and stable client errors.
- `src/wire.ts` defines the JSON-facing domain types used by REST and SSE.
- `src/realtime.ts` owns the lazy EventSource, event dispatch, and the fallback
  between streaming and polling.
- `src/polling.ts` provides the non-overlapping, visibility-aware interval timer.
- `src/store.ts` provides the small platform-only observable store.
- `src/store-cache.ts` reconciles REST and durable SSE data per client.
- `src/plugin.ts` composes typed plugin actions and state.
- `src/plugins/` contains first-party typing, presence, and receipts adapters.
- `src/react/` exposes `useSyncExternalStore` hooks without a state dependency.

## Community

- **[Discord](https://discord.gg/gY3GCTRv5Y)** — chat with the team and other developers
- **[X](https://x.com/chatpackdev)** — releases and updates
- **[Docs](https://docs.chatpack.dev)** — the full documentation site
- **[GitHub Discussions](https://github.com/chddaniel/chatpack/discussions)** — questions, show-and-tell, and feedback
