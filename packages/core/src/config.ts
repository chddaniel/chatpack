/**
 * Configuration for the `chatpack()` factory.
 *
 * @module
 */

import type { Conversation, Message, MessageRole, Metadata } from "./types";
import type { ModerationAction } from "./moderation";
import type { ChatpackPlugin } from "./plugin";
import type { StorageAdapter } from "./storage";
import type { Transport } from "./transport";

/**
 * The authenticated user, as resolved by the developer's {@link AuthHook}.
 *
 * Chatpack only ever needs an id. Extra fields are allowed and ignored.
 */
export interface ChatpackUser {
  /** The developer's user id. */
  id: string;
  /** Any extra fields the developer's auth system provides. */
  [key: string]: unknown;
}

/**
 * Resolves the current user from an incoming request - the **only** auth
 * touchpoint in Chatpack (MVP §2). Developers bring their own auth; Chatpack
 * never owns a users table and never issues sessions.
 *
 * Return `null` to signal an unauthenticated request.
 *
 * In M1 the hook is stored on the instance and consumed by the framework
 * handler in M2; core API methods take an explicit `userId`.
 */
export type AuthHook = (request: Request) => Promise<ChatpackUser | null> | ChatpackUser | null;

/** Context passed to permission hooks. */
export interface PermissionContext {
  /** The user attempting the action (id always present). */
  user: ChatpackUser;
  /** The conversation being read from / written to. */
  conversation: Conversation & {
    /** Convenience: the participant user ids. */
    participantIds: string[];
  };
}

/**
 * Permission hooks (MVP §2). Defaults: `canRead`/`canWrite` allow any
 * participant; `canManage` allows group admins (`docs/decisions/0017`).
 * Override to loosen or tighten.
 */
export interface PermissionHooks {
  /** May `user` read `conversation`? Default: participants only. */
  canRead?: (ctx: PermissionContext) => Promise<boolean> | boolean;
  /** May `user` write to `conversation`? Default: participants only. */
  canWrite?: (ctx: PermissionContext) => Promise<boolean> | boolean;
  /**
   * May `user` administer `conversation` - add/remove members, change roles,
   * rename (`docs/decisions/0017`)?
   *
   * Default: the user is a participant whose `role` is `"admin"`. Override when
   * authority lives outside Chatpack (org roles, subscription tier, staff
   * flags). Leaving a group is exempt: a member may always remove themselves.
   */
  canManage?: (ctx: PermissionContext) => Promise<boolean> | boolean;
  /**
   * May `user` mint an invite link for `conversation`
   * (`docs/decisions/0019`)?
   *
   * Default: the same admin check as {@link PermissionHooks.canManage}, so no
   * existing deployment changes behavior. Override it for the most common
   * variation of this feature - "any member may invite, but only admins may
   * remove people":
   *
   * ```ts
   * permissions: {
   *   canInvite: (ctx) => ctx.conversation.participantIds.includes(ctx.user.id),
   * }
   * ```
   *
   * This exists as its own hook precisely so that variation does not require
   * loosening `canManage`, which would also hand every member the power to
   * remove others and rewrite roles (ADR 0019 §8). Only invite *creation* is
   * gated by it - listing, revoking, and resolving join requests stay on
   * `canManage`, because admitting a specific person is a stronger act than
   * minting a link that still requires the invitee to act.
   */
  canInvite?: (ctx: PermissionContext) => Promise<boolean> | boolean;
}

/** Context passed to the host's moderator authorization hook. */
export interface ModerationPermissionContext {
  user: ChatpackUser;
  action: ModerationAction;
  targetUserId?: string;
  reportId?: string;
  banId?: string;
}

/** Host-owned authorization for moderation admin operations. */
export type CanModerateHook = (ctx: ModerationPermissionContext) => Promise<boolean> | boolean;

/**
 * Context passed to {@link MessageHooks.beforeMessageSend}. `body` is the
 * text as the sender submitted it (after Chatpack's own non-empty check).
 */
export interface BeforeMessageSendContext {
  /** The sender (id always present). */
  user: ChatpackUser;
  /** The conversation being written to. */
  conversation: Conversation & {
    /** Convenience: the two participant user ids. */
    participantIds: string[];
  };
  /** The submitted message text. */
  body: string;
  /** The submitted metadata (`{}` when omitted). */
  metadata: Metadata;
  /** `"user"` unless the caller passed the AI escape hatch role. */
  role: MessageRole;
  /**
   * `"send"` for new messages, `"edit"` when an existing message's body is
   * being rewritten - the same rules usually apply to both.
   */
  action: "send" | "edit";
}

/**
 * What {@link MessageHooks.beforeMessageSend} may return to rewrite the
 * message before it is persisted. Return `undefined`/`void` to accept the
 * message unchanged.
 */
export interface BeforeMessageSendResult {
  /** Replacement text (e.g. after profanity filtering). Must be non-empty. */
  body?: string;
  /** Replacement metadata. Ignored for edits (edits only change the body). */
  metadata?: Metadata;
}

/** The durable mutation that caused an after-message hook to run. */
export type MessageMutationAction = "send" | "edit" | "delete";

