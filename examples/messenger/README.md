# example-messenger — build a 1:1 messenger

A complete, working messenger — sidebar, live messages, read receipts,
edit/delete — in **vanilla HTML + JS** with no framework and no build step,
so you can see exactly where your code ends and Chatpack begins:

- **Chatpack owns:** conversations, messages, permissions, read-state,
  real-time delivery (`server.ts` § 1 — it's ~10 lines).
- **You own:** users + auth (`server.ts` § 2) and the UI (`public/`).

Storage is in-memory (zero setup, data resets on restart). Auth is a
plain-username cookie — **demo only**; in a real app your `auth` hook
verifies a session from your auth library instead.

## Run it

```sh
pnpm install
pnpm --filter example-messenger start
```

Open [http://localhost:3000](http://localhost:3000) in **two browser
windows** (one normal, one private/incognito so the cookies don't collide).
Sign in as `alice` in one and `bob` in the other, start a chat, and watch
messages, edits, deletes, and read receipts flow live between them.

## The 10-minute tour

Everything below lives in [`public/app.js`](./public/app.js), section by
section. The frontend talks **plain HTTP** to the API that `chat.handler()`
serves — there is no Chatpack client library to learn.

### 1. Set up the server

```ts
// server.ts
const chat = chatpack({
  storage: memoryAdapter(),
  auth: (request) => {
    const userId = readSessionCookie(request.headers.get("cookie"));
    return userId ? { id: userId } : null;
  },
});

const handler = chat.handler(); // serves everything under /api/chat
```

That's the whole chat backend. Auth is cookie-based on purpose: the browser
attaches cookies automatically to every request — **including the SSE stream,
where `EventSource` can't send custom headers**.

### 2. Show the inbox

```js
const { conversations } = await api("/conversations");
```

Responses are envelopes keyed by resource (`{ conversations, nextCursor }`,
`{ message }`, ...). Conversations come back most-recently-active first, each
with its two `participants` — the "name" in the sidebar is just the other
participant's `userId` (Chatpack never owns your users table).

### 3. Start a chat

```js
const { conversation } = await api("/conversations", {
  method: "POST",
  body: { otherUserId: "bob" },
});
```

This is **find-or-create**: one conversation exists per user pair, so
"chatting again" returns the existing conversation instead of a duplicate.
Note that Chatpack can't check `otherUserId` exists (no users table) —
validate it against your own users before calling in a real app.

### 4. Load history

```js
const page = await api(`/conversations/${id}/messages?limit=30`);
const messages = page.messages.reverse(); // newest-first → chronological
```

Messages arrive **newest first** with a `nextCursor` for older pages — that
cursor powers the "Load older messages" button (pass it back verbatim as
`?cursor=`). Timestamps are ISO strings on the wire.

### 5. Send a message

```js
await api(`/conversations/${id}/messages`, { method: "POST", body: { body: "hey!" } });
```

The app doesn't append the message locally on success — it lets its own
message arrive through the SSE stream like everyone else's, so there's
exactly one rendering code path.

### 6. Go live

```js
const stream = new EventSource("/api/chat/stream");

stream.addEventListener("message.created", (e) => {
  const { message } = JSON.parse(e.data);
  // append if the conversation is open, otherwise show an unread dot
});
```

One `EventSource`, no WebSocket server, no Socket.IO, no reconnect code:
the browser reconnects automatically with `Last-Event-ID` and Chatpack
replays whatever was missed from storage. Delivery is at-least-once, so the
app dedupes by `message.id`. Edits arrive as `message.updated`, soft-deletes
as `message.deleted` (with `deletedAt` set and an empty body).

### 7. Read receipts

```js
await api(`/conversations/${id}/read`, { method: "POST", body: { messageId: last.id } });
```

Read-state is durable: each participant carries `lastReadMessageId`, which
is how the "Seen" label under your last message is computed after fetching
the conversation. (v0 has no _live_ read-receipt event — the label refreshes
when the conversation is reopened.)

### 8. Edit & delete

```js
await api(`/messages/${messageId}`, { method: "PATCH", body: { body: "fixed typo" } });
await api(`/messages/${messageId}`, { method: "DELETE" }); // soft-delete
```

Only the original sender may edit or delete — enforced server-side, the UI
buttons are just convenience.

## Deliberately not here (v0 scope)

Typing indicators, presence/online status, group chats, attachments, and
live read-receipt pings are not in Chatpack v0 — this example doesn't fake
them. See the [roadmap](../../docs/MVP.md).

## Where to go next

- Swap `memoryAdapter()` for Postgres:
  [`@chatpack/adapter-drizzle`](../../packages/adapter-drizzle) (see
  [`examples/node-server`](../node-server) for the wiring).
- Full API reference — every route, method, and error code:
  [`@chatpack/core`](../../packages/core).
- Mount the same handler on Next.js instead of plain Node:
  [`examples/next-backend`](../next-backend).
