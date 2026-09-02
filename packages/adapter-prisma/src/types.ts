import type {
  AddMessageInput,
  AddParticipantsInput,
  CountUnreadInput,
  CreateGroupConversationInput,
  CreateInviteInput,
  CreateJoinRequestInput,
  DeleteInviteInput,
  GetJoinRequestInput,
  GetOrCreateDirectConversationInput,
  ListConversationsInput,
  ListJoinRequestsInput,
  ListMessagesAfterSeqInput,
  ListMessagesInput,
  ListPublicConversationsInput,
  ReactionInput,
  RemoveParticipantInput,
  ResolveJoinRequestInput,
  SetMessageMentionsInput,
  SetParticipantRoleInput,
  UpdateConversationInput,
  UpdateLastReadInput,
  UpdateMessageInput,
} from "@chatpack/core";
import type { JsonInput, JsonValue } from "./utils";

export interface ConversationRow {
  id: string;
  type: string;
  pairKey: string | null;
  name: string | null;
  visibility: string;
  joinPolicy: string;
  createdAt: Date;
  metadata: JsonValue;
  lastSeq: number;
  lastActivityAt: Date;
}
export interface ParticipantRow {
  conversationId: string;
  userId: string;
  role: string;
  joinedAt: Date;
  lastReadMessageId: string | null;
}
export interface MessageRow {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  role: string;
  seq: number;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  replyToMessageId: string | null;
  forwardedFromMessageId: string | null;
  forwardedFromConversationId: string | null;
  forwardedFromSenderId: string | null;
  metadata: JsonValue;
}
export interface ReactionRow {
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: Date;
}
export interface MentionRow {
  messageId: string;
  userId: string;
  createdAt: Date;
}
export interface InviteRow {
  code: string;
  conversationId: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
  requiresApproval: boolean;
  metadata: JsonValue;
}
export interface JoinRequestRow {
  id: string;
  conversationId: string;
  userId: string;
  status: string;
  message: string | null;
  inviteCode: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  metadata: JsonValue;
}
export interface BlockRow {
  blockerUserId: string;
  blockedUserId: string;
  createdAt: Date;
}
export interface MuteRow {
  userId: string;
  conversationId: string;
  createdAt: Date;
}
export interface ReportRow {
  id: string;
  reporterUserId: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  moderatorNote: string | null;
  evidence: JsonValue;
  createdAt: Date;
  updatedAt: Date;
}
export interface BanRow {
  id: string;
  userId: string;
  createdByUserId: string;
  reason: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
}

export interface CountFilter {
  equals?: number;
  gt?: number;
  lt?: number;
  increment?: number;
}
export interface StringFilter {
  equals?: string;
  in?: string[];
  not?: string;
}
export interface DateFilter {
  equals?: Date;
  gt?: Date;
  lt?: Date;
}
export interface JsonFilterWhere {
  [key: string]:
    | string
    | number
    | boolean
    | Date
    | null
    | string[]
    | CountFilter
    | StringFilter
    | DateFilter
    | JsonFilterWhere
    | JsonFilterWhere[]
    | undefined;
}

