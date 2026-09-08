import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";

/**
 * Where the device's miner credential lives.
 *
 * A miner token lets a device route requests through USAGE as its owner. It is
 * therefore treated like a password, not like configuration:
 *
 *   Windows   encrypted with DPAPI, scoped to the current user account. Another
 *             account on the same machine cannot decrypt it, and a copied file
 *             is useless on any other machine.
 *   elsewhere refused rather than written in plaintext, until a real
 *             platform-appropriate store is implemented.
 *
 * The plaintext exists only in memory, for the duration of one request. It is
 * never printed, never logged, and never written to a config file.
 *
 * DPAPI is reached through PowerShell's ProtectedData rather than a native
 * module on purpose: a beta that needs a compiler toolchain to install is a
 * beta nobody installs.
 */

export class SecretStorageError extends Error {
  constructor(
    readonly code: "unsupported_platform" | "protect_failed" | "unprotect_failed" | "missing",
    message: string,
  ) {
    super(message);
    this.name = "SecretStorageError";
  }
}

export function configDir(): string {
  // %APPDATA%\USAGE on Windows; ~/.usage elsewhere.
  const appData = process.env.APPDATA;
  if (platform() === "win32" && appData) return path.join(appData, "USAGE");
  return path.join(homedir(), ".usage");
}

function credentialPath(): string {
  return path.join(configDir(), "credential.dpapi");
}

/**
 * Run a PowerShell snippet with no profile and no user input.
 *
 * The script is a fixed string in this file: nothing a server sends can reach
 * it, because the miner never executes anything it was told to execute.
 */
function powershell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
    // Piped, not passed as an argument: a command line is visible to other
    // processes and lands in shell history.
    child.stdin?.end(input);
  });
}

/**
 * DPAPI encrypt, CurrentUser scope.
 *
 * The secret is piped through stdin rather than passed as an argument: a
 * command line is visible to other processes and lands in shell history.
 */
const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($protected)
`.trim();

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd()
$protected = [Convert]::FromBase64String($encoded.Trim())
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, 'CurrentUser')
[System.Text.Encoding]::UTF8.GetString($bytes)
`.trim();

export interface StoredCredential {
  token: string;
  deviceId: string;
  deviceName: string;
  serverUrl: string;
}

export async function saveCredential(credential: StoredCredential): Promise<void> {
  if (platform() !== "win32") {
    throw new SecretStorageError(
      "unsupported_platform",
      "USAGE Miner only stores credentials securely on Windows in this beta. It will not write your key in plain text.",
    );
  }

  await mkdir(configDir(), { recursive: true });

  let protectedValue: string;
  try {
    protectedValue = await powershell(PROTECT_SCRIPT, JSON.stringify(credential));
  } catch {
    // Never include the underlying error: it can echo the value being protected.
    throw new SecretStorageError("protect_failed", "Windows could not protect the credential.");
  }

  await writeFile(credentialPath(), protectedValue, { encoding: "utf8", mode: 0o600 });
}

export async function loadCredential(): Promise<StoredCredential | null> {
  let stored: string;
  try {
    stored = await readFile(credentialPath(), "utf8");
  } catch {
    return null;
  }
  if (!stored.trim()) return null;

  if (platform() !== "win32") {
    throw new SecretStorageError(
      "unsupported_platform",
      "This credential was stored on Windows and cannot be read here.",
    );
  }

  try {
    const plaintext = await powershell(UNPROTECT_SCRIPT, stored);
    return JSON.parse(plaintext) as StoredCredential;
  } catch {
    // Wrong user, wrong machine, or a corrupted file. All the same to a caller:
    // this credential cannot be used, so sign in again.
    throw new SecretStorageError(
      "unprotect_failed",
      "Stored credential could not be read on this account. Sign in again.",
    );
  }
}

export async function clearCredential(): Promise<void> {
  await rm(credentialPath(), { force: true });
}

/** Whether secure storage works here at all, checked before promising anything. */
export function secureStorageAvailable(): boolean {
  return platform() === "win32";
}
