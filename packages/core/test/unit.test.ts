import { describe, expect, it } from "vitest";

import { pairKeyFor } from "../src/chatpack";
import { ChatpackError } from "../src/errors";
import { TelemetryCounters, resolveTelemetryEnabled } from "../src/telemetry";

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
