import { and, eq } from "drizzle-orm";

import { pushSubscriptions } from "@/db/thread-schema";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { pushPublicKey } from "@/lib/thread-delivery";

export const runtime = "nodejs";

interface BrowserPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthenticated" }, { status: 401 });
  return Response.json({ publicKey: pushPublicKey() });
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthenticated" }, { status: 401 });
  if (!pushPublicKey()) return Response.json({ error: "Push is not configured" }, { status: 503 });
  let subscription: BrowserPushSubscription;
  try {
    subscription = (await request.json()) as BrowserPushSubscription;
  } catch {
    return Response.json({ error: "Invalid push subscription" }, { status: 400 });
  }
  if (
    !subscription ||
    !validEndpoint(subscription.endpoint) ||
    typeof subscription.keys?.p256dh !== "string" ||
    typeof subscription.keys?.auth !== "string" ||
    subscription.endpoint.length > 2048 ||
    subscription.keys.p256dh.length > 256 ||
    subscription.keys.auth.length > 256
  ) {
    return Response.json({ error: "Invalid push subscription" }, { status: 400 });
  }
  await db
    .insert(pushSubscriptions)
    .values({
      endpoint: subscription.endpoint,
      userId: user.id,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    })
    .onConflictDoNothing();
  const [existing] = await db
    .select({ userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, subscription.endpoint))
    .limit(1);
  if (existing?.userId !== user.id) {
    return Response.json(
      { error: "Push subscription belongs to another account" },
      { status: 409 },
    );
  }
  await db
    .update(pushSubscriptions)
    .set({
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    })
    .where(
      and(
        eq(pushSubscriptions.endpoint, subscription.endpoint),
        eq(pushSubscriptions.userId, user.id),
      ),
    );
  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthenticated" }, { status: 401 });
  const body = (await request.json()) as { endpoint?: string };
  if (typeof body.endpoint !== "string")
    return Response.json({ error: "Invalid endpoint" }, { status: 400 });
  await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.endpoint, body.endpoint), eq(pushSubscriptions.userId, user.id)),
    );
  return Response.json({ ok: true });
}
