"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ClientConversation,
  ClientConversationInvite,
  ClientJoinRequest,
} from "@chatpack/client";
import { MAX_INVITES_PER_CONVERSATION } from "@chatpack/core";
import {
  Ban,
  Copy,
  MoreHorizontal,
  ShieldMinus,
  ShieldPlus,
  TriangleAlert,
  UserMinus,
} from "lucide-react";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { ProfilePicker } from "@/components/chat/profile-picker";
import { ReportDialog } from "@/components/chat/report-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { viewerIsAdmin } from "@/lib/conversation";
import { initialsOf } from "@/lib/profiles";

const EXPIRY_CHOICES = [
  { label: "24 hours", seconds: 60 * 60 * 24 },
  { label: "7 days", seconds: 60 * 60 * 24 * 7 },
  { label: "Never", seconds: null },
];

/**
 * Membership, roles, invite links and the join queue for one group.
 *
 * Every tab here is admin-gated server-side too - core answers `FORBIDDEN` for a
 * member who calls them, so hiding the buttons is a courtesy rather than the
 * enforcement (`docs/decisions/0017`, `0019`).
 */
export function MembersPanel({
  conversation,
  onClose,
}: {
  conversation: ClientConversation;
  onClose: () => void;
}) {
  const { client, viewer, directory, blockedUserIds, toggleBlock } = useChat();
  const isAdmin = viewerIsAdmin(conversation, viewer.id);
  const [invites, setInvites] = useState<ClientConversationInvite[]>([]);
  const [requests, setRequests] = useState<ClientJoinRequest[]>([]);
  const [expirySeconds, setExpirySeconds] = useState<number | null>(60 * 60 * 24 * 7);
  const [maxUses, setMaxUses] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [reportedUserId, setReportedUserId] = useState<string | null>(null);

  const refreshInvites = useCallback(async () => {
    const result = await client.invites.list({ conversationId: conversation.id });
    if (result.data) setInvites(result.data.invites);
  }, [client, conversation.id]);

  const refreshRequests = useCallback(async () => {
    const result = await client.joinRequests.list({
      conversationId: conversation.id,
      status: "pending",
    });
    if (result.data) {
      setRequests(result.data.joinRequests);
      directory.ensure(result.data.joinRequests.map((request) => request.userId));
    }
  }, [client, conversation.id, directory]);

  useEffect(() => {
    if (!isAdmin) return;
    void refreshInvites();
    void refreshRequests();
  }, [isAdmin, refreshInvites, refreshRequests]);

  async function addMember(userId: string): Promise<void> {
    const result = await client.conversations.addParticipants({
      conversationId: conversation.id,
      userIds: [userId],
    });
    if (result.error) toast.error(result.error.message);
  }

  async function setRole(userId: string, role: "admin" | "member"): Promise<void> {
    const result = await client.conversations.setParticipantRole({
      conversationId: conversation.id,
      userId,
      role,
    });
    if (result.error) toast.error(result.error.message);
  }

  async function removeMember(userId: string): Promise<void> {
    const result = await client.conversations.removeParticipant({
      conversationId: conversation.id,
      userId,
    });
    // Demoting the last admin is refused rather than silently allowed - promote
    // someone before you leave.
    if (result.error) toast.error(result.error.message);
  }

  async function createInvite(): Promise<void> {
    const parsedUses = Number.parseInt(maxUses, 10);
    const result = await client.invites.create({
      conversationId: conversation.id,
      ...(expirySeconds === null ? {} : { expiresInSeconds: expirySeconds }),
      ...(Number.isFinite(parsedUses) && parsedUses > 0 ? { maxUses: parsedUses } : {}),
      requiresApproval,
    });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    setMaxUses("");
    await refreshInvites();
  }

  async function revokeInvite(code: string): Promise<void> {
    const result = await client.invites.revoke({ conversationId: conversation.id, code });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    await refreshInvites();
  }

  async function resolveRequest(userId: string, decision: "approve" | "deny"): Promise<void> {
    const result = await client.joinRequests.resolve({
      conversationId: conversation.id,
      userId,
      decision,
    });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    await refreshRequests();
  }

  async function copyInvite(code: string): Promise<void> {
    // The code *is* the permission, the way a document share link is
    // (`docs/decisions/0019`) - so this is the only thing that needs to travel.
    await navigator.clipboard.writeText(`${window.location.origin}/invite/${code}`);
    toast.success("Invite link copied.");
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>People</SheetTitle>
        </SheetHeader>
        <Tabs defaultValue="members" className="min-h-0 flex-1 gap-0">
          <TabsList className="m-4">
            <TabsTrigger value="members">Members</TabsTrigger>
            {isAdmin && <TabsTrigger value="invites">Invites</TabsTrigger>}
            {isAdmin && (
              <TabsTrigger value="requests">
                Requests
                {requests.length > 0 && (
                  <Badge variant="secondary" className="ml-1">
                    {requests.length}
                  </Badge>
                )}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="members" className="min-h-0">
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-1 px-4 pb-4">
                {conversation.participants.map((participant) => {
                  const name =
                    participant.userId === viewer.id
                      ? `${viewer.name} (you)`
                      : directory.nameOf(participant.userId);
                  return (
                    <div
                      key={participant.userId}
                      className="flex items-center gap-3 rounded-lg px-2 py-2"
                    >
                      <Avatar size="sm">
                        <AvatarImage
                          src={directory.profiles[participant.userId]?.image ?? undefined}
                        />
                        <AvatarFallback>{initialsOf(name)}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                      {participant.role === "admin" && <Badge variant="outline">admin</Badge>}
                      {participant.userId !== viewer.id && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon-sm" variant="ghost" aria-label={`Manage ${name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {isAdmin &&
                              (participant.role === "admin" ? (
                                <DropdownMenuItem
                                  onSelect={() => void setRole(participant.userId, "member")}
                                >
                                  <ShieldMinus />
                                  Demote to member
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onSelect={() => void setRole(participant.userId, "admin")}
                                >
                                  <ShieldPlus />
                                  Make admin
                                </DropdownMenuItem>
                              ))}
                            {isAdmin && (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => void removeMember(participant.userId)}
                              >
                                <UserMinus />
                                Remove from group
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onSelect={() => setReportedUserId(participant.userId)}
                            >
                              <TriangleAlert />
                              Report
                            </DropdownMenuItem>
                            {/* Blocking is one-sided and immediate: it refuses new
                                directs between the two of you and leaves this
                                group untouched (`docs/decisions/0021`). */}
                            <DropdownMenuItem onSelect={() => void toggleBlock(participant.userId)}>
                              <Ban />
                              {blockedUserIds.has(participant.userId) ? "Unblock" : "Block"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  );
                })}

                {isAdmin && (
                  <div className="mt-4 flex flex-col gap-2">
                    <Label>Add someone</Label>
                    <ProfilePicker
                      exclude={conversation.participants.map((participant) => participant.userId)}
                      onPick={(profile) => {
                        directory.put(profile);
                        void addMember(profile.id);
                      }}
                    />
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {isAdmin && (
            <TabsContent value="invites" className="min-h-0">
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-4 px-4 pb-4">
                  <div className="flex flex-col gap-2 rounded-lg border p-3">
                    <Label>Expires</Label>
                    <div className="flex gap-2">
                      {EXPIRY_CHOICES.map((choice) => (
                        <Button
                          key={choice.label}
                          size="sm"
                          variant={expirySeconds === choice.seconds ? "default" : "outline"}
                          onClick={() => setExpirySeconds(choice.seconds)}
                        >
                          {choice.label}
                        </Button>
                      ))}
                    </div>
                    <Label htmlFor="invite-max-uses">Maximum uses (optional)</Label>
                    <Input
                      id="invite-max-uses"
                      value={maxUses}
                      onChange={(event) => setMaxUses(event.target.value)}
                      inputMode="numeric"
                      placeholder="Unlimited"
                    />
                    <Button
                      size="sm"
                      variant={requiresApproval ? "default" : "outline"}
                      onClick={() => setRequiresApproval((current) => !current)}
                    >
                      {requiresApproval ? "Link needs approval" : "Link joins immediately"}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Per link, not per group: hand the team an open link and the public a gated
                      one.
                    </p>
                    <Button
                      onClick={() => void createInvite()}
                      disabled={invites.length >= MAX_INVITES_PER_CONVERSATION}
                    >
                      Create invite link
                    </Button>
                  </div>

                  {invites.length === 0 && (
                    <p className="text-sm text-muted-foreground">No invite links yet.</p>
                  )}
                  {invites.map((invite) => (
                    <div key={invite.code} className="flex flex-col gap-2 rounded-lg border p-3">
                      <code className="truncate text-xs">{invite.code}</code>
                      <p className="text-xs text-muted-foreground">
                        {invite.uses} of {invite.maxUses ?? "∞"} uses ·{" "}
                        {invite.expiresAt === null
                          ? "never expires"
                          : `expires ${new Date(invite.expiresAt).toLocaleString()}`}
                        {invite.requiresApproval ? " · needs approval" : ""}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void copyInvite(invite.code)}
                        >
                          <Copy />
                          Copy link
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void revokeInvite(invite.code)}
                        >
                          Revoke
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="requests" className="min-h-0">
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-2 px-4 pb-4">
                  {requests.length === 0 && (
                    <p className="text-sm text-muted-foreground">Nobody is waiting.</p>
                  )}
                  {requests.map((request) => (
                    <div key={request.id} className="flex flex-col gap-2 rounded-lg border p-3">
                      <p className="text-sm font-medium">{directory.nameOf(request.userId)}</p>
                      {request.message !== null && (
                        <p className="text-xs text-muted-foreground">{request.message}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {request.inviteCode === null
                          ? "Asked directly"
                          : "Came from an invite link"}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => void resolveRequest(request.userId, "approve")}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void resolveRequest(request.userId, "deny")}
                        >
                          Deny
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>
          )}
        </Tabs>

        {reportedUserId !== null && (
          <ReportDialog
            open
            onOpenChange={(open) => !open && setReportedUserId(null)}
            targetType="user"
            targetId={reportedUserId}
            description="Moderators see who you reported and why. Blocking them is separate, and immediate."
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
