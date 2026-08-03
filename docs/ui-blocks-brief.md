# Chatpack UI blocks — build brief

**You are building a library of copy-paste chat UI, like shadcn/ui, for
Chatpack.** Developers will browse these on our docs site, copy the source of
whatever they need, paste it into their own app, and have working chat.

You do all of this **inside an AI builder** — Shipper.now, Lovable, v0, or
Bolt. No repo to clone, no dev server, no terminal, no database. You connect to
a chat backend we already run for you.

---

## Part 1 — Get set up (once, ~10 minutes)

### Step 1: Start a project in your AI builder

Create a new React project. Any of these work: Shipper.now, Lovable, v0, Bolt.

### Step 2: Install the connector package

Chatpack talks to your UI through exactly one package: **`@chatpack/client`**.
Tell your builder:

> Install the npm package `@chatpack/client` — version 0.2.0 or newer.

The version matters: 0.2.0 is what makes conversation lists update themselves.
Most builders install packages automatically once the code imports them; if
yours has a dependency panel, add it there.

### Step 3: Create the connection file

Every component you build imports from this one file. Create
`lib/chat-client.ts` and paste this **exactly**:

```ts
import { createChatClient } from "@chatpack/client/react";
import { typingClient, presenceClient, receiptsClient } from "@chatpack/client/plugins";

// ONE client for the whole app. Module scope — never inside a component.
export const chatClient = createChatClient({
  baseURL: "https://demo-api.chatpack.dev",
  basePath: "/api/chat/u/SANDBOX/alice", // <-- see below
  userId: "alice", // so your own messages don't count as unread
  plugins: [typingClient(), presenceClient(), receiptsClient()],
});

// Who you are signed in as. Components need this to tell "my" messages apart.
export const currentUserId = "alice";
```

**Replace `SANDBOX`** with a name of your own — your project name, your
nickname, anything lowercase with dashes (`maria-blocks`, `chat-ui-v2`). It
keeps your chat data separate from other people using the demo backend.

That's the entire setup. There is **no API key, no login, no database**.

### Step 4: Confirm it works

Build a throwaway page that renders this and nothing else:

```tsx
"use client";
import { chatClient, currentUserId } from "@/lib/chat-client";

export default function Test() {
  const conversations = chatClient.useConversations();
  return (
    <pre>
      {currentUserId}: {JSON.stringify(conversations.data, null, 2)}
    </pre>
  );
}
```

You should see **two conversations** (alice↔bob, alice↔carol). If you see them,
you're connected and can start building. If you see `null` or an error, jump to
**Troubleshooting** at the bottom — don't start building on a broken
connection.

### Step 5: How to test live, two-way chat

Open your builder's preview **twice, in two browser windows**. In one window,
`lib/chat-client.ts` says `alice`; temporarily change it to `bob` in the other
(same `SANDBOX`, and change `userId` and `currentUserId` too). Now type in one
window and watch the other.

That's how you verify typing indicators, live message delivery, and unread
badges. **Every block must be checked this way before you call it done.**

### What's already in your sandbox

So you never build against an empty screen, each new sandbox comes pre-loaded:

- **alice ↔ bob** — a short conversation, plus **one edited message** and
  **one deleted message**, so you can style those states without having to
  create them
- **alice ↔ carol** — a second conversation, so lists have more than one row

Data resets if the backend goes to sleep, then reseeds automatically. If your
messages disappear, that's expected — not a bug you caused.

---

## Part 2 — The rules that make a component "correct"

A component that looks perfect but breaks these is **not** acceptable, because
developers will paste it into real apps.

### Rule 1: All data comes from `@chatpack/client`. Never write `fetch`.

If you find yourself writing `fetch("/api/chat/...")` or inventing a URL, stop.
The client handles every URL, response format, and live connection. Hand-rolled
requests are the single most common way this goes wrong.

### Rule 2: Never invent a field or a method.

Part 3 lists **everything that exists**. If your AI builder produces
`conversation.lastMessage`, `user.name`, `user.avatar`, `message.text`, or a
hook not in that list, **it made it up.** Delete it and re-read Part 3.

This is the #1 failure mode. AI tools confidently invent chat APIs because
they've seen hundreds of other chat libraries.

### Rule 3: Users are just ID strings.

Chatpack has **no users table** — no names, no avatars, no profile pictures,
ever. A user is a string like `"alice"` or `"user_abc123"`.

