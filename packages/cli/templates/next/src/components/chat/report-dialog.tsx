"use client";

import { useState } from "react";
import type { ReportTargetType } from "@chatpack/core";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/** Core caps a report reason at 1000 characters and rejects an empty one. */
const MAX_REASON_LENGTH = 1000;

/**
 * One dialog for all three report targets (`docs/decisions/0021`).
 *
 * Reporting is open to every authenticated user - unlike bans and the queue,
 * which need `moderation.canModerate`. Chatpack freezes evidence at submission
 * time, so a reported message that is edited or deleted afterwards still reaches
 * the moderator as it was.
 */
export function ReportDialog({
  open,
  onOpenChange,
  targetType,
  targetId,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetType: ReportTargetType;
  targetId: string;
  description: string;
}) {
  const { client } = useChat();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    const trimmed = reason.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    const result = await client.moderation.report({ targetType, targetId, reason: trimmed });
    setBusy(false);
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    toast.success("Report submitted.");
    setReason("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report this {targetType}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={MAX_REASON_LENGTH}
          rows={4}
          placeholder="What is wrong with it?"
          aria-label="Reason"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || reason.trim().length === 0} onClick={() => void submit()}>
            Send report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
