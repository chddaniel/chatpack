import { afterEach, describe, expect, it, vi } from "vitest";

import { printPlan, printResult } from "../src/output";
import type { SetupPlan } from "../src/types";

describe("CLI output", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints only selected setup details in the plan", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const plan = {
      inspection: { mode: "starter", packageRoot: "/tmp/my-chat-app" },
      answers: {
        framework: "next",
        adapter: "drizzle",
        packageManager: "pnpm",
        authProvider: "better-auth",
        packageName: "my-chat-app",
      },
      actions: [{ kind: "create", path: "/tmp/my-chat-app/package.json", reason: "Create file." }],
      warnings: ["Configure environment variables."],
      errors: [],
    } as unknown as SetupPlan;

    printPlan(plan);

    expect(output.mock.calls.map(([line]) => line).join("\n")).toBe(
      "\nChatpack setup plan\n\n" +
        "Project:  /tmp/my-chat-app\n" +
        "Mode:      starter\n" +
        "Framework: next\n" +
        "Storage:   drizzle\n" +
        "Manager:   pnpm\n" +
        "Auth:      better-auth\n" +
        "Package:   my-chat-app",
    );
  });

  it("summarizes results without listing file paths", () => {
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
    expect(lines).toContain("Created 1 file(s), modified 1 file(s)");
    expect(lines).toContain("Skipped 1 unchanged file(s)");
    expect(lines).not.toContain("/tmp/server.ts");
    expect(lines).not.toContain("/tmp/index.ts");
    expect(lines).not.toContain("/tmp/client.ts");
  });
});
