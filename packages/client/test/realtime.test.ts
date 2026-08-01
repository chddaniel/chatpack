import { describe, expect, it } from "vitest";
import { createRealtime } from "../src/realtime";
import type { ChatpackEventSource } from "../src/config";

class MockEventSource implements ChatpackEventSource {
  readyState = 0;
  onopen: EventListener | null = null;
  onerror: EventListener | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("realtime", () => {
  it("uses one lazy stream and dispatches durable and ephemeral events", () => {
    const source = new MockEventSource();
    const received: string[] = [];
    const realtime = createRealtime({
      url: "/api/chat/stream",
      credentials: "same-origin",
      eventSource: () => source,
      eventTypes: ["message.created", "typing.started"],
      onEvent: (event) => received.push(event.type),
    });

    expect(realtime.getSnapshot().status).toBe("idle");
    const unsubscribe = realtime.subscribe((event) => received.push(event.type));
    realtime.connect();
    expect(realtime.getSnapshot().status).toBe("connecting");
    source.onopen?.(new Event("open"));
    expect(realtime.getSnapshot().status).toBe("open");
    source.emit("typing.started", {
      type: "typing.started",
      ephemeral: true,
      senderId: "bob",
      conversationId: "c1",
      payload: { isTyping: true },
      at: "2026-01-01T00:00:00.000Z",
    });
    source.emit("message.created", {
      type: "message.created",
      conversationId: "c1",
      message: {
        id: "m1",
        conversationId: "c1",
        senderId: "bob",
        body: "hello",
        role: "user",
        metadata: {},
        seq: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
    });
    expect(received).toEqual([
      "typing.started",
      "typing.started",
      "message.created",
      "message.created",
    ]);
    unsubscribe();
    realtime.disconnect();
    expect(realtime.getSnapshot().status).toBe("closed");
  });
});
