import { describe, expect, it } from "vitest";

import { parseArgs, usage } from "../src/args";

describe("CLI arguments", () => {
  it("parses init options", () => {
    expect(
      parseArgs([
        "init",
        "--framework",
        "next",
        "--adapter",
        "memory",
        "--package-manager",
        "pnpm",
        "--client",
        "--yes",
        "--dry-run",
      ]),
    ).toMatchObject({
      command: "init",
      framework: "next",
      adapter: "memory",
      packageManager: "pnpm",
      client: true,
      yes: true,
      dryRun: true,
    });
  });

  it("rejects incomplete resolver and database options", () => {
    expect(() => parseArgs(["init", "--auth-path", "src/auth.ts"])).toThrow(
      "--auth-path requires --auth-export",
    );
    expect(() => parseArgs(["init", "--db-export", "db"])).toThrow(
      "--db-export requires --db-path",
    );
  });

  it("reports unknown options before checking for a value", () => {
    expect(() => parseArgs(["init", "--bogus"])).toThrow("Unknown option: --bogus");
  });

  it("rejects empty option values", () => {
    expect(() => parseArgs(["init", "--cwd="])).toThrow("--cwd requires a value");
    expect(() => parseArgs(["init", "--framework="])).toThrow("--framework requires a value");
  });

  it("preserves unknown short option names", () => {
    expect(() => parseArgs(["init", "-x"])).toThrow("Unknown option: -x");
  });

  it("rejects an invalid auth id property", () => {
    expect(() => parseArgs(["init", "--auth-id-property", "bad-name"])).toThrow(
      "Invalid auth id property: bad-name",
    );
  });

  it("documents the web framework option", () => {
    expect(usage()).toContain("--framework <next|hono|express|web>");
  });
});
