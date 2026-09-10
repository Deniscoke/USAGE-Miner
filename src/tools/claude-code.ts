import { readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { configDir } from "../secrets.js";
import {
  backupName,
  probeVersion,
  type EnableResult,
  type LocalToolAdapter,
  type RouteConfig,
  type RoutingState,
  type ToolDetection,
} from "./adapter.js";

/**
 * Claude Code.
 *
 * Configured through `~/.claude/settings.json`, which supports an `env` block
 * that Claude Code applies to its own sessions. Two keys are all that is
 * needed, and they are exactly the ones USAGE has been routing production
 * traffic with since M4:
 *
 *   ANTHROPIC_BASE_URL       where requests go
 *   ANTHROPIC_CUSTOM_HEADERS carries the device's miner token
 *
 * ANTHROPIC_AUTH_TOKEN is deliberately NOT set. Setting it would overwrite the
 * Authorization header and log the user out of their Claude subscription; the
 * miner token travels in its own header instead, so nobody has to sign out of
 * anything.
 *
 * LAUNCH-ONLY, AND WHY. Claude Code's settings file takes literal environment
 * values. It has no way to name a credential held somewhere else, the way
 * Codex's `env_key` does, so persistent routing would mean writing this
 * device's miner token into `settings.json` in plaintext -- a second copy of a
 * credential that is otherwise held under DPAPI, sitting in a file that gets
 * copied into dotfile repositories and pasted into bug reports.
 *
 * So this adapter does not offer persistent configuration at all. `enableMining`
 * refuses and says why. Routing happens in `launchPlan`: the miner starts Claude
 * Code itself and puts the credential in that child process's environment, where
 * it lives for the session and is gone when the process exits.
 *
 * `disableMining` stays, because earlier builds DID write the token here and
 * those machines have to be cleaned up. See `migrateLegacyCredential`.
 *
 * The file is strict JSON, so it is parsed and re-serialised rather than
 * patched textually, and every key that was already there is preserved.
 */

const HEADER_NAME = "x-usage-miner-token";

/**
 * OpenRouter model slugs for Claude Code's model aliases. Bare Claude ids are
 * not accepted on OpenRouter's Anthropic surface; these are the priced ids in
 * USAGE's `usage-pricing-v3`. Non-secret.
 */
export const OPENROUTER_MODEL_ENV: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC_MODEL: "anthropic/claude-sonnet-4.6",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-5",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-4.6",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5",
  CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/claude-sonnet-4.6",
});

interface ClaudeBackup {
  existed: boolean;
  settings: ClaudeSettings;
}

interface ClaudeSettings {
  env?: Record<string, string>;
  [key: string]: unknown;
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
}

function settingsPath(): string {
  return path.join(claudeDir(), "settings.json");
}

function backupPath(): string {
  return path.join(configDir(), backupName("claude-code"));
}

async function readSettings(): Promise<{ settings: ClaudeSettings; existed: boolean } | null> {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    if (!raw.trim()) return { settings: {}, existed: true };
    return { settings: JSON.parse(raw) as ClaudeSettings, existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: {}, existed: false };
    }
    // Malformed JSON. Refuse rather than overwrite: this file is the user's.
    return null;
  }
}

