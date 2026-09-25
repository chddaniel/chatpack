"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatpackClientError, ClientChannelPreview } from "@chatpack/client";
import { ArrowLeft, LifeBuoy, Megaphone, UsersRound } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { createApplicationChatClient, type ApplicationChatClient } from "@/lib/chatpack.client";
import type { PublicProfile } from "@/lib/profiles";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The public channel directory (`docs/decisions/0020`).
 *
 * Every signed-in user may browse this, which is exactly why a row is a thin
 * preview and never a conversation: returning participants would hand the
 * membership of every public channel to everybody. A count answers "is this the
 * right room?" without naming anyone.
 */
export function ChannelDirectory({
  user,
  client: providedClient,
  onClose,
}: {
  user: PublicProfile;
  client?: ApplicationChatClient;
  onClose?: () => void;
}) {
  const ownedClient = useMemo(() => createApplicationChatClient(user.id), [user.id]);
  const client = providedClient ?? ownedClient;
  const router = useRouter();
  const [channels, setChannels] = useState<ClientChannelPreview[] | null>(null);
  const [error, setError] = useState<ChatpackClientError | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);

  const load = useCallback(
    async (from: string | null) => {
      if (from === null) {
        setLoading(true);
        setError(null);
      }
      const result = await client.channels.list({
        limit: 30,
        ...(from === null ? {} : { cursor: from }),
      });
      if (result.error) {
        if (from === null) setError(result.error);
        else toast.error(result.error.message);
        setLoading(false);
        return;
      }
      setChannels((current) =>
        from === null ? result.data.channels : [...(current ?? []), ...result.data.channels],
      );
      setCursor(result.data.nextCursor);
      setError(null);
      setLoading(false);
    },
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    void client.channels.list({ limit: 30 }).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setChannels(result.data.channels);
      setCursor(result.data.nextCursor);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

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

  const close = onClose ?? (() => router.push("/"));

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="app-channel-directory-dialog app-channel-directory-card"
        showCloseButton={false}
      >
        <DialogHeader className="app-channel-directory-header">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="app-channel-directory-back"
            onClick={close}
            aria-label="Back to chat"
          >
            <ArrowLeft />
          </Button>
          <div className="app-channel-directory-header-copy">
            <DialogTitle>Channels</DialogTitle>
            <DialogDescription>Public groups anyone can join.</DialogDescription>
          </div>
        </DialogHeader>

        {error !== null ? (
          <ChannelDirectoryState
            image="/chatpack/error-3d.png"
            title="Couldn't load channels"
            description="The directory is unavailable right now. Channels you have already joined are unaffected."
            detail={error.code}
            actionLabel="Try again"
            onAction={() => void load(null)}
          />
        ) : loading ? (
          <ChannelDirectoryLoading />
        ) : channels?.length === 0 ? (
          <ChannelDirectoryState
            image="/chatpack/channel-empty.png"
            imageSize={55}
            imageHeight={52}
            title="No channels yet"
            description="A channel is a public group. Create one and anyone in your app can find and join it."
            actionLabel="Create a channel"
            onAction={() => router.push("/?new=group")}
          />
        ) : (
          <div className="app-channel-directory-body">
            {channels?.map((channel) => (
              <div key={channel.conversationId} className="app-channel-directory-row">
                <span className="app-channel-directory-icon" aria-hidden="true">
                  <ChannelIcon name={channel.name} />
                </span>
                <span className="app-channel-directory-copy">
                  <strong>{channel.name ?? "Unnamed channel"}</strong>
                  <small>
                    {channel.participantCount} members ·{" "}
                    {channel.joinPolicy === "open" ? "open" : "approval needed"}
                  </small>
                </span>
                {channel.requestPending ? (
                  <span className="app-channel-directory-requested">Requested</span>
                ) : (
                  <Button
                    size="sm"
                    variant={channel.alreadyParticipant ? "ghost" : "default"}
                    className={
                      channel.alreadyParticipant
                        ? "app-channel-directory-open"
                        : "app-channel-directory-join"
                    }
                    disabled={joining === channel.conversationId}
                    onClick={() => void join(channel)}
                  >
                    {channel.alreadyParticipant
                      ? "Open"
                      : channel.joinPolicy === "open"
                        ? "Join"
                        : "Request"}
                  </Button>
                )}
              </div>
            ))}

            {cursor !== null && (
              <Button variant="ghost" onClick={() => void load(cursor)}>
                Load more channels
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChannelIcon({ name }: { name: string | null }): ReactNode {
  const normalized = name?.toLowerCase() ?? "";
  if (normalized.includes("announce")) return <Megaphone />;
  if (normalized.includes("support")) return <LifeBuoy />;
  return <UsersRound />;
}

function ChannelDirectoryLoading() {
  return (
    <div className="app-channel-directory-body" aria-busy="true">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="app-channel-directory-skeleton" />
      ))}
    </div>
  );
}

function ChannelDirectoryState({
  image,
  imageSize = 46,
  imageHeight,
  title,
  description,
  detail,
  actionLabel,
  onAction,
}: {
  image: string;
  imageSize?: number;
  imageHeight?: number;
  title: string;
  description: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="app-channel-directory-state">
      <div className="app-channel-directory-state-copy">
        <Image src={image} alt="" width={imageSize} height={imageHeight ?? imageSize} />
        <div>
          <strong>{title}</strong>
          <p>{description}</p>
          {detail !== undefined && <code>{detail}</code>}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        className="app-channel-directory-state-action"
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </div>
  );
}
