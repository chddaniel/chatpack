# ADR 0017: Group conversations

- **Status:** accepted
- **Date:** 2026-08-05
- **Milestone:** v1.next (groups)
- Amended: 2026-08-08 (invites landed - see the note under §3)

## Context

`docs/MVP.md` §4 lists "group conversations (N members, roles, invites)" as
deferred, and §5 keeps 1:1 as the v0 shape. **v0 shipped long ago.** That list
described the first release, not the product; this ADR closes the largest item
the roadmap has carried since.

ADR 0002 already chose the shape of this change in advance: "when groups land,
group conversations simply won't carry a pair key; the 1:1 path is unaffected."
This ADR is the amendment that cashes that in.

The important discovery from surveying the code is how little of Chatpack
actually assumes two participants. Three seams are already N-ary:

- `Transport.recipientIds` is `string[]`, so SSE fan-out needs no change.
- `PermissionContext.conversation.participantIds` is `string[]`, and the
  default permission is a **membership test**
  (`participants.some(p => p.userId === userId)`), not a pair test.
- `seq`, read-state, `countUnread`, search scoping, reactions and `replyTo`
  are all per-conversation or per-participant. None of them count to two.

The 1:1-ness is concentrated in four places, and those are what this ADR
changes: `pairKey`, `getOrCreateDirectConversation`'s
`userIds: [string, string]`, `Conversation.participants`' "always exactly two"
contract, and `afterMessageMutation`'s `otherParticipantId`.

Questions this ADR settles:

1. How is a group distinguished from a DM, and what happens to `pairKey`?
2. Where does a group's name live?
3. What is the permission model for membership changes?
4. How does a client learn about membership changes, given that they allocate
   no message `seq`?
5. What happens to `otherParticipantId`, which shipped in core 0.6.0?

## Decision

### 1. One `Conversation` shape with a `type` discriminator

`Conversation` gains `type` and `name`, and `pairKey` becomes nullable:

```ts
interface Conversation {
  id: string;
  type: "direct" | "group";
  /** Sorted `"a:b"` for direct conversations; `null` for groups (ADR 0002). */
  pairKey: string | null;
  /** Group title; `null` for direct conversations. */
  name: string | null;
  createdAt: Date;
  metadata: Metadata;
  participants: Participant[];
}
```

**Not a discriminated union.** `DirectConversation | GroupConversation` would
be more precise but would break every existing `conversation.pairKey` read at
the type level for no runtime benefit. One interface with a discriminator keeps
the diff additive for consumers who only use DMs.

`type` is required rather than optional-defaulting-to-`"direct"` because an
adapter that forgets it should fail typecheck, not silently mint conversations
that pass as DMs.

**A first-class `name`, not `metadata.name`.** Every group UI needs a title.
`metadata` is untyped, so each consumer (and each AI builder) would invent its
own key - `metadata.title`, `.groupName`, `.subject` - which is precisely the
hallucination class `llms.txt` exists to prevent. It also cannot be indexed or
validated. Cost is one nullable column. `name` is trimmed, non-empty when
provided, and at most 200 characters; `null` for DMs, and a group may be
created without one (clients render a participant list, as Slack and iMessage
both do).

### 2. `pairKey` stays the DM uniqueness key, and only that

Groups carry `pairKey: null`. ADR 0002's idempotency guarantee is unchanged
for direct conversations and simply does not apply to groups: **two groups
with identical membership are two different groups**, which is correct - a
"standup" and a "lunch" group with the same five people are not the same
conversation.

For SQL adapters this needs care. Postgres treats `NULL`s as distinct in a
unique index, so the existing index would technically tolerate many `NULL`
rows - but relying on that is a subtlety a custom adapter author should not
have to know. The index becomes explicitly **partial**:

```sql
CREATE UNIQUE INDEX ... ON chatpack_conversations (pair_key)
  WHERE pair_key IS NOT NULL
```

Group creation is therefore **not** find-or-create. `getOrCreateDirectConversation`
keeps its `userIds: [string, string]` signature and its exact semantics; groups
get a separate `createGroupConversation`. Overloading one method would have
meant one call site where idempotency depends on the arguments.

### 3. Roles: `admin` and `member`, with a last-admin invariant

`Participant` gains `role: "admin" | "member"`. Direct conversations report
both participants as `"member"` - a DM has no hierarchy, and inventing one
would imply a DM can be administered.

> **Naming:** `Participant.role` is unrelated to `Message.role`
> (`user`/`assistant`/`system`). They are different types on different
> entities; the ADR notes it because the collision is confusing when grepping.

