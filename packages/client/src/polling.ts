/**
 * Interval poller used as the realtime fallback when SSE cannot work
 * (`docs/decisions/0016`).
 *
 * Deliberately dumb: it owns a timer and nothing else. What a tick actually
 * fetches lives in `client.ts`, because the poller must not know about
 * requesters or the cache.
 *
 * @module
 */

/** The minimum interval a caller can ask for, in milliseconds. */
export const MIN_POLL_INTERVAL_MS = 1000;

/** The default interval when `realtime.intervalMs` is omitted. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Controls one polling loop. */
export interface Poller {
  /**
   * Begin polling. Ticks immediately unless the previous tick was more recent
   * than one interval, then every `intervalMs`. Calling it while already
   * running is a no-op, so a flapping stream cannot stack timers.
   */
  start(): void;
  /** Stop polling and drop the timer. Safe to call when not running. */
  stop(): void;
  /** True between `start()` and `stop()`. */
  isRunning(): boolean;
}

/** Everything the poller needs from its host. */
export interface PollerOptions {
  intervalMs: number;
  /**
   * Runs on every tick. Must never reject - the poller has no way to report
   * an error and a rejection would take out the timer.
   */
  onTick: () => Promise<void>;
  /**
   * Injectable clock, for tests that need to assert elapsed time without
   * `Date.now()`. Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * Creates a poller.
 *
 * Two behaviours worth knowing about:
 *
 * - **Ticks never overlap.** A tick that is still in flight when the timer
 *   fires again skips that beat rather than running concurrently, so a slow
 *   network degrades the effective interval instead of queueing requests.
 * - **A hidden tab does not poll.** Where `document` exists, polling pauses on
 *   `visibilitychange` to hidden and resumes - with an immediate catch-up tick -
 *   when the tab is shown again. Without this, every background tab costs a
 *   request per interval forever.
 */
export function createPoller(options: PollerOptions): Poller {
  const now = options.now ?? Date.now;
  const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, options.intervalMs);

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let ticking = false;
  let lastTickAt = 0;
  let visibilityListener: (() => void) | null = null;

  const isHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

  const tick = (): void => {
    // A tick already in flight owns this beat. Skipping keeps a slow response
    // from stacking requests on a bad connection.
    if (ticking || isHidden()) return;
    ticking = true;
    lastTickAt = now();
    const settle = (): void => {
      ticking = false;
    };
    // Settled through both arms rather than `.finally`, which re-throws and
    // would surface a rejecting `onTick` as an unhandled rejection - noise in a
    // browser console, and fatal in Node under `--unhandled-rejections=strict`.
    void options.onTick().then(settle, settle);
  };

  const startTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(tick, intervalMs);
    // Node keeps the process alive for a pending interval; a polling client
    // must never be the reason a script refuses to exit.
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  const stopTimer = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    start() {
      if (running) return;
      running = true;
      startTimer();
      // Catch up straight away, unless a tick from a previous start() is still
      // fresh - that is what stops a stream flapping open/closed from turning
      // into a request per flap.
      if (now() - lastTickAt >= intervalMs) tick();

      if (typeof document !== "undefined" && visibilityListener === null) {
        visibilityListener = () => {
          if (!running) return;
          if (isHidden()) {
            stopTimer();
            return;
          }
          startTimer();
          tick();
        };
        document.addEventListener("visibilitychange", visibilityListener);
      }
    },
    stop() {
      running = false;
      stopTimer();
      if (visibilityListener !== null && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityListener);
        visibilityListener = null;
      }
    },
    isRunning() {
      return running;
    },
  };
}
