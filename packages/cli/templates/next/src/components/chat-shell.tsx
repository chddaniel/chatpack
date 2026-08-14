"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ClientConversation } from "@chatpack/client";
import { Menu, Send, X } from "lucide-react";
import { toast } from "sonner";

import { ProfileSearch, type PublicProfile } from "@/components/profile-search";
import { AuthButton } from "@/components/auth-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { createApplicationChatClient } from "@/lib/chatpack.client";

interface Viewer {
  id: string;
  name: string;
  image: string | null;
}

export function ChatShell({ user }: { user: Viewer }) {
  const client = useMemo(() => createApplicationChatClient(user.id), [user.id]);
  const conversations = client.useConversations({ limit: 50 });
  const [selectedId, setSelectedId] = useState("");
  const selected = selectedId || conversations.data?.conversations[0]?.id || "";
  const messages = client.useMessages({ conversationId: selected, limit: 50 });
  const [body, setBody] = useState("");
  const [profiles, setProfiles] = useState<Record<string, PublicProfile>>({});

  const participantIds = useMemo(
    () => [
      ...new Set(
        (conversations.data?.conversations ?? []).flatMap((conversation) =>
          conversation.participants.map((participant) => participant.userId),
        ),
      ),
    ],
    [conversations.data],
  );

  useEffect(() => {
    const missing = participantIds.filter((id) => id !== user.id && !profiles[id]);
    if (missing.length === 0) return;
    void fetch("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: missing }),
    }).then(async (response) => {
      if (!response.ok) return;
      const resolved = (await response.json()) as PublicProfile[];
      setProfiles((current) => ({
        ...current,
        ...Object.fromEntries(resolved.map((profile) => [profile.id, profile])),
      }));
    });
  }, [participantIds, profiles, user.id]);

  useEffect(() => {
    const latest = messages.data?.messages[0];
    if (!selected || !latest) return;
    void client.conversations.markRead({ conversationId: selected, messageId: latest.id });
  }, [client, messages.data?.messages, selected]);

  function title(conversation: ClientConversation): string {
    if (conversation.name) return conversation.name;
    const other = conversation.participants.find((participant) => participant.userId !== user.id);
    return other ? (profiles[other.userId]?.name ?? "Direct message") : "Direct message";
  }

  async function openConversation(profile: PublicProfile): Promise<void> {
    const result = await client.conversations.create({ otherUserId: profile.id });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    setProfiles((current) => ({ ...current, [profile.id]: profile }));
    setSelectedId(result.data.id);
  }

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = body.trim();
    if (!selected || !value) return;
    const result = await client.messages.send({ conversationId: selected, body: value });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    setBody("");
  }

  const sidebar = (
    <div className="flex h-full flex-col border-r bg-sidebar">
      <div className="flex items-center justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <p className="font-semibold">Messages</p>
          <p className="truncate text-xs text-muted-foreground">{user.name}</p>
        </div>
        <ProfileSearch onSelect={openConversation} />
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {conversations.isPending &&
            [1, 2, 3].map((item) => <Skeleton key={item} className="h-14 w-full" />)}
          {conversations.data?.conversations.map((conversation) => (
            <button
              key={conversation.id}
              onClick={() => setSelectedId(conversation.id)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent ${selected === conversation.id ? "bg-accent" : ""}`}
            >
              <Avatar>
                <AvatarFallback>{title(conversation).slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {title(conversation)}
              </span>
              {conversation.unreadCount > 0 && (
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                  {conversation.unreadCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>
      <div className="border-t p-3">
        <AuthButton user={user} />
      </div>
    </div>
  );

  return (
    <main className="grid h-dvh bg-background md:grid-cols-[320px_1fr]">
      <aside className="hidden md:block">{sidebar}</aside>
      <section className="flex min-w-0 flex-col">
        <header className="flex h-16 items-center gap-3 border-b px-4">
          <Sheet>
            <SheetTrigger asChild>
              <Button
                className="md:hidden"
                size="icon"
                variant="ghost"
                aria-label="Open conversations"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-80 p-0" showCloseButton={false}>
              <SheetTitle className="sr-only">Conversations</SheetTitle>
              <SheetClose asChild>
                <Button
                  className="absolute top-3 right-14 z-10"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close conversations"
                >
                  <X />
                </Button>
              </SheetClose>
              {sidebar}
            </SheetContent>
          </Sheet>
          <h1 className="truncate font-semibold">
            {conversations.data?.conversations.find((item) => item.id === selected)
              ? title(conversations.data.conversations.find((item) => item.id === selected)!)
              : "Chatpack"}
          </h1>
        </header>
        {conversations.error || messages.error ? (
          <div className="p-6">
            <Alert variant="destructive">
              <AlertTitle>Could not load chat</AlertTitle>
              <AlertDescription>
                {conversations.error?.message ?? messages.error?.message}
              </AlertDescription>
            </Alert>
          </div>
        ) : !selected ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Send />
              </EmptyMedia>
              <EmptyTitle>No conversations yet</EmptyTitle>
              <EmptyDescription>Search for a person to start a direct message.</EmptyDescription>
            </EmptyHeader>
            <ProfileSearch onSelect={openConversation} />
          </Empty>
        ) : (
          <>
            <ScrollArea className="flex-1">
              <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
                {messages.data?.nextCursor && (
                  <Button variant="ghost" onClick={() => void messages.loadMore()}>
                    Load earlier messages
                  </Button>
                )}
                {messages.isPending &&
                  [1, 2, 3].map((item) => <Skeleton key={item} className="h-16 w-3/4" />)}
                {messages.data?.messages.toReversed().map((message) => {
                  const isOwnMessage = message.senderId === user.id;
                  const senderName = isOwnMessage
                    ? "You"
                    : (profiles[message.senderId]?.name ?? "Participant");

                  return (
                    <div
                      key={message.id}
                      className={`flex w-full items-end gap-2 ${isOwnMessage ? "justify-end" : "justify-start"}`}
                      data-message-sender={isOwnMessage ? "self" : "other"}
                    >
                      {!isOwnMessage && (
                        <Avatar className="size-8">
                          <AvatarFallback>{senderName.slice(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                      )}
                      <div
                        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${isOwnMessage ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}
                      >
                        <div className="mb-1 flex items-center gap-2 text-[10px] opacity-70">
                          <span className="font-medium">{senderName}</span>
                          <time>
                            {new Date(message.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                        </div>
                        <p className="whitespace-pre-wrap break-words">{message.body}</p>
                      </div>
                      {isOwnMessage && (
                        <Avatar className="size-8">
                          <AvatarFallback>{user.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
            <form onSubmit={(event) => void send(event)} className="border-t p-4">
              <InputGroup className="mx-auto max-w-3xl">
                <InputGroupTextarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Write a message"
                  aria-label="Message"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="submit"
                    size="icon-sm"
                    disabled={!body.trim()}
                    aria-label="Send"
                  >
                    <Send />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
