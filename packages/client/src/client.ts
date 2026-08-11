/** Composes the framework-agnostic Chatpack client and its resource actions. */
import type {
  ChannelJoinPolicy,
  ChannelVisibility,
  Metadata,
  MessageRole,
  ParticipantRole,
} from "@chatpack/core";
import type { ChatClientOptions } from "./config";
import type { ChatClientResult } from "./errors";
import {
  createPluginContext,
  disposePlugins,
  type ChatClientPlugin,
  type PluginSurfaces,
} from "./plugin";
import { createRealtime, type ChatRealtime } from "./realtime";
import {
  createRequester,
  normalizeBasePath,
  unwrapResult,
  type ClientRequestInit,
  type ChatpackRequester,
} from "./request";
import { createChatpackCache, type ChatpackCache } from "./store-cache";
import type { ReadonlyStore } from "./store";
import type {
  ClientAcceptInviteResult,
  ClientChannelPage,
  ClientConversationInvite,
  ClientConversation,
  ClientConversationPage,
  ClientInvitePreview,
  ClientJoinConversationResult,
  ClientJoinRequest,
  ClientMessage,
  ClientMessagePage,
} from "./wire";

/** Input for creating a conversation with another user. */
export interface ConversationCreateInput {
  otherUserId: string;
  metadata?: Metadata;
}

/**
 * Input for creating a group conversation (ADR 0017). Never find-or-create:
 * every call makes a new group, unlike `conversations.create` for DMs.
 */
export interface GroupCreateInput {
  /** Group title, 1-200 characters after trimming. Omit for an unnamed group. */
  name?: string;
  /**
   * Members to seed the group with, besides yourself. Optional - a group can
   * start with only its creator, who becomes its first admin.
   */
  userIds?: string[];
  /** Whether to list this group in the public channel directory. */
  visibility?: ChannelVisibility;
  /** How users joining a public channel are handled. */
  joinPolicy?: ChannelJoinPolicy;
  metadata?: Metadata;
}

/** Input for updating a group name or channel settings (ADR 0017/0020). */
export interface ConversationUpdateInput {
  conversationId: string;
  /** New title, or `null` to clear it. Omit when changing channel settings only. */
  name?: string | null;
  /** Whether to list this group in the public channel directory. */
  visibility?: ChannelVisibility;
  /** How users joining a public channel are handled. */
  joinPolicy?: ChannelJoinPolicy;
}

/** Input for adding members to a group (ADR 0017). Admin-only; already-present ids are no-ops. */
export interface ParticipantAddInput {
  conversationId: string;
  userIds: string[];
}

/**
 * Input for removing a member from a group (ADR 0017). Admins may remove
 * anyone; a member may remove themselves (leave). Removing the last admin is
 * `LAST_ADMIN_REMAINING` - promote someone first.
 */
export interface ParticipantRemoveInput {
  conversationId: string;
  /** The user to remove - your own id to leave. */
  userId: string;
}

/** Input for promoting or demoting a group member (ADR 0017). Admin-only. */
export interface ParticipantRoleInput {
  conversationId: string;
  userId: string;
  role: ParticipantRole;
}

/** Optional pagination input for listing conversations. */
export interface ConversationListInput {
  limit?: number;
  cursor?: string;
}

/** Input for loading one conversation. */
export interface ConversationGetInput {
  conversationId: string;
}

/** Input for marking a message as read. */
export interface MarkReadInput {
  conversationId: string;
  messageId: string;
}

/** Pagination input for listing messages in a conversation. */
export interface MessageListInput {
  conversationId: string;
  limit?: number;
  cursor?: string;
}

/** Participant-scoped, relevance-ranked message search input. */
export interface MessageSearchInput {
  /** Plain-text terms matched case-insensitively as whole tokens by the server. */
  query: string;
  limit?: number;
  cursor?: string;
}

/** Input for minting an invite link for a group. */
export interface InviteCreateInput {
  conversationId: string;
  expiresInSeconds?: number;
  maxUses?: number;
  requiresApproval?: boolean;
  metadata?: Metadata;
}

/** Input for listing or revoking invites belonging to a group. */
export interface InviteListInput {
  conversationId: string;
}

/** Input for revoking one invite link. */
export interface InviteRevokeInput extends InviteListInput {
  code: string;
}

