---
"@chatpack/core": minor
"@chatpack/adapter-memory": minor
"@chatpack/adapter-drizzle": minor
"@chatpack/client": patch
---

Public channels (ADR 0020): a browsable directory of public groups, with
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
