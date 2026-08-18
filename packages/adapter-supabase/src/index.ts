/**
 * Server-side Supabase/Postgres {@link StorageAdapter} for Chatpack.
 *
 * The caller owns Supabase client creation. Use a service-role or server-secret
 * client only on the server, and never bundle this package into browser code.
 *
 * @module
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getSearchTerms,
  type AddMessageInput,
  type AddParticipantsInput,
  type Conversation,
  type ConversationInvite,
  type ConversationMute,
  type CountUnreadInput,
  type CreateGroupConversationInput,
  type CreateInviteInput,
  type CreateReportInput,
  type CreateJoinRequestInput,
  type DeleteInviteInput,
  type GetJoinRequestInput,
  type GetOrCreateDirectConversationInput,
  type GetOrCreateDirectConversationResult,
  type JoinRequest,
  type ListConversationsInput,
  type ListConversationsResult,
  type ListJoinRequestsInput,
  type ListMessagesAfterSeqInput,
  type ListMessagesInput,
  type ListMessagesResult,
  type ListPublicConversationsInput,
  type ListPublicConversationsResult,
  type Message,
  type MessageMention,
  type ModerationPage,
  type ModerationReport,
  type ModerationStorage,
  type ParticipantRole,
  type Reaction,
  type ReactionInput,
  type RemoveParticipantInput,
  type ResolveJoinRequestInput,
  type SearchMessagesInput,
  type SearchMessagesResult,
  type SetMessageMentionsInput,
  type SetParticipantRoleInput,
  type StorageAdapter,
  type UpdateConversationInput,
  type UpdateLastReadInput,
  type UpdateMessageInput,
  type UserBan,
  type UserBlock,
  type StorageBlockUserInput,
  type StorageMuteConversationInput,
  type StorageListReportsInput,
  type StorageUpdateReportInput,
  type StorageListBansInput,
} from "@chatpack/core";
import type {
  CreateBanInput,
  ListBlocksInput,
  ListMutesInput,
  RevokeBanInput,
} from "@chatpack/core";
import {
  ban,
  block,
  conversation,
  invite,
  joinRequest,
  mention,
  message,
  mute,
  reaction,
  report,
} from "./converters.js";
import {
  checked,
  date,
  dbDate,
  decodeActivityCursor,
  decodeSearchCursor,
  decodeSimpleCursor,
  encodeActivityCursor,
  encodeSearchCursor,
  encodeSimpleCursor,
  id,
  requiredRow,
  requiredRows,
  seq,
  tokenRows,
  type QueryResult,
} from "./utils.js";
import {
  RPC,
  TABLE,
  type BanRow,
  type BlockRow,
  type ConversationRow,
  type CountRow,
  type DirectRpcRow,
  type InviteRow,
  type JoinRequestRow,
  type MentionRow,
  type MessageRow,
  type MuteRow,
  type ParticipantRow,
  type ReactionRow,
  type ReportRow,
  type SearchRow,
} from "./types.js";

/** Options for {@link supabaseAdapter}. */
export interface SupabaseAdapterOptions {
  /** Prefix used in generated conversation and message ids. */
  idPrefix?: string;
}

/**
 * Create a Supabase-backed Chatpack storage adapter.
 *
 * The supplied client must be a server-side client with access to the
 * Chatpack tables. Prefer a service-role/server-secret client with session
 * persistence disabled. Never pass a browser client or expose its key.
 *
 * @param client - An already-created server-side Supabase client.
 * @param options - Optional id prefix configuration.
 */
