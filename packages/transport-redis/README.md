# @chatpack/transport-redis

Redis pub/sub transport for [Chatpack](https://github.com/chddaniel/chatpack) -
**multi-node SSE fan-out**.

Chatpack's default transport is in-process: correct for one server, silently
wrong for two. With two app servers behind a load balancer, Alice's `/stream`
connection lives on node A while Bob's `POST /messages` is handled by node B -
and node B has no way to reach Alice's stream. This package relays every event
through a Redis channel so all nodes see all events.

```bash
npm install @chatpack/transport-redis ioredis
```

## Usage

```ts
import { chatpack } from "@chatpack/core";
import { drizzleAdapter } from "@chatpack/adapter-drizzle";
import { redisPresenceStore, redisTransport } from "@chatpack/transport-redis";
import { presence } from "@chatpack/core/plugins";
import Redis from "ioredis";

// Two connections: a Redis client in subscriber mode cannot issue PUBLISH.
const publisher = new Redis(process.env.REDIS_URL!);
export const chat = chatpack({
  storage: drizzleAdapter(db),
  auth: async (req) => getSessionUser(req),
  transport: redisTransport({
    publisher,
    subscriber: new Redis(process.env.REDIS_URL!),
  }),
  plugins: [presence({ store: redisPresenceStore({ client: publisher }) })],
});
```

That is the entire change. Every route, event, and client behaves identically -
`Transport` is the seam core was designed around, so nothing else moves.

Works with `node-redis` too:

```ts
import { createClient } from "redis";

const publisher = createClient({ url: process.env.REDIS_URL });
const subscriber = publisher.duplicate();
await Promise.all([publisher.connect(), subscriber.connect()]);

const transport = redisTransport({ publisher, subscriber });
```

## Options

| Option       | Default           | Notes                                                                     |
| ------------ | ----------------- | ------------------------------------------------------------------------- |
| `publisher`  | _(required)_      | Redis client used to `PUBLISH`.                                           |
| `subscriber` | _(required)_      | A **second** client, used to `SUBSCRIBE`. Passing the same one throws.    |
| `channel`    | `chatpack:events` | Override to isolate staging from production on a shared Redis.            |
| `nodeId`     | random            | This process's id, used to drop its own echoed events. Override in tests. |
| `onError`    | `console.error`   | `(error, "publish" \| "receive" \| "subscribe")`. Wire to your tracker.   |

`redisTransport()` returns the standard `Transport` plus `nodeId` and
`close()` (unsubscribes and drops local listeners; the connections are yours to
close, since this package did not open them).

## What you get, and what you don't

**Multi-node:** messages (`message.created` / `updated` / `deleted`), reactions
(`reaction.added` / `reaction.removed`), group membership changes
(`participant.added` / `participant.removed` / `conversation.updated`), typing
indicators, and read receipts. All of them travel on the transport -
`TransportEvent` has four members (`ChatEvent`, `ReactionEvent`,
`ConversationEvent`, `EphemeralEvent`) and this package relays all four, reviving
the `Date` fields on whichever snapshot the event carries: a message, or a
conversation and its participants.

**Multi-node: `presence()` with `redisPresenceStore()`.** Pass the same shared
store to every node. It tracks one expiring lease per SSE connection, so
`GET /presence` and online/offline transitions reflect all nodes. The transport
publisher must be a normal Redis connection because the presence store runs
atomic `EVAL` scripts; keep the subscriber connection dedicated to `SUBSCRIBE`.

Without a shared store, presence remains process-local for backward compatibility.

## Real Redis integration test

The normal suite uses an in-memory Redis double. To execute the Lua scripts
against Redis itself, start a Redis server with `redis-cli` available and run:

```bash
CHATPACK_REDIS_URL=redis://127.0.0.1:6379 \
  pnpm --filter @chatpack/transport-redis test -- redis.integration.test.ts
```

When `redis-cli` exists only inside Docker, use
`CHATPACK_REDIS_CLI=docker CHATPACK_REDIS_CLI_ARGS="exec redis redis-cli"`.

## Failure behavior

A Redis outage degrades live delivery; it never fails a send.

`publish()` is synchronous and never throws, as the `Transport` contract
requires - the message is already in storage before anyone is notified
(durable-first). Local subscribers are notified inline, so clients on the
publishing node are unaffected by Redis health. The `PUBLISH` itself is
fire-and-forget, and failures go to `onError`.

So during an outage: senders succeed, history stays correct, same-node clients
stay live, and other-node clients miss events until they reconnect - at which
point `Last-Event-ID` gap-fill replays what they missed from storage.

Redis pub/sub is at-most-once (no replay buffer), which is why durable events
remain replayable from storage and ephemeral ones are defined as droppable.
Reaction and conversation events sit in between: they're stored, but they have no
`seq`, so `Last-Event-ID` can't replay them either - a reaction or a membership
change missed during an outage shows up on the next conversation refetch
([ADR 0013](../../docs/decisions/0013-reactions-and-replies.md),
[ADR 0017](../../docs/decisions/0017-group-conversations.md)).

## Notes

- **Serverless is still not a fit for SSE**, whatever the transport - function
  lifetime is the blocker, not fan-out. Poll `GET /conversations/:id/messages`
  there.
- **Ordering** is per-publisher; two nodes publishing concurrently can
  interleave. Clients sort by `seq`, so message order stays correct.
- **Sticky sessions are not required.** Any node can serve any stream.
- **Presence needs both shared pieces.** Configure `redisTransport()` for event
  fan-out and `redisPresenceStore()` for connection state. Lease expiry removes
  connections from crashed nodes, so snapshots become offline; the default
  five-second offline grace absorbs reconnect flaps.

## Links

- [Chatpack docs](https://docs.chatpack.dev)
- [ADR 0012 - Redis transport](../../docs/decisions/0012-redis-transport.md)
- [ADR 0006 - SSE gap-fill](../../docs/decisions/0006-sse-gap-fill.md)

MIT
