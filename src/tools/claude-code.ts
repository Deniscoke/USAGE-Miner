import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { configDir } from "../secrets.js";
import {
  backupName,
  type EnableResult,
  type LocalToolAdapter,
  type RouteConfig,
  type RoutingState,
  type ToolDetection,
} from "./adapter.js";

const run = promisify(execFile);

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
 * The file is strict JSON, so it is parsed and re-serialised rather than
 * patched textually, and every key that was already there is preserved.
 */

const HEADER_NAME = "x-usage-miner-token";

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
    try {
      const { stdout } = await run("claude", ["--version"], { windowsHide: true, timeout: 10_000 });
      installed = true;
      version = stdout.trim().split(/\s+/)[0] ?? null;
    } catch {
      installed = false;
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

  async enableMining(route: RouteConfig, force = false): Promise<EnableResult> {
    const current = await readSettings();
    if (!current) {
      return {
        ok: false,
        message:
          "Your Claude Code settings.json is not valid JSON. Fix or remove it, then try again — USAGE will not overwrite it.",
      };
    }

    const routing = await this.inspectRouting();
    if (routing.state === "foreign" && !force) {
      return {
        ok: false,
        requiresConfirmation: true,
        message: `Claude Code already routes to ${routing.url}. Enabling USAGE will replace that. Re-run with --force to confirm.`,
      };
    }

    // The rollback copy records what was there, including "there was no file".
    await mkdir(configDir(), { recursive: true });
    await writeFile(
      backupPath(),
      JSON.stringify({ existed: current.existed, settings: current.settings }, null, 2),
      "utf8",
    );

    const settings: ClaudeSettings = {
      ...current.settings,
      env: {
        ...current.settings.env,
        ANTHROPIC_BASE_URL: route.url,
        // Claude Code checks ANTHROPIC_API_KEY first; empty means "use the
        // credential you already have", which keeps a subscription signed in.
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_CUSTOM_HEADERS: `${HEADER_NAME}: ${route.minerToken}`,
      },
    };

    await mkdir(claudeDir(), { recursive: true });
    await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    return { ok: true, message: `Claude Code now mines through ${route.label}.` };
  },

  async disableMining(): Promise<EnableResult> {
    let backup: ClaudeBackup | null = null;
    try {
      backup = JSON.parse(await readFile(backupPath(), "utf8")) as ClaudeBackup;
    } catch {
      backup = null;
    }

    if (!backup) {
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
