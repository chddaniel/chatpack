import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { chatpackVersions, versionTokenSources } from "../src/versions";

const workspaceRoot = join(__dirname, "..", "..");
const templateRoot = join(__dirname, "..", "templates");

const templatePackageJsons = [
  "hono/package.json",
  "express/package.json",
  "auth/better-auth/package.json",
  "auth/authjs/package.json",
  "auth/auth0/package.json",
];

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("starter dependency pins", () => {
  // The starter shipped pinning `@chatpack/core@0.12.0` before that version was
  // published, so every generated app failed `install` on the first command.
  // These two tests are the guard: the pins must track the workspace versions
  // (which Changesets bumps at release time), and no template may hardcode one.
  it.each(Object.entries(versionTokenSources))(
    "%s matches the version of @chatpack/%s",
    async (token, workspacePackage) => {
      const manifest = await readJson(join(workspaceRoot, workspacePackage, "package.json"));
      expect(chatpackVersions[token as keyof typeof chatpackVersions]).toBe(manifest.version);
    },
  );

  it.each(templatePackageJsons)(
    "%s pins @chatpack/* by token, never literally",
    async (relative) => {
      const manifest = await readJson(join(templateRoot, relative));
      const sections = ["dependencies", "devDependencies"] as const;
      const pins = sections.flatMap((section) =>
        Object.entries((manifest[section] ?? {}) as Record<string, string>).filter(([name]) =>
          name.startsWith("@chatpack/"),
        ),
      );
      expect(pins.length).toBeGreaterThan(0);
      for (const [name, range] of pins) {
        expect(range, `${name} in ${relative}`).toMatch(/^\{\{CHATPACK_[A-Z_]+_VERSION\}\}$/);
      }
    },
  );
});
