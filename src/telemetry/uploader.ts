import { uploadTelemetry, type TelemetryUploadResult } from "../api.js";
import type { DeviceKey } from "../device-key.js";
import { logEvent } from "../log.js";
import { DEVICE_SIGNATURE_VERSION } from "../device-key.js";
import { acknowledge, enqueue, pending } from "./buffer.js";
import { stripToSchema, type LocalUsageObservation } from "./observation.js";

/**
 * Getting observations to USAGE, and nothing else.
 *
 * Order of operations for each batch:
 *   1. strip every observation to the schema (belt and braces),
 *   2. sign each one with the device key,
 *   3. upload; on success acknowledge, on failure buffer and back off.
 *
 * The device signature covers a canonical serialization of the observation,
 * so the server can check that what arrived is what this device produced --
 * and so a server that does not yet know this device's key can simply store
 * the signature and verify it later.
 */

export interface SignedObservation {
  observation: LocalUsageObservation;
  signature: { version: typeof DEVICE_SIGNATURE_VERSION; value: string };
}

/**
 * Deterministic serialization for signing: keys in schema order, no
 * whitespace. Server and device must agree on this byte for byte, which is why
 * it is a fixed key list rather than "whatever JSON.stringify does".
 */
export function canonicalObservation(observation: LocalUsageObservation): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(observation).sort()) {
    ordered[key] = observation[key as keyof LocalUsageObservation];
  }
  return JSON.stringify(ordered);
}

export function signObservations(
  observations: readonly LocalUsageObservation[],
  key: DeviceKey,
): SignedObservation[] {
  return observations.map((raw) => {
    const observation = stripToSchema(raw as unknown as Record<string, unknown>);
    return {
      observation,
      signature: { version: DEVICE_SIGNATURE_VERSION, value: key.sign(canonicalObservation(observation)) },
    };
  });
}

export interface UploadOutcome {
  uploaded: number;
  buffered: number;
  result: TelemetryUploadResult | null;
}

/** Retry schedule when the server is unreachable. Seconds. */
const BACKOFF_STEPS = [5, 15, 60, 300];

export function createUploader(input: {
  serverUrl: string;
  token: string;
  key: DeviceKey;
  now?: () => number;
}) {
  const now = input.now ?? (() => Date.now());
  let failures = 0;
  let notBefore = 0;

  async function attempt(observations: readonly LocalUsageObservation[]): Promise<UploadOutcome> {
    if (observations.length === 0) return { uploaded: 0, buffered: 0, result: null };

    if (now() < notBefore) {
      const buffered = await enqueue(observations, now());
      return { uploaded: 0, buffered, result: null };
    }

    try {
      const result = await uploadTelemetry(
        input.serverUrl,
        input.token,
        signObservations(observations, input.key),
      );
      failures = 0;
      notBefore = 0;
      await acknowledge(observations.map((o) => o.localEventId));
      await logEvent({
        event: "telemetry_upload",
        outcome: "ok",
        detail: `accepted=${result.accepted} duplicate=${result.duplicate} rejected=${result.rejected}`,
      });
      return { uploaded: observations.length, buffered: 0, result };
    } catch (error) {
      failures += 1;
      const step = BACKOFF_STEPS[Math.min(failures, BACKOFF_STEPS.length) - 1];
      notBefore = now() + step * 1000;
      const buffered = await enqueue(observations, now());
      await logEvent({
        event: "telemetry_upload",
        outcome: "unreachable",
        detail: `buffered=${buffered} retry_in=${step}s reason=${(error as Error).name}`,
      });
      return { uploaded: 0, buffered, result: null };
    }
  }

  return {
    /** Upload new observations plus anything still buffered from before. */
    async push(observations: readonly LocalUsageObservation[]): Promise<UploadOutcome> {
      const waiting = await pending(now());
      const seen = new Set(waiting.map((o) => o.localEventId));
      const batch = [...waiting, ...observations.filter((o) => !seen.has(o.localEventId))];
      return attempt(batch);
    },
    /** Try to drain the buffer alone -- at startup, and at session end. */
    async flush(): Promise<UploadOutcome> {
      return attempt(await pending(now()));
    },
  };
}
