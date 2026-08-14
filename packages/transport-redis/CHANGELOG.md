# @chatpack/transport-redis

## 0.1.9

### Patch Changes

- 5d6f1c8: Add the community links (Discord, X, docs, Discussions) to every package README and to
  `llms.txt`, so the fastest way to reach the maintainers is on the npm page of whichever
  package you installed. No code changes.
- Updated dependencies [5d6f1c8]
- Updated dependencies [7803136]
  - @chatpack/core@0.12.0

## 0.1.8

### Patch Changes

- Credit the project's co-owners by name rather than GitHub handle in package
  `contributors` metadata and the credits surfaces: DanielCH and DavidCH.
- Updated dependencies
  - @chatpack/core@0.11.2

## 0.1.7

### Patch Changes

- Fill in the `author` and `contributors` metadata, which was empty on every
  published package. Yeabsra Habtu is credited as author (principal author of the
  library), with chddaniel, Ikem Peter and chhddavid as contributors. Registry
  maintainers and publish rights are unchanged. No runtime or API changes —
  package metadata only, so authorship shows up on npm and in registry mirrors.
- Updated dependencies
  - @chatpack/core@0.11.1

## 0.1.6

### Patch Changes

- Updated dependencies [172259f]
  - @chatpack/core@0.11.0

## 0.1.5

### Patch Changes

- Updated dependencies [9287d75]
  - @chatpack/core@0.10.0

## 0.1.4

### Patch Changes

- Updated dependencies [a9e6dd7]
  - @chatpack/core@0.9.0

## 0.1.3

### Patch Changes

- Updated dependencies [06b4e67]
  - @chatpack/core@0.8.0

## 0.1.2

### Patch Changes

- 1c92af5: Relay conversation events across nodes. `decodeEnvelope` required a `message`
  field on every non-ephemeral event, so the new `ConversationEvent` category
  (`participant.added`, `participant.removed`, `conversation.updated`) decoded to
  `null` and every membership change was silently dropped between nodes. The
  decoder now handles all four `TransportEvent` members and revives dates on
  whichever snapshot the event carries - a message, or a conversation and each of
  its participants' `joinedAt`.
- Updated dependencies [1c92af5]
  - @chatpack/core@0.7.0

## 0.1.1

### Patch Changes

- Updated dependencies [76ec258]
- Updated dependencies [99e22c4]
  - @chatpack/core@0.6.0

## 0.1.0

### Minor Changes

- 118bae1: New package: `@chatpack/transport-redis` - a Redis pub/sub `Transport` for
  multi-node SSE fan-out.

  Run two or more app servers behind a load balancer and `/stream` keeps working:
  every event published on any node reaches streams held by every node. One
  option changes; the routes, events, and client contract stay identical.

  ```ts
  import { redisTransport } from "@chatpack/transport-redis";
  import Redis from "ioredis";

  const chat = chatpack({
    storage: drizzleAdapter(db),
    auth,
    transport: redisTransport({
      publisher: new Redis(process.env.REDIS_URL!),
      subscriber: new Redis(process.env.REDIS_URL!),
    }),
  });
  ```

  - **Bring your own client** - works with `ioredis` or `node-redis` v4+; this
    package has no Redis dependency of its own.
  - **Two connections required** - a client in subscriber mode cannot `PUBLISH`,
    so passing the same client twice throws at startup rather than failing on the
    first message.
  - **Local delivery is unaffected by Redis** - `publish()` stays synchronous,
    never throws, and notifies local subscribers before the relay; failures
    surface via `onError`, never on the request path.
  - **`Date` fields survive the wire** - `createdAt` / `editedAt` / `deletedAt`
    are revived as real `Date` instances on receive.
  - Own-node echoes are dropped by `nodeId`, so each event is delivered exactly
    once per process.

  `presence()` remains per-node: it counts live SSE connections in process
  memory, which shared events don't change. Durable events, `typing()`, and
  `receipts()` all relay. Rationale in ADR 0012; guide at
  `/docs/realtime/multi-node`.

### Patch Changes

- Updated dependencies [146e966]
  - @chatpack/core@0.5.0