So every component that displays a person takes a prop to render them:

```tsx
renderUser?: (userId: string) => React.ReactNode;
```

Default to showing the raw ID. The developer plugs in their own user data.
**Never fake an avatar or a display name.**

### Rule 4: Conversations are always exactly 2 people.

1:1 only. No group chat, no member lists, no "add someone" button.

### Rule 5: Style with Tailwind classes and theme tokens only.

No CSS files, no styled-components, no other UI kits. Use the theme tokens in
Part 4 so everything reskins together.

### Rule 6: Each piece is self-contained and pasteable.

One file per component. It may import only from `react`, `@chatpack/client...`,
`lib/chat-client`, `lib/chat-theme`, and its own primitives. **No grab-bag
helper files** — a developer copying one component must not have to copy three
unrelated ones.

### Rule 7: Accessible by default.

Real `<button>` elements, labelled inputs, visible focus rings, `aria-live`
on the message list and typing indicator. Tab must reach everything.

---

## Part 3 — The complete API (nothing else exists)

### Reading data: hooks

Each returns `{ data, error, isPending, isRefetching, refetch }`:

| Hook                                                 | Gives you                                          |
| ---------------------------------------------------- | -------------------------------------------------- |
| `chatClient.useConversations()`                      | `data.conversations`, `data.nextCursor`            |
| `chatClient.useConversation({ conversationId })`     | one conversation                                   |
| `chatClient.useMessages({ conversationId, limit? })` | `data.messages` + **`loadMore()`** for older pages |
| `chatClient.useRealtimeStatus()`                     | `{ status, error }` — no `data` wrapper            |
| `chatClient.useTyping({ conversationId })`           | `{ senderId, at }` or `null` — no `data` wrapper   |
| `chatClient.usePresence({ userIds? })`               | `Record<userId, { online, lastSeenAt }>`           |
| `chatClient.useReceipts({ conversationId })`         | `{ deliveredSeq?, readMessageId? }` or `null`      |

The last four are **not** wrapped in `{ data }` — use their value directly.

### Changing data: actions

All return `{ data, error }` and **never throw**. Always check `result.error`:

```ts
await chatClient.conversations.create({ otherUserId });
await chatClient.conversations.markRead({ conversationId, messageId });
await chatClient.messages.send({ conversationId, body }); // text field is `body`
await chatClient.messages.edit({ messageId, body });
await chatClient.messages.delete({ messageId }); // soft delete → tombstone
await chatClient.typing.start({ conversationId }); // max once per ~3s
await chatClient.realtime.subscribe((event) => {}); // returns unsubscribe fn
```

### The only three data shapes

```ts
// Conversation
{
  (id, pairKey, createdAt, metadata, participants[2], unreadCount);
}
// NO lastMessage. NO updatedAt. NO title. NO name. NO avatar.

// Participant
{
  (conversationId, userId, joinedAt, lastReadMessageId);
}

// Message
{
  (id, conversationId, senderId, body, role, seq, metadata, createdAt, editedAt, deletedAt);
}
// The text is `body` — not text, not content, not message.
```

If a design calls for a last-message preview in the conversation list, **you
cannot build it** — that field doesn't exist. Note it as a limitation in the
component's README instead of faking it.

### Eight behaviors that have broken generated chat UI before

1. **Message lists arrive NEWEST-first.** Reverse them (or use
   `flex-col-reverse`) to render a normal transcript. `loadMore()` fetches
   **older** messages — "scroll up for history".
2. **Deleted messages are tombstones, not gone.** `deletedAt` is set and `body`
   is empty. Render a muted "message deleted" — never filter them out.
3. **Unread counts come from the server:** use `conversation.unreadCount`.
   Never count client-side. Call `conversations.markRead()` with the newest
   visible message id when a thread is open; marking an older one is a safe
   no-op.
4. **"My" bubbles:** compare `message.senderId === currentUserId`. Components
   take `currentUserId` as a prop — the client doesn't know who's signed in.
5. **`role` can be `"assistant"`** (AI chat use case). Style it like the other
   person's bubble unless a design says otherwise.
6. **The typing indicator expires on its own** (~5s → hook returns `null`).
   Just render what the hook gives you. Call `typing.start()` at most once per
   ~3 seconds while typing.
