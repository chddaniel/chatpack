"use client";

import { createChatClient } from "@chatpack/client/react";

export function createApplicationChatClient(userId: string) {
  return createChatClient({
    credentials: "include",
    userId,
    realtime: { mode: "poll", intervalMs: 3000 },
  });
}
