# ADR 0024: Message forwarding

- **Status:** accepted
- **Date:** 2026-08-14
- **Milestone:** v1.next (message forwarding)

## Context

Forwarding moves a message someone already sent into a different
conversation - "look what they said in #eng". Unlike every message feature
before it, the operation spans **two** conversations with two different
membership sets, which is what makes it more than a convenience wrapper around
`sendMessage`.

`docs/STATUS.md` recorded three open questions when this was scoped, all about
the _reference_ rather than the copy:

1. How is the original message represented on the forward?
2. What does a forward show once the original is deleted?
3. What happens when the forwarder later loses access to the source?

ADR 0013 answered the same three for quote-replies (a stored id plus a
core-hydrated `MessageReference`, tombstones resolve with `deleted: true`,
deleting a parent leaves replies alone). Starting from that answer and seeing
where it breaks is what this ADR does - because it does break, and the place it
breaks is a permission boundary that quote-replies never had to cross.

Additional questions this ADR settles:

4. Who is the sender of a forward, and what is its role?
5. Do content hooks run on a forward?
6. What travels with the copy - mentions, reactions, replies?

## Decision

### 1. A forward is a real message that copies the body and keeps provenance

`forwardMessage` writes a **new message** in the target conversation, sent by
the forwarder, whose `body` is a verbatim copy of the source body. Alongside
it, three stored columns record where it came from:

```ts
forwardedFromMessageId: string | null;
forwardedFromConversationId: string | null;
forwardedFromSenderId: string | null;
```

surfaced on the API shape as one assembled object, matching how
`replyToMessageId` surfaces as `replyTo`:

```ts
interface ForwardProvenance {
  messageId: string;
  conversationId: string;
  senderId: string;
}
```

**Copying is forced by permissions, not chosen for convenience.** The
alternative - store only a pointer and hydrate the body on read, as
quote-replies do - requires reading a message in a conversation the _reader_
cannot read. Every viewer in the target would need the source hydrated for
them, and none of them are entitled to it. There is no permission check that
makes pointer-only forwarding safe, so the body is copied at forward time,
when the one person who _is_ entitled to read it is present to authorize it.

### 2. Provenance is frozen, and carries no excerpt and no deleted flag

This is where ADR 0013's shape had to change. `MessageReference` carries an
`excerpt` and a `deleted` flag, both resolved live on every read. Reused
across a conversation boundary, both become leaks:

- A live `excerpt` means the recipient of a forward watches the current body of
  a message in a conversation they cannot read. Edit the source and the
  excerpt changes under them - it would show text that was never forwarded.
- A live `deleted` flag tells them the moment the source conversation deletes
  something.

Neither has any value here, because the forwarded body is already in the
message. An excerpt would be a duplicate of the field next to it.

So `ForwardProvenance` is three ids and nothing else, which makes it **not a
hydrated decoration at all** - it is stored, complete, on the message row.
That answers questions 2 and 3 by construction rather than by rule:

- **Deleting the original does nothing to its forwards.** The copy is
  independent; there is no live field to change. (Consistent with ADR 0013:
  deleting a parent does not touch its replies.)
- **The forwarder losing access to the source does nothing either.** Nothing
  is re-read, so there is nothing to re-check. The permission check happened
  once, at forward time, which is the only moment it was meaningful.

The source **conversation** id is included; the source conversation's **name**
is not. The id is opaque and the forwarder has already chosen to reveal the
content it belongs to, so passing it on lets a client group "forwarded from
the same place" without naming it. A name is human-readable and would hand a
private group's title to someone who was never in it, for a label the app can
resolve itself if the viewer is entitled to it.

### 3. Two conversations means two permission checks

- `canRead` on the **source**, plus the message must exist there, else
  `MESSAGE_NOT_FOUND` - the ADR 0013 §1 wording, so a source id cannot be used
  to probe whether a message exists somewhere the caller cannot read.
- `canWrite` on the **target**, plus the block check (`DIRECT_INTERACTION_BLOCKED`)
  and the ban check (`USER_BANNED`) that `sendMessage` already applies.

No new error codes: `FORBIDDEN_READ`, `FORBIDDEN_WRITE`, `MESSAGE_NOT_FOUND`,
and `MESSAGE_DELETED` all already mean the right thing.

