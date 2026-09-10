import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configDir } from "./secrets.js";

/**
 * Installation identity.
 *
 * A pairing credential is a relationship between one device row and one
 * account, minted when the owner approves a code. An INSTALLATION is the
 * copy of USAGE Miner on this computer, which outlives credentials: it is
 * upgraded, signed out, re-paired. Today every pairing creates a new device
 * row, so a re-pair shows up on the website as a second DESKTOP-PBL7246.
 *
 * This is the durable, random, non-secret id that lets a future pairing say
 * "I am the same installation as before" so the server can reuse the device
 * row rather than mint another. Hostname alone is not identity (two laptops
 * can share one; a rename is not a new machine). The server side -- a
 * nullable `installation_id` on `miner_devices` and a reuse rule in
 * `approve` -- is a schema change and is designed, not applied, in
 * docs/MINER.md; until then the id is sent and recorded nowhere.
 *
 * Deliberately NOT copied across accounts: reusing a device row requires
 * the same owner. A deliberate sign-out and sign-in to another account is a
 * new association.
 */
export async function installationId(): Promise<string> {
  const file = path.join(configDir(), "installation.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { installationId?: unknown };
    if (typeof parsed.installationId === "string" && /^[0-9a-f-]{36}$/.test(parsed.installationId)) {
      return parsed.installationId;
    }
  } catch {
    // First run, or unreadable: mint one below.
  }
  const id = randomUUID();
  await mkdir(configDir(), { recursive: true });
  await writeFile(file, JSON.stringify({ installationId: id, createdAt: new Date().toISOString() }, null, 2), "utf8");
  return id;
}
