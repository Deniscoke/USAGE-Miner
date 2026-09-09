import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { configDir, protectString, unprotectString } from "../secrets.js";
import { stripToSchema, type LocalUsageObservation } from "./observation.js";

/**
 * Observations waiting to be uploaded.
 *
 * Usually empty: a session uploads as it goes. It fills when USAGE is
 * unreachable, so a flaky connection does not silently lose a day of usage.
 *
 * Bounded in every dimension a user would care about:
 *   * SIZE     at most BUFFER_LIMITS.maxObservations; the oldest are dropped
 *   * AGE      anything older than maxAgeMs is discarded unsent
 *   * CONTENT  observations only, run through stripToSchema on the way in,
 *              so the buffer is structurally incapable of holding content
 *   * ACCESS   DPAPI-protected; readable by this Windows account only
 *
 * A dropped observation is a dropped observation. It was never economically
 * meaningful on its own (nothing local is), so losing it costs the user a line
 * on a dashboard, not a reward. That trade is made deliberately in favour of
 * "this file cannot grow without limit".
 */

export const BUFFER_LIMITS = {
  maxObservations: 2000,
  maxAgeMs: 72 * 60 * 60 * 1000,
} as const;

interface BufferFile {
  version: 1;
  observations: LocalUsageObservation[];
}

function bufferPath(): string {
  return path.join(configDir(), "telemetry-buffer.dpapi");
}

async function readBuffer(): Promise<LocalUsageObservation[]> {
  let raw: string;
  try {
    raw = await readFile(bufferPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const file = JSON.parse(await unprotectString(raw)) as BufferFile;
    return Array.isArray(file.observations) ? file.observations : [];
  } catch {
    // Unreadable (another account, corrupted): not worth salvaging.
    return [];
  }
}

async function writeBuffer(observations: LocalUsageObservation[]): Promise<void> {
  if (observations.length === 0) {
    await rm(bufferPath(), { force: true });
    return;
  }
  const file: BufferFile = { version: 1, observations };
  await mkdir(configDir(), { recursive: true });
  await writeFile(bufferPath(), await protectString(JSON.stringify(file)), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function fresh(observation: LocalUsageObservation, now: number): boolean {
  const at = Date.parse(observation.occurredAt);
  return Number.isFinite(at) && now - at <= BUFFER_LIMITS.maxAgeMs;
}

/** Add observations, enforcing every limit. Returns how many are now waiting. */
export async function enqueue(
  observations: readonly LocalUsageObservation[],
  now = Date.now(),
): Promise<number> {
  const existing = await readBuffer();
  const merged = [...existing, ...observations.map((o) => stripToSchema(o as unknown as Record<string, unknown>))]
    .filter((o) => fresh(o, now));
  const kept = merged.slice(-BUFFER_LIMITS.maxObservations);
  await writeBuffer(kept);
  return kept.length;
}

/** Everything waiting, oldest first. Does not remove anything. */
export async function pending(now = Date.now()): Promise<LocalUsageObservation[]> {
  return (await readBuffer()).filter((o) => fresh(o, now));
}

/** Remove observations that were accepted (or permanently rejected) upstream. */
export async function acknowledge(localEventIds: readonly string[]): Promise<void> {
  const done = new Set(localEventIds);
  const remaining = (await readBuffer()).filter((o) => !done.has(o.localEventId));
  await writeBuffer(remaining);
}

export async function clearBuffer(): Promise<void> {
  await rm(bufferPath(), { force: true });
}
