# ADR 0011: Message hooks - in-process before/after, not webhooks

- **Status:** accepted
- **Date:** 2026-08-02
- **Milestone:** v0.next (message hooks)

## Context

Chatpack had three developer touchpoints - `auth`, `permissions.canRead`,
`permissions.canWrite` - and none of them can see message _content_.
Permission hooks receive the user and the conversation, so there is no place
to express "reject this message because of what it says" (length caps,
profanity filters, spam rules) or "do something after a message lands"
(trigger the AI reply, analytics). Consumers were left wrapping `chat.api`
or the HTTP handler by hand, which the hard rules explicitly discourage.

Design questions this ADR settles:

1. Where do content rules run, and can they mutate the message?
2. Do the same rules apply to edits?
3. Is the after-hook a delivery mechanism (webhooks) or a callback?
4. How do hook failures map to HTTP?

## Decision

**1. One `hooks` option, before/after shape** (the BetterAuth idiom):

```ts
chatpack({
  storage, auth,
  hooks: {
    beforeMessageSend?: (ctx) => void | { body?, metadata? },  // gate
    afterMessageSend?:  (ctx) => void,                          // notification
  },
})
```

`beforeMessageSend` runs after auth + permission checks and **before
persistence**. Three outcomes: return nothing (accept unchanged), return
`{ body }`/`{ metadata }` (persist the rewrite; broadcast carries the
rewritten message), or throw (nothing stored, nothing broadcast). A thrown
`ChatpackError` passes through with its own code; any other throw becomes
`MESSAGE_REJECTED` so consumers can `throw new Error("Max 2000 chars.")`
without importing Chatpack types. A rewrite to an empty body is
`INVALID_INPUT` - rejecting must be explicit (throw), never a silent drop.

**2. Hooks run for edits too.** Both hooks fire on `editMessage` with
`ctx.action: "edit"` (vs `"send"`). Otherwise a blocked word could be sent
clean and edited in afterwards. Edits only rewrite `body`; a returned
`metadata` is ignored on the edit path (edits never touched metadata before
this ADR either).

**3. `afterMessageSend` is a callback, not infrastructure.** It runs after
the storage write _and_ the transport publish (durable-first, MVP §9), is
awaited (so `sendMessage` resolving means the hook ran), and **cannot fail
the request** - a throw is logged server-side and swallowed, because the
message already durably exists and the sender must not see an error for a
side-effect. There are deliberately **no retries, no delivery guarantees,
no webhooks** - that is v0-excluded infrastructure (see MVP scope). A
consumer needing reliability enqueues into their own job system from the
hook.

**4. HTTP mapping.** `MESSAGE_REJECTED` → **422 Unprocessable Content**: the
request was well-formed (not 400) and the user is allowed to write (not
403); the _content_ was refused by application rules.

## Alternatives considered

- **Per-event callback registry (`on("message.created", ...)`)** - overlaps
  the transport's subscribe surface and invites treating hooks as a delivery
  mechanism. Rejected in favor of two named, purpose-specific hooks.
- **Content rules inside `permissions.canWrite`** - would need the body in
  `PermissionContext`, muddying "may this user write here?" (checked for
  edits/deletes too) with "is this content acceptable?". Rejected.
- **Blocking `afterMessageSend` (failure fails the request)** - violates
  durable-first: the message is already stored and broadcast, so failing the
  request would lie to the sender. Rejected.
- **Plugin-based application hooks (ADR 0008 seam)** - the application hook
  remains the canonical content rule surface. The plugin seam also exposes a
  blocking hook for nested integrations that must validate or rewrite after
  application rules and before persistence; it does not replace the
  application hook.

## Consequences

- New error code `MESSAGE_REJECTED` (422) in the public contract; clients
  (including `@chatpack/client`) surface it like any enveloped error.
- `sendMessage`/`editMessage` latency now includes both hooks; the docs tell
  consumers to keep them fast and queue heavy work.
- No storage adapter changes: hooks live entirely in core's engine layer.
- Scope guard for reviewers: requests for retries, hook ordering/priorities,
  or webhook delivery on top of `afterMessageSend` are post-v0 - point at
  this ADR.