7. **The conversation list live-updates itself** (client 0.2.0+). An incoming
   message reorders the list most-recently-active-first, bumps `unreadCount`,
   and prepends a conversation that wasn't loaded yet. `useConversations` opens
   the live stream on its own. So **just render what the hook returns** — do
   NOT add a `realtime.subscribe(...)` + `refetch()` loop. (Older guides
   prescribed that workaround for 0.1.x; on 0.2.0 it only causes redundant
   fetches.)
8. **Never write reconnection logic.** Reconnects and catching up on missed
   messages are automatic. Use `useRealtimeStatus()` only to show a subtle
   "reconnecting…" hint when `status !== "open"`.

### Every component handles four states

| State           | What to show                                                     |
| --------------- | ---------------------------------------------------------------- |
| `isPending`     | A skeleton shaped like the real content — not a blank spinner    |
| `error`         | Inline message including `error.code`, plus a `refetch()` button |
| empty           | A friendly line: "No conversations yet"                          |
| very long input | IDs truncate with `…`; message text wraps. Test a 500-char word. |

---

## Part 4 — What to build (the structure)

Build in tiers, **bottom-up**. Each tier composes the one below, so by the time
you reach the blocks, the hard parts are already solved and consistent.

### Tier 0 — The theme (build this first)

One file, `lib/chat-theme.ts`, exporting the Tailwind class strings every
component uses. This is what makes 20 components look like one library, and
lets a developer reskin everything by editing one file.

```ts
export const chatTheme = {
  surface: "bg-white dark:bg-zinc-950",
  panel: "bg-zinc-50 dark:bg-zinc-900",
  border: "border-zinc-200 dark:border-zinc-800",
  textPrimary: "text-zinc-900 dark:text-zinc-50",
  textMuted: "text-zinc-500 dark:text-zinc-400",
  bubbleOwn: "bg-blue-600 text-white",
  bubbleOther: "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50",
  badge: "bg-blue-600 text-white",
  focus: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
  radius: "rounded-2xl",
};
```

Every tier below imports from this. **Dark mode is required** in all of them.
Each component's README must say "also copy `lib/chat-theme.ts`".

### Tier 1 — Primitives (small, no data fetching)

Pure presentational pieces. They take props and render — no hooks, no client
calls. Each is trivially reusable and easy to get right.

| Primitive          | Props                             | Notes                                     |
| ------------------ | --------------------------------- | ----------------------------------------- |
| `UserAvatar`       | `userId`, `renderUser?`, `size?`  | Initials from the ID; no image by default |
| `MessageBubble`    | `message`, `isOwn`, `renderUser?` | Handles tombstone + "edited" marker       |
| `Timestamp`        | `value`, `format?`                | "2:14 PM" / "Yesterday"                   |
| `UnreadBadge`      | `count`                           | Renders nothing when `0`; "99+" cap       |
| `PresenceDot`      | `online`                          | With an accessible label                  |
| `ReadReceiptTicks` | `state`                           | ✓ sent, ✓✓ read                           |
| `EmptyState`       | `title`, `description?`, `icon?`  | Shared empty-state shell                  |
| `LoadingSkeleton`  | `variant`                         | `"list"` \| `"thread"` shapes             |
| `ErrorNotice`      | `code`, `message`, `onRetry`      | The standard error surface                |

### Tier 2 — Connected components (one hook each)

These call exactly one Chatpack hook and handle all four states.

| Component            | Hook used                       | Notes                                      |
| -------------------- | ------------------------------- | ------------------------------------------ |
| `ConversationRow`    | none (takes a conversation)     | Avatar + other participant + unread badge  |
| `TypingIndicator`    | `useTyping`                     | Animated dots, `aria-live="polite"`        |
| `ConnectionStatus`   | `useRealtimeStatus`             | Subtle; invisible when `"open"`            |
| `MessageComposer`    | `messages.send`, `typing.start` | Enter sends, Shift+Enter newline, throttle |
| `MessageActionsMenu` | `messages.edit/delete`          | Only on own messages                       |
| `PresenceIndicator`  | `usePresence`                   | Wraps `PresenceDot`                        |

### Tier 3 — Blocks (the headline pieces)

The things developers actually come to copy.

1. **`ConversationList`** — sidebar: unread badges, active selection, presence
   dots, empty + loading + error states. Live updates come free from the hook
   (gotcha 7) — no subscribe/refetch code.
