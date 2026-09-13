/**
 * Work the miner does while it runs, whether or not anyone is looking.
 *
 * WHY THIS EXISTS. The heartbeat and the buffer flush used to happen only
 * inside the code that answers the desktop page's poll. So "online" meant "a
 * browser tab is open and polling": minimise the tab, let the browser throttle
 * it, or close it with the miner still running, and USAGE saw the computer go
 * silent. Buffered telemetry waited for the next launched session to happen to
 * produce an event. Both now run on a timer inside the Node process itself.
 *
 * One tick at a time: a slow network must not stack ticks on top of each other,
 * so a tick that is still running when the next is due is skipped, not queued.
 */

export const BACKGROUND_TICK_MS = 60_000;

export interface BackgroundLoop {
  stop(): void;
  /** Resolves when the tick currently running (if any) finishes. For tests. */
  idle(): Promise<void>;
}

export function startBackgroundLoop(input: {
  tick: () => Promise<void>;
  intervalMs?: number;
  schedule?: (fn: () => void, ms: number) => { unref?: () => void } | number;
  cancel?: (handle: unknown) => void;
}): BackgroundLoop {
  const intervalMs = input.intervalMs ?? BACKGROUND_TICK_MS;
  const schedule = input.schedule ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const cancel = input.cancel ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  let running: Promise<void> | null = null;
  let stopped = false;

  const run = () => {
    if (stopped || running) return;
    running = input
      .tick()
      // A tick never takes the process down; the next one simply tries again.
      .catch(() => undefined)
      .finally(() => {
        running = null;
      });
  };

  // Once straight away: a miner that has just been started should say so now,
  // not a minute from now.
  run();
  const handle = schedule(run, intervalMs);

  return {
    stop() {
      stopped = true;
      cancel(handle);
    },
    async idle() {
      if (running) await running;
    },
  };
}
