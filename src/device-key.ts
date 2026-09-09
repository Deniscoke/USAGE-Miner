import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { configDir, protectString, unprotectString } from "./secrets.js";

/**
 * A per-device signing key.
 *
 * Generated once, on this machine, and never leaves it: the private half is
 * DPAPI-protected on disk, the public half is registered with USAGE. Every
 * observation the device uploads is signed with it.
 *
 * WHAT A SIGNATURE PROVES: that this observation was produced by software
 * holding this device's key -- i.e. by the paired miner on the paired machine,
 * not by somebody replaying a captured upload or a different device using a
 * copied credential.
 *
 * WHAT IT DOES NOT PROVE: that the numbers are true. The user owns the machine,
 * the key and the telemetry pipe. A signed observation of ten million tokens is
 * a signed lie if the user wanted it to be. That is why the server treats a
 * device signature as provenance, worth exactly nothing economically until an
 * authority it trusts -- its own gateway, a provider's own record -- says the
 * same thing. Device attestation is a lock on the front door of the user's own
 * house; it is not a witness.
 */

export const DEVICE_KEY_ALGORITHM = "ed25519";
export const DEVICE_SIGNATURE_VERSION = "device-sig-v1";

interface StoredKey {
  algorithm: typeof DEVICE_KEY_ALGORITHM;
  /** PKCS#8 PEM, DPAPI-protected. */
  privateKeyProtected: string;
  /** SPKI DER, base64. Plain: it is public. */
  publicKey: string;
  createdAt: string;
}

function keyPath(): string {
  return path.join(configDir(), "device-key.json");
}

export interface DeviceKey {
  publicKey: string;
  sign(payload: string): string;
}

/** Load the device key, generating one on first use. */
export async function loadDeviceKey(): Promise<DeviceKey> {
  let stored: StoredKey | null = null;
  try {
    stored = JSON.parse(await readFile(keyPath(), "utf8")) as StoredKey;
  } catch {
    stored = null;
  }

  if (!stored) {
    const pair = generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    stored = {
      algorithm: DEVICE_KEY_ALGORITHM,
      privateKeyProtected: await protectString(privatePem),
      publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      createdAt: new Date().toISOString(),
    };
    await mkdir(configDir(), { recursive: true });
    await writeFile(keyPath(), JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  const privateKey = createPrivateKey(await unprotectString(stored.privateKeyProtected));
  const publicKey = stored.publicKey;

  return {
    publicKey,
    // Ed25519 signs the message directly; there is no digest parameter.
    sign: (payload) => sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
  };
}

export async function clearDeviceKey(): Promise<void> {
  await rm(keyPath(), { force: true });
}

/** Verification is the server's job; this exists so tests can prove the pair. */
export function verifyWithPublicKey(publicKeyBase64: string, payload: string, signature: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
  return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signature, "base64"));
}
