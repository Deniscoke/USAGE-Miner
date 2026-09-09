import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./secrets.js";

/**
 * Which tools the user has said USAGE may meter, on this device.
 *
 * Local state only, and deliberately boring: tool ids and timestamps, in a
 * plain JSON file, nothing secret. The server holds the authoritative copy
 * (`miner_tool_mappings`); this is the device's memory of what it asked for,
 * so the choice survives a restart and so the launcher can refuse to meter a
 * tool the user never opted in.
 *
 * Opt-in is per tool and explicit. "Detected" never implies "enabled".
 */

export interface LocalMapping {
  tool: string;
  enabledAt: string;
}

interface MappingsFile {
  version: 1;
  mappings: LocalMapping[];
}

function mappingsPath(): string {
  return path.join(configDir(), "mappings.json");
}

export async function loadMappings(): Promise<LocalMapping[]> {
  try {
    const file = JSON.parse(await readFile(mappingsPath(), "utf8")) as MappingsFile;
    return Array.isArray(file.mappings) ? file.mappings : [];
  } catch {
    return [];
  }
}

export async function isMapped(tool: string): Promise<boolean> {
  return (await loadMappings()).some((m) => m.tool === tool);
}

async function save(mappings: LocalMapping[]): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const file: MappingsFile = { version: 1, mappings };
  await writeFile(mappingsPath(), JSON.stringify(file, null, 2), "utf8");
}

export async function setMapped(tool: string, enabled: boolean): Promise<LocalMapping[]> {
  const current = (await loadMappings()).filter((m) => m.tool !== tool);
  const next = enabled ? [...current, { tool, enabledAt: new Date().toISOString() }] : current;
  await save(next);
  return next;
}
