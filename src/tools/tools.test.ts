import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter, migrateLegacyCredential } from "./claude-code.js";
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

  it("refuses to configure itself, because that would mean a token on disk", async () => {
    await writeClaudeSettings(JSON.stringify({ model: "opus" }, null, 2));

    const result = await claudeCodeAdapter.enableMining(ROUTE);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/started by USAGE/i);
    expect(claudeCodeAdapter.persistentConfig).toBe("unsafe");
    // And it did not touch the file on the way to refusing.
    expect(await readClaudeSettings()).toEqual({ model: "opus" });
  });

  it("puts routing in the child process environment, not in a file", async () => {
    const plan = claudeCodeAdapter.launchPlan(ROUTE);

    expect(plan.command).toBe("claude");
    expect(plan.env.ANTHROPIC_BASE_URL).toBe(ROUTE.url);
    expect(plan.env.ANTHROPIC_CUSTOM_HEADERS).toContain(ROUTE.minerToken);
    // Empty, so a signed-in Claude subscription keeps working.
    expect(plan.env.ANTHROPIC_API_KEY).toBe("");
    // Never set: it would replace the user's own Authorization header.
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    // Nothing was written anywhere as a side effect of planning a launch.
    await expect(readFile(claudeSettingsPath(), "utf8")).rejects.toThrow();
  });


  it("leaves somebody else's proxy configuration alone", async () => {
    const original = JSON.stringify(
      { env: { ANTHROPIC_BASE_URL: "https://my-own-proxy.example.com" } },
      null,
      2,
    );
    await writeClaudeSettings(original);

    await claudeCodeAdapter.enableMining(ROUTE);

    expect(await readFile(claudeSettingsPath(), "utf8")).toBe(original);
    expect(await claudeCodeAdapter.inspectRouting()).toEqual({
      state: "foreign",
      url: "https://my-own-proxy.example.com",
    });
  });
});

function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME!, "config.toml");
}

describe("where the miner token does and does not land", () => {
  // Pinned deliberately. One adapter can reference a credential and the other
  // cannot, and the difference is a security property users are told about --
  // so it must fail loudly if either changes, rather than quietly making the
  // download page's promise untrue.
  it("Codex names the credential rather than embedding it", async () => {
    await codexAdapter.enableMining(ROUTE);
    const config = await readFile(codexConfigPath(), "utf8");
    expect(config).not.toContain(ROUTE.minerToken);
    expect(config).toContain('env_key = "USAGE_MINER_TOKEN"');
  });

  it("Claude Code writes nothing at all, so there is nothing to leak", async () => {
    // The property M12 exists to establish. Earlier builds embedded the token
    // here because Claude Code's settings file has no `env_key` equivalent;
    // the answer is not to write the file.
    await claudeCodeAdapter.enableMining(ROUTE);
    await expect(readFile(claudeSettingsPath(), "utf8")).rejects.toThrow();

    // And the credential the launcher passes never reaches a config file --
    // it exists only in the environment handed to the child process.
    const plan = claudeCodeAdapter.launchPlan(ROUTE);
    expect(JSON.stringify(plan.env)).toContain(ROUTE.minerToken);
    await expect(readFile(claudeSettingsPath(), "utf8")).rejects.toThrow();
  });
});

describe("disable on a machine USAGE never configured", () => {
  // The uninstaller calls `disable` for every tool unconditionally, so this is
  // the common case, not an edge case: most people uninstalling have not
  // enabled mining for every tool. Touching a file we did not write would be a
  // stranger reformatting your configuration on the way out.
  it("leaves a Claude Code settings file the user wrote completely alone", async () => {
    const original = `{\n  "theme": "dark",\n  "env": { "ANTHROPIC_API_KEY": "sk-user-own" }\n}`;
    await writeClaudeSettings(original);

    const result = await claudeCodeAdapter.disableMining();

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/not configured by USAGE/);
    expect(await readFile(claudeSettingsPath(), "utf8")).toBe(original);
  });

  it("leaves a Claude Code settings file pointed somewhere else alone", async () => {
    const original = `{\n  "env": { "ANTHROPIC_BASE_URL": "https://someone-elses-proxy.example" }\n}`;
    await writeClaudeSettings(original);

    await claudeCodeAdapter.disableMining();

    expect(await readFile(claudeSettingsPath(), "utf8")).toBe(original);
  });

  it("leaves a Codex config the user wrote completely alone", async () => {
    const original = `approval_policy = "on-request"\nmodel_provider = "openai"\n`;
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    await writeFile(codexConfigPath(), original, "utf8");

    const result = await codexAdapter.disableMining();

    expect(result.ok).toBe(true);
    expect(await readFile(codexConfigPath(), "utf8")).toBe(original);
  });
});

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