Permissions:

| Action                      | Who                         |
| --------------------------- | --------------------------- |
| Read / send / react         | any participant (unchanged) |
| Add participants            | admin                       |
| Remove another participant  | admin                       |
| Remove yourself (leave)     | any participant             |
| Change a participant's role | admin                       |
| Rename the group            | admin                       |

The group's creator is its first admin. Enforced invariant: **a group always
has at least one admin.** Removing or demoting the last admin is
`LAST_ADMIN_REMAINING` (409) rather than silently promoting someone, because
every automatic choice (oldest member? next in insertion order?) is a policy
decision Chatpack has no business making. An admin who wants to leave promotes
someone first.

A new `permissions.canManage` hook sits alongside `canRead`/`canWrite` for
apps whose hierarchy lives elsewhere (org roles, subscription tier). Default
is the admin check above.

**Idempotency, following ADR 0013's reactions:** adding a user who is already
a participant is a no-op, not an error; removing a user who is not a
participant is a no-op. Replayed membership requests must be harmless.

Bounds: a group holds at most 256 participants (`MAX_GROUP_PARTICIPANTS`),
enforced in core so every adapter agrees. A group may exist with only its
creator - you create, then invite.

> **Amendment (2026-08-08, invites shipped - ADR 0019).** "You create, then
> invite" was loose language when this ADR was written: the only way to grow a
> group was `addParticipants`, which needs the other person's user id up front.
> [ADR 0019](./0019-invites-and-join-requests.md) adds the two directions that
> don't - invite links (a mintable code someone redeems) and join requests (an
> outsider asks, an admin resolves) - as an **optional** `invites` storage
> capability, gated by a fourth permission hook, `canInvite`. Membership
> mechanics, roles, and `MAX_GROUP_PARTICIPANTS` are unchanged; redeeming an
> invite publishes the same `participant.added` event described in §4, so no
> new transport category and no subscriber changes.

### 4. Membership changes are a fourth transport category, with no `id:` line

Without live membership events, a user added to a group learns about it on
their next refetch, and members see a five-person group where a sixth is
already talking. So `TransportEvent` gains `ConversationEvent`:

```ts
type: "participant.added" | "participant.removed" | "conversation.updated";
```

These are **durable-backed but carry no `id:` frame**, exactly the ADR 0013
reasoning for reactions: `Last-Event-ID` must keep meaning "the newest message
`seq` I have seen" (ADR 0006), and a membership change allocates no `seq`. An
`id:` here would rewind gap-fill. Consequently they are not replayed on
reconnect, and a client that reopens its stream refetches the conversation -
the same bounded, honest cost reactions already pay.

Each event carries the full post-change participant list, so receiving one
twice is harmless and no follow-up request is needed.

`participant.removed` is delivered to the removed user **as well as** the
remaining members - it is the only signal that tells their client to drop the
conversation. This is the one place `recipientIds` deliberately includes a
non-participant, computed as the membership _before_ the removal.

### 5. `afterMessageMutation` gains `recipientIds`; `otherParticipantId` is deprecated

This is the one part of the change constrained by an already-published API.
Core 0.6.0 shipped:

```ts
otherParticipantId: string; // required
```

derived from `participants.find(p => p.userId !== senderId)` - one arbitrary
participant. In a group of five that hands a push provider a single essentially
random recipient and **silently drops the other three**, which is a
notification bug, not a type error.

The fix is additive:

- New `recipientIds: string[]` - every participant except the sender. This is
  what push integrations should use, and it is correct for both types.
- `otherParticipantId` **stays required** on the context for direct
  conversations and is documented as deprecated. For a group it is set to the
  first non-sender participant, matching 0.6.0's behavior rather than inventing
  a new one.

Making it `string | null` or removing it would break every 0.6.0 hook - a
notification path, i.e. the worst place to introduce a silent break one minor
after shipping. It is removed at 1.0.

### 6. Adapter contract: five new required methods

```ts
createGroupConversation(input): Promise<Conversation>;
addParticipants(input): Promise<Conversation>;
removeParticipant(input): Promise<Conversation>;
setParticipantRole(input): Promise<Conversation>;
updateConversation(input): Promise<Conversation>;  // rename
```

**Required, not optional.** Search became the contract's first optional method
(ADR 0015) because search _matching_ is backend-specific by nature - `tsvector`
lexemes, a regex, and FTS5 genuinely disagree, so a required method would have
quietly downgraded the interchangeable-adapter promise. Group membership is the
opposite: a membership row either exists or it does not, identically on every
backend. It is the reactions case, and reactions are required.

