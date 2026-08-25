"use client";

import { useEffect, useMemo, useState } from "react";
import type { ClientInvitePreview } from "@chatpack/client";
import { MAX_JOIN_REQUEST_MESSAGE_LENGTH } from "@chatpack/core";
import { Hash, Link2Off, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { createApplicationChatClient } from "@/lib/chatpack.client";
import { resolveProfiles, shortenUserId, type PublicProfile } from "@/lib/profiles";

/**
 * The landing page for an invite link (`docs/decisions/0019`).
 *
 * The preview is deliberately thin - a name, a head count and who invited you -
 * because anyone holding the link can see it, whether or not they ever join.
 * Naming the members here would leak them to every forwarded copy of the URL.
 */
export function InviteAccept({ code, user }: { code: string; user: PublicProfile }) {
  const client = useMemo(() => createApplicationChatClient(user.id), [user.id]);
  const router = useRouter();
  const [preview, setPreview] = useState<ClientInvitePreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [invitedByName, setInvitedByName] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void client.invites.preview({ code }).then(async (result) => {
      if (!active) return;
      if (result.error) {
        // A revoked, expired or exhausted code is indistinguishable from a typo
        // on purpose: none of them confirm that a group exists.
        setFailure(result.error.message);
        return;
      }
      setPreview(result.data);
      const [profile] = await resolveProfiles([result.data.invitedBy]);
      if (active) setInvitedByName(profile?.name ?? shortenUserId(result.data.invitedBy));
    });
    return () => {
      active = false;
    };
  }, [client, code]);

  async function accept(): Promise<void> {
    setBusy(true);
    const trimmed = message.trim();
    const result = await client.invites.accept({
      code,
      ...(trimmed.length === 0 ? {} : { message: trimmed }),
    });
    setBusy(false);
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    if (result.data.status === "joined") {
      router.push(`/?conversation=${encodeURIComponent(result.data.conversation.id)}`);
      return;
    }
    toast.success("Sent. An admin has to approve you before you can read it.");
    router.push("/");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 p-6">
      {failure !== null ? (
        <>
          <Alert variant="destructive">
            <Link2Off />
            <AlertTitle>This invite will not work</AlertTitle>
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
          <Button asChild variant="outline">
            <Link href="/">Back to chat</Link>
          </Button>
        </>
      ) : preview === null ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="flex flex-col gap-4 rounded-xl border p-6">
          <div className="flex items-center gap-3">
            <Hash className="size-6 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{preview.name ?? "Unnamed group"}</p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="size-3" />
                {preview.participantCount} members · invited by{" "}
                {invitedByName ?? shortenUserId(preview.invitedBy)}
              </p>
            </div>
          </div>

          {preview.alreadyParticipant ? (
            <>
              <p className="text-sm text-muted-foreground">You are already in this one.</p>
              <Button asChild>
                <Link href={`/?conversation=${encodeURIComponent(preview.conversationId)}`}>
                  Open it
                </Link>
              </Button>
            </>
          ) : (
            <>
              {preview.requiresApproval && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="invite-message">Note for the admins (optional)</Label>
                  <Textarea
                    id="invite-message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    maxLength={MAX_JOIN_REQUEST_MESSAGE_LENGTH}
                    placeholder="I'm on the design team"
                  />
                  <p className="text-xs text-muted-foreground">
                    This link needs approval, so accepting opens a request instead of letting you
                    straight in.
                  </p>
                </div>
              )}
              <Button disabled={busy} onClick={() => void accept()}>
                {preview.requiresApproval ? "Ask to join" : "Join"}
              </Button>
            </>
          )}
        </div>
      )}
    </main>
  );
}
