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
  /** Transport/API error code when the attempt failed, e.g. "unreachable", "revoked". */
  errorCode?: string | null;
  errorStatus?: number | null;
  uploaded: number;
  buffered: number;
  result: TelemetryUploadResult | null;
}

/** Retry schedule when the server is unreachable. Seconds. */
const BACKOFF_STEPS = [5, 15, 60, 300];

/**
 * Observations per request.
 *
 * The server accepts at most 200 per batch and 256 KB per body. The uploader
 * used to send the whole buffer in one request -- up to 2,000 after an offline
 * stretch -- which the server refused, which put them all back in the buffer,
 * which made the next attempt identical. After any outage longer than a couple
 * of hundred requests, syncing stopped for good and the window called it a
 * network problem. A hundred at a time leaves room for signatures under both
 * limits.
 */
export const MAX_UPLOAD_BATCH = 100;

/**
 * Too big to accept, which a smaller batch fixes.
 *
 * Only this. The server reports a bad single observation inside a 200, as
 * `rejected`; its 400s and 422s are about the whole request -- a schema it no
 * longer accepts, a proxy or captive portal answering for it. Halving on those
 * reached every item and dropped each one, which wiped a whole buffer of good
 * observations on one bad answer.
 */
function isTooLarge(status: number | null): boolean {
  return status === 413;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function addResults(total: TelemetryUploadResult | null, next: TelemetryUploadResult): TelemetryUploadResult {
  if (!total) return { ...next };
  return {
    accepted: total.accepted + next.accepted,
    duplicate: total.duplicate + next.duplicate,
    rejected: total.rejected + next.rejected,
    verdicts: { ...(total.verdicts ?? {}), ...(next.verdicts ?? {}) },
    reasons: { ...(total.reasons ?? {}), ...(next.reasons ?? {}) },
  };
}

export function createUploader(input: {
  serverUrl: string;
  token: string;
  key: DeviceKey;
  now?: () => number;
  /** Test seam; defaults to the real API call. */
  upload?: typeof uploadTelemetry;
}) {
  const now = input.now ?? (() => Date.now());
  const upload = input.upload ?? uploadTelemetry;
  let failures = 0;
  let notBefore = 0;

  async function attempt(observations: readonly LocalUsageObservation[]): Promise<UploadOutcome> {
    if (observations.length === 0) return { uploaded: 0, buffered: 0, result: null };

    if (now() < notBefore) {
      const buffered = await enqueue(observations, now());
      return { uploaded: 0, buffered, result: null };
    }

    const queue = chunks(observations, MAX_UPLOAD_BATCH);
    let uploaded = 0;
    let dropped = 0;
    let total: TelemetryUploadResult | null = null;

    for (let i = 0; i < queue.length; i += 1) {
      const batch = queue[i]!;
      try {
        const result = await upload(input.serverUrl, input.token, signObservations(batch, input.key));
        await acknowledge(batch.map((o) => o.localEventId));
        uploaded += batch.length;
        total = addResults(total, result);
      } catch (error) {
        const code = (error as { code?: string }).code ?? null;
        const status = (error as { status?: number }).status ?? null;

        if (isTooLarge(status)) {
          // Halve until it fits. A single observation still too large for
          // the server is dropped: it can never be sent, and keeping it would
          // block everything queued behind it forever.
          if (batch.length > 1) {
            const half = Math.ceil(batch.length / 2);
            queue.splice(i + 1, 0, batch.slice(0, half), batch.slice(half));
            continue;
          }
          await acknowledge([batch[0]!.localEventId]);
          dropped += 1;
          await logEvent({
            event: "telemetry_upload",
            outcome: "error",
            detail: `rejected_permanently status=${status} reason=${code ?? "unknown"}`,
          });
          continue;
        }

        // Unreachable, rate limited, server error, or this device is no longer
        // allowed: keep this batch and everything after it, and back off.
        failures += 1;
        const step = BACKOFF_STEPS[Math.min(failures, BACKOFF_STEPS.length) - 1]!;
        notBefore = now() + step * 1000;
        const buffered = await enqueue(queue.slice(i).flat(), now());
        await logEvent({
          event: "telemetry_upload",
          outcome: status === 401 || status === 403 ? "unauthenticated" : status === 429 ? "rate_limited" : "unreachable",
          detail: `uploaded=${uploaded} buffered=${buffered} retry_in=${step}s reason=${code ?? (error as Error).name}`,
        });
        return { uploaded, buffered, result: null, errorCode: code, errorStatus: status };
      }
    }

    failures = 0;
    notBefore = 0;
    await logEvent({
      event: "telemetry_upload",
      outcome: "ok",
      detail: `batches=${queue.length} accepted=${total?.accepted ?? 0} duplicate=${total?.duplicate ?? 0} rejected=${total?.rejected ?? 0} dropped=${dropped}`,
    });
    return { uploaded, buffered: 0, result: total };
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
