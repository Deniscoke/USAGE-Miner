import { mkdir, readFile, writeFile, symlink, lstat, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { configDir } from "../secrets.js";

/**
 * The USAGE Claude profile (M16C0 §9–§10).
 *
 * MEASURED, NOT ASSUMED. Claude Code 2.1.268 with a saved claude.ai login keeps
 * that login's OAuth token in `Authorization` even when `ANTHROPIC_AUTH_TOKEN`
 * is set in the child's environment (probed 2026-09-11 against a local 401
 * listener: the OAuth token was sent every time; the bearer token was honoured
 * only when the config directory held no saved login). So "Start with USAGE"
 * cannot both leave the user's login where it is AND have Claude Code present
 * the USAGE route session -- unless the session runs in a config directory of
 * its own.
 *
 * This module builds that directory: `%APPDATA%\USAGE\claude-profile`.
 *
 *   SHARED, by directory junction (no admin rights, no copies):
 *     plugins, skills, agents, commands, rules, projects
 *     -- the user's plugins, hooks, skills, per-project memory and history
 *        are the same files in both profiles.
 *   COPIED, sanitised, on every launch:
 *     settings.json  minus `apiKeyHelper` and any `env.ANTHROPIC_*` /
 *                    `env.CLAUDE_CONFIG_DIR` (a credential or base URL there
 *                    would override the session's routing)
 *     CLAUDE.md      global instructions
 *     .claude.json   display preferences only; NEVER `oauthAccount`,
 *                    `primaryApiKey`, `customApiKeyResponses`
 *   NEVER PRESENT:
 *     .credentials.json  -- a login that appears here (someone ran /login
 *                          inside a USAGE session) is removed at the next
 *                          launch. The user's real login in `~/.claude` is
 *                          not read, copied, moved or touched.
 *
 * The profile therefore has exactly one credential: the route session in the
 * child's environment, which is what makes `/status` say
 * "Auth token: ANTHROPIC_AUTH_TOKEN" instead of naming a claude.ai account.
 */

export const SHARED_DIRECTORIES = ["plugins", "skills", "agents", "commands", "rules", "projects"] as const;

const PREFERENCE_KEYS = ["theme", "preferredNotifChannel", "editorMode", "autoUpdates", "verbose", "shiftEnterKeyBindingInstalled", "numStartups"] as const;

export interface UsageClaudeProfile {
  dir: string;
  shared: string[];
  copied: string[];
  /** Directories that could not be shared; the session still works without them. */
  unshared: string[];
  removedSavedLogin: boolean;
}

export function userClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
}

export function usageClaudeProfileDir(): string {
  return path.join(configDir(), "claude-profile");
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

export async function prepareUsageClaudeProfile(input: { source?: string; dir?: string } = {}): Promise<UsageClaudeProfile> {
  const source = input.source ?? userClaudeDir();
  const dir = input.dir ?? usageClaudeProfileDir();
  await mkdir(dir, { recursive: true });

  const shared: string[] = [];
  const unshared: string[] = [];
  for (const name of SHARED_DIRECTORIES) {
    const from = path.join(source, name);
    const to = path.join(dir, name);
    try {
      const fromStat = await stat(from);
      if (!fromStat.isDirectory()) continue;
    } catch {
      continue; // the user has no such directory; nothing to share
    }
    if (await exists(to)) {
      shared.push(name);
      continue;
    }
    try {
      await symlink(from, to, "junction");
      shared.push(name);
    } catch {
      unshared.push(name);
    }
  }

  const copied: string[] = [];

  // settings.json, sanitised. Strict JSON in, strict JSON out; a file that
  // does not parse is not copied rather than guessed at.
  try {
    const raw = await readFile(path.join(source, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as Record<string, unknown> & { env?: Record<string, string> };
    delete settings.apiKeyHelper;
    if (settings.env && typeof settings.env === "object") {
      for (const key of Object.keys(settings.env)) {
        if (/^ANTHROPIC_/.test(key) || key === "CLAUDE_CONFIG_DIR") delete settings.env[key];
      }
      if (Object.keys(settings.env).length === 0) delete settings.env;
    }
    await writeFile(path.join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    copied.push("settings.json");
  } catch {
    // no settings, or unreadable: the profile starts with Claude Code's defaults
  }

  try {
    await writeFile(path.join(dir, "CLAUDE.md"), await readFile(path.join(source, "CLAUDE.md")));
    copied.push("CLAUDE.md");
  } catch {
    // optional
  }

  // .claude.json: preferences only. The onboarding flag is set so the session
  // opens straight into Claude Code rather than a first-run wizard.
  const preferences: Record<string, unknown> = { hasCompletedOnboarding: true };
  try {
    const userConfig = JSON.parse(await readFile(path.join(path.dirname(source), ".claude.json"), "utf8")) as Record<string, unknown>;
    for (const key of PREFERENCE_KEYS) if (key in userConfig) preferences[key] = userConfig[key];
  } catch {
    // optional
  }
  // Preserve what Claude Code wrote into the profile's own config on earlier
  // runs (its per-project trust answers), but never a login.
  try {
    const existing = JSON.parse(await readFile(path.join(dir, ".claude.json"), "utf8")) as Record<string, unknown>;
    delete existing.oauthAccount;
    delete existing.primaryApiKey;
    delete existing.customApiKeyResponses;
    Object.assign(preferences, existing, preferences);
  } catch {
    // first run
  }
  await writeFile(path.join(dir, ".claude.json"), `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  copied.push(".claude.json");

  let removedSavedLogin = false;
  const credentials = path.join(dir, ".credentials.json");
  if (await exists(credentials)) {
    await rm(credentials, { force: true });
    removedSavedLogin = true;
  }

  return { dir, shared, copied, unshared, removedSavedLogin };
}
