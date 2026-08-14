import { afterEach, describe, expect, it, vi } from "vitest";

import { printPlan, printResult } from "../src/output";
import type { SetupPlan } from "../src/types";

function plan(overrides: Partial<SetupPlan> = {}): SetupPlan {
  return {
    inspection: { mode: "starter", packageRoot: "/tmp/my-chat-app" },
    answers: {
      framework: "next",
      adapter: "drizzle",
      packageManager: "pnpm",
      authProvider: "better-auth",
      packageName: "my-chat-app",
    },
    actions: [],
    warnings: [],
    errors: [],
    ...overrides,
  } as unknown as SetupPlan;
}

function manyCreates(count: number, directory: string): SetupPlan["actions"] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "create" as const,
    path: `/tmp/my-chat-app/${directory}/file-${index}.ts`,
    content: "",
    reason: "Create next starter file.",
  }));
}

describe("CLI output", () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(run: () => void): string {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    run();
    return output.mock.calls.map(([line]) => line).join("\n");
  }

  it("prints the setup details in an aligned block", () => {
    const lines = capture(() => printPlan(plan()));

    expect(lines).toBe(
      "\nChatpack setup plan\n\n" +
        "Project:   /tmp/my-chat-app\n" +
        "Mode:      starter\n" +
        "Framework: next\n" +
        "Storage:   drizzle\n" +
        "Manager:   pnpm\n" +
        "Auth:      better-auth\n" +
        "Package:   my-chat-app",
    );
  });

  it("lists each action for a small plan, with paths relative to the project", () => {
    const lines = capture(() =>
      printPlan(
        plan({
          actions: [
            {
              kind: "create",
              path: "/tmp/my-chat-app/src/lib/chatpack.server.ts",
              reason: "Create file.",
            },
            {
              kind: "install",
              command: "pnpm install",
              reason: "Install the pinned dependencies.",
            },
          ],
        }),
      ),
    );

    expect(lines).toContain("- create: src/lib/chatpack.server.ts - Create file.");
    expect(lines).toContain("- install: pnpm install - Install the pinned dependencies.");
  });

  // The starter writes fifty-plus files, so the create list collapses - but a
  // conflict is exactly what a reader needs to see before answering "apply?".
  it("groups a large create list yet still names conflicts and modifications", () => {
    const lines = capture(() =>
      printPlan(
        plan({
          actions: [
            ...manyCreates(30, "src/components/ui"),
            ...manyCreates(10, "src/app"),
            {
              kind: "create",
              path: "/tmp/my-chat-app/src/lib/db.ts",
              reason: "Create file.",
              conflict: "File already exists with different content.",
            },
            {
              kind: "modify",
              path: "/tmp/my-chat-app/.gitignore",
              content: "",
              reason: "Add ignore rules.",
            },
          ],
        }),
      ),
    );

    expect(lines).toContain("- create: 40 file(s)");
    expect(lines).toContain("src/ (40)");
    expect(lines).toContain("Re-run with --dry-run to list every file.");
    expect(lines).toContain("CONFLICT: File already exists with different content.");
    expect(lines).toContain("- modify: .gitignore - Add ignore rules.");
  });

  it("lists every file when verbose, which is what --dry-run asks for", () => {
    const lines = capture(() =>
      printPlan(plan({ actions: manyCreates(30, "src/components/ui") }), { verbose: true }),
    );

    expect(lines).toContain("- create: src/components/ui/file-0.ts - Create next starter file.");
    expect(lines).toContain("- create: src/components/ui/file-29.ts - Create next starter file.");
    expect(lines).not.toContain("Re-run with --dry-run");
  });

  // Warnings carry the only instructions for what setup could not do: an
  // unmounted handler, a secret to fill in, a migration to run. Dropping them
  // silently reported an incomplete setup as a complete one.
  it("prints warnings and errors in the plan", () => {
    const lines = capture(() =>
      printPlan(
        plan({
          warnings: ["Copy .env.example to .env.local and add real secrets."],
          errors: [".DS_Store: starter mode does not allow this entry."],
        }),
      ),
    );

    expect(lines).toContain("Warning: Copy .env.example to .env.local and add real secrets.");
    expect(lines).toContain("Error: .DS_Store: starter mode does not allow this entry.");
  });

  it("reports what changed and every remaining next step", () => {
    const lines = capture(() =>
      printResult(
        plan({
          actions: [
            { kind: "install", command: "npm install @chatpack/core", reason: "Install packages." },
            {
              kind: "create",
              path: "/tmp/my-chat-app/src/server.ts",
              content: "",
              reason: "Create server.",
            },
            {
              kind: "modify",
              path: "/tmp/my-chat-app/src/index.ts",
              content: "",
              reason: "Mount handler.",
            },
            { kind: "skip", path: "/tmp/my-chat-app/src/client.ts", reason: "Already current." },
          ],
          warnings: ["Mount chatpackHandler on /api/chat/* in your Hono entrypoint."],
        }),
      ),
    );

    expect(lines).toContain("Installed: npm install @chatpack/core");
    expect(lines).toContain("Created 1 file(s), modified 1 file(s)");
    expect(lines).toContain("Created: src/server.ts");
    expect(lines).toContain("Modified: src/index.ts");
    expect(lines).toContain("Skipped: src/client.ts - Already current.");
    expect(lines).toContain(
      "Next step: Mount chatpackHandler on /api/chat/* in your Hono entrypoint.",
    );
  });

  it("omits the created-file list once it would be a wall of paths", () => {
    const lines = capture(() =>
      printResult(plan({ actions: manyCreates(40, "src/components/ui") })),
    );

    expect(lines).toContain("Created 40 file(s), modified 0 file(s)");
    expect(lines).not.toContain("file-0.ts");
  });
});
