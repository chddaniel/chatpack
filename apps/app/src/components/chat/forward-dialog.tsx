"use client";

import { useState } from "react";
import Image from "next/image";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import { Check } from "lucide-react";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { conversationTitle } from "@/lib/conversation";
import { initialsOf } from "@/lib/profiles";

/**
 * Copies one message into another conversation (`docs/decisions/0024`).
 *
 * A forward is a **new message** in the target, not a pointer to the old one:
 * the body is copied at forward time and only three ids of provenance travel
 * with it. So the recipient can read the forward without gaining any access to
 * where it came from, and editing the original later changes nothing here.
 */
export function ForwardDialog({
  message,
  fromConversation,
  onClose,
}: {
  message: ClientMessage;
  fromConversation: ClientConversation | null;
  onClose: () => void;
}) {
  const { client, viewer, directory } = useChat();
  const conversations = client.useConversations({ limit: 50 });
  const [busy, setBusy] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [forwardError, setForwardError] = useState<{ code: string } | null>(null);

  const targets = (conversations.data?.conversations ?? []).filter(
    (conversation) => conversation.id !== fromConversation?.id,
  );
  const activeTargetId = selectedTargetId ?? targets[0]?.id ?? null;
  const errorCode = forwardError?.code ?? conversations.error?.code ?? null;
  const loading = conversations.isPending && targets.length === 0 && errorCode === null;

  async function forward(): Promise<void> {
    if (activeTargetId === null) return;
    setBusy(true);
    setForwardError(null);
    // Mentions are deliberately not carried over: they are validated against the
    // **target's** membership, and the people named in the original are usually
    // not in it.
    const result = await client.messages.forward({
      messageId: message.id,
      toConversationId: activeTargetId,
    });
    setBusy(false);
    if (result.error) {
      setForwardError({ code: result.error.code });
      return;
    }
    const target = targets.find((conversation) => conversation.id === activeTargetId);
    if (target !== undefined) {
      toast.success(`Forwarded to ${conversationTitle(target, viewer.id, directory.nameOf)}`);
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="chatpack-ui-forward-dialog app-forward-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="chatpack-ui-forward-dialog-header">
          <DialogTitle>Forward message</DialogTitle>
          {!loading && errorCode === null && targets.length > 0 && (
            <DialogDescription>Choose a conversation to forward to.</DialogDescription>
          )}
        </DialogHeader>

        {errorCode !== null ? (
          <div className="chatpack-ui-forward-dialog-state">
            <Image src="/chatpack/forward-error.png" alt="" width={46} height={46} />
            <div className="chatpack-ui-forward-dialog-state-copy">
              <strong>Couldn&apos;t forward</strong>
              <span>The message was not forwarded. Nothing was sent to anyone.</span>
              <code>{errorCode}</code>
            </div>
            <Button
              type="button"
              className="chatpack-ui-forward-dialog-retry"
              onClick={() => void forward()}
            >
              Try again
            </Button>
          </div>
        ) : loading ? (
          <div className="chatpack-ui-forward-dialog-list" aria-busy="true">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="chatpack-ui-forward-dialog-skeleton" />
            ))}
          </div>
        ) : targets.length === 0 ? (
          <div className="chatpack-ui-forward-dialog-state">
            <Image src="/chatpack/forward-empty.png" alt="" width={56} height={52} />
            <div className="chatpack-ui-forward-dialog-state-copy">
              <strong>Nowhere to forward to</strong>
              <span>
                You are only in this conversation. Start another one and it will show up here.
              </span>
            </div>
            <Button type="button" className="chatpack-ui-forward-dialog-new" onClick={onClose}>
              New conversation
            </Button>
          </div>
        ) : (
          <>
            <div
              className="chatpack-ui-forward-dialog-list"
              role="listbox"
              aria-label="Conversations"
            >
              {targets.map((target) => {
                const title = conversationTitle(target, viewer.id, directory.nameOf);
                const avatarId = avatarProfileId(target, viewer.id);
                const selected = target.id === activeTargetId;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    key={target.id}
                    disabled={busy}
                    className="chatpack-ui-forward-dialog-target"
                    onClick={() => {
                      setSelectedTargetId(target.id);
                      setForwardError(null);
                    }}
                  >
                    <Avatar className="chatpack-ui-forward-dialog-avatar">
                      <AvatarImage
                        src={
                          avatarId === null
                            ? undefined
                            : (directory.profiles[avatarId]?.image ?? undefined)
                        }
                      />
                      <AvatarFallback>{initialsOf(title)}</AvatarFallback>
                    </Avatar>
                    <span className="chatpack-ui-forward-dialog-target-copy">
                      <strong>{title}</strong>
                      {target.type === "group" && (
                        <small>{target.participants.length} members</small>
                      )}
                    </span>
                    <span className="chatpack-ui-forward-dialog-check" aria-hidden="true">
                      {selected && <Check />}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="chatpack-ui-forward-dialog-footer">
              <Button
                type="button"
                variant="ghost"
                className="chatpack-ui-forward-dialog-cancel"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="chatpack-ui-forward-dialog-submit"
                onClick={() => void forward()}
                disabled={busy || activeTargetId === null}
              >
                {busy ? "Forwarding…" : "Forward"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function avatarProfileId(conversation: ClientConversation, viewerId: string): string | null {
  return (
    conversation.participants.find((participant) => participant.userId !== viewerId)?.userId ??
    conversation.participants[0]?.userId ??
    null
  );
}