2. **`MessageThread`** — transcript: date separators, own/other bubbles,
   tombstones, "load older" via `loadMore()`, auto-scroll to newest, calls
   `markRead` when viewed.
3. **`ChatComposerBar`** — composer with typing signal, disabled/sending state,
   character counter.
4. **`ChatWindow`** — thread + composer + typing indicator + connection status
   for a single conversation.
5. **`FullChatLayout`** — two-pane: `ConversationList` + `ChatWindow`,
   responsive (list collapses to a back button on mobile).

### Tier 4 — Variants (once Tier 3 is solid)

Same data, different look — this is where the catalog gets its breadth:

- `CompactChatList` — dense, avatar-only rail
- `BubbleThread` vs `FlatThread` — rounded bubbles vs Slack-style flat rows
- `FloatingChatWidget` — bottom-right launcher + popover panel
- `InboxLayout` — three-pane, email-style
- `MobileChatSheet` — full-screen sheet presentation

### Build order

Theme → 2–3 primitives → the connected component that needs them → then the
block that composes those → then variants. **Never start a block before its
primitives exist.** Finish and verify each tier before moving up.

---

## Part 5 — Delivering each piece

### The spec card

Before building anything, fill this in (in a comment at the top of the file):

```
Name:        ConversationList
Tier:        3 (block)
Uses:        useConversations
Composes:    ConversationRow, UnreadBadge, LoadingSkeleton, EmptyState
Props:       currentUserId, selectedId?, onSelect, renderUser?
States:      pending / error / empty / long-ids
Limitation:  no last-message preview (field doesn't exist in Chatpack)
```

### Folder layout

```
blocks/
  conversation-list/
    conversation-list.tsx
    README.md
primitives/
  message-bubble/
    message-bubble.tsx
    README.md
lib/
  chat-client.ts
  chat-theme.ts
```

### The README per piece (5 lines is plenty)

1. What it does, in one sentence
2. Its props
3. What else to copy (its primitives, plus `lib/chat-theme.ts`)
4. Any limitation
5. A paste-in usage snippet

### Definition of done — check every box

- [ ] Verified live in **two browser windows** (alice + bob), both directions
- [ ] **No `fetch` to a chat URL** anywhere
- [ ] **No invented fields** — search your file for `lastMessage`, `.name`,
      `.avatar`, `.text`, `.content`. None may touch a Chatpack object.
- [ ] Pending, error, empty, and long-content states all reachable and styled
- [ ] Works in **light and dark** mode
- [ ] Keyboard: Tab reaches everything; Enter sends; Shift+Enter = newline
- [ ] TypeScript with no `any` and no `@ts-ignore`
- [ ] Imports only `react`, `@chatpack/client...`, `lib/chat-client`,
      `lib/chat-theme`, and its own primitives
- [ ] Spec card comment at the top of the file; README beside it

---

## Part 6 — Prompts to paste into your AI builder

Builders lose the rules over a long session. Re-paste these.

### Project setup prompt (paste once, at the start)

