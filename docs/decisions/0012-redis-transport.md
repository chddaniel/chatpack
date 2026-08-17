# ADR 0012: Redis pub/sub transport as a separate package

- **Status:** accepted
- **Date:** 2026-08-03
- **Milestone:** post-v0 (distributed transport)

## Context

The v0 transport is `inProcessTransport()`: a `Set` of listeners inside one
process (MVP §5, ADR 0006). That is correct for a single node and silently
wrong for two. With two app servers behind a load balancer, Alice's SSE stream
lives on node A while Bob's `POST /messages` is handled by node B; node B
publishes to its own in-process listener set, and Alice hears nothing until she
reconnects and gap-fills from storage.

This is the single most-cited limitation of the project: the deployment table in
`llms.txt` currently tells serverless and multi-instance users to poll instead
of using `/stream`, and both the roadmap and ADR 0008 (§4) explicitly name a
Redis transport as the intended fix - the transport interface was shaped for it
from the start.

Two questions needed answering: where the code lives, and what the semantics are
when Redis is unhealthy.

## Decision

**1. It ships as a separate package, `@chatpack/transport-redis`.**

ADR 0008 §4 already set this rule: plugins and adapters graduate to their own
package when they carry heavy dependencies, and a Redis client is the example it
gives. Keeping it out of core also means core keeps zero runtime dependencies.

**2. Bring your own Redis client (no driver dependency).**

`redisTransport({ publisher, subscriber })` accepts anything structurally
matching two tiny interfaces (`publish`, and `subscribe`/`on`/`unsubscribe`).
`ioredis` and `node-redis` v4+ both satisfy them, as does a fake in tests. The
alternative - depending on or peer-depending on a specific driver - would force a
version-compatibility matrix on us and possibly a second copy of the driver into
the user's app, for no gain: we use two commands.

The two drivers disagree on message delivery (`ioredis` emits a `"message"`
event; `node-redis` takes the listener inline in `subscribe`), so the shape is
detected at runtime. Exactly one delivery path is ever wired, so no event is
handled twice.

The discriminator is the **casing of the pattern-subscribe method**: `node-redis`
spells it `pSubscribe`, `ioredis` spells it `psubscribe`. The obvious test - the
presence of `on` - is wrong, and was a real bug caught before release: both
drivers extend `EventEmitter`, so it routed `node-redis` down the `ioredis` path,
called `subscribe(channel)` with no listener, and delivered **zero** events while
node-redis emitted "listener is not a function" on its error channel. Nothing
threw and publishing still succeeded, so a deploy would look healthy while no
cross-node event ever arrived. The test double now extends `EventEmitter` like
the real client, which turns that mistake into a test failure.

Note `ioredis`'s optional second argument to `subscribe` is a Node-style
`(err, count)` completion callback, **not** a message listener - treating it as
one is a silent no-op, so the ioredis test double deliberately refuses it.

**Amended (0.1.10).** "Both drivers satisfy the interfaces" was true of the
runtime and false of the types. `RedisSubscriber.subscribe` was one permissive
signature, `subscribe(channel, listener?)`, and **neither** driver is assignable
to it: `node-redis` fails on arity (its listener is required, so it cannot stand
in for a signature that may omit one) and `ioredis` fails on type (that second
parameter is the completion callback above). The snippet in this package's own
README therefore did not compile without a cast, and no test noticed - a test
double is written against our interface and so agrees with it by construction.
`subscribe` is now a **union of the two real signatures**, so a client only has
to match one arm, and the implementation widens it once beside the runtime driver
check that decides which arm to call.
`packages/transport-redis/test/driver-types.ts` holds that in place using the
real `ioredis` and `node-redis` types (dev dependencies, type-checked, never
run), so an edit that breaks a documented driver fails `typecheck` instead of a
user's build. The runtime contract, the discriminator, and the two-connection
rule are unchanged.

**3. Two connections are required, and enforced.**

A Redis connection in subscriber mode rejects `PUBLISH`. Passing the same client
twice is a misconfiguration that would otherwise fail at the first message, so
the factory throws immediately with an explanatory message.

**4. Local delivery does not go through Redis.**

`publish()` fans out to this node's own subscribers synchronously first, then
relays to Redis. This keeps single-node behavior byte-identical to
`inProcessTransport` and means a Redis hiccup cannot delay or drop delivery to
clients on the publishing node. It also makes the relay's job purely additive.

**5. `publish()` stays synchronous and never throws.**

The `Transport` contract requires it: "must not throw; must not await subscriber
work", because the message is already durably stored (durable-first, MVP §9) and
a fan-out failure must not fail the sender's request. The Redis `PUBLISH` is
therefore fire-and-forget; a rejected promise or a synchronous driver throw goes
to an `onError` callback (default `console.error`) instead of the caller.

The visible consequence of a Redis outage is scoped and acceptable: senders still
succeed, storage is still correct, clients on the publishing node still get live
events, and clients on other nodes miss events until they reconnect - at which
point `Last-Event-ID` gap-fill replays what they missed from storage (ADR 0006).
Degraded, not broken.

**6. Events are tagged with a `nodeId` to prevent echo.**

Every envelope carries the publishing node's id; inbound envelopes from this
node are dropped, because those events were already delivered locally in step 4.
Without this, every client would see each message twice.

**7. Dates are revived on receipt.**

`Message.createdAt` / `editedAt` / `deletedAt` are real `Date` instances by
contract - core does not coerce, and the storage-adapter docs call out that
date-as-ISO-string is a common adapter bug. `JSON.stringify` turns them into
strings, so the receiving node parses them back into `Date`s before handing the
event to subscribers. An unparseable value is left as-is rather than converted
into an `Invalid Date`, so corruption surfaces as itself.

**8. The envelope is versioned (`v: 1`), and malformed payloads are ignored.**

A stray publisher on a shared channel, a truncated payload, or a future wire
version must never take a node down; `decodeEnvelope` returns `null` and the
payload is dropped. The channel is configurable (default `chatpack:events`) so
one Redis instance can serve staging and production without crosstalk.

## Consequences

- **Good:** multi-node SSE works with a one-line change and no other API
  difference - `chatpack({ transport: redisTransport({ ... }) })`. Core `src/`
  needed **zero** changes, which validates the transport seam as designed in
  ADR 0006/0008.
- **Good:** typing indicators and read receipts go multi-node for free, since
  they publish ephemeral events on the same transport.
- **Good:** no Redis dependency anywhere in the tree; the test suite proves the
  cross-node path with an in-memory broker that round-trips real JSON (which is
  what catches the `Date` bug).
- **Presence state is a separate shared capability.** `redisTransport()` relays
  presence transitions, while `redisPresenceStore()` stores one expiring lease
  per SSE connection. Configure both on every node for global presence. Without
  the store, `presence()` remains process-local for backward compatibility. The
  lease design and atomic transition rules are in ADR 0025.
- **Limitation - Redis pub/sub is at-most-once.** An event published while a node
  is disconnected from Redis is gone; there is no replay buffer. This is
  tolerable precisely because durable events are replayable from storage and
  ephemeral ones are defined as droppable. A Streams-based transport with
  consumer groups could add replay later behind the same interface.
- **Trade-off:** ordering is per-publisher, not global. Redis delivers one
  publisher's messages in order, but two nodes publishing concurrently can
  interleave. Clients already sort by `seq` (ADR 0003), so this does not affect
  correctness of message order.
- **Note:** serverless platforms remain unsuitable for SSE regardless of
  transport - the function lifetime, not the fan-out, is the blocker. The
  deployment guidance in `llms.txt` keeps recommending polling there.
