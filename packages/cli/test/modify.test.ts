import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { actionForFile, mountAction } from "../src/modify";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("source modifications", () => {
  it("adds a .js extension when mounting a JavaScript integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatpack-cli-modify-"));
    temporaryRoots.push(root);
    const entrypoint = join(root, "index.js");
    const integration = join(root, "lib", "chatpack.hono.js");
    await mkdir(join(root, "lib"), { recursive: true });
    await writeFile(entrypoint, 'import { Hono } from "hono";\nconst app = new Hono();\n');
    await writeFile(integration, "export const chatpackHandler = {};\n");

    const action = mountAction(entrypoint, integration, "hono");

    expect(action.content).toContain('from "./lib/chatpack.hono.js"');
    await writeFile(entrypoint, action.content ?? "");
    expect(await readFile(entrypoint, "utf8")).toContain("/api/chat/*");
  });

  it("uses a .js specifier when mounting a TypeScript integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatpack-cli-modify-"));
    temporaryRoots.push(root);
    const entrypoint = join(root, "index.ts");
    const integration = join(root, "lib", "chatpack.hono.ts");
    await mkdir(join(root, "lib"), { recursive: true });
    await writeFile(entrypoint, 'import { Hono } from "hono";\nconst app = new Hono();\n');
    await writeFile(integration, "export const chatpackHandler = {};\n");

    const action = mountAction(entrypoint, integration, "hono");

    expect(action.content).toContain('from "./lib/chatpack.hono.js"');
  });

  it("marks unchanged files as skipped", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatpack-cli-modify-"));
    temporaryRoots.push(root);
    const path = join(root, "existing.ts");
    const content = "export const value = true;\n";
    await writeFile(path, content);

    const action = actionForFile(path, content, "Keep the file.");

    expect(action.kind).toBe("skip");
    expect(action.content).toBeUndefined();
  });
});
