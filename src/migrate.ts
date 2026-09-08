import { rotateCredential } from "./api.js";
import { logEvent } from "./log.js";
import { loadCredential, saveCredential } from "./secrets.js";
import { migrateLegacyCredential } from "./tools/claude-code.js";

/**
 * Undo what an earlier build did to this machine.
 *
 * Builds before 0.3.0 routed Claude Code by writing the device's miner token
 * into `~/.claude/settings.json` in plaintext. Upgrading has to clean that up,
 * and cleaning it up is two separate obligations:
 *
 *   1. REMOVE IT from the file, restoring whatever was there before.
 *   2. ROTATE IT, because a secret that has sat in a readable file must be
 *      assumed read. Deleting it proves nothing about who saw it first.
 *
 * Doing only the first would be the more comfortable change and the wrong one.
 *
 * IDEMPOTENT AND FAIL-SAFE. On a clean machine it does nothing and says so. If
 * the cleanup fails, rotation does not happen -- rotating while the old token
 * is still in a file would replace a known-exposed credential with a
 * newly-exposed one. If rotation fails, the cleanup still stands and the device
 * keeps a working credential; the next run tries again.
 */

export interface MigrationResult {
  /** Whether anything on this machine actually needed changing. */
  changed: boolean;
  credentialRotated: boolean;
  /** Safe to show a user. Never contains a credential. */
  detail: string;
}

export async function migrateInsecureConfig(): Promise<MigrationResult> {
  const cleanup = await migrateLegacyCredential();
  if (!cleanup.migrated) {
    return { changed: false, credentialRotated: false, detail: cleanup.detail };
  }

  await logEvent({
    event: "migrate",
    tool: "claude-code",
    outcome: "ok",
    detail: cleanup.restoredFromBackup ? "restored_backup" : "removed_keys",
  });

  const credential = await loadCredential().catch(() => null);
  if (!credential) {
    // The exposed token was removed, and there is nothing here to rotate --
    // signing in again mints a fresh one anyway.
    return { changed: true, credentialRotated: false, detail: cleanup.detail };
  }

  try {
    const replacement = await rotateCredential(credential.serverUrl, credential.token);
    await saveCredential({ ...credential, token: replacement.token });
    await logEvent({ event: "rotate", outcome: "ok" });
    return {
      changed: true,
      credentialRotated: true,
      detail: `${cleanup.detail} The exposed credential has been replaced and revoked.`,
    };
  } catch (error) {
    await logEvent({ event: "rotate", outcome: "error", detail: (error as Error).message });
    return {
      changed: true,
      credentialRotated: false,
      detail: `${cleanup.detail} The old credential could not be replaced automatically — revoke this device at /miners and sign in again.`,
    };
  }
}
