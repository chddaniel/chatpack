import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

  it(
    "runs bundled ESM and CJS artifacts without installed dependencies",
    { timeout: 20_000 },
    async () => {
      const root = await mkdtemp(join("/tmp", "chatpack-cli-bundle-"));
      temporaryRoots.push(root);
      const dist = fileURLToPath(new URL("../dist/", import.meta.url));
      await writeFile(join(root, "package.json"), '{"type":"module"}\n');
      await copyFile(join(dist, "index.js"), join(root, "index.js"));
      await copyFile(join(dist, "index.cjs"), join(root, "index.cjs"));
      const fixture = join(root, "fixture");
      await mkdir(fixture);
      await writeFile(join(fixture, "package.json"), '{"name":"fixture","type":"module"}\n');

      for (const artifact of ["index.js", "index.cjs"]) {
        const { stdout } = await execFileAsync(process.execPath, [
          join(root, artifact),
          "init",
          "--cwd",
          fixture,
          "--framework",
          "web",
          "--adapter",
          "memory",
          "--package-manager",
          "npm",
          "--yes",
          "--dry-run",
        ]);
        expect(stdout).toContain("Dry run complete. No packages installed and no files changed.");
      }
    },
  );

  // 20s rather than vitest's 5s default: this copies all 118 template files into
  // an isolated package and then spawns the CLI twice. It sat under a second when
  // the starter was a handful of files, but it grew with the starter and now
  // exceeds 5s whenever the machine is busy - which under `turbo run` it always
  // is. The work is real I/O, so the budget is what was wrong, not the test.
  it(
    "loads published starter assets from bundled ESM and CJS artifacts",
    { timeout: 20_000 },
    async () => {
      const root = await mkdtemp(join("/tmp", "chatpack-cli-starter-bin-"));
      temporaryRoots.push(root);
      const packageRoot = fileURLToPath(new URL("../", import.meta.url));
      const isolatedPackage = join(root, "package");
      await mkdir(join(isolatedPackage, "dist"), { recursive: true });
      await cp(join(packageRoot, "templates"), join(isolatedPackage, "templates"), {
        recursive: true,
      });
      await copyFile(
        join(packageRoot, "dist", "index.js"),
        join(isolatedPackage, "dist", "index.js"),
      );
      await copyFile(
        join(packageRoot, "dist", "index.cjs"),
        join(isolatedPackage, "dist", "index.cjs"),
      );
      await writeFile(join(isolatedPackage, "package.json"), '{"type":"module"}\n');

      for (const artifact of ["index.js", "index.cjs"]) {
        const fixture = join(root, artifact.replace(".", "-"));
        await mkdir(join(fixture, ".git"), { recursive: true });
        const { stdout } = await execFileAsync(process.execPath, [
          join(isolatedPackage, "dist", artifact),
          "init",
          "--cwd",
          fixture,
          "--framework",
          "next",
          "--auth-provider",
          "auth0",
          "--package-manager",
          "pnpm",
          "--name",
          "packed-starter",
          "--yes",
          "--dry-run",
        ]);
        expect(stdout).toContain("Chatpack setup plan");
        expect(stdout).toContain("Framework: next");
        expect(stdout).toContain("Auth:      auth0");
        expect(stdout).toContain("Package:   packed-starter");
        // A dry run lists every file, which is also the strongest proof that the
        // bundled artifact really found the template assets beside it: these two
        // paths only exist in the auth0 overlay and the base layer.
        expect(stdout).toContain("src/components/ui/sidebar.tsx");
        expect(stdout).toContain("src/proxy.ts");
        expect(stdout).toContain("Dry run complete.");
      }
    },
  );
});
