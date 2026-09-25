"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ThreadInboxItem } from "@/lib/thread-state";

export function ThreadInbox() {
  const { openMessage } = useChat();
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<ThreadInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pushKey, setPushKey] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/threads/push").then(async (response) => {
      if (!response.ok) return;
      const result = (await response.json()) as { publicKey: string | null };
      setPushKey(result.publicKey);
    });
  }, []);

  async function enablePush(): Promise<void> {
    if (!pushKey || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      toast.error("Browser alerts are unavailable here.");
      return;
    }
    try {
      const registration = await navigator.serviceWorker.register("/thread-push-sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
      const base64 = pushKey.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
        (char) => char.charCodeAt(0),
      );
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
      const response = await fetch("/api/threads/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) throw new Error("Push subscription failed");
      toast.success("Browser alerts enabled.");
    } catch {
      toast.error("Could not enable browser alerts.");
    }
  }

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/threads", { credentials: "include" });
      if (!response.ok) throw new Error("Could not load threads");
      const result = (await response.json()) as { threads: ThreadInboxItem[] };
      setThreads(result.threads);
    } catch {
      if (open) toast.error("Could not load threads.");
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    queueMicrotask(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function update(
    thread: ThreadInboxItem,
    body: { read?: boolean; unread?: boolean; muted?: boolean },
  ) {
    const response = await fetch(
      `/api/threads/${encodeURIComponent(thread.rootMessageId)}?conversationId=${encodeURIComponent(thread.conversationId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) toast.error("Could not update thread.");
    await refresh();
  }

  const unread = threads.reduce((count, thread) => count + thread.unreadCount, 0);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="w-full justify-start gap-2"
        onClick={() => setOpen(true)}
      >
        <MessageSquare className="size-4" />
        Threads
        {unread > 0 && (
          <span className="ml-auto rounded-full bg-primary px-2 text-xs text-primary-foreground">
            {unread}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[80dvh] flex-col">
          <DialogHeader>
            <DialogTitle>Threads</DialogTitle>
            <DialogDescription>Replies in conversations you follow.</DialogDescription>
          </DialogHeader>
          {pushKey && (
            <Button type="button" size="sm" variant="outline" onClick={() => void enablePush()}>
              Enable browser alerts
            </Button>
          )}
          <ScrollArea className="min-h-0 flex-1">
            {loading ? (
              <p className="p-3 text-sm text-muted-foreground">Loading threads…</p>
            ) : threads.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">Threads you follow appear here.</p>
            ) : (
              <div className="space-y-2 p-1">
                {[...threads]
                  .sort((a, b) => (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0))
                  .map((thread) => (
                    <div key={thread.rootMessageId} className="rounded-lg border p-3">
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() => {
                          openMessage({
                            id: thread.rootMessageId,
                            conversationId: thread.conversationId,
                            threadRootMessageId: null,
                          });
                          setOpen(false);
                          void update(thread, { read: true });
                        }}
                      >
                        <p className="line-clamp-2 text-sm font-medium">
                          {thread.rootBody || "Message deleted"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {thread.unreadCount > 0 ? `${thread.unreadCount} unread` : "Read"} ·{" "}
                          {new Date(thread.lastReplyAt).toLocaleString()}
                        </p>
                      </button>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void update(thread, { unread: true })}
                        >
                          Mark unread
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void update(thread, { muted: !thread.muted })}
                        >
                          {thread.muted ? (
                            <Bell className="size-3" />
                          ) : (
                            <BellOff className="size-3" />
                          )}
                          {thread.muted ? "Notify me" : "Mute replies"}
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