export const claudeCodeAdapter: LocalToolAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  protocol: "anthropic_compatible",

  async detect(): Promise<ToolDetection> {
    let version: string | null = null;
    let installed = false;
    const text = await probeVersion("claude");
    if (text !== null) {
      installed = true;
      version = text.split(/\s+/)[0] ?? null;
    }
    return { installed, version, configPath: settingsPath() };
  },

  async inspectRouting(): Promise<RoutingState> {
    const current = await readSettings();
    if (!current) {
      return { state: "unreadable", reason: "settings.json is not valid JSON." };
    }

    const baseUrl = current.settings.env?.ANTHROPIC_BASE_URL;
    if (!baseUrl) return { state: "off" };
    // "Is this ours" is decided by the header we set, not by the hostname:
    // a user could legitimately self-host USAGE somewhere else.
    const header = current.settings.env?.ANTHROPIC_CUSTOM_HEADERS ?? "";
    return header.includes(HEADER_NAME)
      ? { state: "usage", url: baseUrl }
      : { state: "foreign", url: baseUrl };
  },

  persistentConfig: "unsafe",

  capabilities() {
    return {
      meteringMethods: ["native_otel", "routed"],
      reads: ["model", "tokens", "cache", "request_id", "cost_estimate"],
      // request_id is the Anthropic API request id: correlatable exactly with
      // a USAGE route that carried the same request, and only then.
      verificationCeiling: "provider_correlated",
      availabilityNote: null,
      experimental: false,
    };
  },

  privacyProfile() {
    return {
      reads: ["Model", "Token counts (input, output, cache read, cache write)", "Request ID", "Cost estimate", "Timing"],
      neverReads: ["Prompts", "Responses", "Tool arguments", "File paths", "Source code", "Your email or account id"],
    };
  },

  /**
   * Official telemetry -- code.claude.com/docs/en/monitoring-usage -- pointed
   * at the local receiver for this session only.
   *
   * Logs exporter on, metrics off (metrics carry nothing per-request USAGE
   * needs, and carry account attributes it does not want). OTLP over HTTP as
   * JSON, which the receiver parses without a protobuf dependency.
   *
   * The three content switches are set to 0 explicitly, not left to default:
   * a default is a thing that changes in a release note.
   */
  telemetryLaunch(receiver) {
    return {
      args: [],
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_TRACES_EXPORTER: "none",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${receiver.sessionSecret}`,
        OTEL_LOGS_EXPORT_INTERVAL: "2000",
        OTEL_LOG_USER_PROMPTS: "0",
        OTEL_LOG_TOOL_DETAILS: "0",
        OTEL_LOG_TOOL_CONTENT: "0",
        OTEL_LOG_RAW_API_BODIES: "0",
        OTEL_LOG_ASSISTANT_RESPONSES: "0",
      },
    };
  },

  /**
   * Routing for one session, in the child's environment only.
   *
   * WITH A ROUTE SESSION (the M16C0 path): Claude Code is started in the USAGE
   * profile (see claude-profile.ts) with the session token as its gateway
   * credential. Measured on 2.1.268: a saved claude.ai login keeps its own
   * OAuth token in Authorization even when ANTHROPIC_AUTH_TOKEN is set, so the
   * only way the route session is presented -- and the only way `/status`
   * can show "Auth token: ANTHROPIC_AUTH_TOKEN" -- is a config directory with
   * no saved login. The user's real login in ~/.claude is never touched.
   *
   * For an OpenRouter route the model aliases are OpenRouter slugs, because
   * OpenRouter's Anthropic surface requires them (docs, 2026-09-11) and they
   * are the ids USAGE's pricing snapshot names.
   *
   * WITHOUT ONE (server too old, or route sessions unavailable): the header-
   * only launch. Claude Code then authenticates to USAGE with the device
   * credential in its own header and keeps its claude.ai login in
   * Authorization; USAGE strips that and uses the server-held provider
   * credential, but `/status` cannot show the route as proven. The miner says
   * which of the two it is doing before launching.
   */
  launchPlan(route: RouteConfig) {
    if (route.session) {
      const env: Record<string, string> = {
        CLAUDE_CONFIG_DIR: route.session.profileDir,
        ANTHROPIC_BASE_URL: route.url,
        ANTHROPIC_AUTH_TOKEN: route.session.token,
        // Explicitly empty, so a key in the parent environment cannot win.
        ANTHROPIC_API_KEY: "",
      };
      if (route.providerFamily === "openrouter") Object.assign(env, OPENROUTER_MODEL_ENV);
      return { command: "claude", env };
    }
    return {
      command: "claude",
      env: {
        ANTHROPIC_BASE_URL: route.url,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_CUSTOM_HEADERS: `${HEADER_NAME}: ${route.minerToken}`,
      },
    };
  },

  /**
   * Refused, deliberately.
   *
   * There is no way to do this for Claude Code without leaving a credential on
   * disk, so it is not offered. Removed rather than kept behind a warning: a
   * beta that ships an unsafe path because it used to exist is a beta that
   * ships an unsafe path.
   */
  async enableMining(): Promise<EnableResult> {
    return {
      ok: false,
      message:
        "Claude Code is started by USAGE rather than configured, so no credential is ever written to disk. Use “Start with USAGE”, or run: usage run claude-code",
    };
  },

  async disableMining(): Promise<EnableResult> {
    let backup: ClaudeBackup | null = null;
    try {
      backup = JSON.parse(await readFile(backupPath(), "utf8")) as ClaudeBackup;
    } catch {
      backup = null;
    }

    if (!backup) {
      // Nothing of ours is in there. Say so and touch nothing -- `disable` is
      // called unconditionally by the uninstaller, and rewriting a file USAGE
      // never wrote would reformat it and could drop a key the user set
      // themselves.
      const routing = await this.inspectRouting();
      if (routing.state !== "usage") {
        return { ok: true, message: "Claude Code was not configured by USAGE." };
      }

      // No rollback copy: remove only the keys USAGE sets, and leave the rest.
      const current = await readSettings();
      if (!current) return { ok: false, message: "Could not read Claude Code settings." };

      const env: Record<string, string> = { ...current.settings.env };
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_CUSTOM_HEADERS;
      delete env.ANTHROPIC_API_KEY;

      const settings: ClaudeSettings = { ...current.settings, env };
      if (Object.keys(env).length === 0) delete settings.env;

      await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      return { ok: true, message: "Claude Code no longer routes through USAGE." };
    }

    if (!backup.existed) {
      // USAGE created the file. Removing it restores the machine exactly.
      await rm(settingsPath(), { force: true });
    } else {
      await writeFile(settingsPath(), `${JSON.stringify(backup.settings, null, 2)}\n`, "utf8");
    }
    await rm(backupPath(), { force: true });

    return { ok: true, message: "Claude Code settings restored to what they were before." };
  },

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const routing = await this.inspectRouting();
    if (routing.state === "usage") return { ok: true, detail: `Routing to ${routing.url}` };
    if (routing.state === "off") return { ok: false, detail: "Mining is not enabled." };
    if (routing.state === "foreign") {
      return { ok: false, detail: `Routing to ${routing.url}, which is not USAGE.` };
    }
    return { ok: false, detail: routing.reason };
  },
};

/**
 * Clean up a machine an earlier build wrote a credential onto.
 *
 * Builds before 0.3.0 routed Claude Code by writing this device's miner token
 * into `settings.json`. Upgrading has to remove it -- an upgrade that silently
 * leaves the old exposure in place is not a fix.
 *
 * Safe and idempotent, in that order:
 *
 *   * it only acts when the settings actually carry OUR header, so a file the
 *     user wrote, or one pointing at somebody else's proxy, is never touched;
 *   * it restores the rollback copy when there is one, so unrelated Claude
 *     configuration comes back exactly as it was;
 *   * with no rollback copy it removes only the three keys USAGE sets;
 *   * running it again on a clean machine does nothing and says so.
 *
 * It never reads the old token's value and never returns it. Whether it is
 * still valid is not this function's business: the caller rotates the device
 * credential afterwards, because a secret that has been sitting in a plaintext
 * file must be assumed to have been read.
 */
export async function migrateLegacyCredential(): Promise<{
  migrated: boolean;
  restoredFromBackup: boolean;
  detail: string;
}> {
  const routing = await claudeCodeAdapter.inspectRouting();
  if (routing.state !== "usage") {
    return {
      migrated: false,
      restoredFromBackup: false,
      detail:
        routing.state === "unreadable"
          ? "Claude Code settings could not be read; left untouched."
          : "No USAGE credential found in Claude Code settings.",
    };
  }

  let hadBackup = false;
  try {
    await readFile(backupPath(), "utf8");
    hadBackup = true;
  } catch {
    hadBackup = false;
  }

  const result = await claudeCodeAdapter.disableMining();
  if (!result.ok) {
    return { migrated: false, restoredFromBackup: false, detail: result.message };
  }

  return {
    migrated: true,
    restoredFromBackup: hadBackup,
    detail: hadBackup
      ? "Removed the stored credential and restored your previous Claude Code settings."
      : "Removed the stored credential from Claude Code settings.",
  };
}
