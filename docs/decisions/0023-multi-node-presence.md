# ADR 0023: Multi-node presence leases

## Status

Accepted

## Context

`presence()` originally kept connection counts in a process-local `Map`. Redis
event fan-out could deliver an event to another node, but could not tell that
node how many connections a user had elsewhere. The result was false offline
states and duplicate online/offline transitions.

## Decision

Keep `presence()` storage-neutral through the public `PresenceStore` contract.
The default store remains in-memory. `@chatpack/transport-redis` provides
`redisPresenceStore()` for deployments that already use Redis transport.

The store owns one expiring lease per `{ userId, connectionId }`. Open, heartbeat,
close, and offline confirmation are atomic per user:

- `open` creates a lease and reports `online` only when no other lease exists.
- `heartbeat` renews only an existing lease. It never recreates a dead stream.
- `close` removes only its own lease. The final close creates a pending-offline
  token; a new open invalidates that token.
- `finalizeOffline` reports `offline` only when its token still owns the pending
  transition and no lease remains.
- Lease expiry removes a crashed node's connection. A five-second offline grace
  period remains the default to absorb normal SSE reconnects.

The SSE handler supplies a unique connection id and periodically invokes the
store heartbeat. Async lifecycle hooks stay fire-and-forget from the request's
perspective and store failures are logged without breaking the stream. A
presence snapshot returns an internal error when the shared store fails; it
never reports guessed state.

Redis uses Lua scripts for atomic lease operations. The Redis presence client
must be a normal connection that supports `EVAL`. The transport subscriber
connection remains dedicated to `SUBSCRIBE`.

## Consequences

- Multi-node deployments get one global online/offline state and one transition
  per user, independent of load-balancer placement.
- Existing single-node applications keep their behavior and need no new setup.
- Redis outage can make presence temporarily unavailable or stale; it must not
  fail message sends or SSE connections.
- Presence is still ephemeral. It is not durable user history and is unavailable
  in deployments that use polling instead of SSE.
