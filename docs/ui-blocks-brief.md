# Chatpack UI blocks - build brief

_Hand this whole file to your AI coding tool (Cursor, Claude Code, v0, Bolt...)
as context, then build block by block. Everything your AI needs to know about
the API is in here and in the linked llms.txt - if it invents a method or
field that isn't listed below, it's hallucinating; stop and re-read this._

## What you're building

**Copy-paste chat UI blocks** for the Chatpack docs site (like shadcn/ui
blocks): polished, self-contained React components that developers copy into
their own app. They will NOT be published as an npm package - each block is
a `.tsx` file (or small file group) that must work when pasted into any
Next.js/React app that has `@chatpack/client` installed.

Blocks to build, in priority order:

1. **Conversation list** - sidebar with unread badges, active selection
2. **Message thread** - transcript with date separators, own/other bubbles,
   deleted-message tombstones, "load older" pagination
3. **Message composer** - input + send, Enter to send, typing signal
4. **Typing indicator** - "… is typing" line under the thread
5. **Full chat block** - the above composed into one two-pane layout
6. (nice to have) **Presence dot** and **read receipts** (✓✓) on bubbles

## Ground rules

- **Stack:** React function components, TypeScript, Tailwind CSS classes
  only (no CSS files, no styled-components, no UI kit imports). Each block
  self-contained: one file where possible, no shared utils package.
- **Data comes ONLY from `@chatpack/client`** - never `fetch()` chat routes
  by hand, never invent REST calls. The client handles URLs, envelopes,
  auth cookies, SSE, and deduplication.
- **Chatpack has NO users table.** User ids are opaque strings (`"alice"`,
  `"user_abc123"`). Blocks must take a `renderUser?: (userId: string) =>
ReactNode` prop (or similar) for names/avatars - never assume a user
  object with `name`/`avatar` exists.
- **1:1 conversations only.** Exactly two participants, always. No group
  chat UI, no member lists.
- Accessible by default: real `<button>`s, labelled inputs, focus states,
  `aria-live="polite"` on the message list and typing indicator.

## Setup for local development

Ask the Chatpack maintainer for the repo, or reproduce the environment:

```sh
npm install @chatpack/client react
```

The repo's `examples/next-backend` app is the test bed - it has a working
backend at `/api/chat`, demo cookie auth (buttons to "sign in" as alice/bob),
and a bare-bones page at `/chat` showing the client wired up. Build blocks
against it; two browser windows (one alice, one bob) give you live two-way
chat.

Full API reference (fetch this first): <https://docs.chatpack.dev/llms.txt>
Client docs: <https://docs.chatpack.dev/docs/client/overview>

## The client API - this is ALL of it

```ts
import { createChatClient } from "@chatpack/client/react";
import { typingClient, presenceClient, receiptsClient } from "@chatpack/client/plugins";

// ONE instance per app, module scope, NOT inside a component:
export const chatClient = createChatClient({
  plugins: [typingClient(), presenceClient(), receiptsClient()],
});
```

Hooks (on the client instance created via `@chatpack/client/react`):

| Hook                                                 | Returns                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `chatClient.useConversations()`                      | `{ data: { conversations, nextCursor }, error, isPending, isRefetching, refetch }` |
| `chatClient.useConversation({ conversationId })`     | same shape, single conversation                                                    |
| `chatClient.useMessages({ conversationId, limit? })` | same shape + `loadMore()` for older pages                                          |
| `chatClient.useRealtimeStatus()`                     | `{ status: "idle"\|"connecting"\|"open"\|"closed", error }`                        |
| `chatClient.useTyping({ conversationId })`           | `{ senderId, at } \| null`                                                         |
| `chatClient.usePresence({ userIds? })`               | `Record<userId, { online, lastSeenAt }>`                                           |
| `chatClient.useReceipts({ conversationId })`         | `{ deliveredSeq?, readMessageId? } \| null`                                        |

Actions (all return `{ data, error }` - they never throw for API failures;
always branch on `result.error`):

