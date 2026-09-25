import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { AfterMessageMutationContext } from "@chatpack/core";

import { conversationParticipants, conversations, messages } from "@chatpack/adapter-drizzle";
import { threadAlerts, threadFollows } from "@/db/thread-schema";
import { db } from "@/lib/db";

export interface ThreadInboxItem {
  rootMessageId: string;
  conversationId: string;
  rootBody: string;
  rootSenderId: string;
  lastReplyAt: string;
  unreadCount: number;
  muted: boolean;
}

/** Called from the existing durable after-message hook. */
export async function recordThreadReply({
  action,
  message,
  conversation,
  mentions,
  recipientIds,
}: AfterMessageMutationContext): Promise<void> {
  if (action !== "send" || message.threadRootMessageId === null) return;
  const [root] = await db
    .select({ senderId: messages.senderId, seq: messages.seq })
    .from(messages)
    .where(eq(messages.id, message.threadRootMessageId))
    .limit(1);
  if (!root) return;

  // Direct messages notify both participants. In groups, only participants in
  // the thread and people explicitly mentioned are followed automatically.
  const participantIds = new Set(conversation.participantIds);
  const followers = [
    root.senderId,
    message.senderId,
    ...mentions,
    ...(conversation.type === "direct" ? recipientIds : []),
  ].filter((id, index, all) => participantIds.has(id) && all.indexOf(id) === index);

  await db.transaction(async (tx) => {
    for (const userId of followers) {
      await tx
        .insert(threadFollows)
        .values({
          rootMessageId: message.threadRootMessageId!,
          conversationId: message.conversationId,
          userId,
          lastReadSeq: userId === message.senderId ? message.seq : root.seq,
          lastReplyAt: message.createdAt,
        })
        .onConflictDoUpdate({
          target: [threadFollows.rootMessageId, threadFollows.userId],
          set: { lastReplyAt: message.createdAt },
        });
    }

    // Existing followers remain subscribed without requiring a mention. A mute
    // stops delivery while preserving the thread in their inbox.
    await tx
      .update(threadFollows)
      .set({ lastReplyAt: message.createdAt })
      .where(eq(threadFollows.rootMessageId, message.threadRootMessageId!));
    await tx
      .update(threadFollows)
      .set({ lastReadSeq: sql`greatest(${threadFollows.lastReadSeq}, ${message.seq})` })
      .where(
        and(
          eq(threadFollows.rootMessageId, message.threadRootMessageId!),
          eq(threadFollows.userId, message.senderId),
        ),
      );

    const recipients = await tx
      .select({ userId: threadFollows.userId })
      .from(threadFollows)
      .innerJoin(
        conversationParticipants,
        and(
          eq(conversationParticipants.conversationId, threadFollows.conversationId),
          eq(conversationParticipants.userId, threadFollows.userId),
        ),
      )
      .where(
        and(
          eq(threadFollows.rootMessageId, message.threadRootMessageId!),
          eq(threadFollows.muted, false),
          ne(threadFollows.userId, message.senderId),
        ),
      );
    if (recipients.length > 0) {
      await tx
        .insert(threadAlerts)
        .values(
          recipients.map(({ userId }) => ({
            messageId: message.id,
            rootMessageId: message.threadRootMessageId!,
            userId,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

export async function listThreadInbox(
  userId: string,
  rootMessageId?: string,
): Promise<ThreadInboxItem[]> {
  const rows = await db
    .select({
      rootMessageId: threadFollows.rootMessageId,
      conversationId: threadFollows.conversationId,
      rootBody: messages.body,
      rootSenderId: messages.senderId,
      lastReplyAt: threadFollows.lastReplyAt,
      unreadCount: sql<number>`(
        SELECT count(*)::integer FROM chatpack_messages AS replies
        WHERE replies.thread_root_message_id = ${threadFollows.rootMessageId}
          AND replies.seq > ${threadFollows.lastReadSeq}
          AND replies.sender_id <> ${userId}
      )`.mapWith(Number),
      muted: threadFollows.muted,
    })
    .from(threadFollows)
    .innerJoin(messages, eq(messages.id, threadFollows.rootMessageId))
    .innerJoin(conversations, eq(conversations.id, threadFollows.conversationId))
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, threadFollows.conversationId),
        eq(conversationParticipants.userId, threadFollows.userId),
      ),
    )
    .where(
      and(
        eq(threadFollows.userId, userId),
        rootMessageId === undefined ? undefined : eq(threadFollows.rootMessageId, rootMessageId),
      ),
    )
    .orderBy(desc(threadFollows.lastReplyAt))
    .limit(rootMessageId === undefined ? 100 : 1);
  return rows.map((row) => ({ ...row, lastReplyAt: row.lastReplyAt.toISOString() }));
}

export async function followThread(userId: string, rootMessageId: string): Promise<void> {
  const [root] = await db
    .select({
      conversationId: messages.conversationId,
      seq: messages.seq,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.id, rootMessageId), sql`${messages.threadRootMessageId} IS NULL`))
    .limit(1);
  if (!root) return;
  const [latest] = await db
    .select({ seq: messages.seq, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.threadRootMessageId, rootMessageId))
    .orderBy(desc(messages.seq))
    .limit(1);
  await db
    .insert(threadFollows)
    .values({
      rootMessageId,
      conversationId: root.conversationId,
      userId,
      lastReadSeq: latest?.seq ?? root.seq,
      lastReplyAt: latest?.createdAt ?? root.createdAt,
    })
    .onConflictDoUpdate({
      target: [threadFollows.rootMessageId, threadFollows.userId],
      set: { muted: false, lastReplyAt: latest?.createdAt ?? root.createdAt },
    });
}

export async function setThreadMuted(
  userId: string,
  rootMessageId: string,
  muted: boolean,
): Promise<void> {
  await db
    .update(threadFollows)
    .set({ muted })
    .where(and(eq(threadFollows.userId, userId), eq(threadFollows.rootMessageId, rootMessageId)));
}

export async function markThreadRead(userId: string, rootMessageId: string): Promise<void> {
  const [latest] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.threadRootMessageId, rootMessageId))
    .orderBy(desc(messages.seq))
    .limit(1);
  if (!latest) return;
  await db
    .update(threadFollows)
    .set({ lastReadSeq: sql`greatest(${threadFollows.lastReadSeq}, ${latest.seq})` })
    .where(and(eq(threadFollows.rootMessageId, rootMessageId), eq(threadFollows.userId, userId)));
}

export async function markThreadUnread(userId: string, rootMessageId: string): Promise<void> {
  const [latest] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(and(eq(messages.threadRootMessageId, rootMessageId), ne(messages.senderId, userId)))
    .orderBy(desc(messages.seq))
    .limit(1);
  if (!latest) return;
  await db
    .update(threadFollows)
    .set({ lastReadSeq: latest.seq - 1 })
    .where(and(eq(threadFollows.rootMessageId, rootMessageId), eq(threadFollows.userId, userId)));
}
