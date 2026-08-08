import { describe, expect, it } from "vitest";
import { createChatpackCache, type ChatpackCache } from "../src/store-cache";
import type { ClientConversation, ClientMessage, ClientMessagePage } from "../src/wire";

const page: ClientMessagePage = {
  messages: [
    {
      id: "m1",
      conversationId: "c1",
      senderId: "alice",
      body: "hello",
      role: "user",
      metadata: {},
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      editedAt: null,
      deletedAt: null,
      replyToMessageId: null,
      replyTo: null,
      reactions: [],
    },
  ],
  nextCursor: null,
};

const conversation: ClientConversation = {
  id: "c1",
  type: "direct",
  pairKey: "alice:bob",
  name: null,
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  participants: [],
  unreadCount: 0,
};

function makeConversation(id: string, unreadCount = 0): ClientConversation {
  return { ...conversation, id, unreadCount };
}

function makeMessage(overrides: Partial<ClientMessage> & { seq: number }): ClientMessage {
  return { ...page.messages[0]!, senderId: "bob", ...overrides, id: overrides.id ?? "m_new" };
}

/** A loaded two-conversation list, oldest-active last (server ordering). */
function cacheWithList(unread: [number, number] = [0, 0]) {
  const cache = createChatpackCache({ userId: "alice" });
  cache.setConversations(
    {
      data: {
        conversations: [makeConversation("c1", unread[0]), makeConversation("c2", unread[1])],
        nextCursor: null,
      },
      error: null,
    },
    false,
  );
  return cache;
}

const listOf = (cache: ReturnType<typeof cacheWithList>) =>
  cache.getSnapshot().conversations.data!.conversations.map((c) => [c.id, c.unreadCount]);

