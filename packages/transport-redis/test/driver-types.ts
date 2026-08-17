/**
 * Driver compatibility, asserted by the type checker.
 *
 * `test/fake-redis.ts` proves the *runtime* works, but a fake is written against
 * our own interface, so it agrees with us by construction. It therefore cannot
 * catch the failure this file exists for: `RedisSubscriber` once described a
 * `subscribe(channel, listener?)` that neither `ioredis` nor `node-redis`
 * satisfies, so the snippet in this package's README did not compile - while
 * every test stayed green.
 *
 * The only thing that catches that is a real driver's own published types, so
 * both are devDependencies. Nothing here runs: the file is deliberately not
 * named `*.test.ts` (vitest ignores it), the clients are `declare`d rather than
 * constructed, and `tsconfig.json` includes `test`, so `pnpm typecheck` is what
 * checks it. A compile error here means a user following the README gets one too.
 *
 * @module
 */

import type Redis from "ioredis";
import type { createClient } from "redis";

import type { RedisPublisher, RedisSubscriber, RedisTransportOptions } from "../src/index";

/** `new Redis(url)`. */
declare const ioredisClient: Redis;
/** `createClient({ url })` - node-redis v4+, which spells its API differently. */
declare const nodeRedisClient: ReturnType<typeof createClient>;

export const ioredisPublisher: RedisPublisher = ioredisClient;
export const ioredisSubscriber: RedisSubscriber = ioredisClient;
export const nodeRedisPublisher: RedisPublisher = nodeRedisClient;
export const nodeRedisSubscriber: RedisSubscriber = nodeRedisClient;

/** The README snippet, in the shape a caller actually writes it. */
export const ioredisOptions: RedisTransportOptions = {
  publisher: ioredisClient,
  subscriber: ioredisClient,
};

export const nodeRedisOptions: RedisTransportOptions = {
  publisher: nodeRedisClient,
  subscriber: nodeRedisClient,
};
