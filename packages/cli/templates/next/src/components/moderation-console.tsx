"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientModerationReport, ClientUserBan, ClientUserBlock } from "@chatpack/client";
import type { ReportStatus } from "@chatpack/core";
import { ArrowLeft, Gavel, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { ProfilePicker } from "@/components/chat/profile-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useProfileDirectory } from "@/hooks/use-profiles";
import { createApplicationChatClient } from "@/lib/chatpack.client";
import type { PublicProfile } from "@/lib/profiles";

const STATUSES: ReportStatus[] = ["open", "triaged", "resolved", "dismissed"];

/**
 * The moderator console (`docs/decisions/0021`).
 *
 * Who counts as a moderator is your app's decision, not Chatpack's: the
 * `moderation.canModerate` hook in `lib/chatpack.server.ts` answers it, and this
 * starter wires it to the `MODERATOR_EMAILS` / `MODERATOR_USER_IDS` env vars.
 * The client cannot know the answer, so it asks for the queue and renders the
 * refusal honestly if the server says no.
 */
export function ModerationConsole({ user }: { user: PublicProfile }) {
  const client = useMemo(() => createApplicationChatClient(user.id), [user.id]);
  const directory = useProfileDirectory(user);
  const [status, setStatus] = useState<ReportStatus>("open");
  const [reports, setReports] = useState<ClientModerationReport[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [bans, setBans] = useState<ClientUserBan[]>([]);
  const [bansLoadedAt, setBansLoadedAt] = useState(0);
  const [blocks, setBlocks] = useState<ClientUserBlock[]>([]);

  const refreshReports = useCallback(async () => {
    const result = await client.moderation.listReports({ status, limit: 50 });
    if (result.error) {
      // The only honest way to ask "am I a moderator?" - your `canModerate` hook
      // owns that answer and the client never sees it. NOT_MODERATOR (403) is
      // the code core throws when the hook says no.
      if (result.error.code === "NOT_MODERATOR") setForbidden(true);
      else toast.error(result.error.message);
      setReports([]);
      return;
    }
    setForbidden(false);
    setReports(result.data.reports);
  }, [client, status]);

  const refreshBans = useCallback(async () => {
    const result = await client.moderation.listBans({ limit: 50 });
    if (result.data) {
      setBans(result.data.bans);
      setBansLoadedAt(Date.now());
    }
  }, [client]);

  const refreshBlocks = useCallback(async () => {
    const result = await client.moderation.listBlockedUsers({ limit: 100 });
    if (result.data) setBlocks(result.data.blocks);
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void client.moderation.listReports({ status, limit: 50 }).then((result) => {
      if (cancelled) return;
      if (result.error) {
        if (result.error.code === "NOT_MODERATOR") setForbidden(true);
        else toast.error(result.error.message);
        setReports([]);
        return;
      }
      setForbidden(false);
      setReports(result.data.reports);
    });
    return () => {
      cancelled = true;
    };
  }, [client, status]);

  useEffect(() => {
    let cancelled = false;
    void client.moderation.listBlockedUsers({ limit: 100 }).then((result) => {
      if (!cancelled && result.data) setBlocks(result.data.blocks);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (forbidden) return;
    let cancelled = false;
    void client.moderation.listBans({ limit: 50 }).then((result) => {
      if (!cancelled && result.data) {
        setBans(result.data.bans);
        setBansLoadedAt(Date.now());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, forbidden]);

  // Name resolution is a separate pass so that a resolved batch cannot re-trigger
  // the fetch that asked for it: `ensure` is idempotent, the loaders are not.
  useEffect(() => {
    directory.ensure([
      ...(reports ?? []).map((report) => report.reporterUserId),
      ...bans.map((ban) => ban.userId),
      ...blocks.map((block) => block.blockedUserId),
    ]);
  }, [bans, blocks, directory, reports]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <Button asChild size="icon" variant="ghost" aria-label="Back to chat">
          <Link href="/">
            <ArrowLeft />
          </Link>
        </Button>
        <div>
          <h1 className="text-lg font-semibold">Moderation</h1>
          <p className="text-sm text-muted-foreground">
            Reports, bans, and the people you have blocked yourself.
          </p>
        </div>
      </div>

      <Tabs defaultValue="reports">
        <TabsList>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="bans">Bans</TabsTrigger>
          <TabsTrigger value="blocks">My blocks</TabsTrigger>
        </TabsList>

        <TabsContent value="reports" className="flex flex-col gap-3">
          {forbidden ? (
            <Alert>
              <ShieldCheck />
              <AlertTitle>You are not a moderator</AlertTitle>
              <AlertDescription>
                Add your email to <code>MODERATOR_EMAILS</code> (or your user id to{" "}
                <code>MODERATOR_USER_IDS</code>) in <code>.env.local</code> and restart. Reporting
                and blocking work for everyone; the queue does not.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex gap-2">
                {STATUSES.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={status === option ? "default" : "outline"}
                    onClick={() => setStatus(option)}
                  >
                    {option}
                  </Button>
                ))}
              </div>

              {reports === null && <Skeleton className="h-24 w-full" />}
              {reports?.length === 0 && (
                <p className="text-sm text-muted-foreground">Nothing {status}.</p>
              )}
              {reports?.map((report) => (
                <ReportCard
                  key={report.id}
                  report={report}
                  reporterName={directory.nameOf(report.reporterUserId)}
                  onUpdate={async (nextStatus, note) => {
                    const result = await client.moderation.updateReport({
                      reportId: report.id,
                      status: nextStatus,
                      ...(note === null ? {} : { moderatorNote: note }),
                    });
                    if (result.error) {
                      toast.error(result.error.message);
                      return;
                    }
                    await refreshReports();
                  }}
                  onBan={async (targetUserId) => {
                    const result = await client.moderation.banUser({
                      targetUserId,
                      reason: `Report ${report.id}`,
                    });
                    if (result.error) {
                      toast.error(result.error.message);
                      return;
                    }
                    toast.success("Banned. Sending and joining are refused for them now.");
                    await refreshBans();
                  }}
                />
              ))}
            </>
          )}
        </TabsContent>

        <TabsContent value="bans" className="flex flex-col gap-3">
          {forbidden ? (
            <p className="text-sm text-muted-foreground">Moderators only.</p>
          ) : (
            <>
              <BanForm
                onSubmit={async (targetUserId, reason, expiresAt) => {
                  const result = await client.moderation.banUser({
                    targetUserId,
                    ...(reason === null ? {} : { reason }),
                    ...(expiresAt === null ? {} : { expiresAt }),
                  });
                  if (result.error) {
                    toast.error(result.error.message);
                    return;
                  }
                  await refreshBans();
                }}
              />
              {bans.length === 0 && <p className="text-sm text-muted-foreground">Nobody banned.</p>}
              {bans.map((ban) => {
                const active =
                  ban.revokedAt === null &&
                  (ban.expiresAt === null || new Date(ban.expiresAt).getTime() > bansLoadedAt);
                return (
                  <div key={ban.id} className="flex items-center gap-3 rounded-lg border p-3">
                    <Gavel className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{directory.nameOf(ban.userId)}</p>
                      <p className="text-xs text-muted-foreground">
                        {ban.reason ?? "No reason given"} ·{" "}
                        {ban.expiresAt === null
                          ? "permanent"
                          : `until ${new Date(ban.expiresAt).toLocaleString()}`}
                      </p>
                    </div>
                    {active ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void client.moderation
                            .unbanUser({ banId: ban.id })
                            .then(async (result) => {
                              if (result.error) toast.error(result.error.message);
                              else await refreshBans();
                            })
                        }
                      >
                        Revoke
                      </Button>
                    ) : (
                      <Badge variant="muted">inactive</Badge>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </TabsContent>

        <TabsContent value="blocks" className="flex flex-col gap-3">
          {/* Blocking is a user-level action, not a moderator one: it is one-sided,
              immediate, and needs nobody's approval (`docs/decisions/0021`). */}
          {blocks.length === 0 && (
            <p className="text-sm text-muted-foreground">You have not blocked anyone.</p>
          )}
          {blocks.map((block) => (
            <div
              key={block.blockedUserId}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {directory.nameOf(block.blockedUserId)}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void client.moderation
                    .unblockUser({ targetUserId: block.blockedUserId })
                    .then(async (result) => {
                      if (result.error) toast.error(result.error.message);
                      else await refreshBlocks();
                    })
                }
              >
                Unblock
              </Button>
            </div>
          ))}
        </TabsContent>
      </Tabs>
    </main>
  );
}

function ReportCard({
  report,
  reporterName,
  onUpdate,
  onBan,
}: {
  report: ClientModerationReport;
  reporterName: string;
  onUpdate: (status: ReportStatus, note: string | null) => Promise<void>;
  onBan: (targetUserId: string) => Promise<void>;
}) {
  const [note, setNote] = useState(report.moderatorNote ?? "");
  // A local const, so the `targetType` narrowing below survives into the click
  // handlers that need `senderId`.
  const evidence = report.evidence;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Badge variant="outline">{report.targetType}</Badge>
        <Badge variant="muted">{report.status}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(report.createdAt).toLocaleString()}
        </span>
      </div>

      <p className="text-sm">{report.reason}</p>
      <p className="text-xs text-muted-foreground">Reported by {reporterName}</p>

      {/* Evidence is captured when the report is filed, not read back at review
          time - so a message deleted afterwards is still reviewable
          (`docs/decisions/0021`). */}
      {evidence.targetType === "message" && (
        <div className="rounded-md bg-muted p-3 text-sm">
          <p className="whitespace-pre-wrap break-words">{evidence.body}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {evidence.deletedAt === null
              ? "still live"
              : `deleted ${new Date(evidence.deletedAt).toLocaleString()}`}
          </p>
        </div>
      )}
      {evidence.targetType === "conversation" && (
        <p className="text-xs text-muted-foreground">
          {evidence.type} · {evidence.name ?? "unnamed"} · {evidence.participantIds.length}{" "}
          participants
        </p>
      )}

      <Textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Moderator note (optional)"
        aria-label="Moderator note"
      />

      <div className="flex flex-wrap gap-2">
        {STATUSES.filter((option) => option !== report.status).map((option) => (
          <Button
            key={option}
            size="sm"
            variant="outline"
            onClick={() => void onUpdate(option, note.trim().length === 0 ? null : note.trim())}
          >
            Mark {option}
          </Button>
        ))}
        {evidence.targetType === "message" && (
          <Button size="sm" variant="destructive" onClick={() => void onBan(evidence.senderId)}>
            Ban sender
          </Button>
        )}
        {report.targetType === "user" && (
          <Button size="sm" variant="destructive" onClick={() => void onBan(report.targetId)}>
            Ban user
          </Button>
        )}
      </div>
    </div>
  );
}

function BanForm({
  onSubmit,
}: {
  onSubmit: (
    targetUserId: string,
    reason: string | null,
    expiresAt: string | null,
  ) => Promise<void>;
}) {
  const [target, setTarget] = useState<PublicProfile | null>(null);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("");

  async function submit(): Promise<void> {
    if (target === null) return;
    const parsedDays = Number.parseInt(days, 10);
    const expiresAt =
      Number.isFinite(parsedDays) && parsedDays > 0
        ? new Date(Date.now() + parsedDays * 24 * 60 * 60 * 1000).toISOString()
        : null;
    await onSubmit(target.id, reason.trim().length === 0 ? null : reason.trim(), expiresAt);
    setTarget(null);
    setReason("");
    setDays("");
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <Label>Ban someone</Label>
      {target === null ? (
        <ProfilePicker placeholder="Search the person to ban" onPick={setTarget} />
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{target.name}</span>
          <Button size="sm" variant="ghost" onClick={() => setTarget(null)}>
            Change
          </Button>
        </div>
      )}
      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (optional)"
        aria-label="Ban reason"
      />
      <Input
        value={days}
        onChange={(event) => setDays(event.target.value)}
        inputMode="numeric"
        placeholder="Days (empty = permanent)"
        aria-label="Ban length in days"
      />
      <p className="text-xs text-muted-foreground">
        A ban stops them sending, joining and reacting. It does not delete anything they already
        wrote - moderation is a gate, not an eraser.
      </p>
      <Button disabled={target === null} onClick={() => void submit()}>
        Ban
      </Button>
    </div>
  );
}
