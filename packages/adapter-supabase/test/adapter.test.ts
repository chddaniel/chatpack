import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { supabaseAdapter } from "../src/index";

interface FakeResponse {
  status?: number;
  body: unknown;
}

function fakeClient(
  handler: (request: {
    method: string;
    pathname: string;
    search: string;
    body: unknown;
  }) => FakeResponse,
) {
  return createClient("https://chatpack-test.supabase.co", "test-key", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        );
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const response = handler({
          method: init?.method ?? "GET",
          pathname: url.pathname,
          search: url.search,
          body,
        });
        return new Response(JSON.stringify(response.body), {
          status: response.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  });
}

const conversationRow = {
  id: "conv_1",
  type: "group",
  pair_key: null,
  name: "Team",
  visibility: "public",
  join_policy: "open",
  created_at: "2026-01-01T00:00:00.000Z",
  metadata: { color: "blue", nested: { enabled: true } },
  last_seq: 3,
  last_activity_at: "2026-01-01T00:03:00.000Z",
};

const participantRows = [
  {
    conversation_id: "conv_1",
    user_id: "bob",
    role: "member",
    joined_at: "2026-01-01T00:00:01.000Z",
    last_read_message_id: null,
  },
  {
    conversation_id: "conv_1",
    user_id: "alice",
    role: "admin",
    joined_at: "2026-01-01T00:00:00.000Z",
    last_read_message_id: "msg_1",
  },
];

const messageRow = {
  id: "msg_1",
  conversation_id: "conv_1",
  sender_id: "alice",
  body: "hello",
  role: "user",
  seq: "3",
  created_at: "2026-01-01T00:03:00.000Z",
  edited_at: null,
  deleted_at: "2026-01-01T00:04:00.000Z",
  reply_to_message_id: "msg_0",
  forwarded_from_message_id: "source_1",
  forwarded_from_conversation_id: "source_conv",
  forwarded_from_sender_id: "carol",
  metadata: { attachment: { id: "file_1" } },
};