/** Input for previewing an invite link before accepting it. */
export interface InvitePreviewInput {
  code: string;
}

/** Input for accepting an invite link. */
export interface InviteAcceptInput extends InvitePreviewInput {
  message?: string;
}

/** Typed actions for invite links. */
export interface InviteActions {
  create(
    input: InviteCreateInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversationInvite>>;
  list(
    input: InviteListInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<{ invites: ClientConversationInvite[] }>>;
  revoke(
    input: InviteRevokeInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<{ ok: true }>>;
  preview(
    input: InvitePreviewInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientInvitePreview>>;
  accept(
    input: InviteAcceptInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientAcceptInviteResult>>;
}

/** Input for creating a join request for a group or channel. */
export interface JoinRequestCreateInput {
  conversationId: string;
  message?: string;
}

/** Input for listing a group's join requests. */
export interface JoinRequestListInput extends InviteListInput {
  status?: "pending" | "approved" | "denied";
  limit?: number;
}

/** Input for approving or denying one user's join request. */
export interface JoinRequestResolveInput extends InviteListInput {
  userId: string;
  decision: "approve" | "deny";
}

/** Typed actions for join requests. */
export interface JoinRequestActions {
  create(
    input: JoinRequestCreateInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientJoinRequest>>;
  list(
    input: JoinRequestListInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<{ joinRequests: ClientJoinRequest[] }>>;
  resolve(
    input: JoinRequestResolveInput,
    options?: ChatClientRequestOptions,
  ): Promise<
    ChatClientResult<{ joinRequest: ClientJoinRequest; conversation: ClientConversation | null }>
  >;
}

/** Optional pagination input for the public channel directory. */
export interface ChannelListInput {
  limit?: number;
  cursor?: string;
}

/** Input for joining a public channel. */
export interface ChannelJoinInput {
  conversationId: string;
  message?: string;
}

/** Typed actions for public channels. */
export interface ChannelActions {
  list(
    input?: ChannelListInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientChannelPage>>;
  join(
    input: ChannelJoinInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientJoinConversationResult>>;
}

/** Input for sending a message. */
export interface MessageSendInput {
  conversationId: string;
  body: string;
  role?: MessageRole;
  /**
   * Quote-reply to this message (ADR 0013). Must be a message in the same
   * conversation; replying to a deleted one is allowed.
   */
  replyToMessageId?: string;
  metadata?: Metadata;
}

/** Input for adding or removing one of your own reactions. */
export interface MessageReactInput {
  messageId: string;
  /** Any non-empty string up to 32 characters - emoji, `:shortcode:`, or a custom id. */
  emoji: string;
}

/** Input for editing a message. */
export interface MessageEditInput {
  messageId: string;
  body: string;
}

/** Input for deleting a message. */
export interface MessageDeleteInput {
  messageId: string;
}

/** Per-request headers and cancellation options. */
export interface ChatClientRequestOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/** Typed actions for the conversations resource. */
export interface ConversationActions {
  create(
    input: ConversationCreateInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversation>>;
  /** Create a group conversation (ADR 0017). You become its first admin. */
  createGroup(
    input?: GroupCreateInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversation>>;
  list(
    input?: ConversationListInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversationPage>>;
  get(
    input: ConversationGetInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversation>>;
  /** Rename a group, or clear its title with `name: null` (ADR 0017). Admin-only. */
  update(
    input: ConversationUpdateInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversation>>;
  /** Add members to a group (ADR 0017). Admin-only; idempotent per user. */
  addParticipants(
    input: ParticipantAddInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversation>>;
  /** Remove a member, or leave by passing your own id (ADR 0017). */
  removeParticipant(
    input: ParticipantRemoveInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversation>>;
  /** Promote or demote a group member (ADR 0017). Admin-only. */
  setParticipantRole(
    input: ParticipantRoleInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversation>>;
  markRead(
    input: MarkReadInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<{ ok: true }>>;
}

/** Typed actions for the messages resource. */
export interface MessageActions {
  list(
    input: MessageListInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessagePage>>;
  /** Search every conversation visible to the authenticated participant. */
  search(
    input: MessageSearchInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessagePage>>;
  send(
    input: MessageSendInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
  edit(
    input: MessageEditInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
  delete(
    input: MessageDeleteInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
  /** Add one of your own reactions. Idempotent - reacting twice is one reaction. */
  react(
    input: MessageReactInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
  /** Remove one of your own reactions. Idempotent - removing a missing one is a no-op. */
  unreact(
    input: MessageReactInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
}

/** Public framework-agnostic Chatpack client surface. */
export interface ChatClient {
  conversations: ConversationActions;
  messages: MessageActions;
  invites: InviteActions;
  joinRequests: JoinRequestActions;
  channels: ChannelActions;
  realtime: ChatRealtime;
  $store: ChatpackCache;
  $getPluginState(id: string): ReadonlyStore<unknown> | null;
  dispose(): void;
}

/** Chatpack client surface with the actions and state contributed by plugins. */
export type ChatClientWithPlugins<Plugins extends readonly ChatClientPlugin[]> = ChatClient &
  PluginSurfaces<Plugins>;

function requestOptions(
  options: ChatClientRequestOptions | undefined,
): Pick<ClientRequestInit, "headers" | "signal"> {
  return options === undefined
    ? {}
    : {
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
}

/** Creates an isolated Chatpack client instance. */
export function createChatClient<
  Plugins extends readonly ChatClientPlugin[] = readonly ChatClientPlugin[],
>(options: ChatClientOptions<Plugins> = {}): ChatClientWithPlugins<Plugins> {
  const basePath = normalizeBasePath(options.basePath);
  const plugins: readonly ChatClientPlugin[] = options.plugins ?? [];
  const credentials = options.credentials ?? "same-origin";
  const requesterOptions = {
    basePath,
    credentials,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const requester: ChatpackRequester = createRequester(requesterOptions);
  const cache = createChatpackCache(options.userId === undefined ? {} : { userId: options.userId });
  /**
   * Mirrors the cache's viewer inference (the `userId` option, else the sender
   * of the first local send) for the one decision made outside it: whether a
   * `participant.added` event means *this* user joined a group.
   */
  let viewerId = options.userId;
  const eventTypes = [
    "message.created",
    "message.updated",
    "message.deleted",
    "reaction.added",
    "reaction.removed",
    "participant.added",
    "participant.removed",
    "conversation.updated",
    ...plugins.flatMap((plugin) => plugin.eventTypes),
  ];
  /**
   * Conversations whose first message arrived over the stream before the list
   * knew about them; guards against firing the same backfill twice.
   */
  const backfilling = new Set<string>();

  /**
   * How many threads one poll tick refreshes (`docs/decisions/0016`).
   *
   * The cache keeps every thread it has ever loaded, so polling all of them
   * would cost a request per conversation the user had ever opened, growing for
   * as long as the tab stays alive. Three covers the open thread plus a split
   * view, and anything older catches up when the user navigates back to it -
   * which refetches it anyway.
   */
  const POLLED_THREAD_LIMIT = 3;
  /** Conversation ids most-recently read or written by this client, newest first. */
  const recentThreads: string[] = [];
  /**
   * The `limit` each surface was last fetched with, so a poll re-reads the same
   * page size the host asked for. Without this a host paginating 10 at a time
   * would silently get the server's default of 50 back on every tick.
   */
  const polledLimits = new Map<string, number>();
  const CONVERSATION_LIST_KEY = " conversations";

  function touchThread(conversationId: string, limit?: number): void {
    if (conversationId === "") return;
    const index = recentThreads.indexOf(conversationId);
    if (index !== -1) recentThreads.splice(index, 1);
    recentThreads.unshift(conversationId);
    for (const dropped of recentThreads.splice(POLLED_THREAD_LIMIT)) {
      polledLimits.delete(dropped);
    }
    if (limit !== undefined) polledLimits.set(conversationId, limit);
  }

  /**
   * A brand-new conversation started by the other user has no row in the
   * loaded list, so there is nothing to reorder. Fetch it once and prepend it
   * (with the server's authoritative `unreadCount`) instead of silently
   * dropping the update.
   */
  async function backfillConversation(conversationId: string): Promise<void> {
    if (backfilling.has(conversationId)) return;
    backfilling.add(conversationId);
    try {
      const result = await requester.request<unknown>(
        "/conversations/" + encodeURIComponent(conversationId),
      );
      const conversation = unwrapResult<ClientConversation>(result, "conversation");
      if (conversation.error === null) cache.prependConversation(conversation.data);
    } finally {
      backfilling.delete(conversationId);
    }
  }

  /**
   * One polling refresh (`docs/decisions/0016`): everything the stream would
   * have delivered, from the routes that already exist.
   *
   * Refetches the newest page of every *loaded* thread plus the conversations
   * list, rather than asking for messages after a `seq`. An edit, a delete and a
   * reaction all leave `seq` untouched (`docs/decisions/0003`, `0013`), so an
   * `afterSeq` poll would show new messages and silently miss every other
   * change. Re-reading page one costs one request and catches all of them.
   *
   * Never rejects and never touches loading flags: a poll is background work,
   * so a mounted component must not flip to a spinner every interval, and a
   * failed tick leaves the last good data on screen and retries on the next.
   */
  async function pollOnce(): Promise<void> {
    const loaded = cache.getSnapshot();
    const conversationIds = recentThreads.filter(
      (conversationId) => loaded.messagesByConversation[conversationId]?.data != null,
    );

    const listPoll: Promise<void> =
      loaded.conversations.data === null
        ? Promise.resolve()
        : requester
            .request<ClientConversationPage>("/conversations", {
              query: { limit: polledLimits.get(CONVERSATION_LIST_KEY) },
            })
            .then((result) => {
              if (result.error === null) cache.applyPolledConversations(result.data);
            })
            .catch(() => undefined);

    const threadPolls = conversationIds.map((conversationId) =>
      requester
        .request<ClientMessagePage>(
          "/conversations/" + encodeURIComponent(conversationId) + "/messages",
          { query: { limit: polledLimits.get(conversationId) } },
        )
        .then((result) => {
          if (result.error === null) {
            cache.applyPolledMessages(conversationId, result.data);
            return;
          }
          // A polling client never receives `participant.removed` - this 403
          // on a thread it could read a tick ago is its only signal that the
          // viewer was removed from the group (ADR 0017). The list poll can't
          // catch it either: the merge keeps rows the page didn't mention.
          if (result.error.code === "FORBIDDEN_READ") cache.dropConversation(conversationId);
        })
        .catch(() => undefined),
    );

    await Promise.all([listPoll, ...threadPolls]);
  }

  const realtimeOptions = options.realtime ?? {};
  const realtime = createRealtime({
    url: (options.baseURL?.replace(/\/+$/g, "") ?? "") + basePath + "/stream",
    credentials,
    eventSource: options.eventSource ?? ((url, init) => new EventSource(url, init)),
    eventTypes: [...new Set(eventTypes)],
    mode: realtimeOptions.mode ?? "auto",
    onPoll: pollOnce,
    ...(realtimeOptions.intervalMs === undefined
      ? {}
      : { pollIntervalMs: realtimeOptions.intervalMs }),
    onEvent: (event) => {
      cache.applyEvent(event);
      if ("ephemeral" in event) return;
      // A `message.created` in an unknown conversation means someone else
      // started it; a `participant.added` naming the viewer means they were
      // just added to a group (ADR 0017). Either way the list has no row to
      // update, so fetch the conversation once - the GET carries the viewer's
      // real `unreadCount`, which the event snapshot does not.
      //
      // Other members' adds never backfill: a membership change does not bump
      // server-side activity, so prepending an off-page conversation the
      // viewer was already in would misorder the list. Their snapshot merge is
      // a no-op and the row stays correct wherever pagination finds it. When
      // the viewer is unknown (no `userId` option, nothing sent yet) the
      // backfill errs toward fetching.
      const isNewMessage = event.type === "message.created";
      const isViewerAdded =
        event.type === "participant.added" &&
        (viewerId === undefined || event.affectedUserIds.includes(viewerId));
      if (
        (isNewMessage || isViewerAdded) &&
        cache.isMissingFromConversations(event.conversationId)
      ) {
        void backfillConversation(event.conversationId);
      }
    },
  });
  const pluginContext = createPluginContext(requester, realtime);
  const pluginSurfaces: Record<string, object> = {};
  const pluginInstances: Array<{ dispose?: () => void }> = [];
  const pluginState = new Map<string, ReadonlyStore<unknown>>();

  for (const plugin of plugins) {
    if (Object.hasOwn(pluginSurfaces, plugin.id)) {
      throw new Error('chatpack: duplicate client plugin id "' + plugin.id + '".');
    }
    const instance = plugin.create(pluginContext);
    pluginInstances.push(instance);
    pluginState.set(plugin.id, instance.state);
    pluginSurfaces[plugin.id] = { ...instance.actions, state: instance.state };
  }

  /**
   * Shared by the four group mutations (ADR 0017): unwrap the conversation
   * envelope and echo it into the cache. `setConversation` replaces the
   * single-conversation query (the response carries the viewer's real
   * `unreadCount`), and the snapshot merge updates the copy in the loaded
   * list - the same shape the other members receive over the stream.
   */
  async function changeConversation(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>,
    optionsForRequest: ChatClientRequestOptions | undefined,
  ): Promise<ChatClientResult<ClientConversation>> {
    const result = await requester.request<unknown>(path, {
      method,
      body,
      ...requestOptions(optionsForRequest),
    });
    const conversation = unwrapResult<ClientConversation>(result, "conversation");
    if (conversation.error === null) {
      cache.setConversation(conversation.data.id, conversation);
      cache.applyConversationSnapshot(conversation.data);
    }
    return conversation;
  }

  const conversationActions: ConversationActions = {
    async create(input, optionsForRequest) {
      const result = await requester.request<unknown>("/conversations", {
        method: "POST",
        body: input,
        ...requestOptions(optionsForRequest),
      });
      const conversation = unwrapResult<ClientConversation>(result, "conversation");
      if (conversation.error === null) cache.setConversation(conversation.data.id, conversation);
      return conversation;
    },
    async createGroup(input = {}, optionsForRequest) {
      const result = await requester.request<unknown>("/conversations/group", {
        method: "POST",
        body: input,
        ...requestOptions(optionsForRequest),
      });
      const conversation = unwrapResult<ClientConversation>(result, "conversation");
      if (conversation.error === null) {
        cache.setConversation(conversation.data.id, conversation);
        // A new group has no activity yet, so no stream event will splice it
        // into the list for its creator - prepend the local echo instead. The
        // response carries the viewer's real `unreadCount` (zero), so this is
        // as authoritative as a backfill fetch.
        cache.prependConversation(conversation.data);
      }
      return conversation;
    },
    async list(input = {}, optionsForRequest) {
      cache.setConversationsLoading();
      // Remember the page size of the *first* page only: a poll always re-reads
      // page one, so a `loadMore` limit would be the wrong size for it.
      if (input.cursor === undefined && input.limit !== undefined) {
        polledLimits.set(CONVERSATION_LIST_KEY, input.limit);
      }
      const result = await requester.request<ClientConversationPage>("/conversations", {
        query: { limit: input.limit, cursor: input.cursor },
        ...requestOptions(optionsForRequest),
      });
      cache.setConversations(result, input.cursor !== undefined);
      return result;
    },
    async get(input, optionsForRequest) {
      cache.setConversationLoading(input.conversationId);
      const result = await requester.request<unknown>(
        "/conversations/" + encodeURIComponent(input.conversationId),
        requestOptions(optionsForRequest),
      );
      const conversation = unwrapResult<ClientConversation>(result, "conversation");
      cache.setConversation(input.conversationId, conversation);
      return conversation;
    },
    async update(input, optionsForRequest) {
      return changeConversation(
        "/conversations/" + encodeURIComponent(input.conversationId),
        "PATCH",
        {
          name: input.name,
          visibility: input.visibility,
          joinPolicy: input.joinPolicy,
        },
        optionsForRequest,
      );
    },
    async addParticipants(input, optionsForRequest) {
      return changeConversation(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/participants",
        "POST",
        { userIds: input.userIds },
        optionsForRequest,
      );
    },
    async removeParticipant(input, optionsForRequest) {
      const result = await requester.request<unknown>(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/participants",
        {
          method: "DELETE",
          body: { userId: input.userId },
          ...requestOptions(optionsForRequest),
        },
      );
      const conversation = unwrapResult<ClientConversation>(result, "conversation");
      if (conversation.error === null) {
        // Not `changeConversation`: when the removed user is the viewer
        // (leaving), the echo must drop the conversation rather than re-cache
        // a room the server will now 403 - the same path the stream event
        // takes for the removed user (ADR 0017).
        cache.applyParticipantRemoved([input.userId], conversation.data);
      }
      return conversation;
    },
    async setParticipantRole(input, optionsForRequest) {
      return changeConversation(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/participants",
        "PATCH",
        { userId: input.userId, role: input.role },
        optionsForRequest,
      );
    },
    async markRead(input, optionsForRequest) {
      const result = await requester.request<{ ok: true }>(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/read",
        {
          method: "POST",
          body: { messageId: input.messageId },
          ...requestOptions(optionsForRequest),
        },
      );
      if (result.error === null) cache.applyRead(input.conversationId, input.messageId);
      return result;
    },
  };

  function applyJoinedConversation(conversation: ClientConversation): void {
    cache.setConversation(conversation.id, { data: conversation, error: null });
    cache.applyConversationSnapshot(conversation);
    if (cache.isMissingFromConversations(conversation.id)) {
      cache.prependConversation(conversation);
    }
  }

  function applyJoinResult(result: ClientAcceptInviteResult | ClientJoinConversationResult): void {
    if (result.status === "joined") applyJoinedConversation(result.conversation);
  }

  const inviteActions: InviteActions = {
    async create(input, optionsForRequest) {
      const { conversationId, ...body } = input;
      const result = await requester.request<unknown>(
        "/conversations/" + encodeURIComponent(conversationId) + "/invites",
        {
          method: "POST",
          body,
          ...requestOptions(optionsForRequest),
        },
      );
      return unwrapResult<ClientConversationInvite>(result, "invite");
    },
    async list(input, optionsForRequest) {
      return requester.request<{ invites: ClientConversationInvite[] }>(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/invites",
        requestOptions(optionsForRequest),
      );
    },
    async revoke(input, optionsForRequest) {
      return requester.request<{ ok: true }>(
        "/conversations/" +
          encodeURIComponent(input.conversationId) +
          "/invites/" +
          encodeURIComponent(input.code),
        { method: "DELETE", ...requestOptions(optionsForRequest) },
      );
    },
    async preview(input, optionsForRequest) {
      const result = await requester.request<unknown>(
        "/invites/" + encodeURIComponent(input.code),
        requestOptions(optionsForRequest),
      );
      return unwrapResult<ClientInvitePreview>(result, "invite");
    },
    async accept(input, optionsForRequest) {
      const result = await requester.request<ClientAcceptInviteResult>(
        "/invites/" + encodeURIComponent(input.code) + "/accept",
        {
          method: "POST",
          body: input.message === undefined ? {} : { message: input.message },
          ...requestOptions(optionsForRequest),
        },
      );
      if (result.error === null) applyJoinResult(result.data);
      return result;
    },
  };

  const joinRequestActions: JoinRequestActions = {
    async create(input, optionsForRequest) {
      const { conversationId, ...body } = input;
      const result = await requester.request<unknown>(
        "/conversations/" + encodeURIComponent(conversationId) + "/join-requests",
        {
          method: "POST",
          body,
          ...requestOptions(optionsForRequest),
        },
      );
      return unwrapResult<ClientJoinRequest>(result, "joinRequest");
    },
    async list(input, optionsForRequest) {
      return requester.request<{ joinRequests: ClientJoinRequest[] }>(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/join-requests",
        {
          query: { status: input.status, limit: input.limit },
          ...requestOptions(optionsForRequest),
        },
      );
    },
    async resolve(input, optionsForRequest) {
      const result = await requester.request<{
        joinRequest: ClientJoinRequest;
        conversation: ClientConversation | null;
      }>("/conversations/" + encodeURIComponent(input.conversationId) + "/join-requests", {
        method: "PATCH",
        body: { userId: input.userId, decision: input.decision },
        ...requestOptions(optionsForRequest),
      });
      if (result.error === null && result.data.conversation !== null) {
        applyJoinedConversation(result.data.conversation);
      }
      return result;
    },
  };

  const channelActions: ChannelActions = {
    async list(input = {}, optionsForRequest) {
      return requester.request<ClientChannelPage>("/channels", {
        query: { limit: input.limit, cursor: input.cursor },
        ...requestOptions(optionsForRequest),
      });
    },
    async join(input, optionsForRequest) {
      const result = await requester.request<ClientJoinConversationResult>(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/join",
        {
          method: "POST",
          body: input.message === undefined ? {} : { message: input.message },
          ...requestOptions(optionsForRequest),
        },
      );
      if (result.error === null) applyJoinResult(result.data);
      return result;
    },
  };

  /**
   * Add or remove a reaction and echo the change into the cache. The response
   * carries the full message, so the local echo writes the same complete
   * snapshot the other participant receives over the stream.
   *
   * The emoji travels in the body for both verbs (see the route comment in
   * `packages/core/src/handler.ts`).
   */
  async function changeReaction(
    method: "POST" | "DELETE",
    input: MessageReactInput,
    optionsForRequest: ChatClientRequestOptions | undefined,
  ): Promise<ChatClientResult<ClientMessage>> {
    const result = await requester.request<unknown>(
      "/messages/" + encodeURIComponent(input.messageId) + "/reactions",
      {
        method,
        body: { emoji: input.emoji },
        ...requestOptions(optionsForRequest),
      },
    );
    const message = unwrapResult<ClientMessage>(result, "message");
    if (message.error === null) {
      cache.applyReactions(message.data.conversationId, message.data);
    }
    return message;
  }

  const messageActions: MessageActions = {
    async list(input, optionsForRequest) {
      cache.setMessagesLoading(input.conversationId);
      // Listing a thread is what makes it "open" as far as polling is concerned.
      // Only a first page's limit describes the page a poll will re-read.
      touchThread(input.conversationId, input.cursor === undefined ? input.limit : undefined);
      const result = await requester.request<ClientMessagePage>(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/messages",
        {
          query: { limit: input.limit, cursor: input.cursor },
          ...requestOptions(optionsForRequest),
        },
      );
      cache.setMessages(input.conversationId, result, input.cursor !== undefined);
      return result;
    },
    async search(input, optionsForRequest) {
      cache.setMessageSearchLoading(input.query);
      const result = await requester.request<ClientMessagePage>("/search/messages", {
        query: { q: input.query, limit: input.limit, cursor: input.cursor },
        ...requestOptions(optionsForRequest),
      });
      cache.setMessageSearch(input.query, result, input.cursor !== undefined);
      return result;
    },
    async send(input, optionsForRequest) {
      const { conversationId, ...body } = input;
      touchThread(conversationId);
      const result = await requester.request<unknown>(
        "/conversations/" + encodeURIComponent(conversationId) + "/messages",
        {
          method: "POST",
          body,
          ...requestOptions(optionsForRequest),
        },
      );
      const message = unwrapResult<ClientMessage>(result, "message");
      if (message.error === null) {
        viewerId ??= message.data.senderId;
        cache.applyEvent(
          {
            type: "message.created",
            conversationId: message.data.conversationId,
            message: message.data,
          },
          { local: true },
        );
      }
      return message;
    },
    async edit(input, optionsForRequest) {
      const result = await requester.request<unknown>(
        "/messages/" + encodeURIComponent(input.messageId),
        {
          method: "PATCH",
          body: { body: input.body },
          ...requestOptions(optionsForRequest),
        },
      );
      const message = unwrapResult<ClientMessage>(result, "message");
      if (message.error === null) {
        cache.applyEvent({
          type: "message.updated",
          conversationId: message.data.conversationId,
          message: message.data,
        });
      }
      return message;
    },
    async delete(input, optionsForRequest) {
      const result = await requester.request<unknown>(
        "/messages/" + encodeURIComponent(input.messageId),
        { method: "DELETE", ...requestOptions(optionsForRequest) },
      );
      const message = unwrapResult<ClientMessage>(result, "message");
      if (message.error === null) {
        cache.applyEvent({
          type: "message.deleted",
          conversationId: message.data.conversationId,
          message: message.data,
        });
      }
      return message;
    },
    async react(input, optionsForRequest) {
      return changeReaction("POST", input, optionsForRequest);
    },
    async unreact(input, optionsForRequest) {
      return changeReaction("DELETE", input, optionsForRequest);
    },
  };

  const client: ChatClient = {
    conversations: conversationActions,
    messages: messageActions,
    invites: inviteActions,
    joinRequests: joinRequestActions,
    channels: channelActions,
    realtime,
    $store: cache,
    $getPluginState(id) {
      return pluginState.get(id) ?? null;
    },
    dispose() {
      realtime.disconnect();
      disposePlugins(pluginInstances);
    },
  };

  return Object.assign(client, pluginSurfaces) as ChatClientWithPlugins<Plugins>;
}
