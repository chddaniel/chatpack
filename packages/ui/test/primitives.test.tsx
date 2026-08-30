import { describe, expect, it } from "vitest";
import { ReadReceiptTicks, UserAvatar, readAttachments } from "../src/gallery";
import { ReactionPill, ReplyQuoteBar, UnreadBadge } from "../src/primitives";

describe("@chatpack/ui primitives", () => {
  it("hides zero unread counts and caps large counts", () => {
    expect(UnreadBadge({ count: 0 })).toBeNull();
    const badge = UnreadBadge({ count: 120 });
    expect(badge?.props.children).toContain("99+");
  });

  it("keeps primitive reaction and receipt state presentational", () => {
    const reaction = ReactionPill({ emoji: "👍", count: 2, mine: true });
    expect(reaction.props["aria-pressed"]).toBe(true);
    expect(ReadReceiptTicks({ delivered: true }).props["aria-label"]).toBe("Delivered");
    expect(ReplyQuoteBar({ sender: "Alice", excerpt: "hello", deleted: true })).not.toBeNull();
  });

  it("renders stable avatar initials and rejects invalid attachment metadata", () => {
    expect(UserAvatar({ userId: "alice" }).props.children[0]).toBe("AL");
    expect(readAttachments({ filepack: { version: 99, attachments: [] } })).toEqual([]);
  });
});