Each method returns the **full updated conversation** so core can publish a
complete snapshot without a second round trip - the same choice ADR 0013 made
for `addReaction`/`removeReaction`.

### 7. Routes

| Method | Path                              | Body                             | Who          |
| ------ | --------------------------------- | -------------------------------- | ------------ |
| POST   | `/conversations/group`            | `{ name?, userIds?, metadata? }` | any          |
| PATCH  | `/conversations/:id`              | `{ name }`                       | admin        |
| POST   | `/conversations/:id/participants` | `{ userIds }`                    | admin        |
| DELETE | `/conversations/:id/participants` | `{ userId }`                     | admin / self |
| PATCH  | `/conversations/:id/participants` | `{ userId, role }`               | admin        |

**No new HTTP verbs.** `GET`/`POST`/`PATCH`/`DELETE` are all already exported
by `ChatpackHandler`, so nothing 405s in an already-mounted app - the ADR 0013
lesson about Next.js route files re-exporting by method name. `DELETE` carries
its body for the same reason reactions do: keys mangle in path segments.

`POST /conversations` is untouched and still find-or-create for DMs, so no
existing call changes behavior. Group creation is a separate path rather than a
`type` field on the same route, because one route whose idempotency depends on
its body shape is exactly the ambiguity that makes AI builders guess.

### 8. New error codes

| Code                     | Status | When                                          |
| ------------------------ | ------ | --------------------------------------------- |
| `NOT_CONVERSATION_ADMIN` | 403    | a member attempts an admin-only action        |
| `NOT_GROUP_CONVERSATION` | 409    | membership or rename attempted on a DM        |
| `LAST_ADMIN_REMAINING`   | 409    | removing or demoting the only admin           |
| `GROUP_LIMIT_EXCEEDED`   | 422    | the add would exceed `MAX_GROUP_PARTICIPANTS` |

Every code needs a row in `STATUS_BY_CODE` (`handler.ts`) - the table is
exhaustive over `ChatpackErrorCode`, so a missing row is a typecheck failure.

## Consequences

- **Breaking for custom adapters:** the required contract grows fourteen →
  nineteen methods, plus `Conversation.type`/`name` and `Participant.role`.
  Pre-1.0 this is allowed (ADR 0001) and ships via a changeset. `llms.txt`
  Part 2, the skeleton adapter and the verification checklist all need the new
  methods.
- **Postgres deployments must re-run the migration:** `type`, `name` and
  `role` columns, `pair_key` dropped to nullable, and the `pair_key` unique
  index replaced with a partial one. All statements are idempotent
  (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), but the index swap is a
  `DROP` + `CREATE`, so it must be run before deploying the new adapter.
  Existing rows backfill to `type = 'direct'`, `role = 'member'`.
- **`ReactionSummary.userIds` is now the flagged problem ADR 0013 predicted.**
  It said returning every reactor id "is fine for two participants and wrong
  for two hundred." It is not changed here: capping or hiding it behind a
  viewer-relative `me` flag is a client-visible break, and doing it in the same
  release as groups would conflate two migrations. With
  `MAX_GROUP_PARTICIPANTS` at 256 the array is bounded, so this is a payload
  size question, not a correctness one. It is the next thing to revisit.
- **Multi-node `presence()` requires the shared store** described in ADR 0023.
  Groups fan out the resulting global transitions to every other participant.
- **Threads remain a non-goal.** Groups add participants to a conversation;
  threads add a second axis of ordering (thread identity, per-thread unread,
  nested pagination). ADR 0013's reasoning is unaffected by this change.
- **`getOtherParticipantId` stays** as the 1:1 helper behind the deprecated
  hook field, wrapped in the try/catch added in `ea605ae`. It throws for a
  creator-only group, which is why that guard is load-bearing rather than
  defensive.

## Alternatives considered

- **`metadata.name` instead of a column** - zero schema change, but nothing
  enforces the key and no adapter can index or validate it. See §1.
- **Auto-promote on last-admin removal** - convenient, but every selection rule
  is an unstated policy. Failing loudly is better than picking silently.
- **Groups as an optional adapter capability** (like search) - would spare
  existing custom adapters, but membership is not backend-specific, so this
  would fragment the interchangeability promise for a one-time cost. See §6.
- **`type` on `POST /conversations`** - one fewer route, but idempotency would
  depend on body shape. See §7.
- **Removing `otherParticipantId` now** - correct shape, silent break in
  published push integrations. See §5.
