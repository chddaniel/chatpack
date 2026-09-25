"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
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
  const { client, directory, select } = useChat();
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
  const hasQuery = submitted.length > 0;

  function resultDate(value: string): string {
    const date = new Date(value);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return "Today";
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button size="icon" variant="outline" aria-label="Search messages">
            <Search />
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        className="chatpack-ui-search-dialog app-search-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="chatpack-ui-search-dialog-header">
          <div className="chatpack-ui-search-dialog-title-row">
            <DialogTitle>Search messages</DialogTitle>
            <span>esc</span>
          </div>
          <DialogDescription className="sr-only">
            Search every conversation you are a member of.
          </DialogDescription>
        </DialogHeader>
        <Input
          className="chatpack-ui-search-dialog-field"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search for a word or phrase"
          aria-label="Search query"
          autoFocus
        />
        <ScrollArea className="chatpack-ui-search-dialog-body">
          {search.error !== null ? (
            <div className="chatpack-ui-search-dialog-state">
              <Image src="/chatpack/error-3d.png" alt="" width={46} height={46} />
              <div className="chatpack-ui-search-dialog-state-copy">
                <strong>Search is unavailable</strong>
                <span>We could not reach search just now. Your messages are unaffected.</span>
                <code>{search.error.code}</code>
              </div>
              <Button
                type="button"
                className="chatpack-ui-search-dialog-retry"
                onClick={() => void search.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : search.isPending && hasQuery ? (
            <div className="chatpack-ui-search-dialog-results" aria-busy="true">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="chatpack-ui-search-dialog-skeleton" />
              ))}
            </div>
          ) : hasQuery && results.length === 0 ? (
            <div className="chatpack-ui-search-dialog-state">
              <Image src="/chatpack/search-empty.png" alt="" width={54} height={52} />
              <div className="chatpack-ui-search-dialog-state-copy">
                <strong>No messages found</strong>
                <span>
                  Nothing matches “{submitted}”. Search covers every conversation you are a member
                  of.
                </span>
              </div>
            </div>
          ) : (
            <div className="chatpack-ui-search-dialog-results">
              {results.map((message) => (
                <button
                  type="button"
                  key={message.id}
                  onClick={() => {
                    select(message.conversationId);
                    setIsOpen(false);
                  }}
                  className="chatpack-ui-search-dialog-result"
                >
                  <span className="chatpack-ui-search-dialog-result-meta">
                    <strong>{directory.nameOf(message.senderId)}</strong>
                    <time dateTime={message.createdAt}>{resultDate(message.createdAt)}</time>
                  </span>
                  <span className="chatpack-ui-search-dialog-result-excerpt">{message.body}</span>
                </button>
              ))}
              {(search.data?.nextCursor ?? null) !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void search.loadMore()}
                >
                  Load more results
                </Button>
              )}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
