# ADR 0020: Public channels

- **Status:** accepted
- **Date:** 2026-08-09
- **Milestone:** v1.next (groups, part 3)

## Context

ADR 0017 shipped groups and ADR 0019 shipped the two ways into one: a link, or
a request an admin resolves. Both share a precondition that has been invisible
until now because nothing violated it - **you have to already know the group
exists.** An invite arrives out of band; `requestToJoin` needs a conversation
id you were told. Every group in Chatpack is, in the strict sense, unlisted.

That is the whole of what is missing for the last item on the deferred
group-follow-up list. A public channel is not a new kind of conversation with
new mechanics; it is an existing group that a user can **find without being
told about it**. `#general`, a support room linked from a docs page, a
community channel in a sidebar - all of them are the group machinery that
already ships, plus discovery.

The code says as much. `requestToJoin` carries this comment:

> No permission check by design: asking is not entering, and an admin decides
> (ADR 0019). Gate discoverability above Chatpack if group ids should not be
> guessable.

This ADR moves that line. Discovery becomes Chatpack's job for conversations
that opt into it, and stays the application's job for every conversation that
doesn't.

Questions this ADR settles:

1. Is a channel a third `ConversationType`, or a property of a group?
2. May a non-member read a public channel before joining?
3. Who decides whether joining is instant, and where does that decision live?
4. Does the directory become a required adapter method?
5. How does this compose with per-link `requiresApproval` from ADR 0019?

## Decision

### 1. A channel is a group with `visibility: "public"`

`ConversationType` stays `"direct" | "group"`. `Conversation` gains two fields:

```ts
/** Whether a conversation can be found by people who are not in it. */
type ChannelVisibility = "private" | "public";
/** How a non-member gets in, once they have found it. */
type ChannelJoinPolicy = "open" | "approval";

interface Conversation {
  type: ConversationType; // unchanged: "direct" | "group"
  visibility: ChannelVisibility; // NEW, default "private"
  joinPolicy: ChannelJoinPolicy; // NEW, default "approval"
  // ...everything else unchanged
}
```

There is no `Channel` type, no `createChannel`, and no `"channel"` variant.
"Channel" is vocabulary for a group whose `visibility` is `"public"`; the docs
use the word, the type system does not.

**Why not a third `ConversationType`.** It reads better in isolation and it is
wrong in three concrete ways:

1. **`requireGroup` is a single chokepoint that every group operation funnels
   through** - membership, roles, rename, all eight invite/join-request
   methods. A third type means every one of those call sites has to decide
   whether it means "group" or "group-like", and the failure mode of getting it
   wrong is a channel that silently cannot be renamed or invited to. The
   `visibility` field passes all of them unchanged, because a channel _is_ a
   group.
2. **Unknown enum values are coerced, not preserved.** The Drizzle adapter's
   `toConversation` maps anything that is not `"group"` to `"direct"` on
   purpose (a row written by an older version reads as the safe default rather
   than widening the domain type). A `"channel"` row read by a
   slightly-older adapter build would come back as a **DM** - a two-person
   shape claiming to hold two hundred people. A new column read by old code is
   simply absent, and absent means `"private"`, which is the safe direction.
3. **It would fork the feature surface.** Reactions, replies, search,
   attachments, read-state, unread counts, the five group mutations and the
   eight invite routes all work on groups today. Under `visibility` they work
   on channels on day one with no new code. Under a third type, each one is a
   question.

The honest cost: `visibility` and `joinPolicy` are meaningful on groups and
meaningless on DMs, where they are pinned to `"private"` / `"approval"` and
core refuses to change them (`NOT_GROUP_CONVERSATION`). Two inert fields on
every DM row is the price of not forking the type. It is the same shape
`name` already has - nullable, group-only, present on every row.

### 2. Discovery only. Reading a channel still requires joining

The directory returns a **`ChannelPreview`**, never a `Conversation` and never
a message:

```ts
interface ChannelPreview {
  conversationId: string;
  name: string | null;
  participantCount: number;
  joinPolicy: ChannelJoinPolicy;
  createdAt: Date;
  metadata: Metadata;
  /** `true` when the caller is already in - render "Open", not "Join". */
  alreadyParticipant: boolean;
  /** `true` when the caller has an unresolved request (approval channels). */
  requestPending: boolean;
}
```

This is ADR 0019 §10's `InvitePreview` reasoning applied to a route that is
reachable by definition rather than by holding a secret: a count answers "is
this the right room, and is anyone in it?" without naming a single member.
Returning the conversation would hand every participant's user id to any
authenticated user who lists the directory. `metadata` is included because it
is where an app puts the topic and the icon it needs to render a browse list -
and it is developer-written, so it never contains anything Chatpack put there.

**The entire permission layer is untouched.** `canRead` stays a membership
test, so:

