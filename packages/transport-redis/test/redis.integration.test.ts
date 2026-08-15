/**
 * Optional integration coverage for the actual Redis Lua scripts.
 *
 * Run with a Redis server and redis-cli available:
 * CHATPACK_REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @chatpack/transport-redis test -- redis.integration.test.ts
 * For Docker-only redis-cli, set CHATPACK_REDIS_CLI=docker and
 * CHATPACK_REDIS_CLI_ARGS="exec redis redis-cli".
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { redisPresenceStore, type RedisPresenceIoredisClient } from "../src/index";

type RedisResult = null | number | string | RedisResult[];

const execFileAsync = promisify(execFile);
const redisUrl = process.env["CHATPACK_REDIS_URL"];
const redisCli = process.env["CHATPACK_REDIS_CLI"] ?? "redis-cli";
const redisCliArgs = (process.env["CHATPACK_REDIS_CLI_ARGS"] ?? "")
  .split(" ")
  .filter((arg) => arg !== "");
const describeRedis = redisUrl ? describe : describe.skip;

class RedisCliPresenceClient implements RedisPresenceIoredisClient {
  async eval(
    script: string,
    numberOfKeys: number,
    ...keysAndArguments: string[]
  ): Promise<RedisResult> {
    if (!redisUrl) throw new Error("CHATPACK_REDIS_URL is required.");
    const { stdout } = await execFileAsync(
      redisCli,
      [
        ...redisCliArgs,
        "-u",
        redisUrl,
        "--json",
        "EVAL",
        script,
        String(numberOfKeys),
        ...keysAndArguments,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout.trim()) as RedisResult;
  }

  async command(...args: string[]): Promise<RedisResult> {
    if (!redisUrl) throw new Error("CHATPACK_REDIS_URL is required.");
    const { stdout } = await execFileAsync(redisCli, [
      ...redisCliArgs,
      "-u",
      redisUrl,
      "--json",
      ...args,
    ]);
    return JSON.parse(stdout.trim()) as RedisResult;
  }
}

describeRedis("redisPresenceStore - real Redis scripts", () => {
  it("executes atomic leases and transitions against Redis", async () => {
    const client = new RedisCliPresenceClient();
    const userId = `integration-${process.pid}-${Date.now()}`;
    const prefix = `chatpack:test:${userId}`;
    const store = redisPresenceStore({ client, keyPrefix: prefix });
    const now = new Date("2026-08-15T10:00:00.000Z");
    const keys = [
      `${prefix}:leases:{${encodeURIComponent(userId)}}`,
      `${prefix}:last-seen:{${encodeURIComponent(userId)}}`,
      `${prefix}:pending:{${encodeURIComponent(userId)}}`,
    ];

    try {
      const first = await store.open({
        userId,
        connectionId: "node-a/stream-1",
        now,
        leaseTtlMs: 30_000,
      });
      const second = await store.open({
        userId,
        connectionId: "node-b/stream-2",
        now,
        leaseTtlMs: 30_000,
      });
      expect(first.transition).toBe("online");
      expect(second.transition).toBeNull();
      expect((await store.get({ userId, now })).online).toBe(true);

      await store.close({
        userId,
        connectionId: "node-a/stream-1",
        now: new Date(now.getTime() + 1),
        offlineDelayMs: 0,
      });
      const lastClose = await store.close({
        userId,
        connectionId: "node-b/stream-2",
        now: new Date(now.getTime() + 2),
        offlineDelayMs: 0,
      });
      expect(lastClose.offlineToken).not.toBeNull();
      await expect(
        store.finalizeOffline({
          userId,
          token: lastClose.offlineToken!,
          now: new Date(now.getTime() + 3),
        }),
      ).resolves.toMatchObject({ transition: "offline" });
      expect((await store.get({ userId, now: new Date(now.getTime() + 3) })).online).toBe(false);
    } finally {
      await client.command("DEL", ...keys);
    }
  });
});
