import { afterEach, describe, expect, it, vi } from "vitest";

import { printResult } from "../src/output";
import type { SetupPlan } from "../src/types";

describe("CLI result output", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists installed, created, modified, and skipped targets", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const plan = {
      actions: [
        { kind: "install", command: "npm install @chatpack/core", reason: "Install packages." },
        { kind: "create", path: "/tmp/server.ts", content: "", reason: "Create server." },
        { kind: "modify", path: "/tmp/index.ts", content: "", reason: "Mount handler." },
        { kind: "skip", path: "/tmp/client.ts", reason: "Already current." },
      ],
      warnings: [],
    } as unknown as SetupPlan;

    printResult(plan);

    const lines = output.mock.calls.flat().join("\n");
    expect(lines).toContain("Installed: npm install @chatpack/core");
    expect(lines).toContain("Created: /tmp/server.ts");
    expect(lines).toContain("Modified: /tmp/index.ts");
    expect(lines).toContain("Skipped: /tmp/client.ts");
  });
});
