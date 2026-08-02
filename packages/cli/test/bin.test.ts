import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("installed bin entrypoint", () => {
  it("runs when invoked through an npm-style symlink", async () => {
    const root = await mkdtemp(join("/tmp", "chatpack-cli-bin-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    const target = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const bin = join(root, "node_modules", ".bin", "chatpack");
    await symlink(target, bin);

    const { stdout } = await execFileAsync(process.execPath, [bin, "--help"]);

    expect(stdout).toContain("Usage:");
  });
});
