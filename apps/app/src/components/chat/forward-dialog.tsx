"use client";

import { useState } from "react";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { conversationKind, conversationTitle } from "@/lib/conversation";

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

  async function forward(target: ClientConversation): Promise<void> {
    setBusy(true);
    // Mentions are deliberately not carried over: they are validated against the
    // **target's** membership, and the people named in the original are usually
    // not in it.
    const result = await client.messages.forward({
      messageId: message.id,
      toConversationId: target.id,
    });
    setBusy(false);
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    toast.success(`Forwarded to ${conversationTitle(target, viewer.id, directory.nameOf)}`);
    onClose();
  }

  const targets = (conversations.data?.conversations ?? []).filter(
    (conversation) => conversation.id !== fromConversation?.id,
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Forward message</DialogTitle>
          <DialogDescription className="truncate">
            {message.body || "An attachment"}
          </DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search your conversations" />
          <CommandList>
            <CommandEmpty>No other conversation to forward into.</CommandEmpty>
            <CommandGroup>
              {targets.map((target) => {
                const title = conversationTitle(target, viewer.id, directory.nameOf);
                return (
                  <CommandItem
                    key={target.id}
                    value={`${title} ${target.id}`}
                    disabled={busy}
                    onSelect={() => void forward(target)}
                  >
                    <span className="flex-1 truncate">{title}</span>
                    <span className="text-xs text-muted-foreground">
                      {conversationKind(target)}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
