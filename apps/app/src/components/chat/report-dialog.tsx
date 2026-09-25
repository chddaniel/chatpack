"use client";

import { useState } from "react";
import type { ChatpackClientError } from "@chatpack/client";
import type { ReportTargetType } from "@chatpack/core";

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
const REPORT_REASONS = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment" },
  { value: "something_else", label: "Something else" },
] as const;
type ReportReason = (typeof REPORT_REASONS)[number]["value"];

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
  const [selectedReason, setSelectedReason] = useState<ReportReason>("spam");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<ChatpackClientError | null>(null);

  async function submit(): Promise<void> {
    const label = REPORT_REASONS.find((item) => item.value === selectedReason)?.label ?? "Report";
    const reason = selectedReason === "something_else" ? details.trim() : label;
    if (reason.length === 0) return;
    setError(null);
    setBusy(true);
    const result = await client.moderation.report({ targetType, targetId, reason });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSubmitted(true);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="app-report-dialog">
        <DialogHeader className="app-report-dialog-header">
          <DialogTitle>Report this {targetType}</DialogTitle>
          {!submitted && error === null && (
            <DialogDescription>{description || "Only moderators see reports."}</DialogDescription>
          )}
        </DialogHeader>

        {submitted ? (
          <div className="app-report-dialog-state">
            <span className="app-report-dialog-success-icon" aria-hidden="true">
              ✓
            </span>
            <strong>Report sent</strong>
            <p>A moderator will review it. The sender is not told who reported them.</p>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : error !== null ? (
          <div className="app-report-dialog-state" role="alert">
            <span className="app-report-dialog-error-icon" aria-hidden="true">
              !
            </span>
            <strong>Couldn&apos;t send the report</strong>
            <p>Nothing was submitted. Try again and it will send.</p>
            <code>{error.code}</code>
            <Button className="app-report-dialog-retry" onClick={() => void submit()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <div className={`app-report-dialog-body ${busy ? "app-report-dialog-body-busy" : ""}`}>
              {REPORT_REASONS.map((item) => {
                const selected = selectedReason === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className="app-report-dialog-reason"
                    onClick={() => setSelectedReason(item.value)}
                  >
                    <span className={`app-report-dialog-radio ${selected ? "selected" : ""}`} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
              {selectedReason === "something_else" && (
                <Textarea
                  value={details}
                  onChange={(event) => setDetails(event.target.value)}
                  maxLength={MAX_REASON_LENGTH}
                  rows={4}
                  placeholder="What is wrong with it?"
                  aria-label="Reason"
                />
              )}
            </div>
            <DialogFooter className="app-report-dialog-footer">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={
                  busy || (selectedReason === "something_else" && details.trim().length === 0)
                }
                onClick={() => void submit()}
              >
                Send report
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