**A tombstone cannot be forwarded** (`MESSAGE_DELETED`). Replying to a deleted
message is allowed because the pointer still carries meaning, but a forward's
whole payload is the copied body, and copying an empty one produces a message
that says nothing and claims provenance for it.

**Forwarding a forward is one hop.** Provenance names the message it was
forwarded from, not the original origin - the same flatness rule ADR 0013
applied to replies. Chains are reconstructible by following ids where the
viewer is entitled to; core does not walk them. Forwarding into the _same_
conversation is allowed and needs no special case.

### 4. The forwarder is the sender; the role is the forwarder's

`senderId` is the forwarder. The source's `senderId` is preserved only inside
`forwardedFrom`.

`role` defaults to `"user"` and may be set by the caller, exactly as
`sendMessage` allows. The source's role is deliberately **not** copied: a
forwarded `"assistant"` message would render as though the AI had spoken in a
conversation it was never in, while `senderId` said otherwise. Apps that want
the distinction have `forwardedFrom.senderId` and `metadata`.

### 5. Content hooks run, with `action: "send"`

`beforeMessageSend` runs on every forward. Skipping it would make forwarding a
laundering route for content rules - the same hole ADR 0011 closed for edits,
where a blocked word could otherwise be sent clean and edited in afterwards.

The action stays `"send"` rather than gaining a `"forward"` member, and this is
the security-relevant part: a host that filters `if (action === "send")` must
keep covering forwards. Adding a third action would silently exempt every
existing filter the day this ships - "more descriptive" bought at the cost of
a regression in someone else's code. Hosts that genuinely need to branch can
read the new optional `forwardedFrom` on the hook context, which is additive
and cannot fail open.

`afterMessageMutation` likewise reports `action: "send"`: durably, a forward is
a message being created.

### 6. Nothing else travels with the copy

- **Reactions do not travel.** They are other people's responses in another
  room, and their `userIds` (ADR 0013 §2) would name source participants to
  the target.
- **`replyToMessageId` is null.** A forward is not a reply, and the source's
  parent is not in the target conversation, so the pointer could not resolve.
- **Mentions do not travel** (ADR 0023). Their ids were validated against the
  source's membership; re-validating against the target fails for exactly the
  people who are not in both. The caller may pass a fresh `mentions` array,
  validated against the **target** like any other send.
- **`metadata` does not travel.** The caller may supply their own. Copying it
  would move app-private fields (an attachment key, an AI trace id) into a
  conversation whose readers were never scoped for them, and core cannot know
  which keys are safe.

## Consequences

- **Not breaking for custom adapters, but they must store three columns.**
  `AddMessageInput` gains `forwardedFromMessageId`,
  `forwardedFromConversationId`, and `forwardedFromSenderId`; the method count
  stays where ADR 0023 leaves it (21). An adapter that ignores them keeps
  compiling and loses provenance silently, which is the failure mode ADR 0020
  built `CHANNELS_UNSUPPORTED` to avoid - but a capability flag is the wrong
  tool for three nullable columns on an input object core already passes, so
  this rides on the changeset and the verification checklist instead.
- **Postgres deployments need DDL:** three nullable columns on
  `chatpack_messages` via `ADD COLUMN IF NOT EXISTS`, plus an index on
  `forwarded_from_message_id`. Pure addition, safe to re-run, and applicable
  before deploying.
- **One new route:** `POST /messages/:id/forward` with `{ conversationId }`,
  returning the `{ message }` envelope for the **new** message in the target.
  `POST` on purpose: `ChatpackHandler` is re-exported by name in Next.js route
  files, so a new HTTP method would 405 in every already-mounted app until the
  consumer edited their route file (ADR 0013's reason for rejecting `PUT`).
- **The forward lands as an ordinary `message.created`** in the target
  conversation, with the target's participants as `recipientIds`. It allocates
  a normal `seq`, counts toward `unreadCount`, and reorders the conversation
  list - it is a message. Nothing is published to the source conversation:
  being forwarded is not an event the source can act on, and telling it would
  leak that the target exists.
- **"Forward with a comment" is not shipped.** The body is a verbatim copy and
  cannot be overridden, so provenance always means what it says. Apps compose
  it from a forward plus an ordinary message; if a first-class version is ever
  wanted, an additive `comment` field can carry it without changing this shape.
- **Multi-forward in one call is not shipped.** One message per call keeps the
  permission checks and the `{ message }` envelope one-to-one. A loop in the
  client is a fine substitute and does not need a batch error shape.