```ts
await chatClient.conversations.create({ otherUserId });      // find-or-create
await chatClient.conversations.markRead({ conversationId, messageId });
await chatClient.messages.send({ conversationId, body });    // text field is `body` - NOT text/content
await chatClient.messages.edit({ messageId, body });
await chatClient.messages.delete({ messageId });             // soft delete
await chatClient.typing.start({ conversationId });           // throttle: max 1 per ~3s
await chatClient.realtime.subscribe((event) => { ... });     // raw event stream, returns unsubscribe fn
```

Data shapes (nothing else exists on these objects):

```ts
// Conversation: id, pairKey, createdAt, metadata, participants[2], unreadCount
// - NO lastMessage field. NO updatedAt. NO title/name. If a design needs a
//   last-message preview, note it as a limitation - do not fake the field.
// Participant: conversationId, userId, joinedAt, lastReadMessageId
// Message: id, conversationId, senderId, body, role ("user"|"assistant"|"system"),
//          seq, metadata, createdAt, editedAt, deletedAt
```

## Chat-specific gotchas (each has broken a generated UI before)

1. **Message lists are NEWEST-first.** Reverse (or `flex-col-reverse`) for a
   transcript. `loadMore()` fetches OLDER messages - it's "scroll up for
   history", and it merges into the same list.
2. **Deleted messages are tombstones**, not gone: `deletedAt !== null` and
   the `body` is empty. Render "message deleted" in muted style - don't
   filter them out (it breaks users' sense of history).
3. **Unread badge:** read `conversation.unreadCount` - never count
   client-side. Call `conversations.markRead(...)` with the newest visible
   message id when the thread is open/focused; marking older messages is a
   safe no-op (read-state never regresses).
4. **Own vs other bubbles:** compare `message.senderId` to the current user
   id. The block must take `currentUserId: string` as a prop - the client
   does not know who is signed in (auth belongs to the host app).
5. **`role` field:** `"assistant"` messages exist (AI use case). Style them
   like the other party's bubbles unless the design says otherwise.
6. **Typing indicator expires by itself** (~5s) - the hook returns `null`
   again; just render what the hook gives you. Call `typing.start()`
   throttled while the user types (at most one call per ~3 seconds).
7. **Known client limitation (v0.1.0):** realtime events update the open
   thread's messages, but the conversations LIST does not live-update
   (no reorder, no unread-badge bump) when a message arrives in another
   conversation. Workaround inside the conversation-list block: subscribe
   and refetch -
   ```ts
   useEffect(
     () =>
       chatClient.realtime.subscribe((e) => {
         if (e.type === "message.created") void conversations.refetch();
       }),
     [],
   );
   ```
   (`subscribe` returns its own unsubscribe function - returning it from
   `useEffect` handles cleanup.)
8. **Connection status:** `useRealtimeStatus()` - show a subtle "reconnecting"
   hint when status is not `"open"`. Reconnects and missed-message backfill
   are automatic; never build manual reconnect logic.

## States every block must handle

- `isPending` → skeleton (not a spinner-only blank)
- `error` → inline message with the `error.code`, plus a retry via `refetch()`
- empty → friendly empty state ("No conversations yet")
- long content: names/ids truncate with ellipsis, message bodies wrap;
  test with a 500-char single-word message

## Definition of done (per block)

- [ ] Works in `examples/next-backend` with two browser windows (alice +
      bob) chatting live - both directions.
- [ ] No hand-written `fetch` to `/api/chat/*` anywhere.
- [ ] No invented fields (grep your code for `lastMessage`, `user.name`,
      `avatar` - none should touch Chatpack objects directly).
- [ ] Pending / error / empty states all reachable and styled.
- [ ] TypeScript strict - no `any`, no `@ts-ignore`.
- [ ] Keyboard: Tab reaches everything; Enter sends; Shift+Enter = newline.
- [ ] File is self-contained and pasteable: imports only from `react`,
      `@chatpack/client...`, and the file itself.

## Deliverable

One folder per block, e.g. `blocks/conversation-list/conversation-list.tsx`,
plus a 5-line README per block: what it does, its props, and any limitation
(e.g. the list-refetch workaround from gotcha #7). The Chatpack team will
wire them into the docs site - you don't need to touch the docs site itself.
