import { beforeEach, describe, expect, it, vi } from "vitest";

const clack = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
}));

vi.mock("@clack/prompts", () => clack);

import { PromptCancelledError, confirm, prompt, select, startPromptSession } from "../src/prompts";

describe("interactive prompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clack.isCancel.mockReturnValue(false);
  });

  it("starts a branded prompt session", () => {
    startPromptSession();

    expect(clack.intro).toHaveBeenCalledWith("Chatpack init");
  });

  it("renders labeled select choices with a default", async () => {
    clack.select.mockResolvedValue("next");

    await expect(
      select(
        "Choose a starter",
        [{ value: "next", label: "Next.js", hint: "Full app" }] as const,
        "next",
      ),
    ).resolves.toBe("next");
    expect(clack.select).toHaveBeenCalledWith({
      message: "Choose a starter",
      options: [{ value: "next", label: "Next.js", hint: "Full app" }],
      initialValue: "next",
    });
  });

  it("uses Clack text and confirmation defaults", async () => {
    clack.text.mockResolvedValue("chat-app");
    clack.confirm.mockResolvedValue(true);
    const validate = vi.fn(() => undefined);

    await expect(prompt("Package name", "chat-app", validate)).resolves.toBe("chat-app");
    await expect(confirm("Use detected auth?", true)).resolves.toBe(true);

    expect(clack.text).toHaveBeenCalledWith({
      message: "Package name",
      placeholder: "chat-app",
      defaultValue: "chat-app",
      validate: expect.any(Function),
    });
    const textOptions = clack.text.mock.calls[0]?.[0] as {
      validate: (value: string | undefined) => string | undefined;
    };
    expect(textOptions.validate(undefined)).toBeUndefined();
    expect(textOptions.validate("")).toBeUndefined();
    expect(validate).toHaveBeenCalledWith("chat-app");
    expect(clack.confirm).toHaveBeenCalledWith({
      message: "Use detected auth?",
      initialValue: true,
    });
  });

  it("renders cancellation once and stops setup cleanly", async () => {
    clack.text.mockResolvedValue(Symbol("cancel"));
    clack.isCancel.mockReturnValue(true);

    await expect(prompt("Package name")).rejects.toBeInstanceOf(PromptCancelledError);
    expect(clack.cancel).toHaveBeenCalledWith("Setup cancelled.");
  });
});
