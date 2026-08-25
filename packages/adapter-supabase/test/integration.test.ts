import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { supabaseAdapter } from "../src/index";

const enabled = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!enabled)("Supabase integration (opt-in)", () => {
  it("persists concurrent direct messages with ordered sequences", async () => {
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const storage = supabaseAdapter(client, { idPrefix: `integration_${Date.now()}` });
    const first = await storage.getOrCreateDirectConversation({
      pairKey: `integration:${Date.now()}:alice:bob`,
      userIds: ["alice", "bob"],
      metadata: { integration: true },
    });
    const reverse = await storage.getOrCreateDirectConversation({
      pairKey: first.conversation.pairKey!,
      userIds: ["alice", "bob"],
      metadata: {},
    });
    expect(reverse.conversation.id).toBe(first.conversation.id);

    const messages = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        storage.addMessage({
          conversationId: first.conversation.id,
          senderId: index % 2 === 0 ? "alice" : "bob",
          body: `integration ${index}`,
          role: "user",
          replyToMessageId: null,
          forwardedFromMessageId: null,
          forwardedFromConversationId: null,
          forwardedFromSenderId: null,
          metadata: { index },
        }),
      ),
    );
    expect(new Set(messages.map((entry) => entry.seq)).size).toBe(4);
    expect(messages.every((entry) => entry.createdAt instanceof Date)).toBe(true);
  });
});
