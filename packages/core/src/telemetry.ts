/**
 * Anonymous telemetry counters (MVP §12).
 *
 * Two halves:
 *
 * - **Counters** (M1): in-process integers incremented after successful
 *   domain actions. Zero cost on the hot path.
 * - **Flusher** (M5): a fire-and-forget POST of aggregate deltas on a slow,
 *   unref'd timer. Failures are silent; nothing telemetry does can ever
 *   affect chat.
 *
 * Guarantees (see docs/MVP.md §12):
 *
 * - **Anonymous aggregates only** — counts, library version, and a random
 *   per-process instance id (never persisted, never derived from anything).
 *   Never message bodies, user ids, conversation ids, or hostnames.
 * - **Opt-out** — `telemetry: false` in config or `CHATPACK_TELEMETRY=0`.
 * - **Never on the hot path** — incrementing is a synchronous integer add;
 *   flushing is fire-and-forget with a timeout.
 *
 * @module
 */

import { VERSION } from "./version";

/** Names of the aggregate counters Chatpack tracks. */
export type TelemetryCounterName = "messagesSent" | "conversationsCreated";

/** A snapshot of the current in-process counter values. */
export type TelemetrySnapshot = Record<TelemetryCounterName, number>;

/**
 * In-process telemetry counters.
 *
 * Created internally by `chatpack()`; exposed on the instance as
 * `chat.telemetry` so deployments can read aggregates.
 * When disabled, all operations are no-ops.
 */
export class TelemetryCounters {
  private readonly counts: TelemetrySnapshot = {
    messagesSent: 0,
    conversationsCreated: 0,
  };

  /** Whether telemetry is enabled for this instance. */
  readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** Increment a counter by 1. No-op when telemetry is disabled. */
  increment(name: TelemetryCounterName): void {
    if (!this.enabled) return;
    this.counts[name] += 1;
  }

  /** Read the current counter values (always zeros when disabled). */
  snapshot(): TelemetrySnapshot {
    return { ...this.counts };
  }
}

/**
 * Resolve whether telemetry should be enabled.
 *
 * Precedence: env var `CHATPACK_TELEMETRY=0` always wins (ops-level kill
 * switch), then the `telemetry` config flag, then the default (`true`).
 */
export function resolveTelemetryEnabled(configFlag: boolean | undefined): boolean {
  const env =
    typeof process !== "undefined" && typeof process.env !== "undefined"
      ? process.env["CHATPACK_TELEMETRY"]
      : undefined;
  if (env === "0" || env === "false") return false;
  return configFlag !== false;
}

/** Where aggregate counters are POSTed. Overridable for self-hosters/tests. */
export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.chatpack.dev/v1/aggregates";

/** How often deltas are flushed (12h). Slow on purpose — this is not APM. */
export const DEFAULT_FLUSH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** The exact JSON body a telemetry flush sends — documented, auditable. */
export interface TelemetryPayload {
  /** Random UUID generated per process start. Never persisted. */
  instanceId: string;
  /** `@chatpack/core` version. */
  version: string;
  /** Counter deltas since the previous flush (not running totals). */
  counters: TelemetrySnapshot;
}

/** Options for {@link startTelemetryFlusher}; exposed mainly for tests. */
export interface TelemetryFlusherOptions {
  endpoint?: string;
  intervalMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * Start the periodic telemetry flusher for a set of counters.
 *
 * Sends **deltas** since the last successful flush, so restarts and failed
 * requests never double-count. The timer is `unref`'d — it will never keep a
 * process alive. Every failure mode (offline, DNS, 500, timeout) is silently
 * ignored. Returns a stop function.
 *
 * Called internally by `chatpack()` when telemetry is enabled; also exported
 * for self-hosters pointing at their own collector.
 */
export function startTelemetryFlusher(
  counters: TelemetryCounters,
  options: TelemetryFlusherOptions = {},
): () => void {
  if (!counters.enabled) return () => {};

  const endpoint = options.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT;
  const intervalMs = options.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const fetchFn = options.fetchFn ?? (typeof fetch === "function" ? fetch : undefined);
  if (!fetchFn) return () => {};

  const instanceId = crypto.randomUUID();
  let lastFlushed: TelemetrySnapshot = { messagesSent: 0, conversationsCreated: 0 };

  async function flush(): Promise<void> {
    const current = counters.snapshot();
    const delta: TelemetrySnapshot = {
      messagesSent: current.messagesSent - lastFlushed.messagesSent,
      conversationsCreated: current.conversationsCreated - lastFlushed.conversationsCreated,
    };
    if (delta.messagesSent === 0 && delta.conversationsCreated === 0) return;

    const payload: TelemetryPayload = { instanceId, version: VERSION, counters: delta };

    try {
      const response = await fetchFn!(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) lastFlushed = current;
    } catch {
      // Telemetry must never surface errors. Deltas roll into the next flush.
    }
  }

  const timer = setInterval(() => void flush(), intervalMs);
  // Never keep the host process alive for telemetry.
  if (typeof timer === "object" && "unref" in timer) timer.unref();

  return () => clearInterval(timer);
}
