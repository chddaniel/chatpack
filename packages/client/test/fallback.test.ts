import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@chatpack/adapter-memory";
import { chatpack } from "@chatpack/core";
import { createChatClient } from "../src/client";
import type { ChatpackEventSource } from "../src/config";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A real Chatpack backend behind an in-process `fetch`, so a poll exercises the
 * actual list/messages routes rather than a hand-written stub of them.
 */
function backend() {
  const chat = chatpack({
    storage: memoryAdapter(),
    auth: (request) => {
      const userId = request.headers.get("x-user-id");
      return userId === null ? null : { id: userId };
    },
  });
  const handler = chat.handler({ heartbeatIntervalMs: 0 });
  let requests = 0;
  const fetchAs = (userId: string) => async (input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    const requestURL = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    headers.set("x-user-id", userId);
    return handler.fetch(
      new Request("http://chatpack.invalid" + requestURL.pathname + requestURL.search, {
        ...init,
        headers,
      }),
    );
  };
  return { fetchAs, requestCount: () => requests };
}

/** An `EventSource` that connects but never opens, then errors on command. */
class FlakyEventSource implements ChatpackEventSource {
  readyState = 0;
  onopen: EventListener | null = null;
  onerror: EventListener | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
  fail(): void {
    this.onerror?.(new Event("error"));
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
}

describe("polling fallback (ADR 0016)", () => {
  it("polls new messages, edits, deletes and reactions when SSE is unavailable", async () => {
    vi.useFakeTimers();
    const { fetchAs } = backend();

    // The platform has no EventSource at all - the serverless/RN case.
    const alice = createChatClient({
      userId: "alice",
      fetch: fetchAs("alice"),
      eventSource: () => {
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "auto", intervalMs: 1000 },
    });
    const bob = createChatClient({ userId: "bob", fetch: fetchAs("bob") });

    const created = await bob.conversations.create({ otherUserId: "alice" });
    if (created.error !== null) throw new Error("setup failed");
    const conversationId = created.data.id;
    const first = await bob.messages.send({ conversationId, body: "one" });
    const second = await bob.messages.send({ conversationId, body: "two" });
    if (first.error !== null || second.error !== null) throw new Error("setup failed");

    await alice.conversations.list();
    await alice.messages.list({ conversationId });
    // Mounting a hook is what starts the fallback.
    alice.realtime.connect();

    // The failed stream is reported, but data is still live.
    expect(alice.realtime.getSnapshot()).toMatchObject({
      status: "polling",
      error: { code: "NETWORK_ERROR" },
    });

    const thread = () =>
      alice.$store.getSnapshot().messagesByConversation[conversationId]!.data!.messages;
    expect(thread().map((message) => message.body)).toEqual(["two", "one"]);

    // Everything that has no `seq` of its own, and so would be invisible to an
    // afterSeq poll (ADR 0003, ADR 0013).
    await bob.messages.send({ conversationId, body: "three" });
    await bob.messages.edit({ messageId: first.data.id, body: "one (edited)" });
    await bob.messages.delete({ messageId: second.data.id });
    await bob.messages.react({ messageId: first.data.id, emoji: "👍" });

    // Still stale: nothing reaches a polling client until the next tick.
    expect(thread().map((message) => message.body)).toEqual(["two", "one"]);

    await vi.advanceTimersByTimeAsync(1000);

    const polled = thread();
    expect(polled.map((message) => message.body)).toEqual(["three", "", "one (edited)"]);
    const edited = polled.find((message) => message.id === first.data.id)!;
    expect(edited.editedAt).not.toBeNull();
    expect(edited.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["bob"] }]);
    const deleted = polled.find((message) => message.id === second.data.id)!;
    expect(deleted.deletedAt).not.toBeNull();

    alice.dispose();
    bob.dispose();
  });

