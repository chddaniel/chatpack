/**
 * `@chatpack/core/plugins` - first-party opt-in plugins (`docs/decisions/0008`).
 *
 * All three are ephemeral-only: they add live signals and routes, never
 * storage. Pass them via `chatpack({ plugins: [...] })`:
 *
 * ```ts
 * import { chatpack } from "@chatpack/core";
 * import { typing, presence, receipts } from "@chatpack/core/plugins";
 *
 * const chat = chatpack({
 *   storage: memoryAdapter(),
 *   auth: myAuth,
 *   plugins: [typing(), presence(), receipts()],
 * });
 * ```
 *
 * @module
 */

export { typing } from "./typing";
export {
  presence,
  type PresenceCloseInput,
  type PresenceCloseResult,
  type PresenceFinalizeOfflineInput,
  type PresenceFinalizeOfflineResult,
  type PresenceGetInput,
  type PresenceHeartbeatInput,
  type PresenceOpenInput,
  type PresenceOpenResult,
  type PresenceOptions,
  type PresenceState,
  type PresenceStore,
} from "./presence";
export { receipts } from "./receipts";
