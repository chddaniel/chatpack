# ADR 0006: SSE with `Last-Event-ID` gap-fill, storage as source of truth

- **Status:** accepted
- **Date:** 2026-07-22
- **Milestone:** M3

## Context

M3 adds live delivery: a client should see the other side's messages appear
without polling. The MVP (§9) chose Server-Sent Events over WebSockets for v0:
1:1 text chat is server→client dominated (sends already go through POST), SSE
runs over plain HTTP (no upgrade dance, works with every proxy/load balancer),
and browsers give us reconnection + `Last-Event-ID` for free via `EventSource`.

The hard part of any realtime system isn't the happy path — it's what happens
when the connection drops. If events only exist in flight, a dropped connection
means lost messages.

## Decision

1. **Durable-first publishing.** The engine writes to storage, *then*
   publishes a `ChatEvent` on the `Transport`. The transport is fire-and-forget:
   a slow or crashing subscriber can never fail or block a send. Delivery is
   therefore *at-least-once*; clients reconcile by `message.id` + `seq`.

2. **The event stream is a hint; storage is the truth.** SSE event ids are
   `conversationId:seq`. On reconnect, the client presents its last seen id
   (browsers do this automatically via the `Last-Event-ID` header) and the
   server replays everything after that `seq` **from storage** — via the same
   permission-checked `api.listMessagesAfter` path — before live events resume.
   Missed events are recovered from the durable log, not from a transport
   buffer.

3. **Subscribe before replaying.** The stream subscribes to live events first
   and gap-fills second. The overlap can duplicate an event (harmless —
   at-least-once + dedupe by id); the reverse order would leave a gap
   (a message sent between replay and subscribe is lost — not acceptable).

4. **Participation is enforced server-side per event.** Each published event
   carries `recipientIds` computed by the engine from the conversation's
   participants. The stream delivers an event only if the authenticated user is
   in that list; nothing is trusted from subscription parameters. A forged
   `Last-Event-ID` pointing at a foreign conversation gap-fills through the
   permission layer and gets `FORBIDDEN_READ` (swallowed; stream stays open,
   nothing leaks).

5. **`Transport` is an interface; v0 ships in-process.** Same play as
   `StorageAdapter` (ADR 0001): `publish`/`subscribe` is the entire contract,
   the default is a single-node in-process listener set, and a Redis/pub-sub
   implementation can drop in for multi-node without any public API change.

## Consequences

- **Good:** no lost messages across reconnects, and the guarantee is testable
  (see `sse.test.ts` — "drop the connection, messages backfill on reconnect").
- **Good:** the send path's latency and reliability are independent of how
  many SSE clients are connected or how broken they are.
- **Good:** works on every Web-standard runtime — the endpoint returns a
  `Response` with a `ReadableStream` body; heartbeat comments (default 15s)
  keep proxies from reaping idle connections.
- **Trade-off:** at-least-once means clients must dedupe by message id. This is
  the standard, simple contract; exactly-once would require server-side
  delivery tracking that v0 does not need.
- **Trade-off:** gap-fill covers *the conversation named in the last event id*.
  A client offline long enough to miss activity in *other* conversations
  should re-sync via `GET /conversations` + `GET .../messages` (which clients
  do on cold start anyway). Good enough for v0; a multi-conversation resume
  token can come later without breaking the wire format.
- **Limit (single-node):** the in-process transport does not fan out across
  processes. Documented loudly; fixed later by a Redis transport, not by an
  API change.