  it("refreshes unread counts and ordering on the conversations list", async () => {
    vi.useFakeTimers();
    const { fetchAs } = backend();
    const alice = createChatClient({
      userId: "alice",
      fetch: fetchAs("alice"),
      eventSource: () => {
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "auto", intervalMs: 1000 },
    });
    const bob = createChatClient({ userId: "bob", fetch: fetchAs("bob") });
    const carol = createChatClient({ userId: "carol", fetch: fetchAs("carol") });

    const withBob = await bob.conversations.create({ otherUserId: "alice" });
    const withCarol = await carol.conversations.create({ otherUserId: "alice" });
    if (withBob.error !== null || withCarol.error !== null) throw new Error("setup failed");
    await bob.messages.send({ conversationId: withBob.data.id, body: "from bob" });
    await carol.messages.send({ conversationId: withCarol.data.id, body: "from carol" });

    await alice.conversations.list();
    alice.realtime.connect();
    const list = () =>
      alice.$store
        .getSnapshot()
        .conversations.data!.conversations.map((item) => [item.id, item.unreadCount]);
    expect(list()).toEqual([
      [withCarol.data.id, 1],
      [withBob.data.id, 1],
    ]);

    await bob.messages.send({ conversationId: withBob.data.id, body: "and another" });
    await vi.advanceTimersByTimeAsync(1000);

    // Reordered by activity, with the server's count - not one the client guessed.
    expect(list()).toEqual([
      [withBob.data.id, 2],
      [withCarol.data.id, 1],
    ]);

    alice.dispose();
    bob.dispose();
    carol.dispose();
  });

