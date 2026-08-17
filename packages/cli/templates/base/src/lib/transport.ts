import { redisTransport } from "@chatpack/transport-redis";
import type { Transport } from "@chatpack/core";
// The **named** export, not the default one. ioredis is CommonJS, and the Hono
// and Express starters are ESM on `module: "nodenext"`, where a default import
// of a CJS module is typed as the module object itself - `new Redis(url)` then
// fails to compile with "this expression is not constructable". `{ Redis }` is
// the same class and works in every module setting, including Next's.
import { Redis } from "ioredis";

/**
 * Cross-process real-time fan-out, when `REDIS_URL` is set.
 *
 * Chatpack's default transport is in-process: a message sent on one server is
 * only pushed to the SSE streams held by that same server. That is correct for
 * one process and wrong the moment you scale to two - the second server's
 * clients would see nothing until they reconnected and gap-filled from the
 * database.
 *
 * Returning `undefined` leaves the default in place, so a starter with no
 * Redis configured still works exactly as before.
 *
 * Two connections are required, not one: `subscribe` puts an ioredis client
 * into subscriber mode, where it can no longer issue `publish`.
 */
export function createApplicationTransport(): Transport | undefined {
  const url = process.env.REDIS_URL;
  if (!url) return undefined;
  return redisTransport({
    publisher: new Redis(url),
    subscriber: new Redis(url),
    onError: (error) => {
      console.error("[chatpack] redis transport error", error);
    },
  });
}
