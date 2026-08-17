import { chat } from "@/lib/chatpack.server";

export const runtime = "nodejs";
export const { GET, POST, PATCH, DELETE, PUT } = chat.handler();
