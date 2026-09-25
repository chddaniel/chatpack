import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import webpush from "web-push";

import { conversationParticipants, messages } from "@chatpack/adapter-drizzle";
import { users } from "@/db/auth-schema";
import { pushSubscriptions, threadAlerts, threadFollows } from "@/db/thread-schema";
import { db } from "@/lib/db";

const emailKey = process.env.RESEND_API_KEY;
const emailFrom = process.env.THREAD_EMAIL_FROM;
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT;

export function pushPublicKey(): string | null {
  return vapidPublicKey && vapidPrivateKey && vapidSubject ? vapidPublicKey : null;
}

function threadUrl(conversationId: string, rootMessageId: string, replyId: string): string {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const url = new URL("/", base);
  url.searchParams.set("conversation", conversationId);
  url.searchParams.set("thread", rootMessageId);
  url.searchParams.set("reply", replyId);
  return url.toString();
}

async function sendEmail(input: {
  email: string;
  messageId: string;
  userId: string;
  url: string;
}): Promise<void> {
  if (!emailKey || !emailFrom) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${emailKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `thread-reply/${input.messageId}/${input.userId}`,
    },
    body: JSON.stringify({
      from: emailFrom,
      to: [input.email],
      subject: "New reply in a thread",
      text: `A thread you follow has a new reply. Open it: ${input.url}`,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Email delivery failed: ${response.status}`);
}

async function sendPush(userId: string, url: string): Promise<void> {
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) return;
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify({ title: "New thread reply", body: "Open Chatpack to read it.", url }),
        { TTL: 3600, timeout: 5000 },
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        (error.statusCode === 404 || error.statusCode === 410)
      ) {
        await db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.endpoint, subscription.endpoint));
      } else {
        throw error;
      }
    }
  }
}

/** Deliver one reply's pending jobs. Jobs stay durable if a provider fails. */
export async function deliverThreadAlerts(messageId: string): Promise<void> {
  const jobs = await db
    .select({
      messageId: threadAlerts.messageId,
      rootMessageId: threadAlerts.rootMessageId,
      userId: threadAlerts.userId,
      email: users.email,
      conversationId: messages.conversationId,
      emailSentAt: threadAlerts.emailSentAt,
      pushSentAt: threadAlerts.pushSentAt,
      emailAttempts: threadAlerts.emailAttempts,
      pushAttempts: threadAlerts.pushAttempts,
      muted: threadFollows.muted,
    })
    .from(threadAlerts)
    .innerJoin(messages, eq(messages.id, threadAlerts.messageId))
    .innerJoin(users, eq(users.id, threadAlerts.userId))
    .innerJoin(
      threadFollows,
      and(
        eq(threadFollows.rootMessageId, threadAlerts.rootMessageId),
        eq(threadFollows.userId, threadAlerts.userId),
      ),
    )
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, messages.conversationId),
        eq(conversationParticipants.userId, threadAlerts.userId),
      ),
    )
    .where(eq(threadAlerts.messageId, messageId));

  for (const job of jobs) {
    if (job.muted) continue;
    const url = threadUrl(job.conversationId, job.rootMessageId, job.messageId);
    const key = and(eq(threadAlerts.messageId, job.messageId), eq(threadAlerts.userId, job.userId));
    if (job.emailSentAt === null && job.emailAttempts < 3 && emailKey && emailFrom) {
      try {
        await sendEmail({ email: job.email, messageId: job.messageId, userId: job.userId, url });
        await db.update(threadAlerts).set({ emailSentAt: new Date() }).where(key);
      } catch (error) {
        await db
          .update(threadAlerts)
          .set({ emailAttempts: sql`${threadAlerts.emailAttempts} + 1` })
          .where(key);
        console.error("chatpack: thread email delivery failed", error);
      }
    }
    if (job.pushSentAt === null && job.pushAttempts < 3 && pushPublicKey()) {
      try {
        await sendPush(job.userId, url);
        await db.update(threadAlerts).set({ pushSentAt: new Date() }).where(key);
      } catch (error) {
        await db
          .update(threadAlerts)
          .set({ pushAttempts: sql`${threadAlerts.pushAttempts} + 1` })
          .where(key);
        console.error("chatpack: thread push delivery failed", error);
      }
    }
  }
}

/** Bounded retry entry point for an app scheduler. */
export async function retryThreadAlerts(): Promise<number> {
  if (!(emailKey && emailFrom) && !pushPublicKey()) return 0;
  const pendingDelivery = or(
    emailKey && emailFrom
      ? and(isNull(threadAlerts.emailSentAt), lt(threadAlerts.emailAttempts, 3))
      : undefined,
    pushPublicKey()
      ? and(isNull(threadAlerts.pushSentAt), lt(threadAlerts.pushAttempts, 3))
      : undefined,
  );
  const pending = await db
    .selectDistinct({ messageId: threadAlerts.messageId })
    .from(threadAlerts)
    .innerJoin(messages, eq(messages.id, threadAlerts.messageId))
    .innerJoin(
      threadFollows,
      and(
        eq(threadFollows.rootMessageId, threadAlerts.rootMessageId),
        eq(threadFollows.userId, threadAlerts.userId),
      ),
    )
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, messages.conversationId),
        eq(conversationParticipants.userId, threadAlerts.userId),
      ),
    )
    .where(and(eq(threadFollows.muted, false), pendingDelivery))
    .limit(10);
  await Promise.all(pending.map((row) => deliverThreadAlerts(row.messageId)));
  return pending.length;
}
