import { randomBytes } from "node:crypto";
import type { DeviceKey } from "../device-key.js";
import { logEvent } from "../log.js";
import type { StoredCredential } from "../secrets.js";
import { ALWAYS_ON_PORT, alwaysOnStatus } from "./always-on.js";
import { enqueue } from "./buffer.js";
import { CLAUDE_CODE_MAPPING } from "./mappings.js";
import { normalizeRecords } from "./observation.js";
import { startTelemetryReceiver, type TelemetryReceiver } from "./receiver.js";
import { syncOutcomeFrom, updateTelemetryStatus } from "./status.js";
import { createUploader } from "./uploader.js";

/**
 * The receiver that "measure Claude Code everywhere" points Claude Code at.
 *
 * Lives in the desktop process for as long as it runs, on the fixed loopback
 * port the settings file names. Started and stopped by `refresh()`, so turning
 * the switch on or off takes effect without restarting the miner.
 *
 * MORE THAN ONE WINDOW. Two miner windows can run at once (an npx one and an
 * installed one, say). Only one of them can hold the port; the other reports
 * "port in use". The switch is a FILE, so turning it off in one window says
 * nothing to the process that actually holds the port -- which kept receiving
 * and uploading. So every window re-reads the file on its own timer
 * (`watch()`, every WATCH_INTERVAL_MS) and closes its receiver when the file
 * says off, or opens it when the file says on and the port is free. And
 * anything received after the file says off is dropped, not uploaded, even in
 * the seconds before that window's next check.
 *
 * Observations follow exactly the path launched sessions use: normalised to the
 * schema, signed with the device key, uploaded in batches, buffered when USAGE
 * is unreachable. When nobody is signed in they are buffered and sent once
 * somebody is.
 */

/** How often every window re-reads the switch. */
export const WATCH_INTERVAL_MS = 10_000;

export type AlwaysOnListening = "off" | "listening" | "port_in_use";

export interface AlwaysOnService {
  state(): { listening: AlwaysOnListening; eventsSinceStart: number; lastEventAt: string | null };
  /** Match the receiver to the switch: start it when on, stop it when off. */
  refresh(): Promise<void>;
  /** Re-read the switch on a timer until stop(). Returns the timer's own stop. */
  watch(): () => void;
  stop(): Promise<void>;
  /** Resolves once received exports have been handled. For tests. */
  idle(): Promise<void>;
}

export function createAlwaysOnService(deps: {
  loadCredential: () => Promise<StoredCredential | null>;
  loadDeviceKey: () => Promise<DeviceKey>;
  port?: number;
  /** Test seam; defaults to the real API call. */
  upload?: Parameters<typeof createUploader>[0]["upload"];
  /** Test seams for the watch timer, as in background.ts. */
  watchIntervalMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): AlwaysOnService {
  const port = deps.port ?? ALWAYS_ON_PORT;
  // One id per miner run: Claude Code sessions started anywhere are grouped
  // under it, which is all the schema's localSessionId needs to mean.
  const localSessionId = `always-on-${randomBytes(9).toString("base64url")}`;
  let receiver: TelemetryReceiver | null = null;
  let receiverKey: string | null = null;
  let listening: AlwaysOnListening = "off";
  let events = 0;
  let lastEventAt: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  // One refresh at a time. Two at once both saw no receiver, both started one,
  // and the loser nulled the winner's handle -- a listener nothing could close.
  let refreshing: Promise<void> = Promise.resolve();
  // A busy port is retried on every check; it is logged when it changes, not
  // every ten seconds for as long as another window holds it.
  let lastStartOutcome: string | null = null;
  const watchers = new Set<() => void>();

  async function handle(records: Parameters<Parameters<typeof startTelemetryReceiver>[0]>[0]): Promise<void> {
    // The file is the switch. Turned off in another window since this one last
    // looked: receive nothing, keep nothing, upload nothing -- and close.
    const status = await alwaysOnStatus().catch(() => ({ enabled: false, receiverKey: null }));
    if (!status.enabled) {
      void service.refresh();
      return;
    }

    const observations = normalizeRecords(records, CLAUDE_CODE_MAPPING, { toolVersion: null, localSessionId });
    if (observations.length === 0) return;
    events += observations.length;
    lastEventAt = new Date().toISOString();

    const credential = await deps.loadCredential().catch(() => null);
    if (!credential) {
      await enqueue(observations);
      return;
    }
    const report = (change: Parameters<typeof updateTelemetryStatus>[2]) =>
      updateTelemetryStatus(credential.deviceId, "claude-code", change).catch(() => undefined);
    await report({ lastEventAt });

    const key = await deps.loadDeviceKey();
    const outcome = await createUploader({ serverUrl: credential.serverUrl, token: credential.token, key, upload: deps.upload }).push(observations);
    await report({
      lastSyncAt: new Date().toISOString(),
      lastSyncOutcome: syncOutcomeFrom({ result: outcome.result, errorCode: outcome.errorCode ?? null, errorStatus: outcome.errorStatus ?? null }),
      buffered: outcome.buffered,
    });
  }

  async function start(key: string): Promise<void> {
    try {
      receiver = await startTelemetryReceiver(
        (records) => {
          // Serialised, so two exports never race the buffer file.
          chain = chain.then(() => handle(records)).catch(() => undefined);
        },
        { port, headerKey: key },
      );
      receiverKey = key;
      listening = "listening";
      lastStartOutcome = "ok";
      await logEvent({ event: "always_on_start", tool: "claude-code", outcome: "ok" });
    } catch (error) {
      receiver = null;
      receiverKey = null;
      const code = (error as NodeJS.ErrnoException).code ?? "start_failed";
      listening = code === "EADDRINUSE" ? "port_in_use" : "off";
      if (lastStartOutcome !== code) {
        lastStartOutcome = code;
        await logEvent({ event: "always_on_start", tool: "claude-code", outcome: "error", detail: code });
      }
    }
  }

  async function stop(reason?: string): Promise<void> {
    if (!receiver) {
      listening = "off";
      lastStartOutcome = null;
      return;
    }
    await chain;
    await receiver.close();
    receiver = null;
    receiverKey = null;
    listening = "off";
    lastStartOutcome = null;
    if (reason) await logEvent({ event: "always_on_stop", tool: "claude-code", outcome: "ok", detail: reason });
  }

  const service: AlwaysOnService = {
    state: () => ({ listening, eventsSinceStart: events, lastEventAt }),
    idle: () => chain,
    refresh() {
      refreshing = refreshing.then(async () => {
        const status = await alwaysOnStatus();
        if (status.enabled && status.receiverKey) {
          // A different key means the switch was turned off and on again with
          // a fresh record; the old key must stop working.
          if (receiver && receiverKey !== status.receiverKey) await stop("key_changed");
          // Also retries a port that was busy last time.
          if (!receiver) await start(status.receiverKey);
        } else {
          await stop("disabled");
          listening = "off";
        }
      }).catch(() => undefined);
      return refreshing;
    },
    watch() {
      const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
        const handle = setInterval(fn, ms);
        // Never the reason a process stays alive.
        handle.unref?.();
        return handle;
      });
      const cancel = deps.cancel ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      const handle = schedule(() => void service.refresh(), deps.watchIntervalMs ?? WATCH_INTERVAL_MS);
      let stopped = false;
      const unwatch = () => {
        if (stopped) return;
        stopped = true;
        cancel(handle);
        watchers.delete(unwatch);
      };
      watchers.add(unwatch);
      return unwatch;
    },
    async stop() {
      for (const unwatch of [...watchers]) unwatch();
      await refreshing;
      await stop();
    },
  };
  return service;
}