export interface Delegate<Row, CreateData, UpdateData> {
  create(args: { data: CreateData }): Promise<Row>;
  findUnique(args: { where: JsonFilterWhere }): Promise<Row | null>;
  findFirst(args?: {
    where?: JsonFilterWhere;
    orderBy?: JsonFilterWhere | JsonFilterWhere[];
  }): Promise<Row | null>;
  findMany(args?: {
    where?: JsonFilterWhere;
    orderBy?: JsonFilterWhere | JsonFilterWhere[];
    take?: number;
  }): Promise<Row[]>;
  update(args: { where: JsonFilterWhere; data: UpdateData }): Promise<Row>;
  upsert(args: { where: JsonFilterWhere; create: CreateData; update: UpdateData }): Promise<Row>;
  updateMany(args: { where?: JsonFilterWhere; data: UpdateData }): Promise<{ count: number }>;
  deleteMany(args: { where?: JsonFilterWhere }): Promise<{ count: number }>;
  createMany(args: { data: CreateData[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
  count(args?: { where?: JsonFilterWhere }): Promise<number>;
}

export type ConversationCreateData = Pick<
  ConversationRow,
  | "id"
  | "type"
  | "pairKey"
  | "name"
  | "visibility"
  | "joinPolicy"
  | "createdAt"
  | "metadata"
  | "lastSeq"
  | "lastActivityAt"
>;
export type ParticipantCreateData = ParticipantRow;
export type MessageCreateData = MessageRow;
export type ReactionCreateData = ReactionRow;
export type MentionCreateData = MentionRow;
export type InviteCreateData = InviteRow;
export type JoinRequestCreateData = JoinRequestRow;
export type BlockCreateData = BlockRow;
export type MuteCreateData = MuteRow;
export type ReportCreateData = ReportRow;
export type BanCreateData = BanRow;
export type ConversationUpdateData = Omit<Partial<ConversationCreateData>, "lastSeq"> & {
  lastSeq?: CountFilter;
  metadata?: JsonInput;
};
export type ParticipantUpdateData = Partial<ParticipantCreateData>;
export type MessageUpdateData = Partial<MessageCreateData>;
export type ReactionUpdateData = Partial<ReactionCreateData>;
export type MentionUpdateData = Partial<MentionCreateData>;
export type InviteUpdateData = Omit<Partial<InviteCreateData>, "uses"> & { uses?: CountFilter };
export type JoinRequestUpdateData = Partial<JoinRequestCreateData>;
export type BlockUpdateData = Partial<BlockCreateData>;
export type MuteUpdateData = Partial<MuteCreateData>;
export type ReportUpdateData = Partial<ReportCreateData>;
export type BanUpdateData = Partial<BanCreateData>;

export interface PrismaTransaction {
  chatpackConversation: Delegate<ConversationRow, ConversationCreateData, ConversationUpdateData>;
  conversationParticipant: Delegate<ParticipantRow, ParticipantCreateData, ParticipantUpdateData>;
  chatpackMessage: Delegate<MessageRow, MessageCreateData, MessageUpdateData>;
  chatpackMessageSearchToken: Delegate<
    SearchTokenRow,
    SearchTokenCreateData,
    SearchTokenUpdateData
  >;
  chatpackMessageReaction: Delegate<ReactionRow, ReactionCreateData, ReactionUpdateData>;
  chatpackMessageMention: Delegate<MentionRow, MentionCreateData, MentionUpdateData>;
  chatpackConversationInvite: Delegate<InviteRow, InviteCreateData, InviteUpdateData>;
  chatpackJoinRequest: Delegate<JoinRequestRow, JoinRequestCreateData, JoinRequestUpdateData>;
  chatpackUserBlock: Delegate<BlockRow, BlockCreateData, BlockUpdateData>;
  chatpackConversationMute: Delegate<MuteRow, MuteCreateData, MuteUpdateData>;
  chatpackModerationReport: Delegate<ReportRow, ReportCreateData, ReportUpdateData>;
  chatpackUserBan: Delegate<BanRow, BanCreateData, BanUpdateData>;
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: readonly (string | number | boolean | Date | null)[]
  ): Promise<T[]>;
  $executeRaw(
    query: TemplateStringsArray,
    ...values: readonly (string | number | boolean | Date | null)[]
  ): Promise<number>;
}

export interface SearchTokenRow {
  messageId: string;
  token: string;
  occurrences: number;
}
export type SearchTokenCreateData = SearchTokenRow;
export type SearchTokenUpdateData = Partial<SearchTokenCreateData>;

export interface PrismaClientLike extends PrismaTransaction {
  $transaction<T>(
    callback: (tx: PrismaTransaction) => Promise<T>,
    options?: {
      isolationLevel?: "Serializable" | "ReadCommitted";
      maxWait?: number;
      timeout?: number;
    },
  ): Promise<T>;
}

export type AdapterInputs =
  | AddMessageInput
  | AddParticipantsInput
  | CountUnreadInput
  | CreateGroupConversationInput
  | CreateInviteInput
  | CreateJoinRequestInput
  | DeleteInviteInput
  | GetJoinRequestInput
  | GetOrCreateDirectConversationInput
  | ListConversationsInput
  | ListJoinRequestsInput
  | ListMessagesAfterSeqInput
  | ListMessagesInput
  | ListPublicConversationsInput
  | ReactionInput
  | RemoveParticipantInput
  | ResolveJoinRequestInput
  | SetMessageMentionsInput
  | SetParticipantRoleInput
  | UpdateConversationInput
  | UpdateLastReadInput
  | UpdateMessageInput;
