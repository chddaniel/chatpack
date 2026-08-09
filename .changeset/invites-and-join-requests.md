---
"@chatpack/core": minor
"@chatpack/adapter-memory": minor
"@chatpack/adapter-drizzle": minor
---

Invite links and join requests for group conversations (ADR 0019).

Growing a group previously meant `addParticipants`, which needs the other
person's user id up front. Two new paths don't:

- **Invite links** - an admin mints a code with an optional expiry and use cap,
  anyone holding it previews the group and redeems it.
- **Join requests** - someone with no code asks to join; an admin approves or
  denies from a pending queue.

Eight new `chat.api` methods and routes: `createInvite`, `listInvites`,
`revokeInvite`, `getInvitePreview`, `acceptInvite`, `requestToJoin`,
`listJoinRequests`, `resolveJoinRequest`.

Storage support is an **optional capability**: `StorageAdapter.invites` is a
nine-method namespace, all-or-nothing. Adapters that omit it are unaffected -
the routes answer `501 INVITES_UNSUPPORTED` and nothing else changes. Both
first-party adapters implement it; `@chatpack/adapter-drizzle` adds two tables
(`chatpack_conversation_invites`, `chatpack_join_requests`) as pure additions,
no column changes or index swaps on existing tables.

A fourth permission hook, `canInvite`, gates minting; it defaults to the same
membership test as `canRead`. No new transport event types - redeeming an
invite publishes the existing `participant.added`, so `TransportEvent` stays at
four members and existing subscribers need no changes.

New error codes: `INVITE_NOT_FOUND` / `JOIN_REQUEST_NOT_FOUND` (404),
`ALREADY_PARTICIPANT` (409), `INVITE_EXPIRED` (410), `INVITE_LIMIT_EXCEEDED`
(422), `INVITES_UNSUPPORTED` (501).
