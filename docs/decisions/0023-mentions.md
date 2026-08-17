# ADR 0023: Mentions

- **Status:** accepted
- **Date:** 2026-08-14
- **Milestone:** v1.next (tags & mentions)

## Context

Apps want to mark specific participants in a message so they can be
highlighted and notified - the `@name` affordance every chat product has.

Chatpack owns none of the parts a user actually sees. It has no users table
(MVP §8: user ids are opaque), so it cannot resolve `"@daniel"` to an id; and
ADR 0022 makes `Message.body` opaque text that core never parses, renders, or
sanitizes. Both of those rule out the obvious implementation before it starts.

What is left is the part only the backend can do, and it is the part apps get
wrong: deciding whether a mention is **legitimate**. A mention that names
someone who is not in the conversation is either a bug in the client's
autocomplete or an attempt to notify a stranger, and either way the server is
the only place that can tell.

Design questions this ADR settles:

1. Where do mentions come from - parsed from the body, or supplied?
2. What makes a mention valid, and what happens to an invalid one?
3. What happens to mentions when the body is edited?
4. Are mentions stored on the message row or beside it?
5. Do mentions affect unread counts, ordering, or the SSE contract?

## Decision

### 1. Mentions are supplied as ids, never parsed from the body

`sendMessage` and `editMessage` accept an explicit array of user ids:

```ts
chat.api.sendMessage({
  userId: "alice",
  conversationId: "c_1",
  body: "@bob can you review this?",
  mentions: ["bob"],
});
```

Core never inspects `body` to find them. This is ADR 0022 held to
consistently: the moment core parses `@bob` out of the text it owns a mention
syntax, an escaping rule for literal `@`, and a resolution step from display
name to user id - and it cannot do the last one at all without a users table.

The consequence is deliberate and worth stating plainly: **`body` and
`mentions` can disagree.** A client may send `mentions: ["bob"]` with a body
that never says "bob", or write "@bob" and pass no mentions. Chatpack
validates that the ids name participants; it does not validate that the text
agrees, because it cannot read the text. Rendering the highlight is the app's
job, and the app is the side that knows its own syntax.

### 2. A mention must name a participant of that conversation

Every id is checked against the conversation's current membership. A mention
of a non-participant fails the whole write with a new error code,
`MENTION_NOT_PARTICIPANT` (400).

Rejecting rather than silently dropping is the point of the feature. A
dropped mention is invisible: the sender sees their message delivered and
assumes the person was notified, and nothing anywhere says otherwise. This is
the same reasoning ADR 0020 used for `CHANNELS_UNSUPPORTED` - failing loudly
at the moment of writing beats a value that reads back wrong later.

The set is de-duplicated, and **self-mentions are allowed**: "note to self"
is a real use, and a rule against it would need a reason better than tidiness.

No explicit cap is needed on the number of mentions. Every mention must be a
participant, and groups already cap at `MAX_GROUP_PARTICIPANTS` (ADR 0017 §3),
so the membership check _is_ the bound - an `@all` expansion of a 256-person
group is legitimate and fits. `MAX_MENTIONS_PER_MESSAGE` exists anyway, set to
the same 256, purely as a cheap input guard so a hostile array is rejected
before core starts issuing membership lookups.

### 3. On edit, `mentions` replaces the set - and only new ids are validated

An edit's `mentions` array is the complete new set, not a delta. Omitting it
leaves the stored set untouched, so a client that edits a body without knowing
about mentions cannot silently erase them.

The subtle case, and the reason this section exists: **ids already stored on
the message are not re-validated.** Only ids new to this edit are checked
against membership.

Re-validating everything looks more correct and is worse. Mention Bob, Bob
leaves the group, then fix a typo in that message: a full re-check fails the
edit, and the only way to fix the typo is to drop a mention that was
legitimate when it was made. The sender cannot win that race, which is the
test ADR 0013 §1 already applied to replying to a deleted parent.

So a mention is validated once, when it is claimed, and then it is history. A
stored mention of someone who has since left stays on the message, and
`mentions` keeps reporting them - it records who was mentioned, not who is
currently in the room.

### 4. Mentions live in their own table, hydrated per request

A fifth table (`chatpack_message_mentions`), unique on
`(message_id, user_id)`, and two new adapter methods:
`setMessageMentions` (replace the set, used by both send and edit) and
`listMentionsByMessageIds` (batched hydration, one call per page).

`Message` stays the storage shape and gains nothing; the API shape
`MessageWithDetails` gains `mentions: string[]`, joining `replyTo` and
`reactions` as a per-request decoration (ADR 0013 §1, ADR 0009). The batched
call folds into the `Promise.all` that already hydrates those two, so a page
costs one additional query and a page with no mentions costs none.

A `text[]` column on the message row was the alternative and would have been
less code. It was rejected for what comes next rather than for anything
today: "messages that mention me" wants an index keyed by user id, and a
column that has to grow a GIN index to answer its main query is a table
wearing a disguise. A row per mention also makes the unique constraint the
de-duplication mechanism instead of application code.

### 5. Mentions change nothing about counting, ordering, or replay

A mention is part of a message, and the message is already the unit that
lights the badge. So `unreadCount` (ADR 0009) is untouched, `lastActivityAt`
and conversation ordering are untouched, and no new `seq` is allocated.

There is no new transport event. Mentions ride inside the
`MessageWithDetails` snapshot that `message.created` and `message.updated`
already carry, which means live frames, gap-filled replays (ADR 0006), and
fetched pages agree without the SSE contract changing at all.

Notification delivery is the host's, through the hook it already has:
`AfterMessageMutationContext` gains `mentions: string[]` alongside
`recipientIds`, so a push integration can tell "everyone in the room" from
"the two people actually named". Core sends nothing itself - push providers
remain out of scope.

## Consequences

- **Breaking for custom adapters:** the contract grows 19 → 21 methods
  (`setMessageMentions`, `listMentionsByMessageIds`). Pre-1.0 this is allowed
  (ADR 0001) and ships through a changeset; llms.txt Part 2, the skeleton
  adapter, and the verification checklist all gain the new methods. This
  follows ADR 0013's precedent of growing the required contract rather than
  ADR 0019's optional-namespace one: two methods with no graceful degradation
  do not justify a capability flag, and a mention that silently vanishes is
  exactly the failure a flag is supposed to prevent.
- **Postgres deployments need DDL:** one new table and its two indexes,
  appended to `migrationStatements` (and so to `migrationSql`). Pure
  addition - no column changes, no index swaps - so like invites, channels,
  and moderation, and unlike groups, it can be applied before deploying.
- **No new routes.** `mentions` is a field on the existing send and edit
  bodies (`POST /conversations/:id/messages`, `PATCH /messages/:id`). One new
  error code, `MENTION_NOT_PARTICIPANT` → 400.
- **`body` and `mentions` are independent, forever.** Apps that want them to
  agree must keep them in step themselves. This is the cost of ADR 0022 and it
  is charged here rather than hidden.
- **"Messages that mention me" is not shipped.** No mention inbox, no
  per-conversation mention count, no "unread mentions" badge. The table is
  shaped so all three are additive later (index on `user_id`), and the
  notification path apps actually asked for is already served by the
  `afterMessageMutation` hook. Shipping a second unread axis would mean a
  second read-state per user per conversation, which is a bigger decision than
  this ADR.
- **Forwards start with no mentions** (ADR 0024). A forwarded body may still
  read "@bob", but the stored set does not travel: its ids were validated
  against the source conversation's membership, and re-validating them against
  the target would fail for exactly the participants who are not in both.