- Message history is invisible until you join. Joining an open channel is one
  call, so "preview the conversation" is not a feature the directory needs to
  simulate.
- Search stays participant-scoped (ADR 0015) with no new "should non-members
  match public channels?" question.
- `markRead`'s participant-only rule holds - non-participants have no
  read-state, and inventing one for a browser would put a row in the
  participants table for someone who never joined.
- SSE fan-out is unchanged: `recipientIds` is still the participant list, so
  nobody subscribes to a channel they are not in.

Public _readability_ - Slack-style "read before you join" - is a strictly
larger feature that touches all four of those, and it is deliberately **not**
in this ADR. A later ADR can add it; nothing here forecloses it.

### 3. The join policy lives on the conversation, and it is per-conversation

`joinPolicy: "open"` means any authenticated user who can see the channel may
join it, instantly. `joinPolicy: "approval"` means joining creates a pending
`JoinRequest` for an admin, using the ADR 0019 queue unchanged.

This is the one place this ADR revisits a decision ADR 0019 argued
explicitly. §4 there put `requiresApproval` on the **invite** and rejected a
column on `conversations`, reasoning that policy is per-link in practice ("one
no-approval link for the team, one approval-gated link for a public page") and
that a column would force a single policy per group.

That reasoning was right about invites and does not transfer, because a
directory join **has no link to carry the policy**. The user arrives at the
channel from a list, not from something an admin minted with intent. Somebody
still has to answer "may this stranger walk in?", and with no invite in the
picture the conversation is the only thing left to ask. Both decisions are the
same underlying rule: _the policy lives on whatever the joiner presents._
Present a link, the link decides; present nothing, the channel decides.

So the two compose without ambiguity, and the resolution is worth stating
because it is the first question an implementer will have:

| The joiner has...        | Policy that applies              |
| ------------------------ | -------------------------------- |
| an invite code           | that invite's `requiresApproval` |
| only the conversation id | that channel's `joinPolicy`      |

An invite therefore still overrides the channel: an admin minting a
no-approval link for an `approval` channel is deliberately vouching for
whoever holds it, which is exactly what minting a link means. The inverse also
holds - an approval-gated link into an `open` channel routes through the queue,
because the admin who made that link asked for review.

**The default is `"approval"`, not `"open"`.** Defaults decide what happens to
the developer who sets `visibility: "public"` without reading further, and
between "a stranger is now in the room" and "a stranger is now in a queue",
only one of those is recoverable. Note `joinPolicy` is inert while
`visibility` is `"private"` - a private group with `joinPolicy: "open"` is not
joinable by strangers, because they cannot discover it and `requestToJoin`
still gates on the invite capability. Setting it is arming, not opening.

### 4. `visibility` and `joinPolicy` are columns; the directory is an optional capability

The two are split on purpose, and the split is what keeps this
non-breaking.

**The columns ride the existing required contract.**
`CreateGroupConversationInput` and `UpdateConversationInput` gain
`visibility` and `joinPolicy`, always fully resolved by core (never
`undefined`). Adding a field to an input object is not a new method: the
required contract stays at **nineteen**.

**The directory is a new optional namespace**, following the precedent ADR
0019 §2 set for exactly this:

```ts
interface ChannelStorage {
  /** Public conversations, most-recently-active first. Never participant-scoped. */
  listPublicConversations(
    input: ListPublicConversationsInput,
  ): Promise<ListPublicConversationsResult>;
}

interface StorageAdapter {
  channels?: ChannelStorage; // absent → CHANNELS_UNSUPPORTED (501)
}
```

One method, so "why a namespace rather than an optional method?" needs an
answer: because the namespace is what makes the _columns_ safe. A custom
adapter that ignores the two new input fields would otherwise accept
`visibility: "public"`, persist nothing, and return a conversation that says
`"private"` - a silent downgrade of a security-relevant setting, which is the
worst failure mode available. So **core refuses to set a non-default
`visibility` or `joinPolicy` at all unless `storage.channels` is present**, and
answers `CHANNELS_UNSUPPORTED` (501) instead. One capability check gates the
whole feature: the directory route, the join route, and the two fields. An
adapter either does channels or cannot be asked to pretend.

That also means the namespace has room to grow (name filtering, a
`countPublicConversations` for pagination UIs) without another capability
check, which is the second reason it is a namespace on arrival.

`listPublicConversations` returns full `Conversation` rows and **core**
narrows them to `ChannelPreview`. The alternative - a thin adapter-side
projection - saves one column read on a page of 50 rows and costs every
adapter author the chance to derive `participantCount` differently. Core owns
the shape that non-members see, the same way it owns `InvitePreview`.

Ordering is **most-recently-active first, with an opaque adapter-defined
cursor** - identical to `listConversations`, so an adapter reuses its keyset
pagination and clients reuse their paging code. Not sorted by member count: a
"biggest channels" sort is a product opinion, and `lastActivityAt` is the one
ordering the schema already indexes. There is deliberately **no name search or
filter** in v1; message search took an ADR of its own to get matching
semantics right (ADR 0015) and a channel-name filter would re-open every one
of those questions for a list most apps render whole.

### 5. Two new api methods and two new routes

`chat.api` grows by two: `listPublicConversations` and `joinConversation`.

| Method | Path                      | Body / query   | Who               |
| ------ | ------------------------- | -------------- | ----------------- |
| GET    | `/channels?limit&cursor`  | -              | any authenticated |
| POST   | `/conversations/:id/join` | `{ message? }` | any authenticated |

`GET /channels` is the directory. It is authenticated like every other route
(the auth hook runs before routing - `llms.txt` hard rules); "public" means
"discoverable by your users", not "anonymous". It is mounted at `/channels`
rather than `/conversations/public` because it does not return conversations -
it returns previews, and hanging a different shape off the `/conversations`
prefix invites clients to assume otherwise.

`POST /conversations/:id/join` is self-service entry, and its result is
discriminated exactly like `acceptInvite`'s:

```ts
type JoinConversationResult =
  | { status: "joined"; conversation: ConversationWithUnread; joinRequest: null }
  | { status: "pending"; conversation: null; joinRequest: JoinRequest };
```

Reusing that shape is the point: a client that already handles redeeming a
link handles joining a channel with the same branch.

The two policies map onto machinery that already exists, which is why this
feature is small:

- `"open"` → `admitToGroup`, the shared tail of `acceptInvite` and an approved
  `resolveJoinRequest`. Cap-checks, adds the participant, publishes
  `participant.added`.
- `"approval"` → the same body as `requestToJoin`, including its idempotency
  (re-asking while pending returns the existing row rather than bumping
  yourself up a newest-first moderation queue).

Joining a channel you are already in throws `ALREADY_PARTICIPANT` (409),
following ADR 0019 §5: there is no truthful "you joined" value to return, and
unlike a replayed invite redemption there is no link whose use we are
protecting. A client that wants "Open" instead of "Join" has
`alreadyParticipant` on the preview.

`visibility` and `joinPolicy` are set at creation via
`POST /conversations/group` and changed afterwards via the existing
`PATCH /conversations/:id`, which is why there is no third route. That means
`PATCH` accepts three independently-optional fields where it previously
required `name`; **`name` stays required when it is the only field present**,
so no existing caller changes behavior.

Flipping either field requires `canManage` - the same authority as renaming.
`canInvite` is deliberately **not** reused: ADR 0019 §8 delegates _minting a
link_ to members because the invitee still has to act, whereas making a
channel public exposes it to every user at once and is closer to
administering the group than to inviting one person. No fifth permission hook.

### 6. No new transport event types

`TransportEvent` stays a four-member union.

- Joining publishes the existing **`participant.added`**, exactly as
  `acceptInvite` and an approved request do.
- Flipping `visibility` or `joinPolicy` publishes the existing
  **`conversation.updated`** with empty `affectedUserIds`, exactly as a rename
  does. The event carries the full post-change conversation, so the new fields
  arrive with it for free.

Recipients are the current participants, which is the right audience even for
a channel becoming public: the people who need to know are the ones already
inside. Non-members cannot subscribe to a conversation they are not in, so
there is no "a channel appeared in the directory" event and the directory is
polled. Same reasoning as ADR 0019 §6 - `isConversationEvent` is a hardcoded
three-way check that `@chatpack/transport-redis` branches on to decide which
dates to revive, and that seam has already produced one cross-node data-loss
bug. A live badge for a browse list is not worth re-opening it.

### 7. New error codes

| Code                      | Status | When                                                   |
| ------------------------- | ------ | ------------------------------------------------------ |
| `CHANNELS_UNSUPPORTED`    | 501    | the adapter has no `channels` capability               |
| `NOT_PUBLIC_CONVERSATION` | 403    | self-joining a group whose `visibility` is `"private"` |

`NOT_PUBLIC_CONVERSATION` is 403 rather than 404. A private group is not a
secret from someone holding its id - `requestToJoin` has always answered
honestly for one, and ADR 0019 accepted guessable ids as the app's business.
Answering 404 would claim the conversation does not exist, which is a lie core
would then have to keep consistent with the other routes that do admit it
exists.

Reused unchanged: `NOT_GROUP_CONVERSATION` (a DM cannot be public - its
membership is fixed by `pairKey`), `ALREADY_PARTICIPANT`,
`GROUP_LIMIT_EXCEEDED` (a channel is still capped at
`MAX_GROUP_PARTICIPANTS`), `NOT_CONVERSATION_ADMIN`, `INVALID_INPUT`,
`CONVERSATION_NOT_FOUND`.

Note `joinConversation` on an `"approval"` channel needs the **invites**
capability, not just `channels`, because the queue it writes to is
`InviteStorage`. An adapter with `channels` and no `invites` therefore answers
`INVITES_UNSUPPORTED` for approval joins while open joins work - honest, and
the first-party adapters implement both.

## Consequences

- **Not breaking for custom adapters.** The required contract stays at
  nineteen methods. An adapter that ignores the two new input fields keeps
  working: core refuses to _ask_ it for a public channel (501), so the silent
  downgrade cannot happen. `llms.txt` Part 2 gains `channels` as a second
  opt-in capability section alongside `searchMessages` and `invites`.
- **Postgres deployments must run the migration again** for two new columns on
  `chatpack_conversations` plus one partial index. Unlike ADR 0019's pure table
  additions this touches an existing table, so it is closer to the ADR 0017
  migration - but both columns are `NOT NULL DEFAULT`, so existing rows
  backfill to `private`/`approval` without a rewrite of application code, and
  the statements stay idempotent.
- **`chat.api` grows by two methods** (`listPublicConversations`,
  `joinConversation`). The exhaustive lists in `CLAUDE.md`, `llms.txt` and the
  skill need updating again.
- **Every `Conversation` gains two fields**, including DMs. Clients that
  round-trip conversations through their own types will see them; nothing
  breaks if they are ignored.
- **`@chatpack/client` does not wrap this yet**, the same deliberate lag
  groups and invites both had. Hosts call `fetch` against the two routes. The
  unwrapped-surface list is now search (wrapped in PR #9), the eight invite
  routes, and these two. _(Closed in client 0.7.0: `chatClient.channels.list`
  and `chatClient.channels.join`, alongside the invite wrappers. The unwrapped
  list is empty.)_
- **Channel ids are guessable by design, and that is now load-bearing rather
  than merely tolerated.** The directory hands out ids to every authenticated
  user. `canRead` still gates the contents, so an id buys discovery and
  nothing else - but an app relying on "nobody knows this group's id" as a
  control must keep those groups `private`.
- **The 256-participant cap now binds a shape it was not sized for.** A public
  channel is the first conversation type where hitting
  `MAX_GROUP_PARTICIPANTS` is a plausible outcome of normal use rather than a
  misuse, and `ReactionSummary.userIds` (flagged in ADR 0017 as "fine for two
  participants and wrong for two hundred") gets there faster. Both stay as they
  are here; raising the cap is a separate decision with storage implications.
- **No telemetry counters were added.** The set stays at `messagesSent` and
  `conversationsCreated` (MVP §12).

## Alternatives considered

- **A third `ConversationType: "channel"`** - better vocabulary, but forks
  every `requireGroup` call site, and an unknown type value is coerced to
  `"direct"` by existing adapter code. See §1.
- **Non-members can read public channel history** - the Slack model, and a
  much larger feature: it changes the `canRead` default, re-opens search
  scoping for non-members, needs an exception in `markRead`, and asks whether
  non-members get SSE. Deferred, not foreclosed. See §2.
- **Public means always-joinable (no `joinPolicy`)** - one less field, and it
  makes a moderated public channel impossible without keeping it private and
  handing out approval-gated links, which is exactly the flow this ADR exists
  to remove. See §3.
- **Public means always-approval-gated** - safest, and it makes a genuinely
  open community channel impossible without an admin bottleneck on every
  arrival. See §3.
- **Reusing the invite's `requiresApproval` for directory joins** - no new
  field, but there is no invite in a directory join, so the policy would have
  to be read off some arbitrarily-chosen link. See §3.
- **`visibility` as a required part of the adapter contract, with no
  capability check** - fewer moving parts, but a custom adapter that ignores
  the field silently reports `"private"` for a channel the developer made
  public. Silent downgrade of a visibility setting is the worst available
  failure mode. See §4.
- **A `Channel` type with its own storage tables** - clean separation, and it
  duplicates participants, messages, read-state, reactions and search for a
  thing that is a group with a flag.
- **Adapter-side `ChannelPreview` projection** - saves reading a column per
  row, and lets each adapter derive `participantCount` its own way. See §4.
- **Sorting the directory by participant count** - the "biggest channels"
  browse list every product ships, but it is a product opinion, and
  `lastActivityAt` is what the schema already indexes. See §4.
- **Name search in the directory** - the obvious v2, and it re-opens every
  tokenization question ADR 0015 needed a full ADR to settle. See §4.
- **A `channel.created` / directory transport event** - a live browse list, at
  the cost of growing the union whose guard already caused one cross-node
  data-loss bug. See §6.
