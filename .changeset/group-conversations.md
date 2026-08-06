---
"@chatpack/core": minor
"@chatpack/adapter-memory": minor
"@chatpack/adapter-drizzle": minor
---

Add group conversations: membership, admin roles, and rename (ADR 0017).

DMs and groups are now one `Conversation` shape told apart by `type`
(`"direct" | "group"`). A group holds 1..256 participants, carries `pairKey:
null` and an optional `name`, and gives each participant a `role` of `"admin"`
or `"member"`. DMs are unchanged: still find-or-create, still exactly two
participants, and both of them are admins.

Five server-API methods and five routes are new - `createGroupConversation`
(`POST /conversations/group`), `addParticipants` and `removeParticipant`
(`POST`/`DELETE /conversations/:id/participants`), `setParticipantRole`
(`PATCH /conversations/:id/participants/:userId`), and `updateConversation`
(`PATCH /conversations/:id`). Every one of them returns the complete
conversation, so replace your cached copy rather than merging. Group creation is
never find-or-create: calling it twice with the same members makes two groups.

Core owns the policy, so adapters never re-check it: only admins may add,
remove others, rename, or change roles (403 `NOT_CONVERSATION_ADMIN`); anyone
may remove themselves; a group always keeps at least one admin (409
`LAST_ADMIN_REMAINING`); the cap is 256 participants (422
`GROUP_LIMIT_EXCEEDED`); and a group-only call aimed at a DM is 409
`NOT_GROUP_CONVERSATION`.

Membership changes fan out over the existing SSE stream as a new
`ConversationEvent` category - `participant.added`, `participant.removed`, and
`conversation.updated` - carrying `actorId`, `affectedUserIds`, and the full
conversation. Like reactions they have no `seq`, so their frames carry no `id:`
line and `Last-Event-ID` gap-fill skips them; refetch on stream reopen. A
removed participant receives their own `participant.removed` as the last event
for that conversation. `TransportEvent` is now a four-member union, with an
`isConversationEvent` guard alongside the existing ones.

`afterMessageMutation` gains `recipientIds` - every participant except the
sender, so push notifications reach a whole group. `otherParticipantId` still
works but is **deprecated and will be removed at 1.0**: it is single-valued, so
in a group it resolves to the first non-sender and everyone else gets nothing.

The `StorageAdapter` contract grows the same five methods, and they are
**required** rather than optional like `searchMessages` - a custom adapter will
not typecheck until it implements them. **Existing Drizzle databases must re-run
the migration**, which adds `type` and `name` to `chatpack_conversations`, adds
`role` to `chatpack_conversation_participants`, makes `pair_key` nullable, and
replaces the total unique index on `pair_key` with a partial one (`WHERE
pair_key IS NOT NULL`) so unlimited null-keyed groups can coexist. Existing rows
need no backfill of their own: every pre-group conversation is a DM, and the
migration promotes its participants to `admin` to match how DMs are created now.

`@chatpack/client` reads groups today - `type`, `name`, `role`, unread counts,
messages, and `message.*` events all flow through unchanged - but does not yet
wrap the five mutations or subscribe to `participant.*`; call those routes with
`fetch` and refetch afterwards.