describe("conversations list realtime updates", () => {
  it("reorders to most-recently-active and bumps unreadCount for another party's message", () => {
    const cache = cacheWithList();
    cache.applyEvent({
      type: "message.created",
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", seq: 1 }),
    });
    expect(listOf(cache)).toEqual([
      ["c2", 1],
      ["c1", 0],
    ]);
  });

  it("reorders but does not bump unread for the viewer's own message", () => {
    const cache = cacheWithList();
    cache.applyEvent({
      type: "message.created",
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", seq: 1, senderId: "alice" }),
    });
    expect(listOf(cache)).toEqual([
      ["c2", 0],
      ["c1", 0],
    ]);
  });

  it("does not bump unread for a locally sent message when userId is unknown", () => {
    const cache = createChatpackCache();
    cache.setConversations(
      { data: { conversations: [makeConversation("c1")], nextCursor: null }, error: null },
      false,
    );
    const own = makeMessage({ seq: 1, senderId: "alice" });
    cache.applyEvent(
      { type: "message.created", conversationId: "c1", message: own },
      {
        local: true,
      },
    );
    // The local echo taught the cache who the viewer is, so their own message
    // arriving again over the stream must still not count as unread.
    cache.applyEvent({ type: "message.created", conversationId: "c1", message: own });
    expect(listOf(cache)).toEqual([["c1", 0]]);
  });

  it("counts a redelivered event only once (at-least-once delivery)", () => {
    const cache = cacheWithList();
    const event = {
      type: "message.created" as const,
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", seq: 1 }),
    };
    cache.applyEvent(event);
    cache.applyEvent(event);
    expect(listOf(cache)).toEqual([
      ["c2", 1],
      ["c1", 0],
    ]);
  });

  it("does not re-count a message already present in fetched history", () => {
    const cache = cacheWithList();
    const message = makeMessage({ conversationId: "c2", seq: 7 });
    cache.setMessages(
      "c2",
      { data: { messages: [message], nextCursor: null }, error: null },
      false,
    );
    cache.applyEvent({ type: "message.created", conversationId: "c2", message });
    expect(listOf(cache)).toEqual([
      ["c1", 0],
      ["c2", 0],
    ]);
  });

  it("leaves ordering and unread alone for edits and deletes", () => {
    const cache = cacheWithList([0, 3]);
    const message = makeMessage({ conversationId: "c2", seq: 9 });
    cache.applyEvent({ type: "message.updated", conversationId: "c2", message });
    cache.applyEvent({ type: "message.deleted", conversationId: "c2", message });
    expect(listOf(cache)).toEqual([
      ["c1", 0],
      ["c2", 3],
    ]);
  });

  it("clears unreadCount on markRead of the newest known message", () => {
    const cache = cacheWithList();
    const message = makeMessage({ conversationId: "c2", id: "m9", seq: 4 });
    cache.applyEvent({ type: "message.created", conversationId: "c2", message });
    cache.setMessages(
      "c2",
      { data: { messages: [message], nextCursor: null }, error: null },
      false,
    );
    cache.applyRead("c2", "m9");
    expect(listOf(cache)).toEqual([
      ["c2", 0],
      ["c1", 0],
    ]);
  });

  it("keeps unreadCount when markRead targets an older message", () => {
    const cache = cacheWithList();
    const older = makeMessage({ conversationId: "c2", id: "m1", seq: 1 });
    const newer = makeMessage({ conversationId: "c2", id: "m2", seq: 2 });
    cache.setMessages(
      "c2",
      { data: { messages: [newer, older], nextCursor: null }, error: null },
      false,
    );
    cache.applyEvent({
      type: "message.created",
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", id: "m3", seq: 3 }),
    });
    cache.applyRead("c2", "m1");
    expect(listOf(cache)).toEqual([
      ["c2", 1],
      ["c1", 0],
    ]);
  });

  it("mirrors unread changes onto a per-id conversation entry", () => {
    const cache = cacheWithList();
    cache.setConversation("c2", { data: makeConversation("c2", 0), error: null });
    cache.applyEvent({
      type: "message.created",
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", seq: 1 }),
    });
    expect(cache.getSnapshot().conversationsById["c2"]?.data?.unreadCount).toBe(1);
    cache.applyRead("c2", "m_new");
    expect(cache.getSnapshot().conversationsById["c2"]?.data?.unreadCount).toBe(0);
  });

  it("reports a conversation missing from a loaded list, and prepends it once", () => {
    const cache = cacheWithList();
    expect(cache.isMissingFromConversations("c3")).toBe(true);
    expect(cache.isMissingFromConversations("c1")).toBe(false);
    cache.prependConversation(makeConversation("c3", 1));
    cache.prependConversation(makeConversation("c3", 1));
    expect(listOf(cache)).toEqual([
      ["c3", 1],
      ["c1", 0],
      ["c2", 0],
    ]);
  });

  it("never reports missing while the list has not loaded", () => {
    const cache = createChatpackCache();
    expect(cache.isMissingFromConversations("c1")).toBe(false);
  });

  it("ignores events for a list that has not loaded yet", () => {
    const cache = createChatpackCache({ userId: "alice" });
    cache.applyEvent({
      type: "message.created",
      conversationId: "c1",
      message: makeMessage({ seq: 1 }),
    });
    expect(cache.getSnapshot().conversations.data).toBeNull();
  });
});

