"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import type { ReceiptState } from "@chatpack/client/plugins";

import { useChat } from "@/components/chat/chat-context";
import { MessageRow } from "@/components/chat/message-row";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

export function MessageList({
  conversationId,
  conversation,
  onReply,
}: {
  conversationId: string;
  conversation: ClientConversation | null;
  onReply: (message: ClientMessage) => void;
}) {
  const { client, viewer, directory } = useChat();
  const messages = client.useMessages({ conversationId, limit: 50 });
  const typing = client.useTyping({ conversationId });
  // Typed as "the whole snapshot, or one conversation's state" because the
  // argument decides which; passing a conversation id gives the latter.
  const receipts = client.useReceipts({ conversationId }) as ReceiptState | null;
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const page = messages.data?.messages ?? [];
  const newest = page[0];

  // Every id the page can name: senders, whoever they replied to, whoever they
  // mentioned, and the original sender of a forward.
  const knownIds = useMemo(
    () =>
      page.flatMap((message) => [
        message.senderId,
        ...message.mentions,
        ...(message.replyTo === null ? [] : [message.replyTo.senderId]),
        ...(message.forwardedFrom === null ? [] : [message.forwardedFrom.senderId]),
      ]),
    [page],
  );
  useEffect(() => {
    directory.ensure(knownIds);
  }, [directory, knownIds]);

  useEffect(() => {
    if (conversationId === "" || newest === undefined) return;
    // markRead is monotonic server-side: re-sending an older id is a silent
    // no-op, so this is safe to fire whenever the newest message changes.
    void client.conversations.markRead({ conversationId, messageId: newest.id });
  }, [client, conversationId, newest]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [newest?.id, conversationId]);

  /**
   * How far the other side has got.
   *
   * Two sources for one tick: the durable `lastReadMessageId` on each
   * participant (correct after a reload, and the only thing a polling client
   * has) and the ephemeral `receipt.read` event (live, never stored, and only
   * ever sent to people *other* than the reader - so it always means "someone
   * else", never "me").
   */
  const { readSeq, deliveredSeq } = useMemo(() => {
    const seqById = new Map(page.map((message) => [message.id, message.seq]));
    let durable = 0;
    for (const participant of conversation?.participants ?? []) {
      if (participant.userId === viewer.id || participant.lastReadMessageId === null) continue;
      durable = Math.max(durable, seqById.get(participant.lastReadMessageId) ?? 0);
    }
    const live =
      receipts?.readMessageId === undefined ? 0 : (seqById.get(receipts.readMessageId) ?? 0);
    return { readSeq: Math.max(durable, live), deliveredSeq: receipts?.deliveredSeq ?? 0 };
  }, [conversation?.participants, page, receipts, viewer.id]);

  if (messages.error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTitle>Could not load messages</AlertTitle>
          <AlertDescription>{messages.error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const typingName =
    typing !== null && typing.senderId !== viewer.id ? directory.nameOf(typing.senderId) : null;

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        {(messages.data?.nextCursor ?? null) !== null && (
          <Button variant="ghost" onClick={() => void messages.loadMore()}>
            Load earlier messages
          </Button>
        )}
        {messages.isPending &&
          [1, 2, 3].map((item) => <Skeleton key={item} className="h-16 w-3/4" />)}
        {/* The API returns newest first so a page can be fetched without knowing
            the end; the UI reads oldest first. */}
        {page.toReversed().map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            conversation={conversation}
            onReply={onReply}
            readByOthers={message.seq <= readSeq}
            delivered={message.seq <= deliveredSeq}
          />
        ))}
        {typingName !== null && (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {typingName} is typing…
          </p>
        )}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
