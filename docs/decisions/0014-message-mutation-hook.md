# ADR 0014: Post-persistence message mutation hook

- **Status:** accepted
- **Date:** 2026-08-04
- **Milestone:** v0.next (message mutation hook)

## Context

Chatpack already has `afterMessageSend`, but its name does not describe its
edit behavior. Push providers and other integrations also need the recipient
id and a clear way to distinguish sends, edits, and deletes.

Chatpack must remain storage- and provider-neutral. It must not own device
tokens, a users table, provider clients, retries, or delivery guarantees.

## Decision

Add one canonical post-persistence hook:

```ts
hooks: {
  afterMessageMutation: async ({
    message,
    conversation,
    otherParticipantId,
    action,
  }) => {},
}
```

The action is one of `send`, `edit`, or `delete`. The hook runs after the
successful storage write and the existing internal transport broadcast. The
message is the raw persisted message. The conversation includes
`participantIds`. `otherParticipantId` is derived from the two participants
and the persisted message sender.

The hook is awaited, but failures are logged and swallowed. Internal
`message.created`, `message.updated`, and `message.deleted` broadcasts remain
unchanged and are independent from provider side-effects.

`afterMessageSend` remains as a deprecated compatibility hook. It receives
the extended context for `send` and `edit`, but not `delete`. Configuring both
names fails fast to prevent duplicate side-effects.

## Consequences

- Applications can connect FCM, Web Push, queues, or analytics without Chatpack
  storing provider state.
- Repeated idempotent deletes do not invoke the hook because no persistence
  mutation occurs.
- Hook delivery remains in-process with no retry or delivery guarantee.