describe("reactions in the cache (ADR 0013)", () => {
  const summary = [{ emoji: "👍", count: 1, userIds: ["bob"] }];

  it("replaces the reaction set of a loaded message", () => {
    const cache = createChatpackCache({ userId: "alice" });
    cache.setMessages("c1", { data: page, error: null }, false);

    cache.applyEvent({
      type: "reaction.added",
      conversationId: "c1",
      actorId: "bob",
      emoji: "👍",
      message: { ...page.messages[0]!, reactions: summary },
    });
    const messages = cache.getSnapshot().messagesByConversation["c1"]!.data!.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.reactions).toEqual(summary);

    // The event carries the whole set, so applying it twice is idempotent...
    cache.applyEvent({
      type: "reaction.added",
      conversationId: "c1",
      actorId: "bob",
      emoji: "👍",
      message: { ...page.messages[0]!, reactions: summary },
    });
    expect(cache.getSnapshot().messagesByConversation["c1"]!.data!.messages[0]!.reactions).toEqual(
      summary,
    );

    // ...and a removal is just another full snapshot.
    cache.applyEvent({
      type: "reaction.removed",
      conversationId: "c1",
      actorId: "bob",
      emoji: "👍",
      message: { ...page.messages[0]!, reactions: [] },
    });
    expect(cache.getSnapshot().messagesByConversation["c1"]!.data!.messages[0]!.reactions).toEqual(
      [],
    );
  });

  it("never reorders the list, bumps unread, or advances the seq baseline", () => {
    const cache = cacheWithList([0, 3]);
    cache.setConversation("c2", { data: makeConversation("c2", 3), error: null });
    const message = makeMessage({ conversationId: "c2", id: "m9", seq: 9 });
    cache.setMessages(
      "c2",
      { data: { messages: [message], nextCursor: null }, error: null },
      false,
    );

    cache.applyEvent({
      type: "reaction.added",
      conversationId: "c2",
      actorId: "bob",
      emoji: "👍",
      message: { ...message, reactions: summary },
    });

    // c2 is still second, still at 3 unread.
    expect(listOf(cache)).toEqual([
      ["c1", 0],
      ["c2", 3],
    ]);
    expect(cache.getSnapshot().conversationsById["c2"]?.data?.unreadCount).toBe(3);

    // The seq baseline is untouched, so a *later* real message at the same seq
    // still counts as new rather than being swallowed as a replay.
    cache.applyEvent({
      type: "message.created",
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", id: "m10", seq: 10 }),
    });
    expect(listOf(cache)).toEqual([
      ["c2", 4],
      ["c1", 0],
    ]);
  });

  it("drops a reaction on a message outside the loaded page", () => {
    const cache = createChatpackCache({ userId: "alice" });
    cache.setMessages("c1", { data: page, error: null }, false);

    // Older message, not in this page: splicing it in would put a lone message
    // into a paginated list where it does not belong.
    cache.applyEvent({
      type: "reaction.added",
      conversationId: "c1",
      actorId: "bob",
      emoji: "👍",
      message: makeMessage({ id: "m_old", seq: 0, reactions: summary }),
    });
    const messages = cache.getSnapshot().messagesByConversation["c1"]!.data!.messages;
    expect(messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("ignores a reaction for a conversation with no loaded thread", () => {
    const cache = createChatpackCache({ userId: "alice" });
    cache.applyReactions("c1", { ...page.messages[0]!, reactions: summary });
    expect(cache.getSnapshot().messagesByConversation["c1"]).toBeUndefined();
  });

  it("keeps every other field of the cached message", () => {
    const cache = createChatpackCache({ userId: "alice" });
    const reply = makeMessage({
      id: "m2",
      seq: 2,
      body: "quoting",
      replyToMessageId: "m1",
      replyTo: { id: "m1", senderId: "alice", excerpt: "hello", deleted: false },
    });
    cache.setMessages("c1", { data: { messages: [reply], nextCursor: null }, error: null }, false);

    // A reaction event is applied field-by-field, so a stale body or preview in
    // the event payload can never clobber what the cache already has.
    cache.applyReactions("c1", { ...reply, body: "STALE", replyTo: null, reactions: summary });
    expect(cache.getSnapshot().messagesByConversation["c1"]!.data!.messages[0]).toMatchObject({
      body: "quoting",
      replyTo: { id: "m1", excerpt: "hello" },
      reactions: summary,
    });
  });
});

describe("cache loading flags", () => {
  it("treats a never-loaded id as pending, not refetching", () => {
    const cache = createChatpackCache();
    cache.setMessagesLoading("c1");
    expect(cache.getSnapshot().messagesByConversation["c1"]).toMatchObject({
      isPending: true,
      isRefetching: false,
    });
    cache.setConversationLoading("c1");
    expect(cache.getSnapshot().conversationsById["c1"]).toMatchObject({
      isPending: true,
      isRefetching: false,
    });
  });

  it("treats a reload of cached data as refetching, not pending", () => {
    const cache = createChatpackCache();
    cache.setMessages("c1", { data: page, error: null }, false);
    cache.setMessagesLoading("c1");
    expect(cache.getSnapshot().messagesByConversation["c1"]).toMatchObject({
      isPending: false,
      isRefetching: true,
    });
    cache.setConversation("c1", { data: conversation, error: null });
    cache.setConversationLoading("c1");
    expect(cache.getSnapshot().conversationsById["c1"]).toMatchObject({
      isPending: false,
      isRefetching: true,
    });
  });
});

describe("message search cache", () => {
  it("keeps queries isolated and appends ranked pages without re-sorting", () => {
    const cache = createChatpackCache();
    const first = makeMessage({ id: "ranked-first", seq: 1, body: "needle needle" });
    const second = makeMessage({ id: "ranked-second", seq: 99, body: "needle" });
    const other = makeMessage({ id: "other", seq: 50, body: "different" });

    cache.setMessageSearch(
      " needle ",
      { data: { messages: [first], nextCursor: "page-2" }, error: null },
      false,
    );
    cache.setMessageSearch(
      "needle",
      { data: { messages: [second], nextCursor: null }, error: null },
      true,
    );
    cache.setMessageSearch(
      "different",
      { data: { messages: [other], nextCursor: null }, error: null },
      false,
    );

    const searches = cache.getSnapshot().messageSearches;
    expect(searches["needle"]?.data?.messages.map((message) => message.id)).toEqual([
      "ranked-first",
      "ranked-second",
    ]);
    expect(searches["different"]?.data?.messages.map((message) => message.id)).toEqual(["other"]);
  });

  it("preserves previous data when a refetch fails", () => {
    const cache = createChatpackCache();
    cache.setMessageSearch("needle", { data: page, error: null }, false);
    cache.setMessageSearchLoading("needle");
    cache.setMessageSearch(
      "needle",
      {
        data: null,
        error: { code: "SEARCH_UNSUPPORTED", message: "unsupported", status: 501 },
      },
      false,
    );

    expect(cache.getSnapshot().messageSearches["needle"]).toMatchObject({
      data: page,
      error: { code: "SEARCH_UNSUPPORTED", status: 501 },
      isPending: false,
      isRefetching: false,
    });
  });
});

describe("polled page merges (ADR 0016)", () => {
  const threadOf = (cache: ChatpackCache) =>
    cache.getSnapshot().messagesByConversation["c1"]!.data!.messages;

  it("ignores a polled page for a thread that has never loaded", () => {
    const cache = createChatpackCache({ userId: "alice" });
    // Nothing is mounted, so there is no page to merge into - and inserting one
    // would fabricate a thread the host never asked for.
    cache.applyPolledMessages("c1", page);
    expect(cache.getSnapshot().messagesByConversation["c1"]).toBeUndefined();
  });

  it("notifies once for a real change and never for an unchanged page", () => {
    const cache = createChatpackCache({ userId: "alice" });
    cache.setMessages("c1", { data: page, error: null }, false);
    let notifications = 0;
    cache.subscribe(() => {
      notifications += 1;
    });

    cache.applyPolledMessages("c1", page);
    cache.applyPolledMessages("c1", { ...page, messages: [...page.messages] });
    expect(notifications).toBe(0);

    const arrived = makeMessage({ id: "m2", seq: 2, body: "new" });
    cache.applyPolledMessages("c1", { messages: [arrived, ...page.messages], nextCursor: null });
    expect(notifications).toBe(1);
    expect(threadOf(cache).map((m) => m.id)).toEqual(["m2", "m1"]);
  });

  it("applies an edit, a delete and a reaction - none of which change seq", () => {
    const cache = createChatpackCache({ userId: "alice" });
    cache.setMessages("c1", { data: page, error: null }, false);
    const changed: ClientMessage = {
      ...page.messages[0]!,
      body: "edited",
      editedAt: "2026-01-01T00:01:00.000Z",
      deletedAt: "2026-01-01T00:02:00.000Z",
      reactions: [{ emoji: "👍", count: 1, userIds: ["bob"] }],
    };
    cache.applyPolledMessages("c1", { messages: [changed], nextCursor: null });
    expect(threadOf(cache)[0]).toMatchObject({
      body: "edited",
      editedAt: "2026-01-01T00:01:00.000Z",
      deletedAt: "2026-01-01T00:02:00.000Z",
      reactions: [{ emoji: "👍", count: 1, userIds: ["bob"] }],
    });
  });

  it("detects a reaction removed by another user without any other change", () => {
    const cache = createChatpackCache({ userId: "alice" });
    const reacted: ClientMessage = {
      ...page.messages[0]!,
      reactions: [{ emoji: "👍", count: 2, userIds: ["bob", "alice"] }],
    };
    cache.setMessages(
      "c1",
      { data: { messages: [reacted], nextCursor: null }, error: null },
      false,
    );
    // Same emoji, same message, one fewer user: a naive length-only comparison
    // would miss this and leave a stale count on screen.
    const dropped: ClientMessage = {
      ...reacted,
      reactions: [{ emoji: "👍", count: 1, userIds: ["alice"] }],
    };
    cache.applyPolledMessages("c1", { messages: [dropped], nextCursor: null });
    expect(threadOf(cache)[0]!.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["alice"] }]);
  });

  it("does not splice an older message into a page that was never paged back to", () => {
    const cache = createChatpackCache({ userId: "alice" });
    const newest = makeMessage({ id: "m5", seq: 5 });
    cache.setMessages("c1", { data: { messages: [newest], nextCursor: "m5" }, error: null }, false);
    // A poll page that reaches further back than the loaded page. Inserting the
    // gap-fillers would produce a thread that looks complete but is not.
    cache.applyPolledMessages("c1", {
      messages: [newest, makeMessage({ id: "m4", seq: 4 }), makeMessage({ id: "m3", seq: 3 })],
      nextCursor: null,
    });
    expect(threadOf(cache).map((m) => m.id)).toEqual(["m5"]);
    // The loaded cursor survives: the host can still page backwards.
    expect(cache.getSnapshot().messagesByConversation["c1"]!.data!.nextCursor).toBe("m5");
  });

  it("does not count a polled message as unread", () => {
    const cache = createChatpackCache({ userId: "alice" });
    cache.setConversations(
      { data: { conversations: [makeConversation("c1", 0)], nextCursor: null }, error: null },
      false,
    );
    cache.setMessages("c1", { data: page, error: null }, false);
    const arrived = makeMessage({ id: "m2", seq: 2 });
    cache.applyPolledMessages("c1", { messages: [arrived, ...page.messages], nextCursor: null });

    // The polled list is authoritative for unread; the thread merge must not
    // also bump it, or a polling client would double-count every message.
    expect(listOf(cache)).toEqual([["c1", 0]]);
    // And a stream event replaying the same message is already accounted for.
    cache.applyEvent({ type: "message.created", conversationId: "c1", message: arrived });
    expect(listOf(cache)).toEqual([["c1", 0]]);
  });

  it("takes the polled order and unread counts, keeping unmentioned conversations", () => {
    const cache = cacheWithList([1, 3]);
    let notifications = 0;
    cache.subscribe(() => {
      notifications += 1;
    });

    cache.applyPolledConversations({
      conversations: [makeConversation("c2", 4)],
      nextCursor: null,
    });
    // c2 leads on the server's ordering with the server's count; c1 - which the
    // host had loaded but page one did not mention - keeps its place behind it.
    expect(listOf(cache)).toEqual([
      ["c2", 4],
      ["c1", 1],
    ]);
    expect(notifications).toBe(1);

    // An identical page is not a change.
    cache.applyPolledConversations({
      conversations: [makeConversation("c2", 4)],
      nextCursor: null,
    });
    expect(notifications).toBe(1);
  });

  it("ignores a polled list before the host has loaded one", () => {
    const cache = createChatpackCache({ userId: "alice" });
    cache.applyPolledConversations({
      conversations: [makeConversation("c1", 1)],
      nextCursor: null,
    });
    expect(cache.getSnapshot().conversations.data).toBeNull();
  });

  it("notices a read-state change made in another tab", () => {
    const cache = cacheWithList([0, 0]);
    let notifications = 0;
    cache.subscribe(() => {
      notifications += 1;
    });
    const read: ClientConversation = {
      ...makeConversation("c1", 0),
      participants: [
        {
          conversationId: "c1",
          userId: "alice",
          role: "admin",
          joinedAt: "x",
          lastReadMessageId: "m9",
        },
      ],
    };
    // `unreadCount` is unchanged, so only the participant read-state reveals it.
    cache.applyPolledConversations({
      conversations: [read, makeConversation("c2", 0)],
      nextCursor: null,
    });
    expect(notifications).toBe(1);
  });

  it("notices a group rename", () => {
    const cache = cacheWithList([0, 0]);
    let notifications = 0;
    cache.subscribe(() => {
      notifications += 1;
    });

    // Nothing about read-state moved - only the name did (ADR 0017). Without
    // comparing it, a polling client would render the old title forever.
    cache.applyPolledConversations({
      conversations: [
        { ...makeConversation("c1", 0), type: "group", pairKey: null, name: "Standup" },
        makeConversation("c2", 0),
      ],
      nextCursor: null,
    });
    expect(notifications).toBe(1);
  });

  it("notices a role change", () => {
    const cache = cacheWithList([0, 0]);
    const member: ClientConversation = {
      ...makeConversation("c1", 0),
      type: "group",
      pairKey: null,
      participants: [
        {
          conversationId: "c1",
          userId: "bob",
          role: "member",
          joinedAt: "x",
          lastReadMessageId: null,
        },
      ],
    };
    cache.setConversations(
      {
        data: { conversations: [member, makeConversation("c2", 0)], nextCursor: null },
        error: null,
      },
      false,
    );
    let notifications = 0;
    cache.subscribe(() => {
      notifications += 1;
    });

    // Same membership, same read-state: `role` is the only field that moved.
    cache.applyPolledConversations({
      conversations: [
        {
          ...member,
          participants: [{ ...member.participants[0]!, role: "admin" }],
        },
        makeConversation("c2", 0),
      ],
      nextCursor: null,
    });
    expect(notifications).toBe(1);
  });
});

