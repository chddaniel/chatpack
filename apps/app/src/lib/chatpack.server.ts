import { drizzleAdapter } from "@chatpack/adapter-drizzle";
import { ChatpackError, chatpack } from "@chatpack/core";
import { presence, receipts, typing } from "@chatpack/core/plugins";
import { createFileAttachmentPlugin } from "@chatpack/file";
import { eq } from "drizzle-orm";

import { profiles } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { db, pool } from "@/lib/db";
import { MAX_ATTACHMENTS_PER_MESSAGE, createApplicationFilepack } from "@/lib/filepack";
import { createApplicationTransport } from "@/lib/transport";

/**
 * Longest message body this application accepts.
 *
 * Core has no limit of its own: the body is opaque to it
 * (`docs/decisions/0022`), so the cap is the host's call. `beforeMessageSend`
 * below is where it lands.
 */
const MAX_MESSAGE_LENGTH = 4_000;

function envSet(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

/**
 * Who may use the moderation admin routes - the reports queue and bans.
 *
 * Emails are the convenient form, because that is what you have right after
 * signing up; ids are there for providers where the email can be missing.
 * Chatpack denies every moderator action unless `canModerate` returns true, so
 * leaving both unset keeps `/moderation` closed while reporting and per-user
 * blocks still work for everyone.
 */
const moderatorEmails = envSet("MODERATOR_EMAILS");
const moderatorUserIds = envSet("MODERATOR_USER_IDS");

export async function isModerator(userId: string): Promise<boolean> {
  if (moderatorUserIds.has(userId.toLowerCase())) return true;
  if (moderatorEmails.size === 0) return false;
  // One primary-key lookup per moderator action, deliberately not cached: a
  // stale allowlist is the kind of bug you find out about from an incident.
  const [profile] = await db
    .select({ email: profiles.email })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return profile?.email ? moderatorEmails.has(profile.email.toLowerCase()) : false;
}

/**
 * Asks Chatpack whether this user may see a conversation instead of
 * re-implementing the rule. `getConversation` runs the same `canRead` check the
 * HTTP routes do, and throws when it fails.
 */
async function loadConversation(userId: string, conversationId: string) {
  try {
    return await chat.api.getConversation({ userId, conversationId });
  } catch {
    return null;
  }
}

/** May this user post into the conversation? */
async function canWriteToConversation(userId: string, conversationId: string): Promise<boolean> {
  const conversation = await loadConversation(userId, conversationId);
  // `canRead` already passed if we got a conversation back; writing is a
  // membership test under the default permissions.
  return conversation !== null && conversation.participants.some((p) => p.userId === userId);
}

/**
 * Filepack owns attachment bytes and records; Chatpack messages carry only
 * `{ id, name, contentType, size }`.
 *
 * The read check is handed in as a callback because it needs `chat`, and `chat`
 * needs the plugin built from this Filepack. The closure resolves at request
 * time, which breaks the cycle.
 */
const filepack = createApplicationFilepack({
  pool,
  canAccessConversation: async ({ userId, conversationId }) =>
    (await loadConversation(userId, conversationId)) !== null,
});

const files = createFileAttachmentPlugin({
  filepack,
  // Putting a file into a conversation is writing to it.
  authorizeUpload: ({ actor, conversationId }) => canWriteToConversation(actor.id, conversationId),
  // Re-checked when the file is attached: an upload plan can be minutes old,
  // and the uploader may have been removed from the group since.
  authorizeAttachment: ({ actor, conversationId }) =>
    canWriteToConversation(actor.id, conversationId),
  maxAttachments: MAX_ATTACHMENTS_PER_MESSAGE,
});

export const chat = chatpack({
  storage: drizzleAdapter(db),
  auth: async () => {
    const user = await currentUser();
    return user ? { id: user.id } : null;
  },
  userExists: async (userId: string) => {
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    return Boolean(profile);
  },
  permissions: {
    // Any member may mint an invite link, but only admins may remove people or
    // change roles (`docs/decisions/0019` §8). Delete this to keep invite
    // creation admin-only, which is the default.
    canInvite: (ctx) => ctx.conversation.participantIds.includes(ctx.user.id),
  },
  moderation: {
    canModerate: ({ user }) => isModerator(user.id),
  },
  hooks: {
    // Runs before anything is stored, for both sends and edits. Throw to
    // reject: the sender gets a 422 and nothing is persisted or broadcast.
    beforeMessageSend: ({ body }) => {
      if (body.length > MAX_MESSAGE_LENGTH) {
        throw new ChatpackError(
          "MESSAGE_REJECTED",
          `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`,
        );
      }
    },
    // Runs after the message is durably stored and broadcast. This is the seam
    // for push notifications: `recipientIds` is everyone in the room except the
    // sender, `mentions` is the subset who were actually named. Keep it cheap -
    // the API call awaits this.
    afterMessageMutation: ({ action, message, recipientIds, mentions }) => {
      console.log(
        `[chatpack] ${action} ${message.id}: ${recipientIds.length} recipient(s), ${mentions.length} mention(s)`,
      );
    },
  },
  // Undefined unless REDIS_URL is set, which leaves the single-node default in
  // place (`docs/decisions/0012`).
  transport: createApplicationTransport(),
  // Ephemeral signals - never stored, never replayed - plus the file routes.
  plugins: [typing(), presence(), receipts(), files],
});