export function supabaseAdapter(
  client: SupabaseClient,
  options: SupabaseAdapterOptions = {},
): StorageAdapter {
  const idPrefix = options.idPrefix ?? "chatpack";

  async function participantsFor(
    conversationIds: string[],
  ): Promise<Map<string, ParticipantRow[]>> {
    if (conversationIds.length === 0) return new Map();
    const rows = requiredRows(
      (await client
        .from(TABLE.participants)
        .select("*")
        .in("conversation_id", conversationIds)
        .order("joined_at", { ascending: true })
        .order("user_id", { ascending: true })) as QueryResult<ParticipantRow[]>,
      "load participants",
    );
    const result = new Map<string, ParticipantRow[]>();
    for (const row of rows) {
      const list = result.get(row.conversation_id) ?? [];
      list.push(row);
      result.set(row.conversation_id, list);
    }
    return result;
  }

  async function loadConversation(conversationId: string): Promise<Conversation | null> {
    const row = checked(
      (await client
        .from(TABLE.conversations)
        .select("*")
        .eq("id", conversationId)
        .maybeSingle()) as QueryResult<ConversationRow | null>,
      "get conversation",
    );
    if (!row) return null;
    const participants = await participantsFor([conversationId]);
    return conversation(row, participants.get(conversationId) ?? []);
  }

  async function reloadConversation(conversationId: string): Promise<Conversation> {
    const result = await loadConversation(conversationId);
    if (!result) throw new Error(`supabaseAdapter: unknown conversation "${conversationId}".`);
    return result;
  }

  async function pageConversations(
    filterIds: string[],
    limit: number,
    cursor: string | undefined,
  ): Promise<ListConversationsResult> {
    if (filterIds.length === 0) return { conversations: [], nextCursor: null };
    const decoded = decodeActivityCursor(cursor);
    let query = client.from(TABLE.conversations).select("*").in("id", filterIds);
    if (decoded) {
      const activity = new Date(decoded.activityMs).toISOString();
      query = query.or(
        `last_activity_at.lt.${activity},and(last_activity_at.eq.${activity},id.lt.${decoded.id})`,
      );
    }
    const rows = requiredRows(
      (await query
        .order("last_activity_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1)) as QueryResult<ConversationRow[]>,
      "list conversations",
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const lastActivity = last ? date(last.last_activity_at, "conversation.last_activity_at") : null;
    const nextCursor =
      rows.length > limit && last && lastActivity
        ? encodeActivityCursor({ activityMs: lastActivity.getTime(), id: last.id })
        : null;
    const grouped = await participantsFor(page.map((row) => row.id));
    return {
      conversations: page.map((row) => conversation(row, grouped.get(row.id) ?? [])),
      nextCursor,
    };
  }

  async function reactionsFor(messageId: string): Promise<Reaction[]> {
    const rows = requiredRows(
      (await client
        .from(TABLE.reactions)
        .select("*")
        .eq("message_id", messageId)
        .order("created_at", { ascending: true })
        .order("user_id", { ascending: true })) as QueryResult<ReactionRow[]>,
      "list reactions",
    );
    return rows.map(reaction);
  }

  const moderation: ModerationStorage = {
    async isUserBanned(userId, now = new Date()) {
      return this.getActiveBan(userId, now);
    },

    async isBlocked(userIdA, userIdB) {
      const rows = requiredRows(
        (await client
          .from(TABLE.blocks)
          .select("blocker_user_id")
          .or(
            `and(blocker_user_id.eq.${userIdA},blocked_user_id.eq.${userIdB}),and(blocker_user_id.eq.${userIdB},blocked_user_id.eq.${userIdA})`,
          )
          .limit(1)) as QueryResult<Array<{ blocker_user_id: string }>>,
        "check block",
      );
      return rows.length > 0;
    },

    async createBlock(input: StorageBlockUserInput) {
      const createdAt = new Date();
      const result = await client.from(TABLE.blocks).upsert(
        {
          blocker_user_id: input.blockerUserId,
          blocked_user_id: input.blockedUserId,
          created_at: createdAt.toISOString(),
        },
        { onConflict: "blocker_user_id,blocked_user_id", ignoreDuplicates: true },
      );
      checked(result as QueryResult<null>, "create block");
      const row = requiredRow(
        (await client
          .from(TABLE.blocks)
          .select("*")
          .eq("blocker_user_id", input.blockerUserId)
          .eq("blocked_user_id", input.blockedUserId)
          .maybeSingle()) as QueryResult<BlockRow | null>,
        "load block",
      );
      return block(row);
    },

    async removeBlock(input: StorageBlockUserInput) {
      checked(
        (await client
          .from(TABLE.blocks)
          .delete()
          .eq("blocker_user_id", input.blockerUserId)
          .eq("blocked_user_id", input.blockedUserId)) as QueryResult<null>,
        "remove block",
      );
    },

    async listBlocks(input: ListBlocksInput): Promise<ModerationPage<UserBlock>> {
      const rows = requiredRows(
        (await client
          .from(TABLE.blocks)
          .select("*")
          .eq("blocker_user_id", input.blockerUserId)
          .order("created_at", { ascending: false })
          .order("blocked_user_id", { ascending: false })) as QueryResult<BlockRow[]>,
        "list blocks",
      );
      const cursor = decodeSimpleCursor(input.cursor);
      const start = cursor
        ? Math.max(
            0,
            rows.findIndex(
              (row) => `${row.blocker_user_id}\u0000${row.blocked_user_id}` === cursor,
            ) + 1,
          )
        : 0;
      const page = rows.slice(start, start + input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(block),
        nextCursor:
          last && start + input.limit < rows.length
            ? encodeSimpleCursor(`${last.blocker_user_id}\u0000${last.blocked_user_id}`)
            : null,
      };
    },

    async createMute(input: StorageMuteConversationInput) {
      const result = await client.from(TABLE.mutes).upsert(
        {
          user_id: input.userId,
          conversation_id: input.conversationId,
          created_at: new Date().toISOString(),
        },
        { onConflict: "user_id,conversation_id", ignoreDuplicates: true },
      );
      checked(result as QueryResult<null>, "create mute");
      const row = requiredRow(
        (await client
          .from(TABLE.mutes)
          .select("*")
          .eq("user_id", input.userId)
          .eq("conversation_id", input.conversationId)
          .maybeSingle()) as QueryResult<MuteRow | null>,
        "load mute",
      );
      return mute(row);
    },

    async removeMute(input: StorageMuteConversationInput) {
      checked(
        (await client
          .from(TABLE.mutes)
          .delete()
          .eq("user_id", input.userId)
          .eq("conversation_id", input.conversationId)) as QueryResult<null>,
        "remove mute",
      );
    },

    async listMutes(input: ListMutesInput): Promise<ModerationPage<ConversationMute>> {
      const rows = requiredRows(
        (await client
          .from(TABLE.mutes)
          .select("*")
          .eq("user_id", input.userId)
          .order("created_at", { ascending: false })
          .order("conversation_id", { ascending: false })) as QueryResult<MuteRow[]>,
        "list mutes",
      );
      const cursor = decodeSimpleCursor(input.cursor);
      const start = cursor
        ? Math.max(0, rows.findIndex((row) => row.conversation_id === cursor) + 1)
        : 0;
      const page = rows.slice(start, start + input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(mute),
        nextCursor:
          last && start + input.limit < rows.length
            ? encodeSimpleCursor(last.conversation_id)
            : null,
      };
    },

    async findOpenReport(
      reporterUserId: string,
      targetType: ModerationReport["targetType"],
      targetId: string,
    ) {
      const rows = requiredRows(
        (await client
          .from(TABLE.reports)
          .select("*")
          .eq("reporter_user_id", reporterUserId)
          .eq("target_type", targetType)
          .eq("target_id", targetId)
          .in("status", ["open", "triaged"])
          .limit(1)) as QueryResult<ReportRow[]>,
        "find report",
      );
      return rows[0] ? report(rows[0]) : null;
    },

    async createReport(input: CreateReportInput) {
      const now = new Date().toISOString();
      const row = requiredRow(
        (await client
          .from(TABLE.reports)
          .insert({
            id: id("report", idPrefix),
            reporter_user_id: input.reporterUserId,
            target_type: input.targetType,
            target_id: input.targetId,
            reason: input.reason,
            status: "open",
            moderator_note: null,
            evidence: input.evidence,
            created_at: now,
            updated_at: now,
          })
          .select("*")
          .single()) as QueryResult<ReportRow | null>,
        "create report",
      );
      return report(row);
    },

    async getReport(reportId) {
      const row = checked(
        (await client
          .from(TABLE.reports)
          .select("*")
          .eq("id", reportId)
          .maybeSingle()) as QueryResult<ReportRow | null>,
        "get report",
      );
      return row ? report(row) : null;
    },

    async listReports(input: StorageListReportsInput): Promise<ModerationPage<ModerationReport>> {
      let query = client.from(TABLE.reports).select("*");
      if (input.status !== undefined) query = query.eq("status", input.status);
      if (input.targetType !== undefined) query = query.eq("target_type", input.targetType);
      const rows = requiredRows(
        (await query
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })) as QueryResult<ReportRow[]>,
        "list reports",
      );
      const cursor = decodeSimpleCursor(input.cursor);
      const start = cursor ? Math.max(0, rows.findIndex((row) => row.id === cursor) + 1) : 0;
      const page = rows.slice(start, start + input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(report),
        nextCursor: last && start + input.limit < rows.length ? encodeSimpleCursor(last.id) : null,
      };
    },

    async updateReport(input: StorageUpdateReportInput) {
      const row = requiredRow(
        (await client
          .from(TABLE.reports)
          .update({
            status: input.status,
            moderator_note: input.moderatorNote,
            updated_at: new Date().toISOString(),
          })
          .eq("id", input.reportId)
          .select("*")
          .maybeSingle()) as QueryResult<ReportRow | null>,
        "update report",
      );
      return report(row);
    },

    async getActiveBan(userId, now = new Date()) {
      const rows = requiredRows(
        (await client
          .from(TABLE.bans)
          .select("*")
          .eq("user_id", userId)
          .is("revoked_at", null)
          .or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`)
          .order("created_at", { ascending: false })
          .limit(1)) as QueryResult<BanRow[]>,
        "get active ban",
      );
      return rows[0] ? ban(rows[0]) : null;
    },

    async getBan(banId) {
      const row = checked(
        (await client
          .from(TABLE.bans)
          .select("*")
          .eq("id", banId)
          .maybeSingle()) as QueryResult<BanRow | null>,
        "get ban",
      );
      return row ? ban(row) : null;
    },

    async createBan(input: CreateBanInput) {
      const rows = requiredRows(
        (await client.rpc(RPC.createBan, {
          p_id: id("ban", idPrefix),
          p_user_id: input.userId,
          p_created_by_user_id: input.createdByUserId,
          p_reason: input.reason,
          p_expires_at: dbDate(input.expiresAt),
          p_created_at: new Date().toISOString(),
        })) as QueryResult<BanRow[]>,
        "create ban",
      );
      const row = rows[0];
      if (!row) throw new Error("supabaseAdapter: create ban: no row returned.");
      return ban(row);
    },

    async listBans(input: StorageListBansInput): Promise<ModerationPage<UserBan>> {
      let query = client.from(TABLE.bans).select("*");
      if (input.activeOnly) {
        query = query
          .is("revoked_at", null)
          .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
      }
      const rows = requiredRows(
        (await query
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })) as QueryResult<BanRow[]>,
        "list bans",
      );
      const cursor = decodeSimpleCursor(input.cursor);
      const start = cursor ? Math.max(0, rows.findIndex((row) => row.id === cursor) + 1) : 0;
      const page = rows.slice(start, start + input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(ban),
        nextCursor: last && start + input.limit < rows.length ? encodeSimpleCursor(last.id) : null,
      };
    },

    async revokeBan(input: RevokeBanInput) {
      const existing = await this.getBan(input.banId);
      if (!existing) throw new Error(`supabaseAdapter: unknown ban "${input.banId}".`);
      if (existing.revokedAt !== null) return existing;
      const row = checked(
        (await client
          .from(TABLE.bans)
          .update({
            revoked_at: new Date().toISOString(),
            revoked_by_user_id: input.revokedByUserId,
          })
          .eq("id", input.banId)
          .is("revoked_at", null)
          .select("*")
          .maybeSingle()) as QueryResult<BanRow | null>,
        "revoke ban",
      );
      if (!row) {
        const latest = await this.getBan(input.banId);
        if (!latest) throw new Error(`supabaseAdapter: unknown ban "${input.banId}".`);
        return latest;
      }
      return ban(row);
    },
  };

  return {
    moderation,
    async getOrCreateDirectConversation(
      input: GetOrCreateDirectConversationInput,
    ): Promise<GetOrCreateDirectConversationResult> {
      const rows = requiredRows(
        (await client.rpc(RPC.direct, {
          p_pair_key: input.pairKey,
          p_user_ids: input.userIds,
          p_metadata: input.metadata,
          p_id: id("conv", idPrefix),
          p_created_at: new Date().toISOString(),
        })) as QueryResult<DirectRpcRow[]>,
        "get or create direct conversation",
      );
      const result = rows[0];
      if (!result) throw new Error("supabaseAdapter: direct conversation RPC returned no row.");
      const loaded = await loadConversation(result.conversation_id);
      if (!loaded) {
        throw new Error(
          `supabaseAdapter: conversation for pair key "${input.pairKey}" vanished after RPC.`,
        );
      }
      return { conversation: loaded, created: result.created };
    },

    async createGroupConversation(input: CreateGroupConversationInput): Promise<Conversation> {
      const conversationId = id("conv", idPrefix);
      const rows = requiredRows(
        (await client.rpc(RPC.group, {
          p_id: conversationId,
          p_creator_id: input.creatorId,
          p_user_ids: input.userIds,
          p_name: input.name,
          p_visibility: input.visibility,
          p_join_policy: input.joinPolicy,
          p_metadata: input.metadata,
          p_created_at: new Date().toISOString(),
        })) as QueryResult<ConversationRow[]>,
        "create group conversation",
      );
      if (!rows[0]) throw new Error("supabaseAdapter: group conversation RPC returned no row.");
      return reloadConversation(conversationId);
    },

    async addParticipants(input: AddParticipantsInput): Promise<Conversation> {
      if (input.userIds.length > 0) {
        checked(
          (await client.from(TABLE.participants).upsert(
            input.userIds.map((userId) => ({
              conversation_id: input.conversationId,
              user_id: userId,
              role: "member" as ParticipantRole,
              joined_at: new Date().toISOString(),
              last_read_message_id: null,
            })),
            { onConflict: "conversation_id,user_id", ignoreDuplicates: true },
          )) as QueryResult<null>,
          "add participants",
        );
      }
      return reloadConversation(input.conversationId);
    },

    async removeParticipant(input: RemoveParticipantInput): Promise<Conversation> {
      checked(
        (await client
          .from(TABLE.participants)
          .delete()
          .eq("conversation_id", input.conversationId)
          .eq("user_id", input.userId)) as QueryResult<null>,
        "remove participant",
      );
      return reloadConversation(input.conversationId);
    },

    async setParticipantRole(input: SetParticipantRoleInput): Promise<Conversation> {
      const rows = requiredRows(
        (await client
          .from(TABLE.participants)
          .update({ role: input.role })
          .eq("conversation_id", input.conversationId)
          .eq("user_id", input.userId)
          .select("conversation_id")) as QueryResult<Array<{ conversation_id: string }>>,
        "set participant role",
      );
      if (rows.length === 0) {
        throw new Error(
          `supabaseAdapter: user "${input.userId}" is not a participant of "${input.conversationId}".`,
        );
      }
      return reloadConversation(input.conversationId);
    },

    async updateConversation(input: UpdateConversationInput): Promise<Conversation> {
      const rows = requiredRows(
        (await client
          .from(TABLE.conversations)
          .update({
            name: input.name,
            visibility: input.visibility,
            join_policy: input.joinPolicy,
          })
          .eq("id", input.conversationId)
          .select("id")) as QueryResult<Array<{ id: string }>>,
        "update conversation",
      );
      if (rows.length === 0)
        throw new Error(`supabaseAdapter: unknown conversation "${input.conversationId}".`);
      return reloadConversation(input.conversationId);
    },

    async getConversation(conversationId: string): Promise<Conversation | null> {
      return loadConversation(conversationId);
    },

    async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
      const membershipRows = requiredRows(
        (await client
          .from(TABLE.participants)
          .select("conversation_id")
          .eq("user_id", input.userId)) as QueryResult<Array<{ conversation_id: string }>>,
        "load conversation membership",
      );
      return pageConversations(
        membershipRows.map((row) => row.conversation_id),
        input.limit,
        input.cursor,
      );
    },

    async addMessage(input: AddMessageInput): Promise<Message> {
      const messageId = id("msg", idPrefix);
      const rows = requiredRows(
        (await client.rpc(RPC.message, {
          p_id: messageId,
          p_conversation_id: input.conversationId,
          p_sender_id: input.senderId,
          p_body: input.body,
          p_role: input.role,
          p_reply_to_message_id: input.replyToMessageId,
          p_forwarded_from_message_id: input.forwardedFromMessageId,
          p_forwarded_from_conversation_id: input.forwardedFromConversationId,
          p_forwarded_from_sender_id: input.forwardedFromSenderId,
          p_metadata: input.metadata,
          p_created_at: new Date().toISOString(),
          p_tokens: tokenRows(messageId, input.body),
        })) as QueryResult<MessageRow[]>,
        "add message",
      );
      const row = rows[0];
      if (!row) throw new Error("supabaseAdapter: add message RPC returned no row.");
      return message(row);
    },

    async getMessage(messageId: string): Promise<Message | null> {
      const row = checked(
        (await client
          .from(TABLE.messages)
          .select("*")
          .eq("id", messageId)
          .maybeSingle()) as QueryResult<MessageRow | null>,
        "get message",
      );
      return row ? message(row) : null;
    },

    async getMessagesByIds(messageIds: string[]): Promise<Message[]> {
      if (messageIds.length === 0) return [];
      const rows = requiredRows(
        (await client.from(TABLE.messages).select("*").in("id", messageIds)) as QueryResult<
          MessageRow[]
        >,
        "get messages",
      );
      return rows.map(message);
    },

    async listMessages(input: ListMessagesInput): Promise<ListMessagesResult> {
      const cursorValue = input.cursor === undefined ? null : Number(input.cursor);
      let query = client
        .from(TABLE.messages)
        .select("*")
        .eq("conversation_id", input.conversationId);
      if (cursorValue !== null && Number.isSafeInteger(cursorValue)) {
        query = query.lt("seq", cursorValue);
      }
      const rows = requiredRows(
        (await query.order("seq", { ascending: false }).limit(input.limit + 1)) as QueryResult<
          MessageRow[]
        >,
        "list messages",
      );
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        messages: page.map(message),
        nextCursor:
          rows.length > input.limit && last ? encodeURIComponent(String(seq(last.seq))) : null,
      };
    },

    async searchMessages(input: SearchMessagesInput): Promise<SearchMessagesResult> {
      const terms = getSearchTerms(input.query);
      if (terms.length === 0) return { messages: [], nextCursor: null };
      const cursor = decodeSearchCursor(input.cursor);
      const rows = requiredRows(
        (await client.rpc(RPC.search, {
          p_user_id: input.userId,
          p_terms: terms,
          p_cursor_rank: cursor?.[0] ?? null,
          p_cursor_created_at: cursor ? new Date(cursor[1]).toISOString() : null,
          p_cursor_id: cursor?.[2] ?? null,
          p_limit: input.limit + 1,
        })) as QueryResult<SearchRow[]>,
        "search messages",
      );
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        messages: page.map(message),
        nextCursor:
          rows.length > input.limit && last
            ? encodeSearchCursor(last.rank, date(last.created_at, "search.created_at"), last.id)
            : null,
      };
    },

    async listMessagesAfterSeq(input: ListMessagesAfterSeqInput): Promise<Message[]> {
      const rows = requiredRows(
        (await client
          .from(TABLE.messages)
          .select("*")
          .eq("conversation_id", input.conversationId)
          .gt("seq", input.afterSeq)
          .order("seq", { ascending: true })
          .limit(input.limit)) as QueryResult<MessageRow[]>,
        "list messages after sequence",
      );
      return rows.map(message);
    },

    async updateMessage(input: UpdateMessageInput): Promise<Message> {
      const bodySet = input.body !== undefined;
      const deletedSet = input.deletedAt !== undefined;
      const editedSet = input.editedAt !== undefined;
      const rows = requiredRows(
        (await client.rpc(RPC.updateMessage, {
          p_message_id: input.messageId,
          p_body: input.body ?? null,
          p_body_set: bodySet,
          p_edited_at: dbDate(input.editedAt ?? null),
          p_edited_at_set: editedSet,
          p_deleted_at: dbDate(input.deletedAt ?? null),
          p_deleted_at_set: deletedSet,
          p_tokens: bodySet ? tokenRows(input.messageId, input.body ?? "") : [],
        })) as QueryResult<MessageRow[]>,
        "update message",
      );
      const row = rows[0];
      if (!row) throw new Error(`supabaseAdapter: unknown message "${input.messageId}".`);
      return message(row);
    },

    async updateLastRead(input: UpdateLastReadInput): Promise<void> {
      const rows = requiredRows(
        (await client
          .from(TABLE.participants)
          .update({ last_read_message_id: input.messageId })
          .eq("conversation_id", input.conversationId)
          .eq("user_id", input.userId)
          .select("user_id")) as QueryResult<Array<{ user_id: string }>>,
        "update last read",
      );
      if (rows.length === 0) {
        throw new Error(
          `supabaseAdapter: user "${input.userId}" is not a participant of "${input.conversationId}".`,
        );
      }
    },

    async countUnread(input: CountUnreadInput): Promise<Record<string, number>> {
      const counts: Record<string, number> = {};
      for (const conversationId of input.conversationIds) counts[conversationId] = 0;
      if (input.conversationIds.length === 0) return counts;
      const rows = requiredRows(
        (await client.rpc("chatpack_count_unread", {
          p_user_id: input.userId,
          p_conversation_ids: input.conversationIds,
        })) as QueryResult<CountRow[]>,
        "count unread",
      );
      for (const row of rows) counts[row.conversation_id] = Number(row.count);
      return counts;
    },

    async addReaction(input: ReactionInput): Promise<Reaction[]> {
      checked(
        (await client.from(TABLE.reactions).upsert(
          {
            message_id: input.messageId,
            user_id: input.userId,
            emoji: input.emoji,
            created_at: new Date().toISOString(),
          },
          { onConflict: "message_id,user_id,emoji", ignoreDuplicates: true },
        )) as QueryResult<null>,
        "add reaction",
      );
      return reactionsFor(input.messageId);
    },

    async removeReaction(input: ReactionInput): Promise<Reaction[]> {
      checked(
        (await client
          .from(TABLE.reactions)
          .delete()
          .eq("message_id", input.messageId)
          .eq("user_id", input.userId)
          .eq("emoji", input.emoji)) as QueryResult<null>,
        "remove reaction",
      );
      return reactionsFor(input.messageId);
    },

    async listReactionsByMessageIds(messageIds: string[]): Promise<Reaction[]> {
      if (messageIds.length === 0) return [];
      const rows = requiredRows(
        (await client
          .from(TABLE.reactions)
          .select("*")
          .in("message_id", messageIds)
          .order("created_at", { ascending: true })
          .order("user_id", { ascending: true })) as QueryResult<ReactionRow[]>,
        "list reactions",
      );
      return rows.map(reaction);
    },

    async setMessageMentions(input: SetMessageMentionsInput): Promise<void> {
      checked(
        (await client.rpc(RPC.mentions, {
          p_message_id: input.messageId,
          p_user_ids: input.userIds,
          p_created_at: new Date().toISOString(),
        })) as QueryResult<null>,
        "replace message mentions",
      );
    },

    async listMentionsByMessageIds(messageIds: string[]): Promise<MessageMention[]> {
      if (messageIds.length === 0) return [];
      const rows = requiredRows(
        (await client
          .from(TABLE.mentions)
          .select("*")
          .in("message_id", messageIds)
          .order("created_at", { ascending: true })
          .order("user_id", { ascending: true })) as QueryResult<MentionRow[]>,
        "list mentions",
      );
      return rows.map(mention);
    },

    channels: {
      async listPublicConversations(
        input: ListPublicConversationsInput,
      ): Promise<ListPublicConversationsResult> {
        const rows = requiredRows(
          (await client
            .from(TABLE.conversations)
            .select("id")
            .eq("type", "group")
            .eq("visibility", "public")) as QueryResult<Array<{ id: string }>>,
          "list public conversation ids",
        );
        return pageConversations(
          rows.map((row) => row.id),
          input.limit,
          input.cursor,
        );
      },
    },

    invites: {
      async createInvite(input: CreateInviteInput): Promise<ConversationInvite> {
        const row = requiredRow(
          (await client
            .from(TABLE.invites)
            .insert({
              code: input.code,
              conversation_id: input.conversationId,
              created_by: input.createdBy,
              created_at: new Date().toISOString(),
              expires_at: dbDate(input.expiresAt),
              max_uses: input.maxUses,
              uses: 0,
              requires_approval: input.requiresApproval,
              metadata: input.metadata,
            })
            .select("*")
            .single()) as QueryResult<InviteRow | null>,
          "create invite",
        );
        return invite(row);
      },

      async getInvite(code: string): Promise<ConversationInvite | null> {
        const row = checked(
          (await client
            .from(TABLE.invites)
            .select("*")
            .eq("code", code)
            .maybeSingle()) as QueryResult<InviteRow | null>,
          "get invite",
        );
        return row ? invite(row) : null;
      },

      async listInvites(conversationId: string): Promise<ConversationInvite[]> {
        const rows = requiredRows(
          (await client
            .from(TABLE.invites)
            .select("*")
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: false })
            .order("code", { ascending: false })) as QueryResult<InviteRow[]>,
          "list invites",
        );
        return rows.map(invite);
      },

      async deleteInvite(input: DeleteInviteInput): Promise<void> {
        checked(
          (await client
            .from(TABLE.invites)
            .delete()
            .eq("code", input.code)
            .eq("conversation_id", input.conversationId)) as QueryResult<null>,
          "delete invite",
        );
      },

      async consumeInvite(code: string): Promise<ConversationInvite | null> {
        const rows = requiredRows(
          (await client.rpc(RPC.consumeInvite, {
            p_code: code,
            p_now: new Date().toISOString(),
          })) as QueryResult<InviteRow[]>,
          "consume invite",
        );
        return rows[0] ? invite(rows[0]) : null;
      },

      async createJoinRequest(input: CreateJoinRequestInput): Promise<JoinRequest> {
        const now = new Date().toISOString();
        const row = requiredRow(
          (await client
            .from(TABLE.joinRequests)
            .upsert(
              {
                id: id("jreq", idPrefix),
                conversation_id: input.conversationId,
                user_id: input.userId,
                status: "pending",
                message: input.message,
                invite_code: input.inviteCode,
                created_at: now,
                resolved_at: null,
                resolved_by: null,
                metadata: input.metadata,
              },
              { onConflict: "conversation_id,user_id" },
            )
            .select("*")
            .single()) as QueryResult<JoinRequestRow | null>,
          "create join request",
        );
        return joinRequest(row);
      },

      async getJoinRequest(input: GetJoinRequestInput): Promise<JoinRequest | null> {
        const row = checked(
          (await client
            .from(TABLE.joinRequests)
            .select("*")
            .eq("conversation_id", input.conversationId)
            .eq("user_id", input.userId)
            .maybeSingle()) as QueryResult<JoinRequestRow | null>,
          "get join request",
        );
        return row ? joinRequest(row) : null;
      },

      async listJoinRequests(input: ListJoinRequestsInput): Promise<JoinRequest[]> {
        let query = client
          .from(TABLE.joinRequests)
          .select("*")
          .eq("conversation_id", input.conversationId);
        if (input.status !== undefined) query = query.eq("status", input.status);
        const rows = requiredRows(
          (await query
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(input.limit)) as QueryResult<JoinRequestRow[]>,
          "list join requests",
        );
        return rows.map(joinRequest);
      },

      async resolveJoinRequest(input: ResolveJoinRequestInput): Promise<JoinRequest> {
        const row = requiredRow(
          (await client
            .from(TABLE.joinRequests)
            .update({
              status: input.status,
              resolved_at: input.resolvedAt.toISOString(),
              resolved_by: input.resolvedBy,
            })
            .eq("conversation_id", input.conversationId)
            .eq("user_id", input.userId)
            .select("*")
            .maybeSingle()) as QueryResult<JoinRequestRow | null>,
          "resolve join request",
        );
        return joinRequest(row);
      },
    },
  };
}
