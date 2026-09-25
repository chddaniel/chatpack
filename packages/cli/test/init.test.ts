import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runInit } from "../src/commands/init";
import type { CliArgs } from "../src/types";

const { confirm, installPackages, installProject } = vi.hoisted(() => ({
  confirm: vi.fn(),
  installPackages: vi.fn(),
  installProject: vi.fn(),
}));

vi.mock("../src/prompts", () => ({
  confirm,
  prompt: vi.fn(),
  select: vi.fn(),
  startPromptSession: vi.fn(),
  PromptCancelledError: class PromptCancelledError extends Error {},
}));

// Keeps these tests off the network; the pins themselves are covered by
// versions.test.ts and exercised for real by the starter smoke test.
vi.mock("../src/install", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/install")>()),
  installPackages,
  installProject,
}));

const args: CliArgs = {
  command: "init",
  cwd: "/tmp/does-not-need-to-exist",
  client: false,
  yes: false,
  dryRun: false,
  help: false,
};

const roots: string[] = [];

async function emptyRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chatpack-init-"));
  roots.push(root);
  await mkdir(join(root, ".git"));
  return root;
}

async function withTty<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const mock of [confirm, installPackages, installProject]) mock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("init terminal handling", () => {
  it("fails before prompting when no TTY is available", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runInit(args)).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("requires --yes"));

    error.mockRestore();
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  });
});

// init installs dependencies and writes files into a directory that may already
// hold the developer's own code, so the last word before any of that has to be
// theirs. Losing this gate meant `chatpack init` mutated a project unasked.
describe("init confirmation gate", () => {
  it("writes nothing when the plan is declined", async () => {
    const root = await emptyRepo();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    confirm.mockResolvedValue(false);

    const code = await withTty(() =>
      runInit({
        ...args,
        cwd: root,
        framework: "next",
        authProvider: "better-auth",
        packageManager: "pnpm",
        name: "declined-app",
      }),
    );

    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalledWith("Apply this plan?", false);
    expect(await readdir(root)).toEqual([".git"]);
  }, 15_000);

  it("does not ask when --yes is passed", async () => {
    const root = await emptyRepo();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runInit({
      ...args,
      cwd: root,
      yes: true,
      framework: "hono",
      packageManager: "pnpm",
      name: "unattended-app",
    });

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(installProject).toHaveBeenCalledWith("pnpm", root);
    expect(await readdir(root)).toContain("package.json");
  });
});
