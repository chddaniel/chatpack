"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import { createFileAttachmentMetadata } from "@chatpack/file";
import type { FilepackFile } from "@filepack/core";
import { Paperclip, X } from "lucide-react";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { formatBytes } from "@/components/chat/message-attachments";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  ATTACHMENT_ACCEPT_ATTRIBUTE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/filepack.client";
import { initialsOf } from "@/lib/profiles";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

/** Only re-announce typing this often; the plugin expires an indicator after 5s. */
const TYPING_SIGNAL_INTERVAL_MS = 3000;
const MAX_MESSAGE_LENGTH = 2000;

export function MessageComposer({
  conversationId,
  conversation,
  replyTo,
  onClearReply,
}: {
  conversationId: string;
  conversation: ClientConversation | null;
  replyTo: ClientMessage | null;
  onClearReply: () => void;
}) {
  const { client, files, viewer, directory } = useChat();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<{ code: string; message: string } | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  /**
   * Ids the user picked from the autocomplete, by the name that was inserted.
   *
   * Kept as name → id because the body is the only record of a mention the user
   * can see: Chatpack never parses `body` (`docs/decisions/0022`), so deleting
   * "@Ada" has to be able to drop Ada's id, and the text is what tells us.
   */
  const pickedMentions = useRef(new Map<string, string>());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingSignalledUntil = useRef(0);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    return (conversation?.participants ?? [])
      .filter((participant) => participant.userId !== viewer.id)
      .map((participant) => ({
        userId: participant.userId,
        name: directory.nameOf(participant.userId),
      }))
      .filter((person) => query.length === 0 || person.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [conversation?.participants, directory, mentionQuery, viewer.id]);

  function signalTyping(): void {
    const now = Date.now();
    if (now < typingSignalledUntil.current) return;
    typingSignalledUntil.current = now + TYPING_SIGNAL_INTERVAL_MS;
    // Ephemeral and best-effort: never stored, never replayed, and silently
    // absent while the client is polling (`docs/decisions/0008`).
    void client.typing.start({ conversationId });
  }

  function stopTyping(): void {
    typingSignalledUntil.current = 0;
    void client.typing.stop({ conversationId });
  }

  function updateBody(value: string, caret: number): void {
    setBody(value);
    setSendError(null);
    signalTyping();
    // The word being typed right before the caret, if it starts an `@`.
    const openMention = /@([^\s@]*)$/u.exec(value.slice(0, caret));
    setMentionQuery(openMention === null ? null : openMention[1]);
    setActiveIndex(0);
  }

  function insertMention(person: { userId: string; name: string }): void {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@[^\s@]*$/u, `@${person.name} `);
    const next = before + body.slice(caret);
    pickedMentions.current.set(person.name, person.userId);
    setBody(next);
    setMentionQuery(null);
    // Put the caret back after the name we just inserted.
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(before.length, before.length);
    });
  }

  function addFiles(selected: FileList | null): void {
    if (selected === null) return;
    const chosen = [...selected];
    const tooBig = chosen.filter((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (tooBig.length > 0) {
      toast.error(`Files must be ${formatBytes(MAX_ATTACHMENT_BYTES)} or smaller.`);
    }
    const room = MAX_ATTACHMENTS_PER_MESSAGE - pending.length;
    const accepted = chosen.filter((file) => file.size <= MAX_ATTACHMENT_BYTES).slice(0, room);
    if (accepted.length < chosen.length - tooBig.length) {
      toast.error(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
    }
    setPending((current) => [...current, ...accepted]);
  }

  /** Uploads the picked files and returns their stored records, or `null` on failure. */
  async function uploadPending(): Promise<FilepackFile[] | null> {
    if (pending.length === 0) return [];
    setUploading(true);
    // `input` is what the route's schema validates, and it is how the server
    // learns which conversation the file belongs to - without it the attach
    // check has nothing to authorize against (`docs/decisions/0018`).
    const task = files.upload({
      route: "attachment",
      input: { conversationId },
      files: pending,
    });
    const results = await task.result;
    setUploading(false);
    const completed = results.flatMap((result) =>
      result.status === "completed" ? [result.file] : [],
    );
    if (completed.length !== results.length) {
      setSendError({
        code: "UPLOAD_ERROR",
        message: `${results.length - completed.length} of ${results.length} files failed to upload.`,
      });
      toast.error(
        `${results.length - completed.length} of ${results.length} files failed to upload. Nothing was sent.`,
      );
      return null;
    }
    return completed;
  }

  async function send(): Promise<void> {
    const text = body.trim();
    if (conversationId === "" || (text.length === 0 && pending.length === 0)) return;
    setSendError(null);
    setSending(true);
    const uploaded = await uploadPending();
    if (uploaded === null) {
      setSending(false);
      return;
    }
    /**
     * Only the ids whose `@Name` is still in the text.
     *
     * Mentions are ids the app supplies, validated against membership by core -
     * never `@names` scanned out of the body (ADR 0022/0023). Which means
     * keeping the two in step is this composer's job: pick from the list and the
     * id goes in, delete the name and it comes out.
     */
    const mentions = [...pickedMentions.current]
      .filter(([name]) => text.includes(`@${name}`))
      .map(([, userId]) => userId);

    const result = await client.messages.send({
      conversationId,
      body: text,
      ...(replyTo === null ? {} : { replyToMessageId: replyTo.id }),
      ...(mentions.length === 0 ? {} : { mentions }),
      ...(uploaded.length === 0 ? {} : { metadata: createFileAttachmentMetadata(uploaded) }),
    });
    setSending(false);
    if (result.error) {
      setSendError(result.error);
      toast.error(result.error.message);
      return;
    }
    setBody("");
    setPending([]);
    setSendError(null);
    setMentionQuery(null);
    pickedMentions.current.clear();
    onClearReply();
    stopTyping();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (mentionQuery !== null && candidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % candidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const person = candidates[activeIndex];
        if (person !== undefined) {
          event.preventDefault();
          insertMention(person);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  const busy = sending || uploading;

  return (
    <div className="chatpack-ui-composer app-message-composer">
      <div className="app-message-composer-inner">
        {replyTo !== null && (
          <div className="chatpack-ui-composer-reply app-message-composer-reply">
            <span className="chatpack-ui-composer-reply-label">
              Replying to <strong>{directory.nameOf(replyTo.senderId)}</strong> · {replyTo.body}
            </span>
            <Button size="icon-sm" variant="ghost" onClick={onClearReply} aria-label="Cancel reply">
              <X />
            </Button>
          </div>
        )}

        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pending.map((file, index) => (
              <span
                key={`${file.name}-${index}`}
                className="flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
              >
                <span className="max-w-40 truncate">{file.name}</span>
                <span className="text-muted-foreground">{formatBytes(file.size)}</span>
                <button
                  onClick={() => setPending((current) => current.filter((_, at) => at !== index))}
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="app-message-composer-field-shell">
          {mentionQuery !== null && candidates.length > 0 && (
            <div className="absolute bottom-full left-0 z-10 mb-2 w-64 overflow-hidden rounded-lg border bg-popover p-1 shadow-md">
              {candidates.map((person, index) => (
                <button
                  key={person.userId}
                  onMouseDown={(event) => {
                    // `mousedown` rather than `click`: the textarea must not lose
                    // its caret before the insertion is computed.
                    event.preventDefault();
                    insertMention(person);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                    index === activeIndex ? "bg-accent" : ""
                  }`}
                >
                  <Avatar className="size-6">
                    <AvatarImage src={directory.profiles[person.userId]?.image ?? undefined} />
                    <AvatarFallback className="text-[10px]">
                      {initialsOf(person.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">{person.name}</span>
                </button>
              ))}
            </div>
          )}

          <InputGroup
            className={cn(
              "app-message-composer-field",
              sendError !== null && "app-message-composer-field-error",
              busy && "app-message-composer-field-sending",
            )}
            data-error={sendError !== null ? "true" : undefined}
            data-sending={busy ? "true" : undefined}
          >
            <InputGroupTextarea
              ref={textareaRef}
              value={body}
              onChange={(event) =>
                updateBody(
                  event.target.value,
                  event.target.selectionStart ?? event.target.value.length,
                )
              }
              onKeyDown={onKeyDown}
              onBlur={() => setMentionQuery(null)}
              placeholder="Write a message. Type @ to mention someone."
              aria-label="Message"
              aria-invalid={sendError !== null}
              maxLength={MAX_MESSAGE_LENGTH}
              disabled={conversationId === ""}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-sm"
                variant="ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || pending.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                className="app-message-composer-attach"
                aria-label="Attach files"
              >
                <Paperclip />
              </InputGroupButton>
              <InputGroupButton
                size="icon-sm"
                onClick={() => void send()}
                disabled={busy || (body.trim().length === 0 && pending.length === 0)}
                className="app-message-composer-send"
                aria-label="Send"
              >
                {busy ? "Sending…" : "Send"}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <div className="chatpack-ui-composer-hint-row app-message-composer-hint-row">
          <small
            className={
              sendError !== null ? "chatpack-ui-composer-error" : "chatpack-ui-composer-hint"
            }
          >
            {sendError !== null
              ? "Message didn't send. Tap Send to try again."
              : uploading
                ? "Uploading attachments…"
                : "Enter to send · Shift+Enter for a new line"}
          </small>
          {sendError !== null ? (
            <code className="chatpack-ui-composer-error-code">{sendError.code}</code>
          ) : (
            <small className="chatpack-ui-composer-count" aria-live="polite">
              {body.length}/{MAX_MESSAGE_LENGTH}
            </small>
          )}
        </div>
      </div>
    </div>
  );
}
