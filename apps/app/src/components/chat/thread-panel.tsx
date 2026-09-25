"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import { Bell, BellOff, X } from "lucide-react";

import { useChat } from "@/components/chat/chat-context";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageRow } from "@/components/chat/message-row";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ThreadInboxItem } from "@/lib/thread-state";

export function ThreadPanel({
  root,
  conversation,
  targetReplyId,
  onClose,
}: {
  root: ClientMessage;
  conversation: ClientConversation;
  targetReplyId: string | null;
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
  const [follow, setFollow] = useState<ThreadInboxItem | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const replies = useMemo(
    () => [...(thread.data?.messages ?? [])].reverse(),
    [thread.data?.messages],
  );
  const newestReplyId = thread.data?.messages[0]?.id;
  const followUrl = `/api/threads/${encodeURIComponent(root.id)}?conversationId=${encodeURIComponent(conversation.id)}`;

  const refreshFollow = useCallback(async (): Promise<void> => {
    const response = await fetch(followUrl);
    if (!response.ok) return;
    const result = (await response.json()) as { follow: ThreadInboxItem | null };
    setFollow(result.follow);
  }, [followUrl]);

  useEffect(() => {
    queueMicrotask(() => void refreshFollow());
  }, [refreshFollow]);
  useEffect(() => {
    if (newestReplyId === undefined) return;
    void fetch(followUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    }).then(() => refreshFollow());
  }, [followUrl, newestReplyId, refreshFollow]);

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
  useEffect(() => {
    if (targetReplyId === null || thread.data === null) return;
    if (thread.data.messages.some((message) => message.id === targetReplyId)) {
      document.getElementById(`thread-reply-${targetReplyId}`)?.scrollIntoView({ block: "center" });
    } else if (thread.data.nextCursor !== null && !thread.isPending) {
      void thread.loadMore();
    }
  }, [targetReplyId, thread]);

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
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={async () => {
              await fetch(followUrl, {
                method: follow === null ? "POST" : "PATCH",
                headers: { "Content-Type": "application/json" },
                ...(follow === null ? {} : { body: JSON.stringify({ muted: !follow.muted }) }),
              });
              await refreshFollow();
            }}
          >
            {follow?.muted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
            {follow === null ? "Follow" : follow.muted ? "Muted" : "Following"}
          </Button>
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
            <div
              key={message.id}
              id={`thread-reply-${message.id}`}
              className={message.id === targetReplyId ? "rounded-md ring-2 ring-primary" : ""}
            >
              <MessageRow
                message={message}
                conversation={conversation}
                onReply={setReplyTo}
                readByOthers={false}
                delivered={false}
              />
            </div>
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
