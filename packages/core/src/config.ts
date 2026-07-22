/**
 * Configuration for the `chatpack()` factory.
 *
 * @module
 */

import type { Conversation } from "./types";
import type { StorageAdapter } from "./storage";

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
 * Resolves the current user from an incoming request — the **only** auth
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
    /** Convenience: the two participant user ids. */
    participantIds: string[];
  };
}

/**
 * Permission hooks (MVP §2). The default for both is
 * "only the two participants" — override to loosen or tighten.
 */
export interface PermissionHooks {
  /** May `user` read `conversation`? Default: participants only. */
  canRead?: (ctx: PermissionContext) => Promise<boolean> | boolean;
  /** May `user` write to `conversation`? Default: participants only. */
  canWrite?: (ctx: PermissionContext) => Promise<boolean> | boolean;
}

/** Options accepted by the `chatpack()` factory. */
export interface ChatpackOptions {
  /** Durable storage — e.g. `memoryAdapter()` or (from M4) `drizzleAdapter(db)`. */
  storage: StorageAdapter;
  /**
   * Resolve the current user from a request. Optional in M1 (core API takes
   * explicit user ids); required once the HTTP handler mounts in M2.
   */
  auth?: AuthHook;
  /** Permission overrides. Default: only the two participants can read/write. */
  permissions?: PermissionHooks;
  /**
   * Anonymous aggregate telemetry (MVP §12). Default `true`; set `false` or
   * `CHATPACK_TELEMETRY=0` to disable.
   */
  telemetry?: boolean;
}
