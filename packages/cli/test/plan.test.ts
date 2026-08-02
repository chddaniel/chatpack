import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { inspectProject } from "../src/project/inspect";
import { installCommand } from "../src/install";
import { makePlan } from "../src/plan";
import { validatePlan } from "../src/validate";
import type { CliArgs } from "../src/types";

const tempProjects: string[] = [];

async function project(packageJson: object, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chatpack-cli-"));
  tempProjects.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson, null, 2));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    const directory = full.slice(0, full.lastIndexOf("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const baseArgs = (cwd: string, framework: "next" | "hono" | "express" | "web"): CliArgs => ({
  command: "init",
  cwd,
  framework,
  adapter: "memory",
  packageManager: "pnpm",
  client: false,
  yes: true,
  dryRun: true,
  help: false,
});

afterEach(async () => {
  await Promise.all(
    tempProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project planning", () => {
  it("does not silently choose between multiple detected frameworks", async () => {
    const root = await project(
      { dependencies: { next: "latest", hono: "latest" } },
      { "src/index.ts": 'import { Hono } from "hono";\nconst app = new Hono();\n' },
    );
    const inspection = inspectProject(root);
    expect(inspection.framework).toBeUndefined();
    expect(inspection.frameworkEvidence).toEqual([
      "next: next dependency or import (ambiguous)",
      "hono: hono dependency or Hono application (ambiguous)",
    ]);
    const { framework: _framework, ...ambiguousArgs } = baseArgs(root, "next");
    await expect(makePlan(inspection, ambiguousArgs)).rejects.toThrow("Framework is unknown");
  });

  it("does not treat an unknown app.listen file as a safe entrypoint", async () => {
    const root = await project(
      {},
      { "src/server.ts": "const app = createApplication();\napp.listen(3000);\n" },
    );
    expect(inspectProject(root).serverEntrypoints).toEqual([]);
  });

  it("maps every package manager to its install command", () => {
    expect(installCommand("npm", ["example"])).toBe("npm install example");
    expect(installCommand("pnpm", ["example"])).toBe("pnpm add example");
    expect(installCommand("yarn", ["example"])).toBe("yarn add example");
    expect(installCommand("bun", ["example"])).toBe("bun add example");
  });

  it("rejects missing auth and database modules", async () => {
    const authRoot = await project({}, {});
    await expect(
      makePlan(inspectProject(authRoot), {
        ...baseArgs(authRoot, "web"),
        authPath: "src/no-such-auth.ts",
        authExport: "getUser",
      }),
    ).rejects.toThrow("Auth module not found: src/no-such-auth.ts");

    const databaseRoot = await project({}, {});
    await expect(
      makePlan(inspectProject(databaseRoot), {
        ...baseArgs(databaseRoot, "web"),
        adapter: "drizzle",
        dbPath: "src/no-such-db.ts",
        dbExport: "db",
      }),
    ).rejects.toThrow("Database module not found: src/no-such-db.ts");
  });

  it("plans a Next.js setup without writing during dry-run", async () => {
    const root = await project(
      { dependencies: { next: "latest", react: "latest" } },
      { "tsconfig.json": "{}\n" },
    );
    const plan = await makePlan(inspectProject(root), baseArgs(root, "next"));
    expect(plan.errors).toEqual([]);
    expect(
      plan.actions.some((action) => action.path?.endsWith("app/api/chat/[...chatpack]/route.ts")),
    ).toBe(true);
    expect(validatePlan(plan)).toEqual([]);
    await expect(readFile(join(root, "lib/chatpack.server.ts"))).rejects.toThrow();
  });

  it("creates a Hono mount edit only for one detected application", async () => {
    const root = await project(
      { dependencies: { hono: "latest" } },
      {
        "src/index.ts":
          'import { Hono } from "hono";\nconst app = new Hono();\nexport default app;\n',
      },
    );
    const plan = await makePlan(inspectProject(root), baseArgs(root, "hono"));
    const entrypoint = plan.actions.find((action) => action.path?.endsWith("src/index.ts"));
    expect(entrypoint?.content).toContain("/api/chat/*");
    expect(entrypoint?.conflict).toBeUndefined();
  });

  it("reports an existing generated file as a conflict", async () => {
    const root = await project(
      { dependencies: { next: "latest" } },
      { "lib/chatpack.server.ts": "export const userCode = true;\n" },
    );
    const plan = await makePlan(inspectProject(root), baseArgs(root, "next"));
    expect(
      plan.actions.find((action) => action.path?.endsWith("lib/chatpack.server.ts"))?.conflict,
    ).toBeTruthy();
    expect(
      validatePlan(plan).some((error) =>
        error.endsWith("/lib/chatpack.server.ts: File exists with different content."),
      ),
    ).toBe(true);
  });
});
