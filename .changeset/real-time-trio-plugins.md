---
"@chatpack/core": minor
---

Real-time trio: typing indicators, presence, and live delivery/read ticks as opt-in in-core plugins (ADR 0008).

New:

- **Ephemeral events** — a new transport primitive for fire-and-forget live signals that are never stored and never replayed on reconnect. Their SSE frames carry no `id:` field, so `Last-Event-ID` message gap-fill is unaffected.
- **Plugin seam** — `chatpack({ plugins: [...] })` accepts `ChatpackPlugin` objects with `handleRequest` (extra routes), `onStreamOpen`/`onStreamClose`, `onMarkRead`, and `onEventDelivered` hooks. Notification hooks are fire-and-forget: a throwing plugin never breaks a request.
- **`@chatpack/core/plugins`** subpath export with three first-party plugins:
  - `typing()` — `POST /conversations/:id/typing`, publishes `typing.started`/`typing.stopped` to the other participant.
  - `presence()` — the SSE connection is the heartbeat; publishes `presence.online`/`presence.offline` to conversation partners (multi-tab safe, configurable offline grace period) and serves `GET /presence?userIds=…` restricted to users the caller shares a conversation with.
  - `receipts()` — ephemeral `receipt.delivered` (to the sender, when a recipient's live stream receives the message) and `receipt.read` (to the other participant, on mark-read). Durable `lastReadMessageId` is unchanged.

Breaking (custom `Transport` authors only): `Transport.publish`/`subscribe` now carry `TransportEvent = ChatEvent | EphemeralEvent` instead of `ChatEvent`. Discriminate with the new `isEphemeralEvent()` guard. Transports that just fan events out keep working unchanged.
