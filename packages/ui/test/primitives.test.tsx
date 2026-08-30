import { describe, expect, it } from "vitest";
import { UnreadBadge } from "../src/primitives";

describe("@chatpack/ui primitives", () => {
  it("hides zero unread counts and caps large counts", () => {
    expect(UnreadBadge({ count: 0 })).toBeNull();
    const badge = UnreadBadge({ count: 120 });
    expect(badge?.props.children).toContain("99+");
  });
});
