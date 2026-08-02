import { describe, expect, it, vi } from "vitest";

import { runInit } from "../src/commands/init";
import type { CliArgs } from "../src/types";

const args: CliArgs = {
  command: "init",
  cwd: "/tmp/does-not-need-to-exist",
  client: false,
  yes: false,
  dryRun: false,
  help: false,
};

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
