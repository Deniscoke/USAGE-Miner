import { randomBytes } from "node:crypto";
import type { LocalToolAdapter } from "../tools/adapter.js";
import type { DeviceKey } from "../device-key.js";
import { logEvent } from "../log.js";
import { MAPPINGS } from "./mappings.js";
import { normalizeRecords, type LocalUsageObservation } from "./observation.js";
import { startTelemetryReceiver, type TelemetryReceiver } from "./receiver.js";
import { createUploader } from "./uploader.js";

/**
 * One metered tool session, start to finish.
 *
 *   receiver up -> tool launched with telemetry pointed at it ->
 *   records flattened -> allowlisted into observations -> signed -> uploaded
 *   (or buffered) -> receiver down when the tool exits
 *
 * The session is the unit of everything local: its receiver secret, its
 * localSessionId, its uploader's backoff state. When it ends, nothing of it
 * remains in memory, and nothing of it was ever on disk except the encrypted
 * buffer of observations still waiting for the server.
 */

export interface MeteringSession {
  receiver: TelemetryReceiver;
  localSessionId: string;
  /** Observations produced so far. Counts only; the list is for the UI. */
  observations: LocalUsageObservation[];
  /** Flush what remains and shut the receiver. */
  end(): Promise<{ observed: number; uploaded: number; buffered: number }>;
}

export async function startMeteringSession(input: {
  adapter: LocalToolAdapter;
  toolVersion: string | null;
  serverUrl: string;
  token: string;
  key: DeviceKey;
  onObservation?: (observation: LocalUsageObservation) => void;
}): Promise<MeteringSession> {
  const mapping = MAPPINGS[input.adapter.id];
  if (!mapping) throw new Error(`no telemetry mapping for ${input.adapter.id}`);

  const localSessionId = randomBytes(12).toString("base64url");
  const observations: LocalUsageObservation[] = [];
  const uploader = createUploader({ serverUrl: input.serverUrl, token: input.token, key: input.key });

  let uploaded = 0;
  let buffered = 0;
  let inFlight: Promise<void> = Promise.resolve();

  const receiver = await startTelemetryReceiver((records) => {
    const fresh = normalizeRecords(records, mapping, { toolVersion: input.toolVersion, localSessionId });
    if (fresh.length === 0) return;
    observations.push(...fresh);
    for (const observation of fresh) input.onObservation?.(observation);

    // Serialised so batches never race the buffer file.
    inFlight = inFlight.then(async () => {
      const outcome = await uploader.push(fresh);
      uploaded += outcome.uploaded;
      buffered = outcome.buffered;
    });
  });

  await logEvent({ event: "metering_start", tool: input.adapter.id, outcome: "ok" });

  return {
    receiver,
    localSessionId,
    observations,
    async end() {
      await inFlight;
      // One more try for anything the network refused during the session.
      const flushed = await uploader.flush();
      uploaded += flushed.uploaded;
      buffered = flushed.buffered;
      await receiver.close();
      await logEvent({
        event: "metering_end",
        tool: input.adapter.id,
        outcome: "ok",
        detail: `observed=${observations.length} uploaded=${uploaded} buffered=${buffered} rejected_requests=${receiver.stats.rejected}`,
      });
      return { observed: observations.length, uploaded, buffered };
    },
  };
}
