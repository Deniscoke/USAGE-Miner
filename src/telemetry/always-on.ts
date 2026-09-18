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
 *
 * WHAT "OFF" MEANS. Claude Code reads settings.json when a session starts, so:
 *
 *   * a session started after OFF gets no USAGE telemetry settings at all;
 *   * a session started while it was ON keeps the settings it read, and keeps
 *     exporting to 127.0.0.1:47823 until it is restarted. USAGE never kills a
 *     Claude Code process -- it is the user's work;
 *   * every running miner window watches always-on.json and closes its
 *     receiver when it says off (always-on-service.ts), and a window drops
 *     anything it receives once the file says off. Those exports then meet a
 *     closed port: the connection is refused, Claude Code's exporter gives up
 *     on that batch, and nothing is received, buffered or uploaded.
 *
 * Both switches read the files back afterwards (verifyAlwaysOn) and report
 * failure if they do not say what was asked for.
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
  /** What each of those keys held before, or null if absent, so disabling can put it back. */
  previous?: Record<string, string | null>;
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
    // Metrics and traces are not written at all. Setting them to "none" broke a
    // user's own metrics or traces pipeline, and Claude Code exports neither
    // unless an exporter is named.
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

/**
 * Why a switch did not take. Safe to log: a code, never a value from the file.
 *
 *   settings_unreadable  settings.json is not a JSON object we understand
 *   conflict             the user's telemetry already goes somewhere else
 *   not_applied          the write was made, and reading it back says it did
 *                        not hold (see verifyAlwaysOn)
 *   write_failed         the file system refused the write (EPERM, EBUSY, ...)
 */
export type AlwaysOnFailure = "settings_unreadable" | "conflict" | "not_applied" | "write_failed";

export type AlwaysOnResult =
  | { ok: true; changed: boolean; message: string }
  | { ok: false; reason: AlwaysOnFailure; message: string; /** A safe code, for the log. */ detail?: string };

export async function alwaysOnStatus(): Promise<{ enabled: boolean; receiverKey: string | null }> {
  const state = await readState();
  return { enabled: state?.enabled === true, receiverKey: state?.enabled ? state.receiverKey : null };
}

const UNREADABLE = "Claude Code's settings.json could not be read, so it was left untouched.";

/**
 * settings.json as an object, `{}` when it does not exist, or null when it is
 * something we do not understand -- malformed JSON, or JSON that is not an
 * object. A null is never written over.
 */
async function readClaudeSettings(): Promise<{ settings: ClaudeSettings; raw: string } | null> {
  let raw: string;
  try {
    raw = await readFile(claudeSettingsPath(), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { settings: {}, raw: "" } : null;
  }
  if (!raw.trim()) return { settings: {}, raw };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const settings = parsed as ClaudeSettings;
    if (settings.env !== undefined && (!settings.env || typeof settings.env !== "object" || Array.isArray(settings.env))) return null;
    return { settings, raw };
  } catch {
    return null;
  }
}

/**
 * The keys in settings.json that are still exactly what USAGE wrote, and that
 * held something else (or nothing) before. A key whose earlier value happens
 * to equal ours -- the user already had CLAUDE_CODE_ENABLE_TELEMETRY=1 -- is
 * theirs, and is not counted.
 */
function usageOwnedKeys(env: Record<string, unknown>, state: AlwaysOnState): string[] {
  return Object.entries(state.written)
    .filter(([key, value]) => env[key] === value && (state.previous?.[key] ?? null) !== value)
    .map(([key]) => key);
}

export type AlwaysOnVerification =
  | { ok: true }
  | {
      ok: false;
      /** Safe to log; never a key's value. */
      reason: "state_not_enabled" | "state_still_enabled" | "keys_missing" | "keys_remaining" | "settings_unreadable";
      keys: string[];
    };

/**
 * Read both files back and say whether the switch is really in the position
 * asked for. The files are the truth -- not the function that wrote them, and
 * not what a window last rendered.
 *
 *   on   always-on.json says enabled, and every key USAGE writes is present in
 *        settings.json with exactly the value it wrote.
 *   off  always-on.json does not say enabled, and no key in settings.json still
 *        holds a value only USAGE would have put there.
 */
export async function verifyAlwaysOn(expected: "on" | "off"): Promise<AlwaysOnVerification> {
  const state = await readState();
  const current = await readClaudeSettings();
  if (!current) return { ok: false, reason: "settings_unreadable", keys: [] };
  const env = (current.settings.env ?? {}) as Record<string, unknown>;

  if (expected === "on") {
    if (!state?.enabled) return { ok: false, reason: "state_not_enabled", keys: [] };
    const missing = Object.entries(state.written).filter(([key, value]) => env[key] !== value).map(([key]) => key);
    return missing.length > 0 ? { ok: false, reason: "keys_missing", keys: missing } : { ok: true };
  }

  if (state?.enabled) return { ok: false, reason: "state_still_enabled", keys: [] };
  const remaining = state ? usageOwnedKeys(env, state) : [];
  return remaining.length > 0 ? { ok: false, reason: "keys_remaining", keys: remaining } : { ok: true };
}