> I'm building copy-paste chat UI components on top of the `@chatpack/client`
> npm package (v0.2.0+). Follow these rules exactly — they override your
> defaults.
>
> **Data:** ONLY from `@chatpack/client`, imported from my
> `lib/chat-client.ts`. Never write `fetch()` to a chat URL. Never invent a
> hook, method, or field.
>
> **The complete API — nothing else exists.**
> Hooks (all on `chatClient`, all returning
> `{ data, error, isPending, isRefetching, refetch }` unless noted):
> `useConversations()`, `useConversation({conversationId})`,
> `useMessages({conversationId, limit})` (also returns `loadMore()`),
> `useRealtimeStatus()` → `{status, error}`,
> `useTyping({conversationId})` → `{senderId, at} | null`,
> `usePresence({userIds})`, `useReceipts({conversationId})`.
> Actions (all return `{data, error}`, never throw):
> `conversations.create({otherUserId})`,
> `conversations.markRead({conversationId, messageId})`,
> `messages.send({conversationId, body})`, `messages.edit({messageId, body})`,
> `messages.delete({messageId})`, `typing.start({conversationId})`,
> `realtime.subscribe(cb)`.
>
> **Data shapes — these fields and no others.**
> Conversation: `id, pairKey, createdAt, metadata, participants[2],
unreadCount`. Message: `id, conversationId, senderId, body, role, seq,
metadata, createdAt, editedAt, deletedAt`. Participant:
> `conversationId, userId, joinedAt, lastReadMessageId`.
> There is NO `lastMessage`, NO `updatedAt`, NO user object, NO `name`, NO
> `avatar`. Message text is `body` — never `text` or `content`.
>
> **Chat behavior:** message lists are NEWEST-first (reverse to display);
> `loadMore()` loads OLDER messages; deleted messages are tombstones
> (`deletedAt` set, empty `body`) and must render as "message deleted", not be
> filtered out; unread counts come from `conversation.unreadCount`, never
> counted client-side; own messages = `senderId === currentUserId`. The
> conversation list live-updates by itself — never add a subscribe+refetch
> loop.
>
> **Users have no profiles.** A user is an opaque ID string. Every component
> displaying a person takes `renderUser?: (userId: string) => ReactNode`,
> defaulting to the raw ID. Never fake names or avatars.
>
> **Scope:** 1:1 conversations only, exactly 2 participants. No group chat.
>
> **Style:** React function components, TypeScript (no `any`), Tailwind classes
> only, using tokens from `lib/chat-theme.ts`. Light and dark mode.
> Accessible: real buttons, labelled inputs, focus rings, `aria-live` on
> message lists and typing indicators.
>
> **Self-contained:** one file per component, importing only from `react`,
> `@chatpack/client...`, `lib/chat-client`, `lib/chat-theme`, and its own
> primitives.
>
> If you're unsure whether something exists in the API, it doesn't — ask me
> instead of guessing.

### Per-component prompt (fill in the blanks)

> Build `<NAME>`, a tier-`<0/1/2/3/4>` `<primitive|component|block>`.
>
> **Does:** `<one sentence>`
> **Props:** `<list>`
> **Chatpack hooks/actions it may use:** `<from the API list, or "none">`
> **Composes these existing primitives:** `<list, or "none">`
> **Must handle:** pending (skeleton), error (with `error.code` + retry),
> empty, long content.
>
> Follow all the project rules I gave you. Put a spec-card comment at the top.
> Use only the API surface from those rules — invent nothing.

### Recovery prompt (when it starts hallucinating)

> Stop. You used something that doesn't exist in `@chatpack/client`. The
> complete API is the hooks and actions I listed earlier — nothing else.
> Re-read those rules, find every invented hook, method, or field in the file
> you just wrote, and fix them. Message text is `body`. There is no user
> object, no `lastMessage`.

---

## Troubleshooting

| What you see                                        | What it means                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `data` is `null`, `error.code` is `UNAUTHENTICATED` | Your `basePath` is malformed. It must be exactly `/api/chat/u/<sandbox>/<userId>` — lowercase letters, digits, dashes only. |
| Empty conversation list                             | Wrong user in `basePath`. Seed data belongs to `alice`, `bob`, `carol`.                                                     |
| `NETWORK_ERROR`                                     | Check `baseURL` is exactly `https://demo-api.chatpack.dev` (https, no trailing slash).                                      |
| Messages send but the other window doesn't update   | Both windows must use the **same sandbox** and different users.                                                             |
| The list doesn't reorder on new messages            | You're on `@chatpack/client` 0.1.x — upgrade to 0.2.0+.                                                                     |
| Your messages vanished                              | The demo backend restarted and reseeded. Expected — not your bug.                                                           |
| `FORBIDDEN_READ` / `403`                            | That user isn't in that conversation. `carol` can't read alice↔bob.                                                         |
| Compile error on an invented method                 | Your builder hallucinated. Paste the **Recovery prompt** above.                                                             |

**Reference links** (for you, and for pasting at your builder):

- Everything about Chatpack in one file: <https://docs.chatpack.dev/llms-full.txt>
- Client docs: <https://docs.chatpack.dev/docs/client/overview>
- The demo backend, self-documenting: <https://demo-api.chatpack.dev>

## Handing it back

Deliver the folder structure from Part 5 — either as a GitHub export from your
builder, or as a zip. We review each piece against its definition-of-done
checklist, then wire the catalog into the docs site. You don't touch the docs
site yourself.

If you hit something in a design that Chatpack genuinely can't do (a
last-message preview, a group chat, read-by-name), **write it down as a
limitation** and move on. Do not invent a field to fill the gap — that's the
one thing that makes a component unusable to the developers copying it.
