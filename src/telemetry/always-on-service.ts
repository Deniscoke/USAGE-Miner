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
 * Observations follow exactly the path launched sessions use: normalised to the
 * schema, signed with the device key, uploaded in batches, buffered when USAGE
 * is unreachable. When nobody is signed in they are buffered and sent once
 * somebody is.
 */

export type AlwaysOnListening = "off" | "listening" | "port_in_use";

export interface AlwaysOnService {
  state(): { listening: AlwaysOnListening; eventsSinceStart: number; lastEventAt: string | null };
  /** Match the receiver to the switch: start it when on, stop it when off. */
  refresh(): Promise<void>;
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
}): AlwaysOnService {
  const port = deps.port ?? ALWAYS_ON_PORT;
  // One id per miner run: Claude Code sessions started anywhere are grouped
  // under it, which is all the schema's localSessionId needs to mean.
  const localSessionId = `always-on-${randomBytes(9).toString("base64url")}`;
  let receiver: TelemetryReceiver | null = null;
  let listening: AlwaysOnListening = "off";
  let events = 0;
  let lastEventAt: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  async function handle(records: Parameters<Parameters<typeof startTelemetryReceiver>[0]>[0]): Promise<void> {
    const observations = normalizeRecords(records, CLAUDE_CODE_MAPPING, { toolVersion: null, localSessionId });
    if (observations.length === 0) return;
    events += observations.length;
    lastEventAt = new Date().toISOString();

    const credential = await deps.loadCredential().catch(() => null);
    if (!credential) {
      await enqueue(observations);
      return;
    }
    const status = (change: Parameters<typeof updateTelemetryStatus>[2]) =>
      updateTelemetryStatus(credential.deviceId, "claude-code", change).catch(() => undefined);
    await status({ lastEventAt });

    const key = await deps.loadDeviceKey();
    const outcome = await createUploader({ serverUrl: credential.serverUrl, token: credential.token, key, upload: deps.upload }).push(observations);
    await status({
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
      listening = "listening";
      await logEvent({ event: "always_on_start", tool: "claude-code", outcome: "ok" });
    } catch (error) {
      receiver = null;
      listening = (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "port_in_use" : "off";
      await logEvent({ event: "always_on_start", tool: "claude-code", outcome: "error", detail: (error as NodeJS.ErrnoException).code ?? "start_failed" });
    }
  }

  async function stop(): Promise<void> {
    if (!receiver) {
      listening = "off";
      return;
    }
    await chain;
    await receiver.close();
    receiver = null;
    listening = "off";
  }

  return {
    state: () => ({ listening, eventsSinceStart: events, lastEventAt }),
    idle: () => chain,
    async refresh() {
      const status = await alwaysOnStatus();
      if (status.enabled && status.receiverKey) {
        if (!receiver) await start(status.receiverKey);
      } else {
        await stop();
      }
    },
    stop,
  };
}
