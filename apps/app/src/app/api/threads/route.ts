import { currentUser } from "@/lib/auth";
import { listThreadInbox } from "@/lib/thread-state";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthenticated" }, { status: 401 });
  return Response.json({ threads: await listThreadInbox(user.id) });
}