  it("stops polling when the stream opens, and resumes when it drops", async () => {
    vi.useFakeTimers();
    const { fetchAs } = backend();
    const source = new FlakyEventSource();
    const alice = createChatClient({
      userId: "alice",
      fetch: fetchAs("alice"),
      eventSource: () => source,
      realtime: { mode: "auto", intervalMs: 1000 },
    });
    const bob = createChatClient({ userId: "bob", fetch: fetchAs("bob") });

    const created = await bob.conversations.create({ otherUserId: "alice" });
    if (created.error !== null) throw new Error("setup failed");
    const conversationId = created.data.id;
    await bob.messages.send({ conversationId, body: "one" });
    await alice.conversations.list();
    await alice.messages.list({ conversationId });
    alice.realtime.connect();

    // A stream that is merely connecting must not trigger the fallback.
    expect(alice.realtime.getSnapshot().status).toBe("connecting");

    source.fail();
    expect(alice.realtime.getSnapshot().status).toBe("polling");
    await bob.messages.send({ conversationId, body: "two" });
    await vi.advanceTimersByTimeAsync(1000);
    const thread = () =>
      alice.$store.getSnapshot().messagesByConversation[conversationId]!.data!.messages;
    expect(thread()).toHaveLength(2);

    // EventSource's own retry succeeds: the stream is authoritative again, the
    // fallback error clears, and no further requests are spent on polling.
    source.open();
    expect(alice.realtime.getSnapshot()).toEqual({ status: "open", error: null });
    const beforeIdle = thread().length;
    await bob.messages.send({ conversationId, body: "three" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(thread()).toHaveLength(beforeIdle);

    alice.dispose();
    bob.dispose();
  });

  it("mode: sse never polls, and mode: poll never opens a stream", async () => {
    vi.useFakeTimers();
    const { fetchAs } = backend();

    let streamAttempts = 0;
    const streamOnly = createChatClient({
      userId: "alice",
      fetch: fetchAs("alice"),
      eventSource: () => {
        streamAttempts += 1;
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "sse", intervalMs: 1000 },
    });
    const bob = createChatClient({ userId: "bob", fetch: fetchAs("bob") });
    const created = await bob.conversations.create({ otherUserId: "alice" });
    if (created.error !== null) throw new Error("setup failed");
    const conversationId = created.data.id;
    await bob.messages.send({ conversationId, body: "one" });

    await streamOnly.messages.list({ conversationId });
    streamOnly.realtime.connect();
    // Opted out: the pre-0.4 behaviour, closed with an error and no fallback.
    expect(streamOnly.realtime.getSnapshot().status).toBe("closed");
    await bob.messages.send({ conversationId, body: "two" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      streamOnly.$store.getSnapshot().messagesByConversation[conversationId]!.data!.messages,
    ).toHaveLength(1);

    const pollOnly = createChatClient({
      userId: "alice",
      fetch: fetchAs("alice"),
      eventSource: () => {
        streamAttempts += 1;
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "poll", intervalMs: 1000 },
    });
    await pollOnly.messages.list({ conversationId });
    pollOnly.realtime.connect();
    // Straight to polling with no error: nothing failed, this was the choice.
    expect(pollOnly.realtime.getSnapshot()).toEqual({ status: "polling", error: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      pollOnly.$store.getSnapshot().messagesByConversation[conversationId]!.data!.messages,
    ).toHaveLength(2);
    // One attempt total - the `sse` client's. `poll` never touched EventSource.
    expect(streamAttempts).toBe(1);

    streamOnly.dispose();
    pollOnly.dispose();
    bob.dispose();
  });

  it("stops polling on dispose and never leaves a timer running", async () => {
    vi.useFakeTimers();
    const { fetchAs, requestCount } = backend();
    const alice = createChatClient({
      userId: "alice",
      fetch: fetchAs("alice"),
      eventSource: () => {
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "poll", intervalMs: 1000 },
    });
    const bob = createChatClient({ userId: "bob", fetch: fetchAs("bob") });
    const created = await bob.conversations.create({ otherUserId: "alice" });
    if (created.error !== null) throw new Error("setup failed");
    await alice.messages.list({ conversationId: created.data.id });
    alice.realtime.connect();
    await vi.advanceTimersByTimeAsync(2000);

    alice.dispose();
    const settled = requestCount();
    // A disposed client that keeps polling is a leak that outlives the component
    // that made it, and keeps billing for it.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestCount()).toBe(settled);

    bob.dispose();
  });

  it("does not notify subscribers when a poll finds nothing new", async () => {
    vi.useFakeTimers();
    const { fetchAs } = backend();
    const alice = createChatClient({
      userId: "alice",
      fetch: fetchAs("alice"),
      eventSource: () => {
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "poll", intervalMs: 1000 },
    });
    const bob = createChatClient({ userId: "bob", fetch: fetchAs("bob") });
    const created = await bob.conversations.create({ otherUserId: "alice" });
    if (created.error !== null) throw new Error("setup failed");
    const conversationId = created.data.id;
    await bob.messages.send({ conversationId, body: "one" });
    await alice.conversations.list();
    await alice.messages.list({ conversationId });

    let notifications = 0;
    const unsubscribe = alice.$store.subscribe(() => {
      notifications += 1;
    });
    alice.realtime.connect();

    // Ten idle ticks. Every one of them would re-render every mounted component
    // if the cache reported a change for an unchanged page.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notifications).toBe(0);

    // A real change still gets through.
    await bob.messages.send({ conversationId, body: "two" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(notifications).toBeGreaterThan(0);

    unsubscribe();
    alice.dispose();
    bob.dispose();
  });

  it("polls the page size the host asked for, not the server default", async () => {
    vi.useFakeTimers();
    const { fetchAs } = backend();
    const queries: string[] = [];
    const alice = createChatClient({
      userId: "alice",
      fetch: async (input, init) => {
        queries.push(new URL(input instanceof Request ? input.url : String(input)).search);
        return fetchAs("alice")(input, init);
      },
      eventSource: () => {
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "poll", intervalMs: 1000 },
    });
    const bob = createChatClient({ userId: "bob", fetch: fetchAs("bob") });
    const created = await bob.conversations.create({ otherUserId: "alice" });
    if (created.error !== null) throw new Error("setup failed");
    const conversationId = created.data.id;
    for (let index = 0; index < 6; index += 1) {
      await bob.messages.send({ conversationId, body: "message " + index });
    }

    // A host paginating in small pages.
    await alice.conversations.list({ limit: 5 });
    await alice.messages.list({ conversationId, limit: 2 });
    expect(
      alice.$store.getSnapshot().messagesByConversation[conversationId]!.data!.messages,
    ).toHaveLength(2);

    alice.realtime.connect();
    await vi.advanceTimersByTimeAsync(0);

    // Both polls carry the host's own limit. Falling back to the server default
    // of 50 would quietly turn a 2-message page into a 6-message one.
    expect(queries).toContain("?limit=2");
    expect(queries).toContain("?limit=5");
    expect(
      alice.$store.getSnapshot().messagesByConversation[conversationId]!.data!.messages,
    ).toHaveLength(2);

    alice.dispose();
    bob.dispose();
  });

  it("keeps conversations the host paged in but a poll did not return", async () => {
    vi.useFakeTimers();
    const { fetchAs } = backend();
    const alice = createChatClient({
      userId: "alice",
      fetch: fetchAs("alice"),
      eventSource: () => {
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "poll", intervalMs: 1000 },
    });

    const conversationIds: string[] = [];
    for (const partner of ["bob", "carol", "dave"]) {
      const client = createChatClient({ userId: partner, fetch: fetchAs(partner) });
      const created = await client.conversations.create({ otherUserId: "alice" });
      if (created.error !== null) throw new Error("setup failed");
      conversationIds.push(created.data.id);
      await client.messages.send({ conversationId: created.data.id, body: "hi" });
      client.dispose();
    }

    // Page through the whole list one conversation at a time.
    const firstPage = await alice.conversations.list({ limit: 1 });
    if (firstPage.error !== null) throw new Error("list failed");
    await alice.conversations.list({ limit: 1, cursor: firstPage.data.nextCursor! });
    const loaded = () =>
      alice.$store.getSnapshot().conversations.data!.conversations.map((item) => item.id);
    expect(loaded()).toHaveLength(2);

    alice.realtime.connect();
    await vi.advanceTimersByTimeAsync(2000);

    // The poll re-reads page one (a single conversation). The second page the
    // host had already loaded must survive - replacing would erase it.
    expect(loaded()).toHaveLength(2);
    expect(new Set(loaded()).size).toBe(2);

    alice.dispose();
  });

  it("polls only the most recently used threads", async () => {
    vi.useFakeTimers();
    const { fetchAs } = backend();
    const alice = createChatClient({
      userId: "alice",
      fetch: fetchAs("alice"),
      eventSource: () => {
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "poll", intervalMs: 1000 },
    });

    // Five conversations opened over a session, each from a different partner.
    const partners = ["bob", "carol", "dave", "erin", "frank"];
    const conversationIds: string[] = [];
    for (const partner of partners) {
      const client = createChatClient({ userId: partner, fetch: fetchAs(partner) });
      const created = await client.conversations.create({ otherUserId: "alice" });
      if (created.error !== null) throw new Error("setup failed");
      conversationIds.push(created.data.id);
      await client.messages.send({ conversationId: created.data.id, body: "hi from " + partner });
      await alice.messages.list({ conversationId: created.data.id });
      client.dispose();
    }

    // Count only the URLs a tick asks for.
    const polled: string[] = [];
    const counting = createChatClient({
      userId: "alice",
      fetch: async (input, init) => {
        polled.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
        return fetchAs("alice")(input, init);
      },
      eventSource: () => {
        throw new ReferenceError("EventSource is not defined");
      },
      realtime: { mode: "poll", intervalMs: 1000 },
    });
    for (const conversationId of conversationIds) {
      await counting.messages.list({ conversationId });
    }

    counting.realtime.connect();
    // Let the immediate tick finish, then measure exactly one interval's worth.
    await vi.advanceTimersByTimeAsync(0);
    polled.length = 0;
    await vi.advanceTimersByTimeAsync(1000);

    // The list is not loaded, so only threads are polled - and only the three
    // most recent, not every conversation ever opened in this tab.
    const threadPolls = polled.filter((path) => path.endsWith("/messages"));
    expect(threadPolls).toHaveLength(3);
    for (const conversationId of conversationIds.slice(-3)) {
      expect(threadPolls.some((path) => path.includes(conversationId))).toBe(true);
    }
    expect(threadPolls.some((path) => path.includes(conversationIds[0]!))).toBe(false);

    alice.dispose();
    counting.dispose();
  });
});