describe("migrating a machine an older build wrote a credential onto", () => {
  /** Exactly what builds before 0.3.0 left behind. */
  async function writeLegacyExposure(extra: Record<string, unknown> = {}): Promise<void> {
    await writeClaudeSettings(
      JSON.stringify(
        {
          ...extra,
          env: {
            ANTHROPIC_BASE_URL: ROUTE.url,
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_CUSTOM_HEADERS: `x-usage-miner-token: ${ROUTE.minerToken}`,
          },
        },
        null,
        2,
      ),
    );
  }

  it("removes the credential and reports that it did", async () => {
    await writeLegacyExposure({ model: "opus" });

    const result = await migrateLegacyCredential();

    expect(result.migrated).toBe(true);
    const after = await readFile(claudeSettingsPath(), "utf8");
    expect(after).not.toContain(ROUTE.minerToken);
    expect(after).not.toContain("x-usage-miner-token");
  });

  it("keeps unrelated Claude configuration exactly", async () => {
    await writeLegacyExposure({ model: "opus", permissions: { allow: ["Bash"] } });

    await migrateLegacyCredential();

    const settings = await readClaudeSettings();
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash"] });
  });

  it("is idempotent: a second run changes nothing", async () => {
    await writeLegacyExposure({ model: "opus" });

    const first = await migrateLegacyCredential();
    const afterFirst = await readFile(claudeSettingsPath(), "utf8");
    const second = await migrateLegacyCredential();

    expect(first.migrated).toBe(true);
    expect(second.migrated).toBe(false);
    expect(await readFile(claudeSettingsPath(), "utf8")).toBe(afterFirst);
  });

  it("does nothing on a machine that was never affected", async () => {
    const original = `{\n  "model": "opus"\n}`;
    await writeClaudeSettings(original);

    const result = await migrateLegacyCredential();

    expect(result.migrated).toBe(false);
    expect(await readFile(claudeSettingsPath(), "utf8")).toBe(original);
  });

  it("leaves a foreign endpoint alone rather than claiming it as ours", async () => {
    // Somebody else's proxy is not an exposure to clean up, and rewriting it
    // would be this tool breaking a configuration it does not own.
    const original = JSON.stringify(
      { env: { ANTHROPIC_BASE_URL: "https://someone-elses.example" } },
      null,
      2,
    );
    await writeClaudeSettings(original);

    const result = await migrateLegacyCredential();

    expect(result.migrated).toBe(false);
    expect(await readFile(claudeSettingsPath(), "utf8")).toBe(original);
  });

  it("restores the rollback copy when one exists", async () => {
    const original = { model: "opus", env: { FOO: "bar" } };
    await writeClaudeSettings(JSON.stringify(original, null, 2));
    // Simulate what the old enable path recorded before it overwrote the file.
    await mkdir(process.env.APPDATA!, { recursive: true });
    await writeFile(
      path.join(process.env.APPDATA!, "USAGE", "claude-code.backup.json"),
      JSON.stringify({ existed: true, settings: original }, null, 2),
      "utf8",
    ).catch(async () => {
      await mkdir(path.join(process.env.APPDATA!, "USAGE"), { recursive: true });
      await writeFile(
        path.join(process.env.APPDATA!, "USAGE", "claude-code.backup.json"),
        JSON.stringify({ existed: true, settings: original }, null, 2),
        "utf8",
      );
    });
    await writeLegacyExposure({ model: "opus" });

    const result = await migrateLegacyCredential();

    expect(result.migrated).toBe(true);
    expect(result.restoredFromBackup).toBe(true);
    expect(await readClaudeSettings()).toEqual(original);
  });
});
