import { memoryAdapter } from "@chatpack/adapter-memory";
import { chatpack, type ChatpackHandler } from "@chatpack/core";
import { describe, expect, it, vi } from "vitest";

import { createChatClient } from "../src/client";

function clientFor(handler: ChatpackHandler, userId: string) {
  return createChatClient({
    userId,
    fetch: async (input, init) => {
      const requestURL = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.set("x-user-id", userId);
      return handler.fetch(
        new Request("http://chatpack.invalid" + requestURL.pathname + requestURL.search, {
          ...init,
          headers,
        }),
      );
    },
  });
}

function handlerFor(storage = memoryAdapter()): ChatpackHandler {
  return chatpack({
    storage,
    telemetry: false,
    auth: (request) => {
      const userId = request.headers.get("x-user-id");
      return userId === null ? null : { id: userId };
    },
  }).handler();
}

describe("invite, join-request, and channel client actions", () => {
  it("forwards every route with typed action inputs", async () => {
    const requests: Array<{ url: URL; method: string; body: unknown }> = [];
    const client = createChatClient({
      fetch: async (input, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        requests.push({
          url: new URL(input instanceof Request ? input.url : String(input)),
          method: init?.method ?? "GET",
          body,
        });
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        const payload =
          path === "/api/chat/conversations/team%2F1/invites" && init?.method !== "PATCH"
            ? init?.method === "POST"
              ? { invite: {} }
              : { invites: [] }
            : path === "/api/chat/conversations/team%2F1/join-requests"
              ? init?.method === "POST"
                ? { joinRequest: {} }
                : init?.method === "PATCH"
                  ? { joinRequest: {}, conversation: null }
                  : { joinRequests: [] }
              : path === "/api/chat/channels"
                ? { channels: [], nextCursor: null }
                : path.includes("/accept") || path.endsWith("/join")
                  ? { status: "pending", conversation: null, joinRequest: {} }
                  : path.includes("/invites/")
                    ? { invite: {} }
                    : { ok: true };
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    });

    await client.invites.create({
      conversationId: "team/1",
      expiresInSeconds: 60,
      maxUses: 2,
      requiresApproval: true,
      metadata: { source: "test" },
    });
    await client.invites.list({ conversationId: "team/1" });
    await client.invites.revoke({ conversationId: "team/1", code: "code/value" });
    await client.invites.preview({ code: "code/value" });
    await client.invites.accept({ code: "code/value", message: "please let me in" });
    await client.joinRequests.create({ conversationId: "team/1", message: "hello" });
    await client.joinRequests.list({ conversationId: "team/1", status: "pending", limit: 5 });
    await client.joinRequests.resolve({
      conversationId: "team/1",
      userId: "bob",
      decision: "deny",
    });
    await client.channels.list({ limit: 3, cursor: "next/page" });
    await client.channels.join({ conversationId: "team/1", message: "hello" });

    expect(requests.map(({ url, method }) => [method, url.pathname, url.search])).toEqual([
      ["POST", "/api/chat/conversations/team%2F1/invites", ""],
      ["GET", "/api/chat/conversations/team%2F1/invites", ""],
      ["DELETE", "/api/chat/conversations/team%2F1/invites/code%2Fvalue", ""],
      ["GET", "/api/chat/invites/code%2Fvalue", ""],
      ["POST", "/api/chat/invites/code%2Fvalue/accept", ""],
      ["POST", "/api/chat/conversations/team%2F1/join-requests", ""],
      ["GET", "/api/chat/conversations/team%2F1/join-requests", "?status=pending&limit=5"],
      ["PATCH", "/api/chat/conversations/team%2F1/join-requests", ""],
      ["GET", "/api/chat/channels", "?limit=3&cursor=next%2Fpage"],
      ["POST", "/api/chat/conversations/team%2F1/join", ""],
    ]);
    expect(requests[0]?.body).toEqual({
      expiresInSeconds: 60,
      maxUses: 2,
      requiresApproval: true,
      metadata: { source: "test" },
    });
    expect(requests[4]?.body).toEqual({ message: "please let me in" });
    expect(requests[7]?.body).toEqual({ userId: "bob", decision: "deny" });
  });

  it("supports open and approval invite flows, including cache updates", async () => {
    const handler = handlerFor();
    const alice = clientFor(handler, "alice");
    const bob = clientFor(handler, "bob");

    const group = await alice.conversations.createGroup({ name: "Invites" });
    if (group.error !== null) throw new Error("group setup failed");
    await bob.conversations.list();

    const openInvite = await alice.invites.create({
      conversationId: group.data.id,
      maxUses: 1,
    });
    if (openInvite.error !== null) throw new Error("invite setup failed");

    const preview = await bob.invites.preview({ code: openInvite.data.code });
    expect(preview).toMatchObject({
      error: null,
      data: { conversationId: group.data.id, alreadyParticipant: false },
    });

    const joined = await bob.invites.accept({ code: openInvite.data.code });
    expect(joined.error).toBeNull();
    if (joined.error !== null || joined.data.status !== "joined") {
      throw new Error("invite acceptance failed");
    }
    expect(joined.data.conversation.participants.map((item) => item.userId)).toContain("bob");
    expect(bob.$store.getSnapshot().conversations.data?.conversations[0]?.id).toBe(group.data.id);

    // A replay by the admitted user remains truthful even after the one use is spent.
    const replay = await bob.invites.accept({ code: openInvite.data.code });
    expect(replay).toMatchObject({ error: null, data: { status: "joined" } });

    const approvalGroup = await alice.conversations.createGroup({
      name: "Approval",
      visibility: "public",
      joinPolicy: "approval",
    });
    if (approvalGroup.error !== null) throw new Error("approval group setup failed");
    const approvalInvite = await alice.invites.create({
      conversationId: approvalGroup.data.id,
      requiresApproval: true,
    });
    if (approvalInvite.error !== null) throw new Error("approval invite setup failed");

    const pending = await bob.invites.accept({ code: approvalInvite.data.code, message: "hello" });
    expect(pending).toMatchObject({
      error: null,
      data: { status: "pending", conversation: null, joinRequest: { status: "pending" } },
    });
    const repeated = await bob.invites.accept({ code: approvalInvite.data.code });
    expect(repeated).toMatchObject({
      error: null,
      data: { status: "pending", joinRequest: { status: "pending" } },
    });
    if (
      pending.error !== null ||
      pending.data.status !== "pending" ||
      repeated.error !== null ||
      repeated.data.status !== "pending"
    ) {
      throw new Error("pending setup failed");
    }
    expect(repeated.data.joinRequest.id).toBe(pending.data.joinRequest.id);

    const queue = await alice.joinRequests.list({
      conversationId: approvalGroup.data.id,
      status: "pending",
    });
    expect(queue).toMatchObject({ error: null, data: { joinRequests: [{ userId: "bob" }] } });

    const denied = await alice.joinRequests.resolve({
      conversationId: approvalGroup.data.id,
      userId: "bob",
      decision: "deny",
    });
    expect(denied).toMatchObject({
      error: null,
      data: { joinRequest: { status: "denied" }, conversation: null },
    });

    // Denial is not a block: a fresh request can be submitted and approved.
    const fresh = await bob.joinRequests.create({
      conversationId: approvalGroup.data.id,
      message: "asking again",
    });
    expect(fresh).toMatchObject({ error: null, data: { status: "pending" } });
    const approved = await alice.joinRequests.resolve({
      conversationId: approvalGroup.data.id,
      userId: "bob",
      decision: "approve",
    });
    expect(approved).toMatchObject({
      error: null,
      data: { joinRequest: { status: "approved" }, conversation: { id: approvalGroup.data.id } },
    });
    expect(alice.$store.getSnapshot().conversationsById[approvalGroup.data.id]?.data?.id).toBe(
      approvalGroup.data.id,
    );

    const alreadyResolved = await alice.joinRequests.resolve({
      conversationId: approvalGroup.data.id,
      userId: "bob",
      decision: "deny",
    });
    expect(alreadyResolved.error?.code).toBe("JOIN_REQUEST_NOT_FOUND");
  });

  it("lists and joins channels with open and pending policies", async () => {
    const handler = handlerFor();
    const alice = clientFor(handler, "alice");
    const bob = clientFor(handler, "bob");

    const open = await alice.conversations.createGroup({
      name: "Open channel",
      visibility: "public",
      joinPolicy: "open",
    });
    const approval = await alice.conversations.createGroup({
      name: "Approval channel",
      visibility: "public",
      joinPolicy: "approval",
    });
    const privateGroup = await alice.conversations.createGroup({ name: "Private" });
    if (open.error !== null || approval.error !== null || privateGroup.error !== null) {
      throw new Error("channel setup failed");
    }

    const directory = await bob.channels.list();
    expect(directory).toMatchObject({
      error: null,
      data: {
        channels: [
          { conversationId: approval.data.id, requestPending: false, alreadyParticipant: false },
          { conversationId: open.data.id, requestPending: false, alreadyParticipant: false },
        ],
      },
    });
    expect(
      directory.data?.channels.some((item) => item.conversationId === privateGroup.data.id),
    ).toBe(false);

    const joined = await bob.channels.join({ conversationId: open.data.id });
    expect(joined).toMatchObject({ error: null, data: { status: "joined" } });

    const pending = await bob.channels.join({
      conversationId: approval.data.id,
      message: "please approve",
    });
    expect(pending).toMatchObject({
      error: null,
      data: { status: "pending", conversation: null, joinRequest: { inviteCode: null } },
    });

    const afterRequest = await bob.channels.list();
    expect(
      afterRequest.data?.channels.find((item) => item.conversationId === approval.data.id),
    ).toMatchObject({
      requestPending: true,
    });
  });

  it("preserves not-found, expired, and unsupported feature errors", async () => {
    const handler = handlerFor();
    const alice = clientFor(handler, "alice");
    const bob = clientFor(handler, "bob");

    expect((await alice.invites.preview({ code: "missing" })).error?.code).toBe("INVITE_NOT_FOUND");

    vi.useFakeTimers();
    try {
      const group = await alice.conversations.createGroup({ name: "Expiring" });
      if (group.error !== null) throw new Error("group setup failed");
      const invite = await alice.invites.create({
        conversationId: group.data.id,
        expiresInSeconds: 1,
      });
      if (invite.error !== null) throw new Error("invite setup failed");
      vi.advanceTimersByTime(1_001);
      expect((await bob.invites.accept({ code: invite.data.code })).error?.code).toBe(
        "INVITE_EXPIRED",
      );
    } finally {
      vi.useRealTimers();
    }

    const inviteStorage = memoryAdapter();
    delete inviteStorage.invites;
    const noInvites = clientFor(handlerFor(inviteStorage), "alice");
    expect((await noInvites.invites.list({ conversationId: "group" })).error?.code).toBe(
      "INVITES_UNSUPPORTED",
    );

    const channelStorage = memoryAdapter();
    delete channelStorage.channels;
    const noChannels = clientFor(handlerFor(channelStorage), "alice");
    expect((await noChannels.channels.list()).error?.code).toBe("CHANNELS_UNSUPPORTED");
  });
});
