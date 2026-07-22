/**
 * M2 HTTP suite: the whole REST API driven through `chat.handler()` with
 * Web-standard Requests — exactly what curl exercises in the M2 DoD:
 * "curl can find-or-create, send, and list over HTTP with auth enforced."
 *
 * Auth simulation: the test auth hook reads an `x-user-id` header. Real apps
 * resolve a session/JWT instead — same shape, one async function.
 */
import { describe, expect, it } from "vitest";

import { chatpack, type ChatpackHandler } from "@chatpack/core";
import { memoryAdapter } from "../src/index";

const BASE = "http://test.local/api/chat";

function createHttpChat(): ChatpackHandler {
  const chat = chatpack({
    storage: memoryAdapter(),
    telemetry: false,
    auth: (request) => {
      const userId = request.headers.get("x-user-id");
      return userId ? { id: userId } : null;
    },
  });
  return chat.handler();
}

function get(handler: ChatpackHandler, path: string, userId?: string): Promise<Response> {
  return handler.GET(
    new Request(`${BASE}${path}`, {
      headers: userId ? { "x-user-id": userId } : {},
    }),
  );
}

function send(
  handler: ChatpackHandler,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  userId?: string,
  body?: unknown,
): Promise<Response> {
  return handler.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(userId ? { "x-user-id": userId } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

describe("M2 Definition of Done — find-or-create, send, list over HTTP with auth", () => {
  it("runs the full curl flow", async () => {
    const handler = createHttpChat();

    // alice creates a conversation with bob
    const createRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "bob",
    });
    expect(createRes.status).toBe(200);
    const { conversation } = (await createRes.json()) as {
      conversation: { id: string; participants: { userId: string }[] };
    };
    expect(conversation.participants.map((p) => p.userId).sort()).toEqual(["alice", "bob"]);

    // alice sends a message
    const sendRes = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "alice",
      { body: "hey bob!" },
    );
    expect(sendRes.status).toBe(201);

    // bob replies
    await send(handler, "POST", `/conversations/${conversation.id}/messages`, "bob", {
      body: "hey alice!",
    });

    // bob lists the history
    const listRes = await get(handler, `/conversations/${conversation.id}/messages`, "bob");
    expect(listRes.status).toBe(200);
    const history = (await listRes.json()) as { messages: { body: string }[] };
    expect(history.messages.map((m) => m.body)).toEqual(["hey alice!", "hey bob!"]);
  });
});

describe("auth enforcement", () => {
  it("returns 401 without an authenticated user", async () => {
    const handler = createHttpChat();

    const res = await get(handler, "/conversations");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");

    const post = await send(handler, "POST", "/conversations", undefined, {
      otherUserId: "bob",
    });
    expect(post.status).toBe(401);
  });

  it("refuses to build a handler without an auth hook", () => {
    const chat = chatpack({ storage: memoryAdapter(), telemetry: false });
    expect(() => chat.handler()).toThrowError(/auth/);
  });
});

describe("permissions over HTTP", () => {
  it("maps FORBIDDEN_* to 403 and hides other people's conversations", async () => {
    const handler = createHttpChat();
    const createRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "bob",
    });
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    const read = await get(handler, `/conversations/${conversation.id}/messages`, "mallory");
    expect(read.status).toBe(403);

    const write = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "mallory",
      { body: "let me in" },
    );
    expect(write.status).toBe(403);
    const body = (await write.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN_WRITE");
  });
});

describe("validation and error mapping", () => {
  it("400 for malformed JSON, missing fields, and bad roles", async () => {
    const handler = createHttpChat();

    const malformed = await handler.POST(
      new Request(`${BASE}/conversations`, {
        method: "POST",
        headers: { "x-user-id": "alice", "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(malformed.status).toBe(400);

    const missing = await send(handler, "POST", "/conversations", "alice", {});
    expect(missing.status).toBe(400);

    const createRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "bob",
    });
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };
    const badRole = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "alice",
      { body: "hi", role: "admin" },
    );
    expect(badRole.status).toBe(400);

    const badLimit = await get(handler, "/conversations?limit=abc", "alice");
    expect(badLimit.status).toBe(400);
  });

  it("404 for unknown resources and unknown routes", async () => {
    const handler = createHttpChat();

    expect((await get(handler, "/conversations/nope", "alice")).status).toBe(404);
    expect((await get(handler, "/definitely-not-a-route", "alice")).status).toBe(404);
    const outside = await handler.GET(
      new Request("http://test.local/other/path", { headers: { "x-user-id": "alice" } }),
    );
    expect(outside.status).toBe(404);
  });
});

