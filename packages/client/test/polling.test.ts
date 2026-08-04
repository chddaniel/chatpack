import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoller, MIN_POLL_INTERVAL_MS } from "../src/polling";

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
});

/**
 * Let the microtask that clears the in-flight flag run. A tick settles in a
 * promise callback, so a synchronous `advanceTimersByTime` would find the
 * previous tick still "in flight" and skip every following beat.
 */
const settle = (): Promise<void> => Promise.resolve();

/** Minimal stand-in for the parts of `document` the poller touches. */
function stubDocument(visibilityState: "visible" | "hidden") {
  const listeners = new Set<() => void>();
  const stub = {
    visibilityState,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    /** Flip visibility and fire `visibilitychange`, as a browser would. */
    setVisibility(next: "visible" | "hidden") {
      stub.visibilityState = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
  (globalThis as { document?: unknown }).document = stub;
  return stub;
}

describe("createPoller", () => {
  it("ticks immediately, then on the interval, and stops when told", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const poller = createPoller({
      intervalMs: 5000,
      onTick: () => {
        ticks += 1;
        return Promise.resolve();
      },
    });

    expect(poller.isRunning()).toBe(false);
    poller.start();
    // The first tick is synchronous: a fallback that waited a full interval
    // would leave the user staring at stale data for its whole duration.
    expect(ticks).toBe(1);
    expect(poller.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(ticks).toBe(3);

    poller.stop();
    expect(poller.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toBe(3);
  });

  it("clamps a too-tight interval to the floor", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const poller = createPoller({
      intervalMs: 10,
      onTick: () => {
        ticks += 1;
        return Promise.resolve();
      },
    });
    poller.start();
    await settle();
    ticks = 0;

    // Asking for 10ms must not produce 100 requests per second.
    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_MS - 1);
    expect(ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks).toBe(1);
    poller.stop();
  });

  it("never runs two ticks at once", async () => {
    vi.useFakeTimers();
    let started = 0;
    let release = (): void => undefined;
    const poller = createPoller({
      intervalMs: 1000,
      onTick: () => {
        started += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    poller.start();
    expect(started).toBe(1);

    // Three beats pass while the first request is still in flight. A poller that
    // fired anyway would pile up requests on exactly the slow connection that
    // can least afford them.
    await vi.advanceTimersByTimeAsync(3000);
    expect(started).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(2);
    poller.stop();
  });

  it("does not poll a hidden tab, and catches up when it is shown again", async () => {
    vi.useFakeTimers();
    const doc = stubDocument("visible");
    let ticks = 0;
    const poller = createPoller({
      intervalMs: 1000,
      onTick: () => {
        ticks += 1;
        return Promise.resolve();
      },
    });

    poller.start();
    await settle();
    expect(ticks).toBe(1);

    doc.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    // A background tab polling forever is how a chat client quietly becomes the
    // most expensive route on someone's server.
    expect(ticks).toBe(1);

    doc.setVisibility("visible");
    // Shown again: refresh at once rather than after another full interval.
    expect(ticks).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(3);

    poller.stop();
    expect(doc.listenerCount()).toBe(0);
  });

  it("does not start a second timer when start() is called repeatedly", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const poller = createPoller({
      intervalMs: 1000,
      onTick: () => {
        ticks += 1;
        return Promise.resolve();
      },
    });

    // A flapping stream calls start() on every error.
    poller.start();
    poller.start();
    poller.start();
    expect(ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(2);
    poller.stop();
  });

  it("does not re-tick when restarted inside the same interval", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const poller = createPoller({
      intervalMs: 5000,
      onTick: () => {
        ticks += 1;
        return Promise.resolve();
      },
    });

    poller.start();
    await settle();
    expect(ticks).toBe(1);
    // stop/start pairs come from a stream that connects and drops repeatedly.
    // Each restart must not buy another immediate request.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      poller.stop();
      poller.start();
      await settle();
    }
    expect(ticks).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(ticks).toBe(2);
    poller.stop();
  });

  it("keeps polling after a tick rejects", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const poller = createPoller({
      intervalMs: 1000,
      onTick: () => {
        ticks += 1;
        return Promise.reject(new Error("network down"));
      },
    });

    // `onTick` is documented as never rejecting, but a rejection must degrade to
    // "this tick did nothing" rather than killing the timer for good - and must
    // not escape as an unhandled rejection, which this test would also catch.
    poller.start();
    expect(ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks).toBe(3);
    poller.stop();
  });
});
