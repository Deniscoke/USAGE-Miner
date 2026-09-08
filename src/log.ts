import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./secrets.js";
import { VERSION } from "./version.js";

/**
 * Local logging.
 *
 * WHAT MAY BE LOGGED: a timestamp, which tool adapter acted, a safe outcome
 * code, and the app version.
 *
 * WHAT MAY NEVER BE LOGGED: the miner token, an Authorization header, a
 * provider credential, a prompt, a response, source code, or a tool payload.
 *
 * Enforced by an allowlist rather than by discipline: a caller passing an extra
 * field simply has it dropped. The miner also never reads a prompt in the first
 * place -- it configures routing and gets out of the way.
 */

export type LogOutcome =
  | "ok"
  | "unauthenticated"
  | "unreachable"
  | "rate_limited"
  | "config_conflict"
  | "config_unreadable"
  | "not_installed"
  | "error";

export interface LogFields {
  event: string;
  tool?: string;
  outcome: LogOutcome;
  detail?: string;
}

const ALLOWED_FIELDS = ["event", "tool", "outcome", "detail"] as const;

/**
 * A last line of defence: even `detail` is scrubbed of anything token-shaped,
 * so a message assembled somewhere else cannot leak a credential into a file
 * the user might paste into a bug report.
 */
function scrub(value: string): string {
  return value
    .replace(/usgm_[A-Za-z0-9_-]+/g, "usgm_[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

export function logPath(): string {
  return path.join(configDir(), "miner.log");
}

export async function logEvent(fields: LogFields): Promise<void> {
  const line: Record<string, unknown> = {
    at: new Date().toISOString(),
    version: VERSION,
  };
  for (const field of ALLOWED_FIELDS) {
    const value = fields[field];
    if (value === undefined) continue;
    line[field] = typeof value === "string" ? scrub(value) : value;
  }

  try {
    await mkdir(configDir(), { recursive: true });
    await appendFile(logPath(), `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // Logging must never be the reason a command fails.
  }
}

export { scrub as scrubForLog };
