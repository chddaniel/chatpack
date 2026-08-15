import type { ClientConversation } from "@chatpack/client";
import type { ParticipantRole } from "@chatpack/core";

/**
 * What the UI calls a conversation.
 *
 * Chatpack only has two types, `"direct"` and `"group"`. A **channel** is a
 * group whose `visibility` is `"public"` - there is deliberately no third type,
 * so every group feature (roles, invites, rename, membership) applies to a
 * channel unchanged (`docs/decisions/0020`). This function is the one place that
 * flattens the two fields into the three words a user recognises.
 */
export type ConversationKind = "direct" | "group" | "channel";

export function conversationKind(conversation: ClientConversation): ConversationKind {
  if (conversation.type === "direct") return "direct";
  return conversation.visibility === "public" ? "channel" : "group";
}

/** The other person in a DM, or `null` for a group. */
export function otherParticipantId(
  conversation: ClientConversation,
  viewerId: string,
): string | null {
  if (conversation.type !== "direct") return null;
  const other = conversation.participants.find((participant) => participant.userId !== viewerId);
  return other?.userId ?? null;
}

/**
 * What to show in the sidebar and the header.
 *
 * A group may legitimately have no name, so an unnamed one falls back to its
 * members - the way Slack and iMessage both do. A DM never has a name: core has
 * no users table to build one from, so the title comes from your profile
 * directory.
 */
export function conversationTitle(
  conversation: ClientConversation,
  viewerId: string,
  nameOf: (userId: string) => string,
): string {
  if (conversation.name) return conversation.name;
  const others = conversation.participants
    .filter((participant) => participant.userId !== viewerId)
    .map((participant) => nameOf(participant.userId));
  if (others.length === 0) return conversation.type === "direct" ? "Direct message" : "Empty group";
  if (conversation.type === "direct") return others[0];
  return others.slice(0, 3).join(", ") + (others.length > 3 ? ` +${others.length - 3}` : "");
}

/** The viewer's role, or `null` when they somehow are not a member. */
export function viewerRole(
  conversation: ClientConversation,
  viewerId: string,
): ParticipantRole | null {
  return (
    conversation.participants.find((participant) => participant.userId === viewerId)?.role ?? null
  );
}

/**
 * Whether the viewer may administer this conversation.
 *
 * A DM has no hierarchy - core reports every direct participant as `"member"`,
 * and admin-only routes answer `FORBIDDEN` there. Checking this before rendering
 * a button is a courtesy; the server is what actually enforces it.
 */
export function viewerIsAdmin(conversation: ClientConversation, viewerId: string): boolean {
  return conversation.type === "group" && viewerRole(conversation, viewerId) === "admin";
}
