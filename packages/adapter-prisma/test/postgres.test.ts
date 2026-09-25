import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client/client.js";
import { chatpack, type ChatpackInstance, type StorageAdapter } from "@chatpack/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaAdapter } from "../src/index.js";
import pg from "pg";
import { readFile } from "node:fs/promises";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
let client: PrismaClient;
let chat: ChatpackInstance;
let storage: StorageAdapter;
let pool: pg.Pool;
const runId = crypto.randomUUID().replaceAll("-", "");

suite("Prisma PostgreSQL adapter", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(
      await readFile(
        new URL("../prisma/migrations/0001_chatpack/migration.sql", import.meta.url),
        "utf8",
      ),
    );
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    storage = prismaAdapter(client);
    chat = chatpack({ storage, telemetry: false });
  });

  afterAll(async () => {
    await client.$disconnect();
    await pool.end();
  });

  it("converges concurrent DMs and allocates message sequences", async () => {
    const conversations = await Promise.all(
      Array.from({ length: 8 }, () =>
        chat.api.getOrCreateConversation({
          userId: `alice-${runId}`,
          otherUserId: `bob-${runId}`,
        }),
      ),
    );
    expect(new Set(conversations.map((conversation) => conversation.id)).size).toBe(1);
    const sent = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        chat.api.sendMessage({
          userId: index % 2 ? `alice-${runId}` : `bob-${runId}`,
          conversationId: conversations[0]!.id,
          body: `message-${index}`,
        }),
      ),
    );
    expect(sent.map((message) => message.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it("creates groups atomically and preserves mention replacement", async () => {
    const group = await chat.api.createGroupConversation({
      userId: `alice-${runId}`,
      userIds: [`bob-${runId}`],
      name: "team",
    });
    const message = await chat.api.sendMessage({
      userId: `alice-${runId}`,
      conversationId: group.id,
      body: "hello @bob",
      mentions: [`bob-${runId}`],
    });
    await chat.api.editMessage({
      userId: `alice-${runId}`,
      messageId: message.id,
      body: "hello",
      mentions: [],
    });
    const stored = await client.chatpackMessageMention.findMany({
      where: { messageId: message.id },
    });
    expect(stored).toHaveLength(0);
  });

  it("enforces invite caps and converges active bans", async () => {
    const group = await chat.api.createGroupConversation({
      userId: `owner-${runId}`,
      userIds: [],
      name: "limited",
    });
    const invite = await storage.invites!.createInvite({
      conversationId: group.id,
      code: `invite-cap-${runId}`,
      createdBy: `owner-${runId}`,
      expiresAt: null,
      maxUses: 3,
      requiresApproval: false,
      metadata: {},
    });
    const redemptions = await Promise.all(
      Array.from({ length: 8 }, () => storage.invites!.consumeInvite(invite.code)),
    );
    expect(redemptions.filter((result) => result !== null)).toHaveLength(3);
    const bans = await Promise.all(
      Array.from({ length: 6 }, () =>
        storage.moderation!.createBan({
          userId: `bad-user-${runId}`,
          createdByUserId: `owner-${runId}`,
          reason: "spam",
          expiresAt: null,
        }),
      ),
    );
    expect(new Set(bans.map((ban) => ban.id)).size).toBe(1);
    expect(await storage.moderation!.isUserBanned(`bad-user-${runId}`)).not.toBeNull();
  });
});
