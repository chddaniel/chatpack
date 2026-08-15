"use client";

import { useEffect, useState } from "react";
import {
  parseFileAttachmentMetadata,
  type FileAttachmentReference,
  type ResolvedFileAttachment,
} from "@chatpack/file";
import { Download, FileX2 } from "lucide-react";

import { useChat } from "@/components/chat/chat-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/filepack.client";

/**
 * Reads the attachment references a message carries.
 *
 * Chatpack messages store only `{ id, name, contentType, size }` under a
 * `filepack` key in metadata - never a URL. Bytes live in Filepack, and every
 * download URL is minted per request and expires, so a file can never leak
 * through message history (`docs/decisions/0018`).
 */
export function readAttachments(
  metadata: Record<string, unknown>,
): readonly FileAttachmentReference[] {
  try {
    return (
      parseFileAttachmentMetadata(metadata, MAX_ATTACHMENTS_PER_MESSAGE)?.filepack.attachments ?? []
    );
  } catch {
    // Metadata whose `filepack` key was not written by `@chatpack/file`. The
    // message still renders - it just has no attachments as far as we know.
    return [];
  }
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageAttachments({
  conversationId,
  attachments,
}: {
  conversationId: string;
  attachments: readonly FileAttachmentReference[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {attachments.map((attachment) => (
        <Attachment key={attachment.id} conversationId={conversationId} attachment={attachment} />
      ))}
    </div>
  );
}

function Attachment({
  conversationId,
  attachment,
}: {
  conversationId: string;
  attachment: FileAttachmentReference;
}) {
  const { files } = useChat();
  const [resolved, setResolved] = useState<ResolvedFileAttachment | null>(null);

  useEffect(() => {
    let cancelled = false;
    // `resolveTarget` checks that the file is still readable in this
    // conversation and mints a short-lived URL, caching it until just before it
    // expires. Re-mounting the row does not cost a new signature.
    void files
      .resolveTarget({ conversationId, fileId: attachment.id })
      .then((target) => {
        if (!cancelled) setResolved(target);
      })
      .catch(() => {
        if (!cancelled) setResolved({ status: "unavailable", fileId: attachment.id });
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, conversationId, files]);

  if (resolved === null) return <Skeleton className="h-10 w-56 rounded-lg" />;

  if (resolved.status === "unavailable") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs opacity-70">
        <FileX2 className="size-4" />
        <span className="truncate">{attachment.name} is no longer available</span>
      </div>
    );
  }

  if (resolved.kind === "inline" && attachment.contentType.startsWith("image/")) {
    return (
      <a href={resolved.url} target="_blank" rel="noreferrer" className="block">
        {/* Not `next/image`: the URL is signed, expires in minutes, and points at
            whichever bucket the deployment configured. Optimising it would mean
            allow-listing that host and caching a link that is meant to rot. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={resolved.url}
          alt={attachment.name}
          className="max-h-64 w-auto max-w-full rounded-lg border"
        />
      </a>
    );
  }

  return (
    <Button asChild variant="outline" size="sm" className="h-auto justify-start py-2">
      <a href={resolved.url} download={attachment.name}>
        <Download />
        <span className="min-w-0 flex-1 truncate text-left">{attachment.name}</span>
        <span className="text-xs text-muted-foreground">{formatBytes(attachment.size)}</span>
      </a>
    </Button>
  );
}
