import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { configDir } from "../secrets.js";

/**
 * Measuring Claude Code however it was started.
 *
 * THE GAP. The miner used to see Claude Code only when it launched Claude Code
 * itself, with telemetry settings in the child's environment. Claude Code
 * started from a terminal, a shortcut or the VS Code extension sent the miner
 * nothing, which for most people is most of their usage.
 *
 * WHAT THIS DOES, AND ONLY WITH CONSENT. Claude Code reads an `env` block from
 * ~/.claude/settings.json for every session (documented at
 * code.claude.com/docs/en/monitoring-usage). Turning this on adds telemetry
 * settings there that point Claude Code's OpenTelemetry log export at a
 * receiver the running miner keeps on a fixed loopback port. Nothing else in
 * the file is touched, and turning it off removes exactly the keys it added,
 * and only if they still hold the values it wrote.
 *
 * WHAT IS WRITTEN IS NOT A USAGE CREDENTIAL. No miner token, route session or
 * provider key goes into the file -- routing stays launch-only. The one value
 * that looks like a secret is the header that lets the local receiver tell
 * Claude Code apart from a web page. It is readable by any program running as
 * this user, which is exactly the set of programs that could already forge
 * local telemetry some other way; and local telemetry is displayed, never
 * rewarded, so the worst a forger achieves is a wrong number on their own
 * screen. The per-session launch path, with its fresh secret, is unchanged.
 *
 * PRIVACY. The prompt, response, tool detail and raw body switches are written
 * as "0" explicitly. Defaults are things that change in release notes.
 *
 * WHEN THE MINER IS NOT RUNNING, Claude Code's exports go nowhere and that
 * usage is not measured. That is acceptable for figures that are display-only.
 */

/** Loopback only, and chosen outside the ranges Windows hands out at random. */
export const ALWAYS_ON_PORT = 47823;
export const ALWAYS_ON_HEADER = "X-Usage-Miner";

interface AlwaysOnState {
  version: 1;
  enabled: boolean;
  /** Sent by Claude Code in ALWAYS_ON_HEADER; see the module note on what it is and is not. */
  receiverKey: string;
  /** The exact values written, so disabling removes only what is still ours. */
  written: Record<string, string>;
  enabledAt: string | null;
}

type ClaudeSettings = Record<string, unknown> & { env?: Record<string, unknown> };

function claudeSettingsPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "settings.json");
}

function statePath(): string {
  return path.join(configDir(), "always-on.json");
}

async function readState(): Promise<AlwaysOnState | null> {
  try {
    const state = JSON.parse(await readFile(statePath(), "utf8")) as AlwaysOnState;
    return state.version === 1 && typeof state.receiverKey === "string" ? state : null;
  } catch {
    return null;
  }
}

async function writeState(state: AlwaysOnState): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(statePath(), JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** The environment Claude Code is given. Pure, so the exact keys are testable. */
export function alwaysOnClaudeEnv(receiverKey: string, port: number = ALWAYS_ON_PORT): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_TRACES_EXPORTER: "none",
    // Per-signal names, so a user's own collector configured through the
    // generic OTEL_EXPORTER_OTLP_* variables is left alone for other signals.
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `${ALWAYS_ON_HEADER}=${receiverKey}`,
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_LOG_ASSISTANT_RESPONSES: "0",
    OTEL_LOG_TOOL_DETAILS: "0",
    OTEL_LOG_TOOL_CONTENT: "0",
    OTEL_LOG_RAW_API_BODIES: "0",
  };
}

/** Keys that, if the user set them to something else, mean their telemetry already goes somewhere. */
const CONFLICTING = ["OTEL_LOGS_EXPORTER", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"];

export type AlwaysOnResult =
  | { ok: true; changed: boolean; message: string }
  | { ok: false; reason: "settings_unreadable" | "conflict"; message: string };

export async function alwaysOnStatus(): Promise<{ enabled: boolean; receiverKey: string | null }> {
  const state = await readState();
  return { enabled: state?.enabled === true, receiverKey: state?.enabled ? state.receiverKey : null };
}

export async function enableAlwaysOn(options: { force?: boolean } = {}): Promise<AlwaysOnResult> {
  let settings: ClaudeSettings = {};
  let raw = "";
  try {
    raw = await readFile(claudeSettingsPath(), "utf8");
    settings = raw.trim() ? (JSON.parse(raw) as ClaudeSettings) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Malformed JSON is the user's file in a state we do not understand.
      return { ok: false, reason: "settings_unreadable", message: "Claude Code's settings.json could not be read, so it was left untouched." };
    }
  }

  const previous = await readState();
  const receiverKey = previous?.receiverKey ?? randomBytes(24).toString("base64url");
  const wanted = alwaysOnClaudeEnv(receiverKey);
  const env = { ...((settings.env ?? {}) as Record<string, unknown>) };

  if (!options.force) {
    const theirs = CONFLICTING.filter((key) => {
      const value = env[key];
      return typeof value === "string" && value !== "" && value !== wanted[key] && value !== previous?.written[key];
    });
    if (theirs.length > 0) {
      return {
        ok: false,
        reason: "conflict",
        message: `Claude Code already sends its telemetry elsewhere (${theirs.join(", ")}). Nothing was changed.`,
      };
    }
  }

  const next: ClaudeSettings = { ...settings, env: { ...env, ...wanted } };
  await mkdir(path.dirname(claudeSettingsPath()), { recursive: true });
  // Kept once, the first time, so a person can always see what was there.
  if (!previous && raw) {
    await writeFile(path.join(configDir(), "claude-settings-before-always-on.json"), raw, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
  }
  await writeFile(claudeSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await writeState({ version: 1, enabled: true, receiverKey, written: wanted, enabledAt: new Date().toISOString() });
  return { ok: true, changed: true, message: "Claude Code sessions started anywhere on this PC are now measured while USAGE Miner runs." };
}

export async function disableAlwaysOn(): Promise<AlwaysOnResult> {
  const state = await readState();
  if (!state?.enabled) return { ok: true, changed: false, message: "It was not on." };

  let settings: ClaudeSettings | null = null;
  try {
    const raw = await readFile(claudeSettingsPath(), "utf8");
    settings = raw.trim() ? (JSON.parse(raw) as ClaudeSettings) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: "settings_unreadable", message: "Claude Code's settings.json could not be read, so it was left untouched." };
    }
  }

  if (settings) {
    const env = { ...((settings.env ?? {}) as Record<string, unknown>) };
    // Only what is still exactly ours. A key the user has since changed is theirs now.
    for (const [key, value] of Object.entries(state.written)) {
      if (env[key] === value) delete env[key];
    }
    const next: ClaudeSettings = { ...settings };
    if (Object.keys(env).length > 0) next.env = env;
    else delete next.env;
    await writeFile(claudeSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  await writeState({ ...state, enabled: false, enabledAt: null });
  return { ok: true, changed: true, message: "Claude Code's settings are back to what they were." };
}