describe("remaining routes", () => {
  it("edit, delete, read-state, and conversation listing work over HTTP", async () => {
    const handler = createHttpChat();

    const createRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "bob",
    });
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    const sendRes = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "alice",
      { body: "helo" },
    );
    const { message } = (await sendRes.json()) as { message: { id: string } };

    // edit
    const editRes = await send(handler, "PATCH", `/messages/${message.id}`, "alice", {
      body: "hello",
    });
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as { message: { body: string; editedAt: string } };
    expect(edited.message.body).toBe("hello");
    expect(edited.message.editedAt).not.toBeNull();

    // bob cannot edit alice's message → 403
    const forbiddenEdit = await send(handler, "PATCH", `/messages/${message.id}`, "bob", {
      body: "hax",
    });
    expect(forbiddenEdit.status).toBe(403);

    // read-state
    const readRes = await send(handler, "POST", `/conversations/${conversation.id}/read`, "bob", {
      messageId: message.id,
    });
    expect(readRes.status).toBe(200);
    const convRes = await get(handler, `/conversations/${conversation.id}`, "bob");
    const fresh = (await convRes.json()) as {
      conversation: { participants: { userId: string; lastReadMessageId: string | null }[] };
    };
    expect(fresh.conversation.participants.find((p) => p.userId === "bob")?.lastReadMessageId).toBe(
      message.id,
    );

    // list conversations
    const listRes = await get(handler, "/conversations", "alice");
    const list = (await listRes.json()) as { conversations: unknown[]; nextCursor: unknown };
    expect(list.conversations).toHaveLength(1);

    // delete → tombstone
    const deleteRes = await send(handler, "DELETE", `/messages/${message.id}`, "alice");
    expect(deleteRes.status).toBe(200);
    const deleted = (await deleteRes.json()) as { message: { deletedAt: string; body: string } };
    expect(deleted.message.deletedAt).not.toBeNull();
    expect(deleted.message.body).toBe("");

    // editing a deleted message → 409
    const editDeleted = await send(handler, "PATCH", `/messages/${message.id}`, "alice", {
      body: "resurrect",
    });
    expect(editDeleted.status).toBe(409);
  });

  it("supports pagination query params", async () => {
    const handler = createHttpChat();
    const createRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "bob",
    });
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    for (let i = 1; i <= 5; i++) {
      await send(handler, "POST", `/conversations/${conversation.id}/messages`, "alice", {
        body: `m${i}`,
      });
    }

    const page1Res = await get(
      handler,
      `/conversations/${conversation.id}/messages?limit=2`,
      "bob",
    );
    const page1 = (await page1Res.json()) as {
      messages: { body: string }[];
      nextCursor: string;
    };
    expect(page1.messages.map((m) => m.body)).toEqual(["m5", "m4"]);

    const page2Res = await get(
      handler,
      `/conversations/${conversation.id}/messages?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      "bob",
    );
    const page2 = (await page2Res.json()) as { messages: { body: string }[] };
    expect(page2.messages.map((m) => m.body)).toEqual(["m3", "m2"]);
  });

  it("respects a custom basePath", async () => {
    const chat = chatpack({
      storage: memoryAdapter(),
      telemetry: false,
      auth: (request) => {
        const userId = request.headers.get("x-user-id");
        return userId ? { id: userId } : null;
      },
    });
    const handler = chat.handler({ basePath: "/chat" });

    const res = await handler.POST(
      new Request("http://test.local/chat/conversations", {
        method: "POST",
        headers: { "x-user-id": "alice", "content-type": "application/json" },
        body: JSON.stringify({ otherUserId: "bob" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
