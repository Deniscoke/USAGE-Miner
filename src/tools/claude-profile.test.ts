import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareUsageClaudeProfile, SHARED_DIRECTORIES } from "./claude-profile.js";
import { claudeCodeAdapter, OPENROUTER_MODEL_ENV } from "./claude-code.js";

/**
 * M16C0 §10: the USAGE profile shares everything but a login, and the launch
 * plan carries a route session -- never a provider credential, never the
 * device credential in a file.
 */

let home: string;
let source: string;
let profile: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "usage-claude-profile-"));
  source = path.join(home, ".claude");
  profile = path.join(home, "AppData", "USAGE", "claude-profile");
  await mkdir(source, { recursive: true });
  for (const name of SHARED_DIRECTORIES) await mkdir(path.join(source, name), { recursive: true });
  await writeFile(path.join(source, "plugins", "marker.txt"), "shared", "utf8");
  await writeFile(
    path.join(source, "settings.json"),
    JSON.stringify({ enabledPlugins: { "x@y": true }, apiKeyHelper: "get-key.sh", env: { ANTHROPIC_BASE_URL: "https://elsewhere", ANTHROPIC_AUTH_TOKEN: "sk-should-not-copy", OTEL_X: "1" } }),
    "utf8",
  );
  await writeFile(path.join(source, "CLAUDE.md"), "# rules", "utf8");
  await writeFile(path.join(source, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-secret" } }), "utf8");
  await writeFile(path.join(home, ".claude.json"), JSON.stringify({ theme: "dark", oauthAccount: { emailAddress: "owner@example.com" }, primaryApiKey: "sk-ant-x" }), "utf8");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("the USAGE Claude profile", () => {
  it("shares plugins, skills, rules and memory by junction, and never the saved login", async () => {
    const result = await prepareUsageClaudeProfile({ source, dir: profile });
    expect(result.dir).toBe(profile);
    expect(result.shared.sort()).toEqual([...SHARED_DIRECTORIES].sort());
    expect((await lstat(path.join(profile, "plugins"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(profile, "plugins", "marker.txt"), "utf8")).toBe("shared");
    expect(await readdir(profile)).not.toContain(".credentials.json");
    // The user's own login is untouched where it lives.
    expect(await readFile(path.join(source, ".credentials.json"), "utf8")).toContain("sk-ant-oat01-secret");
  });

  it("copies settings without any credential, base URL or key helper, and preferences without the account", async () => {
    await prepareUsageClaudeProfile({ source, dir: profile });
    const settings = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
    expect(settings.enabledPlugins).toEqual({ "x@y": true });
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(settings.env).toEqual({ OTEL_X: "1" });
    expect(JSON.stringify(settings)).not.toContain("sk-should-not-copy");
    const config = JSON.parse(await readFile(path.join(profile, ".claude.json"), "utf8"));
    expect(config).toEqual({ hasCompletedOnboarding: true, theme: "dark" });
    expect(await readFile(path.join(profile, "CLAUDE.md"), "utf8")).toBe("# rules");
  });

  it("removes a login somebody saved inside the profile, and is idempotent", async () => {
    await prepareUsageClaudeProfile({ source, dir: profile });
    await writeFile(path.join(profile, ".credentials.json"), "{}", "utf8");
    await writeFile(path.join(profile, ".claude.json"), JSON.stringify({ theme: "dark", oauthAccount: { emailAddress: "x" }, projects: { "C:/x": { hasTrustDialogAccepted: true } } }), "utf8");
    const again = await prepareUsageClaudeProfile({ source, dir: profile });
    expect(again.removedSavedLogin).toBe(true);
    expect(await readdir(profile)).not.toContain(".credentials.json");
    const config = JSON.parse(await readFile(path.join(profile, ".claude.json"), "utf8"));
    expect(config.oauthAccount).toBeUndefined();
    expect(config.projects).toEqual({ "C:/x": { hasTrustDialogAccepted: true } });
    expect(again.shared.length).toBe(SHARED_DIRECTORIES.length);
  });
});

describe("the route-session launch plan", () => {
  const base = { url: "https://usage.example/api/gateway/provider/or-1/anthropic", minerToken: "usgm_device", label: "OpenRouter", providerFamily: "openrouter", surface: "anthropic_compatible" as const };

  it("presents the route session as the gateway credential inside the USAGE profile, with OpenRouter model slugs", () => {
    const plan = claudeCodeAdapter.launchPlan({ ...base, session: { token: "usgr_session", expiresAt: "2026-09-11T20:00:00.000Z", profileDir: "C:\\p" } });
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe("C:\\p");
    expect(plan.env.ANTHROPIC_BASE_URL).toBe(base.url);
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("usgr_session");
    expect(plan.env.ANTHROPIC_API_KEY).toBe("");
    expect(plan.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(OPENROUTER_MODEL_ENV.ANTHROPIC_DEFAULT_OPUS_MODEL);
    // The device credential is not in the child at all on this path, and no
    // value in the environment is a provider key.
    expect(Object.values(plan.env).join(" ")).not.toContain("usgm_");
    expect(Object.values(plan.env).join(" ")).not.toMatch(/sk-or|sk-ant/);
  });

  it("keeps the header-only launch when there is no route session", () => {
    const plan = claudeCodeAdapter.launchPlan(base);
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(plan.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(plan.env.ANTHROPIC_CUSTOM_HEADERS).toContain("usgm_device");
  });

  it("sets no OpenRouter model slugs for a non-OpenRouter route", () => {
    const plan = claudeCodeAdapter.launchPlan({ ...base, providerFamily: "anthropic", session: { token: "usgr_s", expiresAt: "", profileDir: "p" } });
    expect(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });
});
