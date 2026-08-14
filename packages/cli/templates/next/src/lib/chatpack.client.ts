"use client";

import { createChatClient } from "@chatpack/client/react";

export function createApplicationChatClient(userId: string) {
  return createChatClient({
    credentials: "include",
    userId,
    // "auto" opens the SSE stream and falls back to polling by itself. Pinning
    // "poll" meant the starter never exercised real-time delivery at all.
    realtime: { mode: "auto", intervalMs: 3000 },
  });
}
