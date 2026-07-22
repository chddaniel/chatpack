/**
 * Anonymous telemetry counters (MVP §12).
 *
 * v0 (M1) ships only the **seam**: in-process counters incremented after
 * successful domain actions. The flusher that periodically POSTs aggregates
 * to the Chatpack telemetry endpoint lands in launch polish (M5) — this
 * module exists now so the hooks don't have to be retrofitted into a
 * published API later.
 *
 * Guarantees (see docs/MVP.md §12):
 *
 * - **Anonymous aggregates only** — counts, never content or identifiers.
 * - **Opt-out** — `telemetry: false` in config or `CHATPACK_TELEMETRY=0`.
 * - **Never on the hot path** — incrementing is a synchronous integer add;
 *   flushing (later) is fire-and-forget.
 *
 * @module
 */

/** Names of the aggregate counters Chatpack tracks. */
export type TelemetryCounterName = "messagesSent" | "conversationsCreated";

/** A snapshot of the current in-process counter values. */
export type TelemetrySnapshot = Record<TelemetryCounterName, number>;

/**
 * In-process telemetry counters.
 *
 * Created internally by `chatpack()`; exposed on the instance as
 * `chat.telemetry` so deployments (and later the M5 flusher) can read
 * aggregates. When disabled, all operations are no-ops.
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
