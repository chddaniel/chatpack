import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "../src/args";
import { applyFileAction } from "../src/modify";
import { makePlan } from "../src/plan";
import { inspectProject } from "../src/project/inspect";
import type { AuthProvider, CliArgs, Framework, PackageManager } from "../src/types";
import { validatePlan } from "../src/validate";

const roots: string[] = [];

async function emptyRepo(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chatpack-starter-"));
  roots.push(root);
  await mkdir(join(root, ".git"));
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), value);
  }
  return root;
}

function args(
  cwd: string,
  framework: Framework,
  manager: PackageManager = "pnpm",
  provider?: AuthProvider,
): CliArgs {
  return {
    command: "init",
    cwd,
    framework,
    adapter: "drizzle",
    packageManager: manager,
    ...(provider ? { authProvider: provider } : {}),
    client: false,
    yes: true,
    dryRun: true,
    help: false,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("starter inspection and planning", () => {
  it("detects empty and allowed-doc repositories as starter mode", async () => {
    const empty = await emptyRepo();
    expect(inspectProject(empty).mode).toBe("starter");
    expect(inspectProject(empty).starterConflicts).toEqual([]);

    const documented = await emptyRepo({
      ".gitignore": ".env\n",
      "README.md": "# Existing\n",
      "LICENSE.txt": "license\n",
    });
    const inspection = inspectProject(documented);
    expect(inspection.mode).toBe("starter");
    expect(inspection.starterConflicts).toEqual([]);
    const plan = await makePlan(inspection, args(documented, "hono"));
    expect(plan.actions.find((action) => action.path?.endsWith("CHATPACK_SETUP.md"))).toBeTruthy();
    expect(plan.actions.find((action) => action.path?.endsWith("README.md"))).toBeUndefined();
  });

  it("reports unsafe pre-existing content before mutation", async () => {
    const root = await emptyRepo({
      "src/index.ts": "export {};\n",
      "vite.config.ts": "export {};\n",
    });
    const plan = await makePlan(inspectProject(root), args(root, "express"));
    expect(plan.errors).toEqual([
      "src: empty-repository starter mode does not allow this pre-existing entry.",
      "vite.config.ts: empty-repository starter mode does not allow this pre-existing entry.",
    ]);
    expect(validatePlan(plan)).toEqual([
      ...plan.errors,
      expect.stringContaining("src/index.ts: File exists with different content."),
    ]);
  });

  it("keeps package.json projects in existing-project mode", async () => {
    const root = await emptyRepo({ "package.json": "{}\n" });
    expect(inspectProject(root).mode).toBe("existing");
  });

  it.each(["better-auth", "authjs", "auth0"] as const)(
    "plans a complete Next starter for %s",
    async (provider) => {
      const root = await emptyRepo();
      const plan = await makePlan(inspectProject(root), args(root, "next", "pnpm", provider));
      expect(validatePlan(plan)).toEqual([]);
      expect(plan.answers.authProvider).toBe(provider);
      expect(
        plan.actions.find((action) => action.path?.endsWith("package.json"))?.content,
      ).toContain(`"authProvider": "${provider}"`);
      expect(
        plan.actions.some((action) => action.path?.includes("components/ui/sidebar.tsx")),
      ).toBe(true);
      expect(plan.actions.some((action) => action.path?.includes("api/profiles/route.ts"))).toBe(
        true,
      );
      expect(
        plan.actions.find((action) => action.path?.endsWith("profile-search.tsx"))?.content,
      ).toContain("setOpen(false)");
      expect(
        plan.actions.find((action) => action.path?.endsWith("chat-shell.tsx"))?.content,
      ).toContain("messages.toReversed()");
      expect(
        plan.actions.find((action) => action.path?.endsWith("chat-shell.tsx"))?.content,
      ).toContain('aria-label="Open conversations"');
      if (provider === "better-auth") {
        expect(
          plan.actions.find((action) => action.path?.endsWith("src/lib/auth.ts"))?.content,
        ).toContain("user: users");
      }
      expect(plan.actions.at(-1)?.command).toBe("pnpm install");
    },
  );

  it.each([
    ["hono", "npm"],
    ["express", "bun"],
  ] as const)("plans a fail-closed %s starter", async (framework, manager) => {
    const root = await emptyRepo();
    const plan = await makePlan(inspectProject(root), args(root, framework, manager));
    expect(validatePlan(plan)).toEqual([]);
    expect(
      plan.actions.find((action) => action.path?.endsWith("src/lib/chatpack.ts"))?.content,
    ).toContain("auth: async () => null");
    expect(plan.actions.find((action) => action.path?.endsWith("src/index.ts"))?.content).toContain(
      "/api/health",
    );
    expect(plan.actions.at(-1)?.command).toBe(`${manager} install`);
  });

  it("requires all non-interactive starter decisions", async () => {
    const root = await emptyRepo();
    const { framework: _framework, ...withoutFramework } = args(root, "next");
    await expect(makePlan(inspectProject(root), withoutFramework)).rejects.toThrow(
      "Starter framework is required",
    );
    const { packageManager: _manager, ...withoutManager } = args(root, "next");
    await expect(makePlan(inspectProject(root), withoutManager)).rejects.toThrow(
      "Package manager is required",
    );
    await expect(makePlan(inspectProject(root), args(root, "next"))).rejects.toThrow(
      "Next.js starter auth provider is required",
    );
  });

  it("rejects incompatible starter options and invalid names", async () => {
    const root = await emptyRepo();
    await expect(
      makePlan(inspectProject(root), { ...args(root, "web"), framework: "web" }),
    ).rejects.toThrow("existing projects");
    await expect(
      makePlan(inspectProject(root), { ...args(root, "hono"), authProvider: "auth0" }),
    ).rejects.toThrow("only available for Next.js");
    await expect(
      makePlan(inspectProject(root), { ...args(root, "hono"), adapter: "memory" }),
    ).rejects.toThrow("memory storage");
    await expect(
      makePlan(inspectProject(root), { ...args(root, "hono"), authPath: "auth.ts" }),
    ).rejects.toThrow("Existing-project option");
    await expect(
      makePlan(inspectProject(root), { ...args(root, "hono"), name: "Bad Name" }),
    ).rejects.toThrow("Invalid package name");
  });

  it("is immutable during planning and retry-safe after files are applied", async () => {
    const root = await emptyRepo();
    const options = { ...args(root, "express"), name: "retry-safe" };
    const plan = await makePlan(inspectProject(root), options);
    await expect(readFile(join(root, "package.json"))).rejects.toThrow();
    for (const action of plan.actions) {
      if (action.kind === "create" || action.kind === "modify") applyFileAction(action);
    }
    const retry = await makePlan(inspectProject(root), options);
    expect(retry.inspection.mode).toBe("starter");
    expect(
      retry.actions.filter((action) => action.kind === "create" || action.kind === "modify"),
    ).toEqual([]);
    expect(retry.actions.filter((action) => action.kind === "skip").length).toBeGreaterThan(5);
    expect(validatePlan(retry)).toEqual([]);
  });

  it("parses starter command options", () => {
    expect(
      parseArgs([
        "init",
        "--framework",
        "next",
        "--auth-provider",
        "auth0",
        "--name",
        "@scope/chat",
      ]),
    ).toMatchObject({ authProvider: "auth0", name: "@scope/chat" });
    expect(() => parseArgs(["init", "--auth-provider", "clerk"])).toThrow(
      "Unsupported auth provider",
    );
  });
});
