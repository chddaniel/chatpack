import { describe, expect, it, vi } from "vitest";

import { pairKeyFor } from "../src/chatpack";
import { ChatpackError } from "../src/errors";
import {
  TelemetryCounters,
  resolveTelemetryEnabled,
  startTelemetryFlusher,
  type TelemetryPayload,
} from "../src/telemetry";
import { VERSION } from "../src/version";

describe("pairKeyFor", () => {
  it("is deterministic regardless of argument order", () => {
    expect(pairKeyFor("alice", "bob")).toBe("alice:bob");
    expect(pairKeyFor("bob", "alice")).toBe("alice:bob");
  });
});

describe("ChatpackError", () => {
  it("carries a stable machine-readable code", () => {
    const err = new ChatpackError("FORBIDDEN_WRITE", "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ChatpackError");
    expect(err.code).toBe("FORBIDDEN_WRITE");
    expect(err.message).toBe("nope");
  });
});

describe("telemetry", () => {
  it("defaults to enabled", () => {
    delete process.env["CHATPACK_TELEMETRY"];
    expect(resolveTelemetryEnabled(undefined)).toBe(true);
  });

  it("is disabled via config flag", () => {
    delete process.env["CHATPACK_TELEMETRY"];
    expect(resolveTelemetryEnabled(false)).toBe(false);
  });

  it("is disabled via CHATPACK_TELEMETRY=0 even if config enables it", () => {
    process.env["CHATPACK_TELEMETRY"] = "0";
    expect(resolveTelemetryEnabled(true)).toBe(false);
    delete process.env["CHATPACK_TELEMETRY"];
  });

  it("increments counters when enabled", () => {
    const counters = new TelemetryCounters(true);
    counters.increment("messagesSent");
    counters.increment("messagesSent");
    counters.increment("conversationsCreated");
    expect(counters.snapshot()).toEqual({ messagesSent: 2, conversationsCreated: 1 });
  });

  it("is a no-op when disabled", () => {
    const counters = new TelemetryCounters(false);
    counters.increment("messagesSent");
    expect(counters.snapshot()).toEqual({ messagesSent: 0, conversationsCreated: 0 });
  });
});

describe("telemetry flusher", () => {
  it("POSTs anonymous deltas, not running totals", async () => {
    vi.useFakeTimers();
    try {
      const counters = new TelemetryCounters(true);
      const calls: TelemetryPayload[] = [];
      const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
        calls.push(JSON.parse(init!.body as string) as TelemetryPayload);
        return new Response(null, { status: 204 });
      });

      const stop = startTelemetryFlusher(counters, {
        intervalMs: 1000,
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      counters.increment("messagesSent");
      counters.increment("messagesSent");
      await vi.advanceTimersByTimeAsync(1000);

      counters.increment("messagesSent");
      counters.increment("conversationsCreated");
      await vi.advanceTimersByTimeAsync(1000);

      expect(calls).toHaveLength(2);
      // First flush: totals so far.
      expect(calls[0]!.counters).toEqual({ messagesSent: 2, conversationsCreated: 0 });
      // Second flush: only the delta since the first.
      expect(calls[1]!.counters).toEqual({ messagesSent: 1, conversationsCreated: 1 });
      // The payload is anonymous: a random instance id + version + counts only.
      expect(Object.keys(calls[0]!).sort()).toEqual(["counters", "instanceId", "version"]);
      expect(calls[0]!.version).toBe(VERSION);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the request entirely when nothing changed", async () => {
    vi.useFakeTimers();
    try {
      const counters = new TelemetryCounters(true);
      const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
      const stop = startTelemetryFlusher(counters, {
        intervalMs: 1000,
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchFn).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows failures and re-sends the delta on the next flush", async () => {
    vi.useFakeTimers();
    try {
      const counters = new TelemetryCounters(true);
      const calls: TelemetryPayload[] = [];
      let failNext = true;
      const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (failNext) {
          failNext = false;
          throw new Error("offline");
        }
        calls.push(JSON.parse(init!.body as string) as TelemetryPayload);
        return new Response(null, { status: 204 });
      });

      const stop = startTelemetryFlusher(counters, {
        intervalMs: 1000,
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      counters.increment("messagesSent");
      await vi.advanceTimersByTimeAsync(1000); // fails silently
      await vi.advanceTimersByTimeAsync(1000); // retries with same delta

      expect(calls).toHaveLength(1);
      expect(calls[0]!.counters.messagesSent).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when telemetry is disabled", () => {
    const counters = new TelemetryCounters(false);
    const fetchFn = vi.fn();
    const stop = startTelemetryFlusher(counters, {
      intervalMs: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    stop();
  });
});
