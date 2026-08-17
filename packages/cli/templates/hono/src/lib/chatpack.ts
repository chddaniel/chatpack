import { drizzleAdapter } from "@chatpack/adapter-drizzle";
import { ChatpackError, chatpack } from "@chatpack/core";
import { presence, receipts, typing } from "@chatpack/core/plugins";
import { createFileAttachmentPlugin } from "@chatpack/file";

import { db, pool } from "@/lib/db.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, createApplicationFilepack } from "@/lib/filepack.js";
import { createApplicationTransport } from "@/lib/transport.js";

/**
 * Longest message body this application accepts.
 *
 * Core has no limit of its own: the body is opaque to it
 * (`docs/decisions/0022`), so the cap is the host's call. `beforeMessageSend`
 * below is where it lands.
 */
const MAX_MESSAGE_LENGTH = 4_000;

/**
 * Who may use the moderation admin routes - the reports queue and bans.
 *
 * Chatpack denies every moderator action unless `canModerate` returns true, so
 * leaving `MODERATOR_USER_IDS` unset keeps those routes closed while reporting
 * and per-user blocks still work for everyone.
 */
const moderatorUserIds = new Set(
  (process.env.MODERATOR_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);

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

// Replace this fail-closed resolver with your host application's verified session.
export const chat = chatpack({
  storage: drizzleAdapter(db),
  auth: async () => null,
  permissions: {
    // Any member may mint an invite link, but only admins may remove people or
    // change roles (`docs/decisions/0019` §8). Delete this to keep invite
    // creation admin-only, which is the default.
    canInvite: (ctx) => ctx.conversation.participantIds.includes(ctx.user.id),
  },
  moderation: {
    canModerate: ({ user }) => moderatorUserIds.has(user.id),
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
