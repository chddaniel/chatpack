"use client";

import { presenceClient, receiptsClient, typingClient } from "@chatpack/client/plugins";
import { createChatClient } from "@chatpack/client/react";

export function createApplicationChatClient(userId: string) {
  return createChatClient({
    credentials: "include",
    userId,
    // "auto" opens the SSE stream and falls back to polling by itself. Pinning
    // "poll" meant the starter never exercised real-time delivery at all.
    realtime: { mode: "auto", intervalMs: 3000 },
    // The three ephemeral plugins. Each one must also be registered on the
    // server (`src/lib/chatpack.server.ts`) or its routes answer 404.
    //
    // Typing, presence and receipts are never stored and never replayed
    // (`docs/decisions/0008`), so they go quiet while the client is polling
    // instead of streaming - there is nothing for a poll to fetch.
    plugins: [typingClient(), presenceClient(), receiptsClient()],
  });
}

/** The client type, so components can accept one without re-deriving it. */
export type ApplicationChatClient = ReturnType<typeof createApplicationChatClient>;
