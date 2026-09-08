import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter, CODEX_MANAGED_MARKERS } from "./codex.js";
import { scrubForLog } from "../log.js";

/**
 * Tool adapters, against real files in a temporary home.
 *
 * The property that matters most is not "does enabling work" -- it is "does
 * disabling put everything back". A miner that mangles somebody's Claude Code
 * or Codex configuration has done more harm than mining could ever be worth.
 */

const ROUTE = {
  url: "https://usage-ten.vercel.app/api/gateway/provider/11111111-1111-4111-8111-111111111111",
  minerToken: "usgm_test_token_value",
  label: "OpenRouter",
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "usage-miner-test-"));
  // Every path the adapters touch is redirected into the temp directory.
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.CODEX_HOME = path.join(home, ".codex");
  process.env.APPDATA = path.join(home, "AppData");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

async function writeClaudeSettings(contents: string): Promise<void> {
  await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), contents, "utf8");
}

function claudeSettingsPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
}

async function readClaudeSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(claudeSettingsPath(), "utf8")) as Record<string, unknown>;
}

describe("Claude Code adapter", () => {
  it("starts off when nothing is configured", async () => {
    expect(await claudeCodeAdapter.inspectRouting()).toEqual({ state: "off" });
  });

  it("routes through USAGE without touching the user's other settings", async () => {
    await writeClaudeSettings(
      JSON.stringify({ model: "opus", permissions: { allow: ["Bash"] } }, null, 2),
    );

    const result = await claudeCodeAdapter.enableMining(ROUTE);
    expect(result.ok).toBe(true);

    const settings = await readClaudeSettings();
    // Everything that was there is still there.
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash"] });

    const env = settings.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe(ROUTE.url);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain("x-usage-miner-token");
    // Empty, so a signed-in Claude subscription keeps working.
    expect(env.ANTHROPIC_API_KEY).toBe("");
    // Never set: it would replace the user's own Authorization header.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("restores the file byte-for-byte on disable", async () => {
    const original = { model: "opus", env: { FOO: "bar" } };
    await writeClaudeSettings(JSON.stringify(original, null, 2));

    await claudeCodeAdapter.enableMining(ROUTE);
    await claudeCodeAdapter.disableMining();

    expect(await readClaudeSettings()).toEqual(original);
  });

  it("removes the file entirely when USAGE created it", async () => {
    await claudeCodeAdapter.enableMining(ROUTE);
    await claudeCodeAdapter.disableMining();

    // The machine is exactly as it was: no leftover file.
    await expect(readFile(claudeSettingsPath(), "utf8")).rejects.toThrow();
  });

  it("refuses to overwrite a custom endpoint without consent", async () => {
    await writeClaudeSettings(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://my-own-proxy.example.com" } }, null, 2),
    );

    const result = await claudeCodeAdapter.enableMining(ROUTE);
    expect(result.ok).toBe(false);
    expect(result.requiresConfirmation).toBe(true);

    // Untouched until the user says so.
    const settings = await readClaudeSettings();
    expect((settings.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(
      "https://my-own-proxy.example.com",
    );

    const forced = await claudeCodeAdapter.enableMining(ROUTE, true);
    expect(forced.ok).toBe(true);
  });

  it("refuses to touch a settings file it cannot parse", async () => {
    await writeClaudeSettings("{ this is not json ");

    const result = await claudeCodeAdapter.enableMining(ROUTE);
    expect(result.ok).toBe(false);
    // The user's file is left exactly as they left it.
    expect(await readFile(claudeSettingsPath(), "utf8")).toBe("{ this is not json ");
  });

  it("reports health from the configuration it actually finds", async () => {
    expect((await claudeCodeAdapter.healthCheck()).ok).toBe(false);
    await claudeCodeAdapter.enableMining(ROUTE);
    expect((await claudeCodeAdapter.healthCheck()).ok).toBe(true);
  });
});

function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME!, "config.toml");
}

describe("Codex adapter", () => {
  it("writes a provider block Codex understands", async () => {
    const result = await codexAdapter.enableMining(ROUTE);
    expect(result.ok).toBe(true);

    const config = await readFile(codexConfigPath(), "utf8");
    expect(config).toContain('model_provider = "usage"');
    expect(config).toContain("[model_providers.usage]");
    expect(config).toContain(`base_url = "${ROUTE.url}/v1"`);
    expect(config).toContain('wire_api = "chat"');
    // The credential is named, not embedded: it never lands in a config file.
    expect(config).toContain('env_key = "USAGE_MINER_TOKEN"');
    expect(config).not.toContain(ROUTE.minerToken);
  });

  it("keeps the user's own configuration around it", async () => {
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    await writeFile(codexConfigPath(), 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n', "utf8");

    await codexAdapter.enableMining(ROUTE);
    const config = await readFile(codexConfigPath(), "utf8");
    expect(config).toContain('approval_policy = "on-request"');
    expect(config).toContain('sandbox_mode = "workspace-write"');
  });

  it("restores the original file on disable", async () => {
    const original = 'approval_policy = "on-request"\n';
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    await writeFile(codexConfigPath(), original, "utf8");

    await codexAdapter.enableMining(ROUTE);
    await codexAdapter.disableMining();

    expect(await readFile(codexConfigPath(), "utf8")).toBe(original);
  });

  it("removes only its own block when there is no backup", async () => {
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    await codexAdapter.enableMining(ROUTE);

    // Simulate a lost backup: strip the block directly.
    const config = await readFile(codexConfigPath(), "utf8");
    const stripped = CODEX_MANAGED_MARKERS.stripManagedBlock(config);
    expect(stripped).not.toContain("model_providers.usage");
    expect(stripped).not.toContain(CODEX_MANAGED_MARKERS.BEGIN_MARKER);
  });

  it("refuses to replace a provider the user chose", async () => {
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    await writeFile(codexConfigPath(), 'model_provider = "my-own"\n', "utf8");

    const result = await codexAdapter.enableMining(ROUTE);
    expect(result.ok).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(await readFile(codexConfigPath(), "utf8")).toContain('model_provider = "my-own"');
  });

  it("does not mistake its own block for a foreign provider", async () => {
    await codexAdapter.enableMining(ROUTE);
    const config = await readFile(codexConfigPath(), "utf8");
    expect(CODEX_MANAGED_MARKERS.foreignProvider(config)).toBeNull();
  });

  it("does not stack duplicate blocks when enabled twice", async () => {
    await codexAdapter.enableMining(ROUTE);
    await codexAdapter.enableMining({ ...ROUTE, label: "Second" });

    const config = await readFile(codexConfigPath(), "utf8");
    const occurrences = config.split(CODEX_MANAGED_MARKERS.BEGIN_MARKER).length - 1;
    expect(occurrences).toBe(1);
    expect(config).toContain("Second");
  });
});

describe("logging never carries a credential", () => {
  it("redacts anything token-shaped", () => {
    expect(scrubForLog("failed with usgm_abc123DEF456")).toBe("failed with usgm_[redacted]");
    expect(scrubForLog("key sk-proj-abcdefgh12345")).toBe("key sk-[redacted]");
    expect(scrubForLog("Authorization: Bearer eyJhbGciOi.abc")).toContain("Bearer [redacted]");
  });

  it("leaves ordinary messages alone", () => {
    expect(scrubForLog("Claude Code is not installed")).toBe("Claude Code is not installed");
  });
});
