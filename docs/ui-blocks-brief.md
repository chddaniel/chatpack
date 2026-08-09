# Chatpack UI blocks — the brief

You're building copy-paste chat UI — a conversation sidebar, a message thread, a composer, and a few looks for each. Like shadcn/ui, but for chat: a developer browses our docs, copies one, pastes it, done.

You work entirely inside an AI builder (Shipper.now, Lovable, v0, Bolt). Nothing to install, no server, no database — we run the backend.

**You never write code.** Boxes starting with `>` are prompts: copy, paste into your builder, send. The line under each says what you should see — checking it is the job. One prompt at a time.

## 1. Setup (~10 min, once)

Start a new **React** project, then paste this. First change `chatpack-blocks` to a name of your own (lowercase, digits, dashes) — that's your private corner of the demo backend.

> I'm building copy-paste chat UI on top of the npm package `@chatpack/client`. Foundation only — no UI yet.
>
> 1. Install `@chatpack/client` **0.3.0 or newer** (0.3.0 is the first with reactions and quote-replies; I need both).
> 2. Tailwind CSS working, dark mode on, `class` strategy.
> 3. Create `lib/chat-client.ts` with exactly this:
>
> ```ts
> import { createChatClient } from "@chatpack/client/react";
> import { typingClient, presenceClient, receiptsClient } from "@chatpack/client/plugins";
>
> const SANDBOX = "chatpack-blocks";
>
> // ?user=bob in the URL switches user. Anything unrecognised falls back to
> // alice, so a typo can never build a broken address.
> function readUserId(): "alice" | "bob" | "carol" {
>   if (typeof window === "undefined") return "alice";
>   const u = new URLSearchParams(window.location.search).get("user");
>   return u === "bob" || u === "carol" ? u : "alice";
> }
>
> export const currentUserId = readUserId();
>
> // ONE client for the whole app. Module scope — never inside a component.
> export const chatClient = createChatClient({
>   baseURL: "https://demo-api.chatpack.dev",
>   basePath: `/api/chat/u/${SANDBOX}/${currentUserId}`,
>   userId: currentUserId,
>   plugins: [typingClient(), presenceClient(), receiptsClient()],
> });
> ```
>
> Exactly as written: client at module scope, only one in the project, no options added, renamed, reordered or improved. Everything I ask for later imports from this file.
>
> Reply with the version you installed and confirm the file matches. If you changed anything, say what and why.

**Should see:** a version `0.3` or higher, "exactly as given". Older → _"Too old. Install `@chatpack/client@latest` and tell me the version."_ Changed the file → _"Put it back to exactly what I gave you, character for character — it's correct for this package."_

Now check the connection before building anything:

> Create a page at `/test` rendering this and nothing else:
>
> ```tsx
> "use client";
> import { chatClient, currentUserId } from "@/lib/chat-client";
> export default function Test() {
>   const c = chatClient.useConversations();
>   return (
>     <pre>
>       {currentUserId}: {JSON.stringify(c.data, null, 2)}
>     </pre>
>   );
> }
> ```
>
> Open it and paste back exactly what appears. If it shows `null`, an empty list or an error, **do not try to fix it** — no `fetch`, no URL changes, no proxy, no API route, no new packages. Just tell me the error code plus the exact `baseURL` and `basePath` used.

**Should see:** ugly raw data with two conversations (alice↔bob, alice↔carol). Anything else → the table at the bottom. Don't build on a broken connection; you'll debug components for hours over one wrong character in a URL.

**Test with two people.** Open the preview in one window, and the same URL with `?user=bob` in a second. Type in one, watch the other — that's how you check typing dots, instant delivery and unread badges. **Do this on every piece before calling it finished**; it's the only way to catch what looks perfect sitting still and breaks the moment two people use it.

Your sandbox is pre-filled so you never design against a blank screen: alice↔bob (a short chat plus one edited message, one deleted, one with reactions — 👍 from two people, 🎉 from one — and one quote-reply), alice↔carol, and a three-person Design team group. If the backend sleeps it wakes with that same data, so vanishing test messages are expected.

## 2. The rules

**Paste this before asking for a single component**, and again whenever things drift. It's long, blunt and repetitive on purpose — it's written for a machine, and the repetition is what stops it inventing an API. Paste it exactly.

