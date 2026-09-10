import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./secrets.js";

/**
 * Which tools the user has said USAGE may meter, on this device -- the
 * device's MEMORY of it, never the truth.
 *
 * The server's `miner_tool_mappings` row for the CURRENT paired device is
 * the authoritative mapping state. This file exists for two narrower jobs:
 * the launcher refuses to meter a tool the user never opted in, and the
 * choice survives a restart while the server is reconciled. It is keyed by
 * device id as well as tool, because a pairing is a relationship between one
 * device row and one account: when an installation re-pairs it gets a new
 * device id, and the previous device's consent must not walk across to the
 * new one. (0.4.1 keyed this by tool alone and showed "mapping ON" for a
 * device the server had never heard of. That was the bug.)
 *
 * Nothing secret lives here: tool ids, a device id, timestamps.
 */

export interface LocalMapping {
  deviceId: string;
  tool: string;
  enabledAt: string;
}

interface MappingsFileV2 {
  version: 2;
  mappings: LocalMapping[];
}

function mappingsPath(): string {
  return path.join(configDir(), "mappings.json");
}

export async function loadMappings(): Promise<LocalMapping[]> {
  try {
    const file = JSON.parse(await readFile(mappingsPath(), "utf8")) as { version?: unknown; mappings?: unknown };
    // A version-1 file carried no device id, so nothing in it can be tied to
    // the current pairing. It is ignored, not migrated: consent is re-read
    // from the server and re-asked if the server has none.
    if (file.version !== 2 || !Array.isArray(file.mappings)) return [];
    return (file.mappings as unknown[]).filter(
      (m): m is LocalMapping =>
        typeof m === "object" && m !== null &&
        typeof (m as LocalMapping).deviceId === "string" &&
        typeof (m as LocalMapping).tool === "string",
    );
  } catch {
    return [];
  }
}

export async function isMapped(deviceId: string, tool: string): Promise<boolean> {
  return (await loadMappings()).some((m) => m.deviceId === deviceId && m.tool === tool);
}

async function save(mappings: LocalMapping[]): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const file: MappingsFileV2 = { version: 2, mappings };
  await writeFile(mappingsPath(), JSON.stringify(file, null, 2), "utf8");
}

export async function setMapped(deviceId: string, tool: string, enabled: boolean): Promise<LocalMapping[]> {
  const current = (await loadMappings()).filter((m) => !(m.deviceId === deviceId && m.tool === tool));
  const next = enabled ? [...current, { deviceId, tool, enabledAt: new Date().toISOString() }] : current;
  await save(next);
  return next;
}

/**
 * Make the local memory match what the server says about THIS device.
 *
 * Called whenever the server's mapping list is fetched. Entries for other
 * device ids are left alone (they belong to other pairings and are inert);
 * entries for this device are replaced by the server's enabled set, so the
 * launcher's gate and the window's display cannot disagree with the server
 * for longer than one config fetch.
 */
export async function reconcileMappings(
  deviceId: string,
  server: readonly { tool: string; status: string; updatedAt?: string | null }[],
): Promise<LocalMapping[]> {
  const others = (await loadMappings()).filter((m) => m.deviceId !== deviceId);
  const mine = server
    .filter((m) => m.status === "enabled")
    .map((m) => ({ deviceId, tool: m.tool, enabledAt: m.updatedAt ?? new Date().toISOString() }));
  const next = [...others, ...mine];
  await save(next);
  return next;
}
