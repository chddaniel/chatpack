# ADR 0008: Ephemeral events + plugins live in core

- **Status:** accepted
- **Date:** 2026-07-28
- **Milestone:** v0.next (real-time trio)

## Context

The v0.next slice adds the "feels alive" features: typing indicators, presence
(online/last-seen), and live delivery/read ticks. The MVP (§4) sketched these
as separate npm packages (`@chatpack/plugin-typing`, `@chatpack/plugin-presence`,
`@chatpack/plugin-receipts`) plus a "generic ephemeral-event primitive" on the
transport to serve them.

Two observations changed the packaging call:

1. **These features are feather-light.** They are ephemeral-only - no storage,
   no schema, no adapter work. Each is 50–150 lines on top of the right
   primitive. A separate npm package per feature means a tsup config, exports
   map, changeset, publish, README, and a version-compatibility matrix each -
   pure overhead for server-side code where bundle size is irrelevant.
2. **The precedent ships plugins in the main package.** BetterAuth - the
   explicit comparable - exposes most plugins as subpath imports
   (`better-auth/plugins`) and reserves separate packages for heavy
   dependencies.

At the same time, hardwiring the features into core (always-on) was rejected:
presence keeps server state and typing adds endpoints some developers won't
want exposed. The seam matters; the separate package does not.

## Decision

1. **Ephemeral events are a core transport primitive.** The `Transport` now
   carries `TransportEvent = ChatEvent | EphemeralEvent`. An `EphemeralEvent`
   (`{ ephemeral: true, type, conversationId?, senderId, recipientIds,
payload, at }`) is fire-and-forget: never persisted, never replayed. Its
   SSE frame carries **no `id:` line**, so `EventSource` never adopts it as
   `Last-Event-ID` and message gap-fill (ADR 0006) is untouched. Miss a
   typing ping and it's gone - which is correct.

2. **A minimal plugin seam lives in core.** `chatpack({ plugins: [...] })`
   accepts `ChatpackPlugin` objects with exactly the hooks the trio needs and
   nothing more: `handleRequest` (extra routes, tried after core routes miss,
   before the 404), `onStreamOpen`/`onStreamClose` (SSE lifecycle),
   `onMarkRead`, and `onEventDelivered`. Notification hooks are
   fire-and-forget - a throwing plugin never breaks the request that
   triggered it, the same rule transport listeners already follow.

3. **First-party ephemeral plugins ship inside `@chatpack/core`** as a subpath
   export: `import { typing, presence, receipts } from "@chatpack/core/plugins"`.
   Opt-in, one npm package, zero extra publishing.

   - `typing()` - `POST /conversations/:id/typing`; publishes
     `typing.started`/`typing.stopped` to the other participant. Stateless;
     clients throttle sends and expire the indicator after ~5s.
   - `presence()` - the SSE connection **is** the heartbeat. Counts streams
     per user (multi-tab safe), publishes `presence.online`/`presence.offline`
     to conversation partners on 0↔1 transitions (with an offline grace
     period, default 5s, to absorb reconnect flaps), and serves
     `GET /presence?userIds=…` restricted to users the caller shares a
     conversation with.
   - `receipts()` - `receipt.delivered` to the sender when a recipient's live
     stream receives their message; `receipt.read` to the other participant on
     mark-read. Durable last-read stays in core, untouched.

4. **Separate packages are reserved for real weight.** A plugin (or client)
   graduates to its own package when it has heavy dependencies (Redis
   transport), a different runtime (`@chatpack/react` runs in the browser and
   peer-depends on React), or a third-party author. Those plug into the same
   `plugins: []` seam - the packaging changes, the architecture doesn't.

## Consequences

- **Good:** the trio costs one line to adopt and zero lines to ignore. No
  new packages to version, publish, or keep compatible.
- **Good:** gap-fill and the durable data model are completely unaffected -
  ephemeral events cannot perturb `Last-Event-ID`, storage, or adapters.
- **Good:** the `plugins: []` seam is the long-term extension point; later
  packages (groups, AI, third-party) target it without core changes.
- **Trade-off:** `Transport.publish`/`subscribe` now carry `TransportEvent`
  instead of `ChatEvent` - a minor breaking change for custom transport
  authors (fine at 0.x, called out in the changelog). Existing transports
  that just fan out events keep working unchanged.
- **Trade-off:** presence state is in-memory and single-node, exactly like
  the in-process transport (MVP §5, ADR 0006). Documented loudly; a
  multi-node deployment needs a shared-state presence implementation later.
- **Trade-off:** ephemeral delivery is at-most-once (drops) _and_
  at-least-once per connection for delivered ticks (two tabs → two ticks).
  Clients dedupe by `payload.messageId`; the durable truth is always in
  storage.
- **Supersedes** the `@chatpack/plugin-*` package naming in MVP §4.
