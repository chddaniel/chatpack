"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientChannelPreview } from "@chatpack/client";
import { ArrowLeft, Hash, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { createApplicationChatClient } from "@/lib/chatpack.client";
import type { PublicProfile } from "@/lib/profiles";

/**
 * The public channel directory (`docs/decisions/0020`).
 *
 * Every signed-in user may browse this, which is exactly why a row is a thin
 * preview and never a conversation: returning participants would hand the
 * membership of every public channel to everybody. A count answers "is this the
 * right room?" without naming anyone.
 */
export function ChannelDirectory({ user }: { user: PublicProfile }) {
  const client = useMemo(() => createApplicationChatClient(user.id), [user.id]);
  const router = useRouter();
  const [channels, setChannels] = useState<ClientChannelPreview[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);

  const load = useCallback(
    async (from: string | null) => {
      const result = await client.channels.list({
        limit: 30,
        ...(from === null ? {} : { cursor: from }),
      });
      if (result.error) {
        toast.error(result.error.message);
        return;
      }
      setChannels((current) =>
        from === null ? result.data.channels : [...(current ?? []), ...result.data.channels],
      );
      setCursor(result.data.nextCursor);
    },
    [client],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  async function join(channel: ClientChannelPreview): Promise<void> {
    if (channel.alreadyParticipant) {
      router.push(`/?conversation=${encodeURIComponent(channel.conversationId)}`);
      return;
    }
    setJoining(channel.conversationId);
    const result = await client.channels.join({ conversationId: channel.conversationId });
    setJoining(null);
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    // One call, two outcomes: an `open` channel admits you, an `approval` one
    // opens a join request for an admin. `status` says which, so the UI never has
    // to guess from which field is null (`docs/decisions/0020` §5).
    if (result.data.status === "joined") {
      router.push(`/?conversation=${encodeURIComponent(result.data.conversation.id)}`);
      return;
    }
    toast.success("Requested. An admin has to approve you before you can read it.");
    await load(null);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <Button asChild size="icon" variant="ghost" aria-label="Back to chat">
          <Link href="/">
            <ArrowLeft />
          </Link>
        </Button>
        <div>
          <h1 className="text-lg font-semibold">Channels</h1>
          <p className="text-sm text-muted-foreground">
            Public channels anyone signed in can find. Discovery is not membership - you still have
            to join to read one.
          </p>
        </div>
      </div>

      {channels === null && <Skeleton className="h-20 w-full" />}

      {channels?.length === 0 && (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Hash />
            </EmptyMedia>
            <EmptyTitle>No public channels yet</EmptyTitle>
            <EmptyDescription>
              Any group becomes one: open it, then set its visibility to public.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {channels?.map((channel) => (
        <div key={channel.conversationId} className="flex items-center gap-3 rounded-lg border p-4">
          <Hash className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{channel.name ?? "Unnamed channel"}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Users className="size-3" />
              {channel.participantCount} members ·{" "}
              {channel.joinPolicy === "open" ? "anyone can join" : "joining needs approval"}
            </p>
          </div>
          {channel.requestPending ? (
            <Badge variant="secondary">requested</Badge>
          ) : (
            <Button
              size="sm"
              variant={channel.alreadyParticipant ? "outline" : "default"}
              disabled={joining === channel.conversationId}
              onClick={() => void join(channel)}
            >
              {channel.alreadyParticipant
                ? "Open"
                : channel.joinPolicy === "open"
                  ? "Join"
                  : "Ask to join"}
            </Button>
          )}
        </div>
      ))}

      {cursor !== null && (
        <Button variant="ghost" onClick={() => void load(cursor)}>
          Load more channels
        </Button>
      )}
    </main>
  );
}