function writeFailure(error: unknown): AlwaysOnResult {
  const code = (error as NodeJS.ErrnoException).code ?? "unknown";
  return {
    ok: false,
    reason: "write_failed",
    detail: code,
    message: `Claude Code's settings.json could not be written (${code}). If Claude Code or an editor has it open, close it and try again.`,
  };
}

export async function enableAlwaysOn(options: { force?: boolean } = {}): Promise<AlwaysOnResult> {
  const current = await readClaudeSettings();
  // Malformed JSON is the user's file in a state we do not understand.
  if (!current) return { ok: false, reason: "settings_unreadable", message: UNREADABLE };
  const { settings, raw } = current;

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

  // What each key held before this switch touched it. Kept from the first
  // enable, so turning it on twice does not record our own values as theirs.
  const previousValues: Record<string, string | null> = previous?.enabled && previous.previous
    ? previous.previous
    : Object.fromEntries(Object.keys(wanted).map((key) => [key, typeof env[key] === "string" ? (env[key] as string) : null]));

  const next: ClaudeSettings = { ...settings, env: { ...env, ...wanted } };
  const nextState: AlwaysOnState = { version: 1, enabled: true, receiverKey, written: wanted, previous: previousValues, enabledAt: new Date().toISOString() };
  try {
    await mkdir(path.dirname(claudeSettingsPath()), { recursive: true });
    // Kept once, the first time, so a person can always see what was there.
    if (!previous && raw) {
      await writeFile(path.join(configDir(), "claude-settings-before-always-on.json"), raw, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
    }
    // The record of what is about to be written goes down FIRST. If the
    // settings write then fails, the record still says which values are ours,
    // so turning it off can find them; the reverse order could leave keys in
    // settings.json that no record claims.
    await writeState(nextState);
    try {
      await writeFile(claudeSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    } catch (error) {
      // Nothing was written to settings.json; put the record back.
      await writeState(previous ?? { ...nextState, enabled: false, enabledAt: null }).catch(() => undefined);
      return writeFailure(error);
    }
  } catch (error) {
    return writeFailure(error);
  }

  const check = await verifyAlwaysOn("on");
  if (!check.ok) {
    return { ok: false, reason: "not_applied", detail: check.reason, message: "Measure everywhere did not take: Claude Code's settings.json does not hold what was written. Try again." };
  }
  return { ok: true, changed: true, message: "Claude Code sessions started anywhere on this PC are now measured while USAGE Miner runs." };
}

/**
 * Turn it off, and prove it.
 *
 * Only what is still exactly ours is touched. A key the user has since changed
 * is theirs and stays; a key that is still ours goes back to what it held
 * before, or away if it held nothing. Nothing else in the file changes.
 *
 * Off when already off is a no-op that writes nothing -- unless a record says
 * keys of ours are still in settings.json (an interrupted earlier switch), in
 * which case they are removed exactly as above.
 */
export async function disableAlwaysOn(): Promise<AlwaysOnResult> {
  const state = await readState();
  const current = await readClaudeSettings();

  // Nothing on record, or a record that is off with nothing of ours left in
  // the file: nothing to do. A file we cannot read is left alone either way.
  if (!state) return { ok: true, changed: false, message: "It was not on." };
  if (!state.enabled && (!current || usageOwnedKeys((current.settings.env ?? {}) as Record<string, unknown>, state).length === 0)) {
    return { ok: true, changed: false, message: "It was not on." };
  }
  if (!current) return { ok: false, reason: "settings_unreadable", message: UNREADABLE };

  const { settings } = current;
  const env = { ...((settings.env ?? {}) as Record<string, unknown>) };
  let touched = false;
  for (const [key, value] of Object.entries(state.written)) {
    if (env[key] !== value) continue;
    const before = state.previous?.[key] ?? null;
    if (before === value) continue;
    touched = true;
    if (before === null) delete env[key];
    else env[key] = before;
  }

  try {
    // Written only when something of ours was in it: a file with nothing to
    // take out is not rewritten (or created) just to reformat it.
    if (touched) {
      const next: ClaudeSettings = { ...settings };
      if (Object.keys(env).length > 0) next.env = env;
      else delete next.env;
      await writeFile(claudeSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    }
    if (state.enabled) await writeState({ ...state, enabled: false, enabledAt: null });
  } catch (error) {
    return writeFailure(error);
  }

  const check = await verifyAlwaysOn("off");
  if (!check.ok) {
    return {
      ok: false,
      reason: "not_applied",
      detail: check.reason,
      message: check.reason === "state_still_enabled"
        ? "Measure everywhere is still recorded as on. Try again."
        : "Some of USAGE's settings are still in Claude Code's settings.json. Try again.",
    };
  }
  return { ok: true, changed: true, message: "Claude Code's settings are back to what they were." };
}
