import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "../secrets.js";

/**
 * What metering is doing right now, for the window to show.
 *
 * A metering session runs inside the tool's launcher process; the desktop
 * window is a different process. This small file is how one tells the other
 * -- per device and tool -- whether tracking is active, when the last event
 * was seen, and whether the last upload was accepted or why not. The reasons
 * are the server's own verdict words or a coarse category, never a token,
 * never a request id, never an observation.
 *
 * Silent failure was the M13 product bug: a user could believe mapping worked
 * while tracked usage stayed at zero. Every outcome now lands here.
 */

export type SyncOutcome =
  | "accepted"
  | "duplicate"
  | "mapping_missing"
  | "mapping_disabled"
  | "revoked_device"
  | "bad_signature"
  | "insufficient_scope"
  | "unsupported_schema"
  | "network"
  | "rejected";

export interface ToolTelemetryStatus {
  deviceId: string;
  tool: string;
  /** A session is running and its receiver is listening. */
  active: boolean;
  pid: number | null;
  sessionStartedAt: string | null;
  lastEventAt: string | null;
  eventsThisSession: number;
  lastSyncAt: string | null;
  lastSyncOutcome: SyncOutcome | null;
  /** Observations waiting in the local buffer for the server. */
  buffered: number;
}

interface StatusFile {
  version: 1;
  tools: ToolTelemetryStatus[];
}

function statusPath(): string {
  return path.join(configDir(), "telemetry-status.json");
}

export async function loadTelemetryStatus(): Promise<ToolTelemetryStatus[]> {
  try {
    const file = JSON.parse(await readFile(statusPath(), "utf8")) as StatusFile;
    return file.version === 1 && Array.isArray(file.tools) ? file.tools : [];
  } catch {
    return [];
  }
}

export async function updateTelemetryStatus(
  deviceId: string,
  tool: string,
  change: Partial<Omit<ToolTelemetryStatus, "deviceId" | "tool">>,
): Promise<ToolTelemetryStatus> {
  const all = await loadTelemetryStatus();
  const existing = all.find((s) => s.deviceId === deviceId && s.tool === tool);
  const next: ToolTelemetryStatus = {
    deviceId,
    tool,
    active: false,
    pid: null,
    sessionStartedAt: null,
    lastEventAt: null,
    eventsThisSession: 0,
    lastSyncAt: null,
    lastSyncOutcome: null,
    buffered: 0,
    ...existing,
    ...change,
  };
  const rest = all.filter((s) => !(s.deviceId === deviceId && s.tool === tool));
  await mkdir(configDir(), { recursive: true });
  const file: StatusFile = { version: 1, tools: [...rest, next] };
  await writeFile(statusPath(), JSON.stringify(file, null, 2), "utf8");
  return next;
}

/** A session that died without ending leaves `active: true` behind; a dead pid means it is over. */
export function isSessionAlive(status: ToolTelemetryStatus): boolean {
  if (!status.active || status.pid === null) return false;
  try {
    process.kill(status.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Map the server's verdict reasons and transport errors to one safe word. */
export function syncOutcomeFrom(input: {
  result: { accepted: number; duplicate: number; rejected: number; reasons?: Record<string, string> } | null;
  errorCode?: string | null;
  errorStatus?: number | null;
}): SyncOutcome {
  if (!input.result) {
    if (input.errorStatus === 0 || input.errorCode === "unreachable") return "network";
    if (input.errorCode === "revoked") return "revoked_device";
    if (input.errorCode === "insufficient_scope") return "insufficient_scope";
    if (input.errorCode === "unsupported_schema") return "unsupported_schema";
    return "network";
  }
  if (input.result.accepted > 0) return "accepted";
  if (input.result.rejected === 0 && input.result.duplicate > 0) return "duplicate";
  const reasons = Object.values(input.result.reasons ?? {});
  if (reasons.some((r) => r === "mapping_not_enabled")) return "mapping_disabled";
  if (reasons.some((r) => r === "bad_signature")) return "bad_signature";
  if (reasons.some((r) => r === "unsupported_schema")) return "unsupported_schema";
  return "rejected";
}

/** Human words for the window. Never more than the category. */
export const SYNC_COPY: Record<SyncOutcome, string> = {
  accepted: "Synced",
  duplicate: "Synced (already recorded)",
  mapping_missing: "FAILED — this device has no mapping for the app on USAGE",
  mapping_disabled: "FAILED — device mapping is off on USAGE; turn Map usage off and on to fix",
  revoked_device: "FAILED — this device was revoked; sign in again",
  bad_signature: "FAILED — device key mismatch; sign out and in again",
  insufficient_scope: "FAILED — this device's credential cannot upload usage; sign in again",
  unsupported_schema: "FAILED — USAGE Miner is out of date",
  network: "FAILED — could not reach USAGE; kept locally, will retry",
  rejected: "FAILED — USAGE rejected the upload",
};