> I'm building copy-paste chat UI components on top of the `@chatpack/client` npm package (v0.3.0+). Follow these rules exactly — they override your defaults.
>
> **Data:** ONLY from `@chatpack/client`, imported from my `lib/chat-client.ts`. Never write `fetch()` to a chat URL. Never invent a hook, method, or field.
>
> **The complete API — nothing else exists.** Hooks (all on `chatClient`, all returning `{data, error, isPending, isRefetching, refetch}` unless noted): `useConversations()` → `data.conversations`, `data.nextCursor`; `useConversation({conversationId})`; `useMessages({conversationId, limit})` → `data.messages`, also returns `loadMore()`; `useRealtimeStatus()` → `{status, error}`, no `data` wrapper; `useTyping({conversationId})` → `{senderId, at} | null`, no `data` wrapper; `usePresence({userIds})` → `Record<userId, {online, lastSeenAt}>`, where a user nobody has seen online is **missing from the object entirely** — read it as `presence[userId]?.online`, never `presence[userId].online`, and treat missing as offline (`lastSeenAt` can also be `null`); `useReceipts({conversationId})` → `{deliveredSeq?, readMessageId?} | null`.
> Actions (all return `{data, error}`, never throw — always check `error`): `conversations.create({otherUserId})`, `conversations.markRead({conversationId, messageId})`, `messages.send({conversationId, body, replyToMessageId?})`, `messages.edit({messageId, body})`, `messages.delete({messageId})`, `messages.react({messageId, emoji})`, `messages.unreact({messageId, emoji})`, `typing.start({conversationId})` (max once per ~3s), `typing.stop({conversationId})` (call it right after a send, so the dots clear immediately instead of lingering the full ~5s), `realtime.subscribe(cb)`.
> There is NO `useReactions` hook — reactions are a field on the message.
>
> **Data shapes — these fields and no others.** Conversation: `id, type, pairKey, name, createdAt, metadata, participants[2], unreadCount`. Message: `id, conversationId, senderId, body, role, seq, metadata, createdAt, editedAt, deletedAt, reactions, replyToMessageId, replyTo`. Participant: `conversationId, userId, role, joinedAt, lastReadMessageId`.
> `type` is `"direct" | "group"` and `name` is `string | null` (always null for a DM, so don't render it as a title — that's what `renderUser` is for). Participant `role` is `"admin" | "member"`; both people in a DM are `admin`, so it tells you nothing in a 1:1 and no block should branch on it.
> A `reactions` entry is `{emoji, count, userIds}` — one per distinct emoji, NOT per person; `userIds` is earliest-first and its length always equals `count`; there is NO `isMine`/`reactedByMe` (compute it with `userIds.includes(currentUserId)`). `replyTo` is read-only, `{id, senderId, excerpt, deleted}` — a 140-char preview with no parent `body`; when the parent is deleted, `deleted` is true and `excerpt` is empty. To send a reply you pass `replyToMessageId` (a string id), never a `replyTo` object.
> There is NO `lastMessage`, NO `updatedAt`, NO user object, NO `avatar`, and no user-facing `name` on a person — the conversation `name` above is a group title, never a display name. Message text is `body` — never `text` or `content`.
>
> **Chat behavior:** message lists are NEWEST-first (reverse to display); `loadMore()` loads OLDER messages; deleted messages come back with `deletedAt` set and an empty `body` and must render as "message deleted", never be filtered out; unread counts come from `conversation.unreadCount`, never counted client-side; own messages = `senderId === currentUserId`; `role` may be `"assistant"` (style it like the other person's); the typing indicator expires itself (~5s → `null`). Never write reconnection logic — reconnects and catch-up are automatic; `useRealtimeStatus()` is only for a subtle "reconnecting…" hint. The conversation list live-updates itself — never add a subscribe+refetch loop. Reactions also live-update and are already applied to what `useMessages` returns — never mirror reactions into `useState`, never subscribe to reaction events by hand. `react`/`unreact` are safe to call repeatedly, so a toggle never checks server state first.
>
> **Users have no profiles.** A user is an opaque ID string. Every component displaying a person takes `renderUser?: (userId: string) => ReactNode`, defaulting to the raw ID. Never fake names or avatars.
>
> **Scope:** build for 1:1 conversations only — assume exactly 2 participants. The seeded Design team group exercises Chatpack's group data but is outside this batch: filter conversation lists to `conversation.type === "direct"` before rendering, and never auto-select the group. Group blocks are a later batch, so don't build member lists, admin controls, or a rename UI. Two consequences to respect anyway: get "the other person" from `participants.find(p => p.userId !== currentUserId)`, never `participants[1]`, and don't hardcode `participants.length === 2` as a validity check.
>
> **Style:** React function components, TypeScript (no `any`), Tailwind only, tokens from `lib/chat-theme.ts`, light and dark mode. Accessible: real buttons, labelled inputs, focus rings, `aria-live` on message lists and typing indicators.
>
> **Self-contained:** one file per component, importing only `react`, `@chatpack/client...`, `lib/chat-client`, `lib/chat-theme`, and its own primitives.
>
> `currentUserId` is read from the browser URL, so anything displaying it must render only after mount — otherwise server-rendered markup disagrees with the browser.
>
> If you're unsure whether something exists in the API, it doesn't — ask me instead of guessing.

**When it drifts, you'll see it on screen:** a name you never typed ("Sarah Chen") or a stock avatar — both invented; messages that appear in your window but never the other one — it hand-wrote a request; an "add someone" button — it forgot 1:1; a new `utils.ts` — it forgot self-contained; Tab getting stuck or skipping a control — it forgot accessibility. Re-paste the rules, then: _"List any file you've already written that breaks these, and how. Don't fix them yet."_

**And make it check what you can't see.** After finishing any component:

> Audit the file you just wrote against my rules. Don't fix anything — report, then wait. (1) Search for `fetch(` — matches or "none". (2) Search for `lastMessage`, `.name`, `.avatar`, `.text`, `.content`, `.isMine`, `.reactedByMe`, `useReactions` — for each, does it touch Chatpack data? Any that do are invented. (3) List every field you read off a Chatpack conversation, message or participant. (4) List every import. (5) Any `any` or `@ts-ignore`? (6) Does it handle loading, error (with `error.code` + retry), empty, and very long content?

**Should see:** "none" for `fetch`, no invented fields, imports limited to those four sources, no `any`, four states handled. Otherwise: fix, re-audit.

**Two limits to design around, not around:** the sidebar **can't** preview the last message (no such field), and reactions are the one thing not caught up after a reconnect — they arrive on the next fetch, so never show "reacted 2s ago". Hit a limit like these? Write it in the component's README. Never invent a field to fill the gap — that's the one change that makes a component useless to whoever copies it.

## 3. What to build

Bottom-up: theme → a few primitives → the connected piece that needs them → the block composing those → variants. Never start a block before its primitives exist, and check each layer in two windows before climbing.

**Theme first** — this is what makes twenty components look like one library and lets a developer reskin everything from one file:

> Create `lib/chat-theme.ts` with exactly this and nothing else:
>
> ```ts
> export const chatTheme = {
>   surface: "bg-white dark:bg-zinc-950",
>   panel: "bg-zinc-50 dark:bg-zinc-900",
>   border: "border-zinc-200 dark:border-zinc-800",
>   textPrimary: "text-zinc-900 dark:text-zinc-50",
>   textMuted: "text-zinc-500 dark:text-zinc-400",
>   bubbleOwn: "bg-blue-600 text-white",
>   bubbleOther: "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50",
>   badge: "bg-blue-600 text-white",
>   focus: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
>   radius: "rounded-2xl",
> };
> ```
>
> Every component from now on takes its colours, borders, radius and focus ring from here. Never hard-code a colour class in a component.

**Primitives** (props only, no data fetching): `UserAvatar` (initials from the ID, no photo by default) · `MessageBubble` (handles deleted + "edited") · `Timestamp` · `UnreadBadge` (nothing at 0, caps at "99+") · `PresenceDot` · `ReadReceiptTicks` (✓ sent, ✓✓ read) · `ReactionPill` (pressed-in when yours; knows nothing about the backend — whoever uses it decides what clicking does) · `ReplyQuoteBar` (italic "message deleted" when the original's gone) · `EmptyState` · `LoadingSkeleton` · `ErrorNotice`.

**Connected** (one hook each, all four states): `ConversationRow` · `TypingIndicator` · `ConnectionStatus` (invisible when all's well) · `MessageComposer` (Enter sends, Shift+Enter newline) · `MessageActionsMenu` (edit/delete only your own; Reply works on anyone's, deleted included) · `MessageReactions` (pills + an "add" button; just the button when empty) · `EmojiPicker` (6–8 hard-coded emoji — do **not** install an emoji-picker package) · `PresenceIndicator`.

**Blocks** — the headline pieces: **`ConversationList`** (unread badges, selection, presence dots; live updates are free, write no refresh logic) · **`MessageThread`** (day separators, own/other bubbles, deleted placeholders, reaction pills below, quote bars above, "load older", auto-scroll, marks read as seen) · **`ChatComposerBar`** (typing signal, disabled-while-sending, char count, dismissible "replying to…" that clears after a send) · **`ChatWindow`** (thread + composer + typing + connection hint) · **`FullChatLayout`** (sidebar beside window; on mobile the sidebar becomes a back button).

**Variants**, once the blocks are solid: `CompactChatList` (avatar-only rail) · `BubbleThread` vs `FlatThread` (rounded vs Slack-style rows) · `FloatingChatWidget` · `InboxLayout` (three-column) · `MobileChatSheet`.

## 4. Delivering

Ask for one piece at a time:

> Build `<NAME>`, a tier-`<0/1/2/3/4>` `<primitive|component|block>`. **Does:** `<one sentence>`. **Props:** `<list>`. **May use:** `<hooks/actions from the API list, or "none">`. **Composes:** `<existing primitives, or "none">`. **Must handle:** loading (skeleton shaped like the real content), error (`error.code` + retry), empty, and long content (a 500-char word, a very long user ID).
>
> Follow all the project rules — invent nothing. Put a comment at the top with name, tier, hooks used, primitives composed, props, states, and any limitation. Add a README.md beside it: what it does in one sentence, its props, what else to copy (its primitives plus `lib/chat-theme.ts`), any limitation, and a paste-in usage snippet.
>
> Then show me each of the four states, with temporary buttons to force them and a note on how — we'll delete that switch before it ships.

Layout, set once: _"Organise as `blocks/<name>/{<name>.tsx,README.md}`, `primitives/<name>/{...}`, `lib/{chat-client.ts,chat-theme.ts}`. One component per folder with its own README. Never two components in one file, never a shared utils/helpers file."_

**Done means:** verified live in two windows both ways · a reaction added in window A appears in B with no reload, clicking your own removes it, double-clicking fast doesn't make the count 2 · a reply to a deleted message shows "message deleted", not a blank · all four states seen and styled · light and dark · Tab reaches everything, Enter sends, Shift+Enter newlines · no invented names or avatars on screen · audit prompt clean · spec comment and README in place.

**When it invents something** (an error naming a property, or a name/avatar you didn't ask for):

> Stop. You used something that doesn't exist in `@chatpack/client`. The complete API is the hooks and actions I listed earlier — nothing else. Re-read those rules, find every invented hook, method or field in the file you just wrote, and fix them. Message text is `body`. There is no user object, no `lastMessage`, no `useReactions` hook, and no `isMine` on a reaction.

## When something goes wrong

| What you see                                      | What it means                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`, nothing comes back             | Typo in the address. Ask for the exact `basePath` — must be `/api/chat/u/your-sandbox/alice`, lowercase/digits/dashes |
| Empty conversation list                           | Right sandbox, wrong user — only `alice`, `bob`, `carol` have conversations                                           |
| `NETWORK_ERROR`                                   | `baseURL` must be exactly `https://demo-api.chatpack.dev` — https, no trailing slash                                  |
| `?user=bob` doesn't switch user                   | Reload from scratch; adding it to an open page won't work. Still alice → `lib/chat-client.ts` got changed             |
| A "hydration" / "text did not match" warning      | Something showing the user rendered on the server, where the URL isn't known. It must render only after mount         |
| Sends work, other window doesn't move             | Same sandbox, different people                                                                                        |
| Sidebar doesn't reorder; `messages.react` missing | Old package. Install `@chatpack/client@latest` and ask which version it got (reactions need 0.3.0+)                   |
| Reaction count jumps to 2 on a double-click       | It's keeping reactions in its own state. _"Delete that state and render `message.reactions` from the hook."_          |
| A reaction added elsewhere didn't appear          | Not caught up after a reconnect. Expected — the next fetch has it                                                     |
| `INVALID_INPUT` on a reaction                     | Emoji empty, or longer than 32 characters                                                                             |
| "Cannot read properties of undefined" on presence | A user nobody's seen online isn't in the object. _"Use `presence[userId]?.online` and treat missing as offline."_     |
| `MESSAGE_NOT_FOUND` on a reply                    | Replying across conversations; replies work only inside one                                                           |
| `FORBIDDEN_READ` / 403                            | That person isn't in that conversation — carol can't read alice↔bob                                                   |
| Test messages vanished                            | Backend restarted and reseeded. Expected                                                                              |
| Won't compile, error names a function             | It hallucinated. Paste the recovery prompt above                                                                      |

**Look things up:** <https://docs.chatpack.dev/llms-full.txt> (everything in one file) · <https://docs.chatpack.dev/docs/client/overview> · <https://demo-api.chatpack.dev> (the demo backend documents itself).

**Handing back:** export to GitHub or zip, laid out as above. We review each piece against the checklist and wire the gallery into the docs site — you don't touch that. If a design wants something Chatpack can't do, write it down as a limitation and tell us.