describe("supabaseAdapter conversion and query boundaries", () => {
  it("converts nullable timestamps, bigint sequences, metadata, and participant order", async () => {
    const client = fakeClient(({ pathname }) => {
      if (pathname.endsWith("/chatpack_conversations")) return { body: [conversationRow] };
      if (pathname.endsWith("/chatpack_conversation_participants")) {
        return { body: participantRows };
      }
      throw new Error(`unexpected request ${pathname}`);
    });
    const storage = supabaseAdapter(client);

    const conversation = await storage.getConversation("conv_1");
    expect(conversation).toMatchObject({
      id: "conv_1",
      type: "group",
      visibility: "public",
      joinPolicy: "open",
      metadata: { color: "blue", nested: { enabled: true } },
    });
    expect(conversation?.createdAt).toBeInstanceOf(Date);
    expect(conversation?.participants.map((participant) => participant.userId)).toEqual([
      "alice",
      "bob",
    ]);
    expect(conversation?.participants[0]?.lastReadMessageId).toBe("msg_1");
  });

  it("maps tombstones and forwarding fields without returning date strings", async () => {
    const client = fakeClient(({ pathname }) => {
      if (pathname.endsWith("/chatpack_messages")) return { body: [messageRow] };
      throw new Error(`unexpected request ${pathname}`);
    });
    const message = await supabaseAdapter(client).getMessage("msg_1");
    expect(message).toMatchObject({
      id: "msg_1",
      seq: 3,
      body: "hello",
      deletedAt: new Date("2026-01-01T00:04:00.000Z"),
      forwardedFromMessageId: "source_1",
      metadata: { attachment: { id: "file_1" } },
    });
    expect(message?.createdAt).toBeInstanceOf(Date);
    expect(message?.editedAt).toBeNull();
  });

  it("returns empty batched lookups without touching Supabase", async () => {
    let calls = 0;
    const client = fakeClient(() => {
      calls += 1;
      return { body: [] };
    });
    const storage = supabaseAdapter(client);
    await expect(storage.getMessagesByIds([])).resolves.toEqual([]);
    await expect(storage.listReactionsByMessageIds([])).resolves.toEqual([]);
    await expect(storage.listMentionsByMessageIds([])).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it("surfaces PostgREST errors instead of returning partial data", async () => {
    const client = fakeClient(({ pathname }) => {
      if (pathname.endsWith("/chatpack_messages")) {
        return { status: 400, body: { message: "database unavailable", code: "P0001" } };
      }
      return { body: [] };
    });
    await expect(supabaseAdapter(client).getMessage("msg_1")).rejects.toThrow(
      "supabaseAdapter: get message: database unavailable",
    );
  });

  it("uses canonical search RPC output and opaque cursor encoding", async () => {
    const calls: string[] = [];
    const client = fakeClient(({ pathname }) => {
      calls.push(pathname);
      if (pathname.endsWith("/rpc/chatpack_search_messages")) {
        return {
          body: [{ ...messageRow, id: "msg_2", rank: 4, created_at: "2026-01-02T00:00:00.000Z" }],
        };
      }
      throw new Error(`unexpected request ${pathname}`);
    });
    const result = await supabaseAdapter(client).searchMessages!({
      userId: "alice",
      query: "hello",
      limit: 1,
    });
    expect(result.messages[0]?.id).toBe("msg_2");
    expect(result.messages[0]?.createdAt).toBeInstanceOf(Date);
    expect(result.nextCursor).toBeNull();
    expect(calls).toEqual(["/rest/v1/rpc/chatpack_search_messages"]);
  });

  it("keeps newest-first pagination cursor opaque and URL-safe", async () => {
    const client = fakeClient(({ pathname, search }) => {
      if (!pathname.endsWith("/chatpack_messages"))
        throw new Error(`unexpected request ${pathname}`);
      if (search.includes("seq=lt.3")) return { body: [{ ...messageRow, seq: "2", id: "msg_0" }] };
      return { body: [messageRow, { ...messageRow, seq: "2", id: "msg_0" }] };
    });
    const storage = supabaseAdapter(client);
    const first = await storage.listMessages({ conversationId: "conv_1", limit: 1 });
    expect(first.messages.map((entry) => entry.id)).toEqual(["msg_1"]);
    expect(first.nextCursor).toBe(encodeURIComponent("3"));
    const second = await storage.listMessages({
      conversationId: "conv_1",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.messages.map((entry) => entry.id)).toEqual(["msg_0"]);
  });

  it("pages conversations through the SQL RPC instead of an unbounded id filter", async () => {
    const requests: Array<{ pathname: string; body: unknown }> = [];
    const rows = [
      { ...conversationRow, id: "conv_3", last_activity_at: "2026-01-01T00:03:00.000Z" },
      { ...conversationRow, id: "conv_2", last_activity_at: "2026-01-01T00:02:00.000Z" },
      { ...conversationRow, id: "conv_1", last_activity_at: "2026-01-01T00:01:00.000Z" },
    ];
    const client = fakeClient(({ pathname, body }) => {
      requests.push({ pathname, body });
      if (pathname.endsWith("/rpc/chatpack_list_conversations")) return { body: rows };
      if (pathname.endsWith("/chatpack_conversation_participants")) return { body: [] };
      throw new Error(`unexpected request ${pathname}`);
    });
    const storage = supabaseAdapter(client);

    const first = await storage.listConversations({ userId: "alice", limit: 2 });
    expect(first.conversations.map((entry) => entry.id)).toEqual(["conv_3", "conv_2"]);
    expect(first.nextCursor).not.toBeNull();

    await storage.listConversations({ userId: "alice", limit: 2, cursor: first.nextCursor! });
    await storage.channels?.listPublicConversations({ limit: 1 });

    const rpcRequests = requests.filter(({ pathname }) =>
      pathname.endsWith("/rpc/chatpack_list_conversations"),
    );
    expect(rpcRequests).toHaveLength(3);
    expect(rpcRequests[0]?.body).toMatchObject({
      p_user_id: "alice",
      p_public_only: false,
      p_cursor_activity_at: null,
      p_cursor_id: null,
      p_limit: 3,
    });
    expect(rpcRequests[1]?.body).toMatchObject({
      p_user_id: "alice",
      p_public_only: false,
      p_cursor_activity_at: "2026-01-01T00:02:00.000Z",
      p_cursor_id: "conv_2",
      p_limit: 3,
    });
    expect(rpcRequests[2]?.body).toMatchObject({
      p_user_id: null,
      p_public_only: true,
      p_cursor_activity_at: null,
      p_cursor_id: null,
      p_limit: 2,
    });
    expect(requests.every(({ pathname }) => !pathname.endsWith("/chatpack_conversations"))).toBe(
      true,
    );
  });

  it("relies on the unique reaction key and returns complete snapshots", async () => {
    let writes = 0;
    const reactions = [
      {
        message_id: "msg_1",
        user_id: "alice",
        emoji: "👍",
        created_at: "2026-01-01T00:05:00.000Z",
      },
    ];
    const client = fakeClient(({ pathname, method }) => {
      if (pathname.endsWith("/chatpack_message_reactions") && method === "POST") {
        writes += 1;
        return { body: [] };
      }
      if (pathname.endsWith("/chatpack_message_reactions") && method === "GET") {
        return { body: reactions };
      }
      throw new Error(`unexpected request ${method} ${pathname}`);
    });
    const storage = supabaseAdapter(client);
    await expect(
      storage.addReaction({ messageId: "msg_1", userId: "alice", emoji: "👍" }),
    ).resolves.toHaveLength(1);
    await expect(
      storage.addReaction({ messageId: "msg_1", userId: "alice", emoji: "👍" }),
    ).resolves.toHaveLength(1);
    expect(writes).toBe(2);
  });

  it("uses atomic mention replacement and preserves tombstone mapping", async () => {
    const requests: Array<{ pathname: string; body: unknown }> = [];
    const updated = { ...messageRow, body: "", deleted_at: "2026-01-01T00:06:00.000Z" };
    const client = fakeClient(({ pathname, body }) => {
      requests.push({ pathname, body });
      if (pathname.endsWith("/rpc/chatpack_replace_message_mentions")) return { body: [] };
      if (pathname.endsWith("/rpc/chatpack_update_message")) return { body: [updated] };
      throw new Error(`unexpected request ${pathname}`);
    });
    const storage = supabaseAdapter(client);
    await storage.setMessageMentions({ messageId: "msg_1", userIds: ["bob", "carol"] });
    const deleted = await storage.updateMessage({
      messageId: "msg_1",
      body: "",
      deletedAt: new Date("2026-01-01T00:06:00.000Z"),
    });
    expect(deleted.body).toBe("");
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(requests[0]?.body).toMatchObject({ p_user_ids: ["bob", "carol"] });
    expect(requests[1]?.body).toMatchObject({ p_body_set: true, p_deleted_at_set: true });
  });
});