/** Context passed to {@link MessageHooks.afterMessageMutation}. */
export interface AfterMessageMutationContext {
  /** The message exactly as persisted, including its id and sequence. */
  message: Message;
  /** The conversation containing the message. */
  conversation: Conversation & {
    /** Convenience: the participant user ids. */
    participantIds: string[];
  };
  /**
   * Every participant except the sender - i.e. everyone who should be notified
   * (`docs/decisions/0017`). **Use this**, not `otherParticipantId`: it is
   * correct for both direct and group conversations.
   *
   * Empty when the sender is the only participant (a creator-only group).
   */
  recipientIds: string[];
  /**
   * The participant who is not the persisted message sender.
   *
   * @deprecated Single-valued, so it silently drops recipients in a group:
   * for a group it is the *first* non-sender participant, matching the
   * behavior shipped in core 0.6.0. Use {@link recipientIds} instead. Removed
   * at 1.0; kept required here because narrowing or removing it would break
   * every 0.6.0 push integration (`docs/decisions/0017` §5).
   */
  otherParticipantId: string;
  /** The durable message mutation that completed. */
  action: MessageMutationAction;
}

/** Context passed to the deprecated {@link MessageHooks.afterMessageSend}. */
export interface AfterMessageSendContext {
  /** The message exactly as persisted (post-rewrite, with id and seq). */
  message: Message;
  /** The conversation it landed in. */
  conversation: Conversation & {
    /** Convenience: the participant user ids. */
    participantIds: string[];
  };
  /** Every participant except the sender (`docs/decisions/0017`). */
  recipientIds: string[];
  /**
   * The participant who is not the persisted message sender.
   *
   * @deprecated See {@link AfterMessageMutationContext.otherParticipantId} -
   * use `recipientIds`.
   */
  otherParticipantId: string;
  /** `"send"` for new messages, `"edit"` for body rewrites. */
  action: "send" | "edit";
}

/**
 * Message lifecycle hooks (`docs/decisions/0011` and `0014`). The before hook
 * runs for sends and edits. The after hook runs for every durable message
 * mutation; `ctx.action` tells them apart.
 */
export interface MessageHooks {
  /**
   * Runs after auth and permission checks pass, **before the message is
   * persisted**. Three outcomes:
   *
   * - return nothing - accept the message unchanged
   * - return `{ body }` / `{ metadata }` - persist the rewritten version
   * - throw (a `ChatpackError` with code `MESSAGE_REJECTED`, or anything
   *   else) - nothing is stored, nothing is broadcast, and the sender gets
   *   a 422 with the thrown message
   */
  beforeMessageSend?: (
    ctx: BeforeMessageSendContext,
  ) => Promise<BeforeMessageSendResult | void> | BeforeMessageSendResult | void;
  /**
   * Runs after a message is persisted and broadcast (durable-first, MVP §9).
   * It receives `send`, `edit`, and `delete` actions. This is a side-effect
   * hook, not a gate: it cannot block or change the message. The API call
   * awaits it, but a throwing hook is logged server-side and never fails the
   * request because the message already exists. Keep heavy work in a queue.
   */
  afterMessageMutation?: (ctx: AfterMessageMutationContext) => Promise<void> | void;
  /**
   * @deprecated Use `afterMessageMutation`. This compatibility hook keeps its
   * original send/edit-only behavior and does not run for deletes.
   */
  afterMessageSend?: (ctx: AfterMessageSendContext) => Promise<void> | void;
}

/** Options accepted by the `chatpack()` factory. */
export interface ChatpackOptions {
  /** Durable storage - e.g. `memoryAdapter()` or (from M4) `drizzleAdapter(db)`. */
  storage: StorageAdapter;
  /**
   * Resolve the current user from a request. Optional in M1 (core API takes
   * explicit user ids); required once the HTTP handler mounts in M2.
   */
  auth?: AuthHook;
  /** Permission overrides. Default: only the two participants can read/write. */
  permissions?: PermissionHooks;
  /** Optional moderation configuration. Admin access is denied when omitted. */
  moderation?: {
    /** Authorizes moderator report and ban actions. */
    canModerate?: CanModerateHook;
  };
  /**
   * Message lifecycle hooks (`docs/decisions/0011` and `0014`): block or
   * rewrite messages before they persist, react after they do. Default: none.
   */
  hooks?: MessageHooks;
  /**
   * Live event fan-out (MVP §6). Default: a single-node in-process transport,
   * which is correct for one server process. A Redis/pub-sub transport can be
   * plugged in later without any other API change.
   */
  transport?: Transport;
  /**
   * Opt-in plugins (`docs/decisions/0008`) - e.g. `typing()`, `presence()`,
   * `receipts()` from `@chatpack/core/plugins`. Default: none. Plugins add
   * ephemeral real-time behavior (extra routes, live signals) and never touch
   * storage.
   */
  plugins?: ChatpackPlugin[];
  /**
   * Anonymous aggregate telemetry (MVP §12). Default `true`; set `false` or
   * `CHATPACK_TELEMETRY=0` to disable.
   */
  telemetry?: boolean;
}
