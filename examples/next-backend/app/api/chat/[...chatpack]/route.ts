/**
 * The whole Chatpack REST + SSE API, mounted on one catch-all route.
 *
 * This file is the entire Next.js integration.
 */
import { toNextRouteHandlers } from "@chatpack/next";

import { chat } from "@/lib/chat";

export const { GET, POST, PATCH, DELETE } = toNextRouteHandlers(chat);