describe("conversation events (ADR 0017)", () => {
  const groupSnapshot = (name: string | null, userIds: [string, string][]) => ({
    id: "c1",
    type: "group" as const,
    pairKey: null,
    name,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    participants: userIds.map(([userId, role]) => ({
      conversationId: "c1",
      userId,
      role: role as "admin" | "member",
      joinedAt: "2026-01-01T00:00:00.000Z",
      lastReadMessageId: null,
    })),
  });

  function groupCache(unread = 3): ChatpackCache {
    const cache = createChatpackCache({ userId: "alice" });
    const loaded: ClientConversation = {
      ...groupSnapshot("Old name", [["alice", "admin"]]),
      unreadCount: unread,
    };
    cache.setConversations(
      {
        data: { conversations: [loaded, makeConversation("c2", 1)], nextCursor: null },
        error: null,
      },
      false,
    );
    cache.setConversation("c1", { data: loaded, error: null });
    return cache;
  }

  it("merges a rename into the list and the single query, keeping unreadCount", () => {
    const cache = groupCache(3);
    cache.applyEvent({
      type: "conversation.updated",
      conversationId: "c1",
      actorId: "alice",
      affectedUserIds: [],
      conversation: groupSnapshot("New name", [["alice", "admin"]]),
    });
    const snapshot = cache.getSnapshot();
    const inList = snapshot.conversations.data!.conversations.find((c) => c.id === "c1")!;
    // The event snapshot carries no unreadCount (it fans out to everyone), so
    // the viewer's cached count must survive the merge.
    expect(inList.name).toBe("New name");
    expect(inList.unreadCount).toBe(3);
    expect(snapshot.conversationsById["c1"]!.data!.name).toBe("New name");
    expect(snapshot.conversationsById["c1"]!.data!.unreadCount).toBe(3);
  });

  it("merges membership and role changes without reordering the list", () => {
    const cache = groupCache();
    cache.applyEvent({
      type: "participant.added",
      conversationId: "c1",
      actorId: "alice",
      affectedUserIds: ["bob"],
      conversation: groupSnapshot("Old name", [
        ["alice", "admin"],
        ["bob", "member"],
      ]),
    });
    const list = cache.getSnapshot().conversations.data!.conversations;
    // Membership changes bump no server-side activity, so the order must hold.
    expect(list.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(list[0]!.participants.map((p) => p.userId)).toEqual(["alice", "bob"]);
  });

  it("does not notify subscribers for a redelivered identical snapshot", () => {
    const cache = groupCache();
    const event = {
      type: "participant.added" as const,
      conversationId: "c1",
      actorId: "alice",
      affectedUserIds: ["bob"],
      conversation: groupSnapshot("Old name", [
        ["alice", "admin"],
        ["bob", "member"],
      ]),
    };
    cache.applyEvent(event);
    let notifications = 0;
    cache.subscribe(() => {
      notifications += 1;
    });
    // At-least-once delivery: the same event again must change nothing.
    cache.applyEvent(event);
    expect(notifications).toBe(0);
  });

  it("ignores snapshots for conversations the cache never loaded", () => {
    const cache = cacheWithList();
    let notifications = 0;
    cache.subscribe(() => {
      notifications += 1;
    });
    cache.applyEvent({
      type: "conversation.updated",
      conversationId: "c_unknown",
      actorId: "alice",
      affectedUserIds: [],
      conversation: { ...groupSnapshot("Elsewhere", [["alice", "admin"]]), id: "c_unknown" },
    });
    expect(notifications).toBe(0);
  });

  it("drops the conversation everywhere when the viewer is removed", () => {
    const cache = groupCache();
    cache.setMessages(
      "c1",
      { data: { messages: page.messages, nextCursor: null }, error: null },
      false,
    );
    cache.applyEvent({
      type: "participant.removed",
      conversationId: "c1",
      actorId: "bob",
      affectedUserIds: ["alice"],
      conversation: groupSnapshot("Old name", [["bob", "admin"]]),
    });
    const snapshot = cache.getSnapshot();
    expect(snapshot.conversations.data!.conversations.map((c) => c.id)).toEqual(["c2"]);
    expect(snapshot.conversationsById["c1"]).toBeUndefined();
    expect(snapshot.messagesByConversation["c1"]).toBeUndefined();
  });

  it("keeps the conversation when someone else is removed", () => {
    const cache = groupCache();
    cache.applyEvent({
      type: "participant.added",
      conversationId: "c1",
      actorId: "alice",
      affectedUserIds: ["bob"],
      conversation: groupSnapshot("Old name", [
        ["alice", "admin"],
        ["bob", "member"],
      ]),
    });
    cache.applyEvent({
      type: "participant.removed",
      conversationId: "c1",
      actorId: "alice",
      affectedUserIds: ["bob"],
      conversation: groupSnapshot("Old name", [["alice", "admin"]]),
    });
    const inList = cache
      .getSnapshot()
      .conversations.data!.conversations.find((c) => c.id === "c1")!;
    expect(inList.participants.map((p) => p.userId)).toEqual(["alice"]);
  });

  it("keeps (not drops) the conversation when the viewer is unknown", () => {
    const cache = createChatpackCache();
    const loaded: ClientConversation = {
      ...groupSnapshot("Old name", [
        ["alice", "admin"],
        ["bob", "member"],
      ]),
      unreadCount: 0,
    };
    cache.setConversations(
      { data: { conversations: [loaded], nextCursor: null }, error: null },
      false,
    );
    // Without a viewer id the cache cannot tell "alice left" from "I left" -
    // merging the snapshot is the safe wrong-at-worst-until-refetch choice.
    cache.applyEvent({
      type: "participant.removed",
      conversationId: "c1",
      actorId: "alice",
      affectedUserIds: ["alice"],
      conversation: groupSnapshot("Old name", [["bob", "admin"]]),
    });
    const list = cache.getSnapshot().conversations.data!.conversations;
    expect(list.map((c) => c.id)).toEqual(["c1"]);
    expect(list[0]!.participants.map((p) => p.userId)).toEqual(["bob"]);
  });
});
