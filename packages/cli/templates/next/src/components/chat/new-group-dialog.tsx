"use client";

import { useState } from "react";
import {
  MAX_CONVERSATION_NAME_LENGTH,
  MAX_GROUP_PARTICIPANTS,
  type ChannelJoinPolicy,
  type ChannelVisibility,
} from "@chatpack/core";
import { X } from "lucide-react";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { ProfilePicker } from "@/components/chat/profile-picker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialsOf, type PublicProfile } from "@/lib/profiles";

/**
 * Creates a group, or a public channel (`docs/decisions/0017` and `0020`).
 *
 * Unlike a DM this is never find-or-create: two groups with the same members are
 * two different groups, so every submit makes a new one and you become its first
 * admin.
 */
export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const { client, directory, select } = useChat();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<ChannelVisibility>("private");
  const [joinPolicy, setJoinPolicy] = useState<ChannelJoinPolicy>("approval");
  const [members, setMembers] = useState<PublicProfile[]>([]);
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    setBusy(true);
    const trimmed = name.trim();
    const result = await client.conversations.createGroup({
      ...(trimmed.length === 0 ? {} : { name: trimmed }),
      ...(members.length === 0 ? {} : { userIds: members.map((member) => member.id) }),
      visibility,
      // Inert while the group is private: nobody outside can discover it, so the
      // policy is armed rather than open (`docs/decisions/0020`).
      joinPolicy,
    });
    setBusy(false);
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    for (const member of members) directory.put(member);
    select(result.data.id);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>
            A group can start with nobody but you - add members now or invite them later.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={MAX_CONVERSATION_NAME_LENGTH}
              placeholder="Design team"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Visibility</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={visibility === "private" ? "default" : "outline"}
                onClick={() => setVisibility("private")}
              >
                Private group
              </Button>
              <Button
                type="button"
                size="sm"
                variant={visibility === "public" ? "default" : "outline"}
                onClick={() => setVisibility("public")}
              >
                Public channel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {visibility === "public"
                ? "Listed in /channels for every signed-in user. Discovery only - joining is still how someone gets to read it."
                : "Invisible to anyone who is not a member."}
            </p>
          </div>

          {visibility === "public" && (
            <div className="flex flex-col gap-2">
              <Label>Joining</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={joinPolicy === "approval" ? "default" : "outline"}
                  onClick={() => setJoinPolicy("approval")}
                >
                  Needs approval
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={joinPolicy === "open" ? "default" : "outline"}
                  onClick={() => setJoinPolicy("open")}
                >
                  Anyone can join
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="group-members">
              Members ({members.length + 1}/{MAX_GROUP_PARTICIPANTS})
            </Label>
            {members.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {members.map((member) => (
                  <span
                    key={member.id}
                    className="flex items-center gap-2 rounded-full border px-2 py-1 text-xs"
                  >
                    <Avatar size="sm">
                      <AvatarImage src={member.image ?? undefined} />
                      <AvatarFallback>{initialsOf(member.name)}</AvatarFallback>
                    </Avatar>
                    {member.name}
                    <button
                      onClick={() =>
                        setMembers((current) => current.filter((item) => item.id !== member.id))
                      }
                      aria-label={`Remove ${member.name}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <ProfilePicker
              id="group-members"
              placeholder="Search people to add"
              exclude={members.map((member) => member.id)}
              onPick={(profile) => setMembers((current) => [...current, profile])}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void create()}>
            Create group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
