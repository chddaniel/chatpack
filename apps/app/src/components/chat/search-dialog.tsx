"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import { useChat } from "@/components/chat/chat-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Full-text search across every conversation the viewer is in
 * (`docs/decisions/0015`).
 *
 * Participant-scoped by construction: the server only ever searches
 * conversations you belong to, so there is no way to phrase a query that reaches
 * someone else's messages. Tombstones are excluded - a deleted message is not
 * findable.
 */
export function SearchDialog({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  hideTrigger = false,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const { client, select } = useChat();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const isOpen = controlledOpen ?? open;
  const setIsOpen = controlledOnOpenChange ?? setOpen;

  useEffect(() => {
    const timer = window.setTimeout(() => setSubmitted(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  // An empty query is a no-op in the hook, so this costs nothing until typed in.
  const search = client.useMessageSearch({ query: submitted, limit: 20 });
  const results = submitted.length === 0 ? [] : (search.data?.messages ?? []);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button size="icon" variant="outline" aria-label="Search messages">
            <Search />
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Search messages</DialogTitle>
          <DialogDescription>
            Whole words, ranked by relevance, across your conversations only.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search for a word or phrase"
          aria-label="Search query"
          autoFocus
        />
        <ScrollArea className="max-h-72">
          <div className="flex flex-col gap-1">
            {search.isPending && submitted.length > 0 && <Skeleton className="h-12 w-full" />}
            {submitted.length > 0 && !search.isPending && results.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No messages matched.</p>
            )}
            {results.map((message) => (
              <button
                key={message.id}
                onClick={() => {
                  select(message.conversationId);
                  setOpen(false);
                }}
                className="rounded-lg px-3 py-2 text-left hover:bg-accent"
              >
                <p className="line-clamp-2 text-sm">{message.body}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(message.createdAt).toLocaleString()}
                </p>
              </button>
            ))}
            {(search.data?.nextCursor ?? null) !== null && (
              <Button variant="ghost" size="sm" onClick={() => void search.loadMore()}>
                Load more results
              </Button>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
