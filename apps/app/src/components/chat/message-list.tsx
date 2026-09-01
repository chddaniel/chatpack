"use client";

import { Fragment, useEffect, useMemo, useRef } from "react";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import type { ReceiptState } from "@chatpack/client/plugins";
import Image, { type ImageProps } from "next/image";

import { useChat } from "@/components/chat/chat-context";
import { MessageRow } from "@/components/chat/message-row";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

const EMPTY_MESSAGES: ClientMessage[] = [];

export function MessageList({
  conversationId,
  conversation,
  onReply,
  onSayHello,
}: {
  conversationId: string;
  conversation: ClientConversation | null;
  onReply: (message: ClientMessage) => void;
  onSayHello?: () => void;
}) {
  const { client, viewer, directory } = useChat();
  const messages = client.useMessages({ conversationId, limit: 50 });
  const typing = client.useTyping({ conversationId });
  // Typed as "the whole snapshot, or one conversation's state" because the
  // argument decides which; passing a conversation id gives the latter.
  const receipts = client.useReceipts({ conversationId }) as ReceiptState | null;
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const page = messages.data?.messages ?? EMPTY_MESSAGES;
  const newest = page[0];
  const displayMessages = useMemo(() => page.toReversed(), [page]);

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
      <MessageListState
        image="/chatpack/error-3d.png"
        title="Couldn't load messages"
        description="The conversation is fine — we just could not reach it. Nothing has been lost."
        detail={messages.error.code}
        actionLabel="Try again"
        onAction={() => void messages.refetch()}
      />
    );
  }

  if (messages.isPending && page.length === 0) {
    return (
      <ScrollArea className="flex-1">
        <div className="app-message-list flex flex-col gap-[14px] p-4" role="status">
          {[240, 180, 260, 210, 200].map((width, index) => (
            <div
              key={index}
              className={`flex w-full ${
                index === 2 || index === 4 ? "justify-end" : "justify-start"
              }`}
            >
              <Skeleton
                className="rounded-2xl bg-sidebar-accent"
                style={{ width, height: index % 2 === 0 ? 34 : 20 }}
              />
            </div>
          ))}
        </div>
      </ScrollArea>
    );
  }

  if (page.length === 0) {
    return (
      <MessageListState
        image="/chatpack/message-empty.png"
        imageSize={46}
        title="No messages yet"
        description="Send the first message and it appears here instantly — for everyone in the conversation, with no refresh."
        actionLabel="Say hello"
        onAction={onSayHello ?? (() => undefined)}
      />
    );
  }

  const typingName =
    typing !== null && typing.senderId !== viewer.id ? directory.nameOf(typing.senderId) : null;

  return (
    <ScrollArea className="flex-1">
      <div className="app-message-list mx-auto flex max-w-[560px] flex-col gap-[14px] p-4">
        {(messages.data?.nextCursor ?? null) !== null && (
          <Button variant="ghost" onClick={() => void messages.loadMore()}>
            Load earlier messages
          </Button>
        )}
        {/* The API returns newest first so a page can be fetched without knowing
            the end; the UI reads oldest first. */}
        {displayMessages.map((message, index) => {
          const previous = displayMessages[index - 1];
          const showDay =
            previous === undefined ||
            messageDayKey(previous.createdAt) !== messageDayKey(message.createdAt);
          return (
            <Fragment key={message.id}>
              {showDay && (
                <div className="app-message-list-day-separator">
                  {messageDayLabel(message.createdAt)}
                </div>
              )}
              <MessageRow
                message={message}
                conversation={conversation}
                onReply={onReply}
                readByOthers={message.seq <= readSeq}
                delivered={message.seq <= deliveredSeq}
              />
            </Fragment>
          );
        })}
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

function MessageListState({
  image,
  imageSize = 46,
  title,
  description,
  detail,
  actionLabel,
  onAction,
}: {
  image: ImageProps["src"];
  imageSize?: number;
  title: string;
  description: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="app-message-list flex flex-1 flex-col items-center justify-center gap-[18px] p-4 text-center">
      <div className="flex w-full max-w-[300px] flex-col items-center gap-3">
        <Image src={image} alt="" width={imageSize} height={imageSize} />
        <div className="flex w-full flex-col items-center gap-2">
          <p className="text-base font-semibold leading-[19px]">{title}</p>
          <p className="max-w-[300px] text-[13px] leading-4 text-muted-foreground">{description}</p>
          {detail && (
            <p className="font-mono text-[11px] leading-[14px] text-muted-foreground">{detail}</p>
          )}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={onAction}
        className="h-[34px] rounded-[10px] px-3.5 text-[13px] shadow-[inset_0_-2px_1px_rgba(0,0,0,0.25)]"
      >
        {actionLabel}
      </Button>
    </div>
  );
}

function messageDayKey(value: string | Date): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function messageDayLabel(value: string | Date): string {
  const date = new Date(value);
  const now = new Date();
  return messageDayKey(value) === messageDayKey(now)
    ? "TODAY"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase();
}
