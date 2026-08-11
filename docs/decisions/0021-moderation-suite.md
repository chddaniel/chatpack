# ADR 0021: Core moderation suite

- **Status:** accepted
- **Date:** 2026-08-11
- **Milestone:** v1.next

## Context

Chatpack had message hooks and conversation-admin controls, but no durable
user blocks, mutes, abuse reports, or account bans. The existing plugin seam
can add routes and message hooks, but it cannot reliably guard every core API
operation or the SSE stream.

Chatpack also does not own a users table. User ids, authentication, and host
account roles remain application-owned.

## Decision

Moderation is an optional core capability backed by an optional
`StorageAdapter.moderation` implementation. First-party memory and Drizzle
adapters implement it. Existing custom adapters remain valid and return
`MODERATION_UNSUPPORTED` when moderation is requested without the capability.

Hosts provide `moderation.canModerate`. If the hook is absent or returns false,
moderator operations fail with `NOT_MODERATOR`.

### User controls

- Blocks are private relations and are enforced in both directions.
- Blocks stop new direct conversations and direct message mutations.
- Existing direct history stays readable.
- Blocks do not affect shared group conversations.
- Mutes are per-user, per-conversation notification preferences. They do not
  change unread counts or SSE delivery.

### Reports

Reports target a user, message, or conversation. They start as `open` and can
move through `triaged`, `resolved`, or `dismissed`. One reporter can have one
active report for one target; repeated open or triaged submissions return the
existing report.

Message and conversation reports store immutable submit-time evidence. This
lets moderators inspect the reported context without granting non-participant
read access to live conversations.

### Bans

Bans are permanent or expire at a specified future time. Active bans block all
Chatpack API operations and SSE connections. Existing streams re-check the ban
on heartbeat and close after the next failed check. Revocation records the
moderator and timestamp; it does not delete the ban history.

Chatpack bans do not revoke host sessions or change host authentication.

### HTTP and client surface

Self-service routes live under `/moderation/blocks`, `/moderation/mutes`, and
`/moderation/reports`. Moderator report and ban tools use the same
`/moderation/reports` and `/moderation/bans` resources and require
`canModerate`.

The browser client exposes these actions under `client.moderation`. No
moderation events are added to `TransportEvent`; moderation writes do not
create message sequence numbers and are private.

## Consequences

- Core gains cross-cutting active-user and direct-interaction checks.
- Adapters gain four durable moderation table families.
- Report evidence can contain message text and participant ids. Hosts must
  protect moderator access and database access accordingly.
- The optional capability avoids breaking existing custom adapters, but those
  adapters cannot use moderation until they implement the contract.
- Admin UI, user resolution, notifications, and host-session revocation remain
  outside Chatpack.

## Alternatives rejected

- **Route-only plugin:** cannot enforce block or ban across existing core API
  methods and streams.
- **Privileged live reads for moderators:** would bypass participant-scoped
  reads and make evidence mutable.
- **Ids-only reports:** would leave core moderator tools without enough context
  to act on reported messages or conversations.
