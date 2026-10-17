import { currentUser } from "@/lib/auth";
import { chat } from "@/lib/chatpack.server";
import {
  followThread,
  listThreadInbox,
  markThreadRead,
  markThreadUnread,
  setThreadMuted,
} from "@/lib/thread-state";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ rootId: string }> };

async function authorize(request: Request, context: RouteContext) {
  const user = await currentUser();
  if (!user) return null;
  const { rootId } = await context.params;
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) return null;
  try {
    const root = await chat.api.getMessage({ userId: user.id, conversationId, messageId: rootId });
    if (root.threadRootMessageId !== null) return null;
    return { userId: user.id, rootId };
  } catch {
    return null;
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const auth = await authorize(request, context);
  if (!auth) return Response.json({ error: "Thread unavailable" }, { status: 404 });
  const [item] = await listThreadInbox(auth.userId, auth.rootId);
  return Response.json({ follow: item ?? null });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const auth = await authorize(request, context);
  if (!auth) return Response.json({ error: "Thread unavailable" }, { status: 404 });
  await followThread(auth.userId, auth.rootId);
  return Response.json({ ok: true });
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const auth = await authorize(request, context);
  if (!auth) return Response.json({ error: "Thread unavailable" }, { status: 404 });
  const body = (await request.json()) as { read?: boolean; unread?: boolean; muted?: boolean };
  if (body.read === true) await markThreadRead(auth.userId, auth.rootId);
  if (body.unread === true) await markThreadUnread(auth.userId, auth.rootId);
  if (typeof body.muted === "boolean") {
    await followThread(auth.userId, auth.rootId);
    await setThreadMuted(auth.userId, auth.rootId, body.muted);
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const auth = await authorize(request, context);
  if (!auth) return Response.json({ error: "Thread unavailable" }, { status: 404 });
  await setThreadMuted(auth.userId, auth.rootId, true);
  return Response.json({ ok: true });
}
