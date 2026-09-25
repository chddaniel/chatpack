"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import { X } from "lucide-react";

import { useChat } from "@/components/chat/chat-context";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageRow } from "@/components/chat/message-row";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export function ThreadPanel({
  root,
  conversation,
  onClose,
}: {
  root: ClientMessage;
  conversation: ClientConversation;
  onClose: () => void;
}) {
  const { client, directory } = useChat();
  const snapshot = useSyncExternalStore(
    client.$store.subscribe,
    client.$store.getSnapshot,
    client.$store.getSnapshot,
  );
  const liveRoot =
    snapshot.messagesByConversation[conversation.id]?.data?.messages.find(
      (message) => message.id === root.id,
    ) ?? root;
  const thread = client.useThread({
    conversationId: conversation.id,
    rootMessageId: root.id,
    limit: 50,
  });
  const [replyTo, setReplyTo] = useState<ClientMessage | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const replies = useMemo(
    () => [...(thread.data?.messages ?? [])].reverse(),
    [thread.data?.messages],
  );
  const newestReplyId = thread.data?.messages[0]?.id;

  const knownIds = useMemo(
    () =>
      [liveRoot, ...replies].flatMap((message) => [
        message.senderId,
        ...message.mentions,
        ...(message.replyTo === null ? [] : [message.replyTo.senderId]),
        ...(message.forwardedFrom === null ? [] : [message.forwardedFrom.senderId]),
      ]),
    [liveRoot, replies],
  );
  useEffect(() => {
    directory.ensure(knownIds);
  }, [directory, knownIds]);
  useEffect(() => {
    if (newestReplyId !== undefined) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [newestReplyId]);

  return (
    <div
      className="flex h-full min-h-0 flex-col border-l bg-background"
      aria-label="Message thread"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div>
          <h2 className="text-sm font-semibold">Thread</h2>
          <p className="text-xs text-muted-foreground">Reply to this message</p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          aria-label="Close thread"
        >
          <X />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          <MessageRow
            message={liveRoot}
            conversation={conversation}
            onReply={setReplyTo}
            readByOthers={false}
            delivered={false}
          />
          <div className="border-t pt-3 text-xs text-muted-foreground">
            {Math.max(liveRoot.threadReplyCount ?? 0, replies.length)}{" "}
            {Math.max(liveRoot.threadReplyCount ?? 0, replies.length) === 1 ? "reply" : "replies"}
          </div>
          {thread.error && (
            <div className="text-sm text-destructive">
              Could not load replies.{" "}
              <button type="button" className="underline" onClick={() => void thread.refetch()}>
                Try again
              </button>
            </div>
          )}
          {thread.isPending && replies.length === 0 && (
            <p className="text-sm text-muted-foreground">Loading replies…</p>
          )}
          {thread.data?.nextCursor && (
            <Button type="button" variant="ghost" onClick={() => void thread.loadMore()}>
              Load earlier replies
            </Button>
          )}
          {replies.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              conversation={conversation}
              onReply={setReplyTo}
              readByOthers={false}
              delivered={false}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <MessageComposer
        conversationId={conversation.id}
        conversation={conversation}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        threadRootMessageId={root.id}
      />
    </div>
  );
}
