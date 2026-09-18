import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALWAYS_ON_HEADER, alwaysOnClaudeEnv, alwaysOnStatus, disableAlwaysOn, enableAlwaysOn, verifyAlwaysOn } from "./always-on.js";
import { startTelemetryReceiver } from "./receiver.js";

/**
 * "Measure Claude Code everywhere", against a real settings file in a temp home.
 *
 * What has to hold: it writes no credential and no content switch left at a
 * default; it never clobbers telemetry the user already sends elsewhere; and
 * turning it off leaves the user's own settings exactly as they are, including
 * anything they changed after turning it on.
 */

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "usage-always-on-"));
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.APPDATA = path.join(home, "AppData");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
});

const settingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
const readSettings = async () => JSON.parse(await readFile(settingsFile(), "utf8")) as { env?: Record<string, string>; [k: string]: unknown };

async function writeSettings(value: unknown) {
  await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  await writeFile(settingsFile(), JSON.stringify(value, null, 2), "utf8");
}

describe("the environment written for Claude Code", () => {
  const env = alwaysOnClaudeEnv("key-123", 47823);

  it("points only the logs signal at the loopback receiver", () => {
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("http://127.0.0.1:47823/v1/logs");
    expect(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe("http/json");
    // Not written at all: "none" would have switched off a user's own pipeline.
    expect(env.OTEL_METRICS_EXPORTER).toBeUndefined();
    expect(env.OTEL_TRACES_EXPORTER).toBeUndefined();
  });

  it("switches every content setting off explicitly", () => {
    for (const key of ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS", "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES"]) {
      expect(env[key], key).toBe("0");
    }
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    // Never traces, never the enhanced-telemetry beta.
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBeUndefined();
  });

  it("carries no USAGE credential of any kind", () => {
    const all = JSON.stringify(env);
    expect(all).not.toMatch(/usgm_|usgr_|Bearer/);
    expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe(`${ALWAYS_ON_HEADER}=key-123`);
  });
});

describe("turning it on and off", () => {
  it("adds its keys beside the user's own settings, and removes exactly them again", async () => {
    await writeSettings({ model: "opus", env: { MY_VAR: "mine" }, permissions: { allow: ["Bash(ls)"] } });

    expect((await enableAlwaysOn()).ok).toBe(true);
    const on = await readSettings();
    expect(on.model).toBe("opus");
    expect(on.env!.MY_VAR).toBe("mine");
    expect(on.env!.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect((await alwaysOnStatus()).enabled).toBe(true);

    expect((await disableAlwaysOn()).ok).toBe(true);
    const off = await readSettings();
    expect(off).toEqual({ model: "opus", env: { MY_VAR: "mine" }, permissions: { allow: ["Bash(ls)"] } });
    expect((await alwaysOnStatus()).enabled).toBe(false);
  });

  it("leaves a key the user changed afterwards, because it is theirs now", async () => {
    await enableAlwaysOn();
    const on = await readSettings();
    on.env!.OTEL_LOG_USER_PROMPTS = "1";
    await writeSettings(on);

    await disableAlwaysOn();
    const off = await readSettings();
    expect(off.env!.OTEL_LOG_USER_PROMPTS).toBe("1");
    expect(off.env!.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
  });

  it("refuses to take over telemetry the user already sends somewhere else", async () => {
    await writeSettings({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com" } });
    const result = await enableAlwaysOn();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("conflict");
    expect((await readSettings()).env).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com" });
    expect((await alwaysOnStatus()).enabled).toBe(false);
  });

  it("will not touch a settings file it cannot parse", async () => {
    await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    await writeFile(settingsFile(), "{ this is not json", "utf8");
    const result = await enableAlwaysOn();
    expect(result.ok === false && result.reason).toBe("settings_unreadable");
    expect(await readFile(settingsFile(), "utf8")).toBe("{ this is not json");
  });

  it("creates the settings file when Claude Code has none yet, and keeps the same key when turned on twice", async () => {
    await enableAlwaysOn();
    const first = (await readSettings()).env!.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
    await enableAlwaysOn();
    expect((await readSettings()).env!.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe(first);
  });
});

describe("the fixed-port receiver", () => {
  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  const body = JSON.stringify({ resourceLogs: [] });

  it("accepts Claude Code's key header and nothing else", async () => {
    const port = await freePort();
    const receiver = await startTelemetryReceiver(() => undefined, { port, headerKey: "the-key" });
    try {
      const url = `http://127.0.0.1:${port}/v1/logs`;
      const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json", [ALWAYS_ON_HEADER]: "the-key" }, body });
      expect(ok.status).toBe(200);
      const wrong = await fetch(url, { method: "POST", headers: { "content-type": "application/json", [ALWAYS_ON_HEADER]: "guess" }, body });
      expect(wrong.status).toBe(401);
      const bearer = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${receiver.sessionSecret}` }, body });
      expect(bearer.status).toBe(401);
    } finally {
      await receiver.close();
    }
  });

  it("refuses any request a browser page makes, even with the right key", async () => {
    const port = await freePort();
    const receiver = await startTelemetryReceiver(() => undefined, { port, headerKey: "the-key" });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json", [ALWAYS_ON_HEADER]: "the-key", origin: "https://evil.example" },
        body,
      });
      expect(response.status).toBe(403);
    } finally {
      await receiver.close();
    }
  });

  it("reports a busy port instead of crashing", async () => {
    const port = await freePort();
    const first = await startTelemetryReceiver(() => undefined, { port, headerKey: "a" });
    try {
      await expect(startTelemetryReceiver(() => undefined, { port, headerKey: "b" })).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});


describe("the always-on service, end to end", () => {
  it("receives a real Claude Code export, keeps the numbers, drops the person, and uploads it", async () => {
    const { createAlwaysOnService } = await import("./always-on-service.js");
    const { generateKeyPairSync, sign } = await import("node:crypto");
    await enableAlwaysOn();

    const pair = generateKeyPairSync("ed25519");
    const uploads: unknown[] = [];
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const service = createAlwaysOnService({
      port,
      loadCredential: async () => ({ token: "usgm_test", deviceId: "device-1", deviceName: "PC", serverUrl: "https://usage.invalid" }),
      loadDeviceKey: async () => ({
        publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        sign: (payload: string) => sign(null, Buffer.from(payload), pair.privateKey).toString("base64"),
      }),
      upload: async (_url, _token, batch) => {
        uploads.push(...batch);
        return { accepted: batch.length, duplicate: 0, rejected: 0 };
      },
    });
    await service.refresh();
    expect(service.state().listening).toBe("listening");

    const key = (await alwaysOnStatus()).receiverKey!;
    const attr = (k: string, v: string | number) => ({ key: k, value: typeof v === "number" ? { intValue: v } : { stringValue: v } });
    const exportBody = {
      resourceLogs: [{
        resource: { attributes: [attr("service.name", "claude-code")] },
        scopeLogs: [{
          scope: { name: "com.anthropic.claude_code.events" },
          logRecords: [{
            timeUnixNano: String(Date.now()) + "000000",
            body: { stringValue: "claude_code.api_request" },
            attributes: [
              attr("event.name", "api_request"),
              attr("user.email", "someone@example.com"),
              attr("prompt", "SECRET PROMPT"),
              attr("model", "claude-sonnet-5"),
              attr("input_tokens", 1500),
              attr("output_tokens", 240),
              attr("cache_read_tokens", 800),
              attr("cache_creation_tokens", 100),
              attr("request_id", "req_everywhere_1"),
            ],
          }],
        }],
      }],
    };
    const response = await fetch("http://127.0.0.1:" + port + "/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json", [ALWAYS_ON_HEADER]: key },
      body: JSON.stringify(exportBody),
    });
    expect(response.status).toBe(200);
    await service.idle();

    expect(uploads).toHaveLength(1);
    const sent = JSON.stringify(uploads);
    expect(sent).toContain("req_everywhere_1");
    expect(sent).toContain("1500");
    expect(sent).not.toContain("SECRET PROMPT");
    expect(sent).not.toContain("someone@example.com");
    expect(service.state().eventsSinceStart).toBe(1);

    // Turning the switch off stops the receiver.
    await disableAlwaysOn();
    await service.refresh();
    expect(service.state().listening).toBe("off");
  }, 30_000);
});

describe("content and identity never reach the buffer or the upload", () => {
  it("drops prompts, responses, tool content, account identity and skill/MCP/plugin names from real Claude Code records", async () => {
    const { createAlwaysOnService } = await import("./always-on-service.js");
    const { pending } = await import("./buffer.js");
    const { OBSERVATION_FIELDS } = await import("./observation.js");
    const { generateKeyPairSync, sign } = await import("node:crypto");
    await enableAlwaysOn();

    // Everything Claude Code can put on a record, per its monitoring docs, that
    // is not compute metadata -- including what it sends with every content
    // switch off (user.email, organization.id, account ids, skill.name, ...).
    const CONTENT: Record<string, string> = {
      prompt: "SECRET PROMPT refactor auth, password hunter2",
      user_prompt: "SECRET USER PROMPT text",
      body: "SECRET RAW BODY {\"messages\":[]}",
      tool_input: "SECRET TOOL INPUT rm -rf ~/.ssh",
      tool_parameters: "SECRET TOOL PARAMETERS C:\\\\Users\\\\denis\\\\project",
      response: "SECRET MODEL RESPONSE here is the code",
      content: "SECRET CONTENT const API_KEY = 1",
      "user.email": "someone.private@example.com",
      "user.id": "SECRET-user-id-hash",
      "organization.id": "SECRET-org-7f3a",
      "user.account_uuid": "SECRET-account-uuid-1",
      "user.account_id": "SECRET-account-id-2",
      "session.id": "SECRET-session-id-3",
      "skill.name": "SECRET-my-private-skill",
      "agent.name": "SECRET-my-agent",
      "plugin.name": "SECRET-my-plugin",
      "marketplace.name": "SECRET-my-marketplace",
      "mcp_server.name": "SECRET-internal-mcp-server",
      "mcp_tool.name": "SECRET-internal-mcp-tool",
      "vcs.repository.url": "https://github.com/SECRET/private-repo",
      "vcs.branch": "SECRET-feature-branch",
    };
    const attr = (k: string, v: string | number) => ({ key: k, value: typeof v === "number" ? { intValue: v } : { stringValue: v } });
    const time = String(Date.now()) + "000000";
    const exportBody = {
      resourceLogs: [{
        resource: { attributes: [attr("service.name", "claude-code"), attr("user.email", CONTENT["user.email"])] },
        scopeLogs: [{
          scope: { name: "com.anthropic.claude_code.events" },
          logRecords: [
            {
              timeUnixNano: time,
              body: { stringValue: CONTENT.user_prompt },
              attributes: [attr("event.name", "user_prompt"), attr("prompt", CONTENT.prompt), attr("prompt_length", 42), attr("input_tokens", 7), attr("output_tokens", 7)],
            },
            {
              timeUnixNano: time,
              body: { stringValue: CONTENT.body },
              attributes: [
                attr("event.name", "claude_code.api_request"),
                ...Object.entries(CONTENT).map(([k, v]) => attr(k, v)),
                attr("model", "claude-sonnet-5"),
                attr("input_tokens", 1500),
                attr("output_tokens", 240),
                attr("cache_read_tokens", 800),
                attr("cache_creation_tokens", 100),
                attr("duration_ms", 1234),
                attr("request_id", "req_privacy_1"),
              ],
            },
          ],
        }],
      }],
    };

    const pair = generateKeyPairSync("ed25519");
    const uploads: unknown[] = [];
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    let signedIn = false;
    const service = createAlwaysOnService({
      port,
      loadCredential: async () => (signedIn ? { token: "usgm_test", deviceId: "device-1", deviceName: "PC", serverUrl: "https://usage.invalid" } : null),
      loadDeviceKey: async () => ({
        publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        sign: (payload: string) => sign(null, Buffer.from(payload), pair.privateKey).toString("base64"),
      }),
      upload: async (_url, _token, batch) => {
        uploads.push(...batch);
        return { accepted: batch.length, duplicate: 0, rejected: 0 };
      },
    });
    await service.refresh();
    const key = (await alwaysOnStatus()).receiverKey!;
    const post = () => fetch("http://127.0.0.1:" + port + "/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json", [ALWAYS_ON_HEADER]: key },
      body: JSON.stringify(exportBody),
    });

    const assertClean = (value: unknown) => {
      const text = JSON.stringify(value);
      for (const [name, secret] of Object.entries(CONTENT)) expect(text, name).not.toContain(secret);
      expect(text).not.toContain("SECRET");
    };

    try {
      // Signed out: the observation goes to the offline buffer.
      expect((await post()).status).toBe(200);
      await service.idle();
      const buffered = await pending();
      expect(buffered).toHaveLength(1);
      expect(Object.keys(buffered[0]).sort()).toEqual([...OBSERVATION_FIELDS].sort());
      expect(buffered[0].upstreamRequestId).toBe("req_privacy_1");
      expect(buffered[0].cacheReadTokens).toBe(800);
      expect(buffered[0].cacheWriteTokens).toBe(100);
      assertClean(buffered);

      // Signed in: the same kind of record goes to the upload payload.
      signedIn = true;
      expect((await post()).status).toBe(200);
      await service.idle();
      expect(uploads.length).toBeGreaterThanOrEqual(1);
      for (const item of uploads as { observation: Record<string, unknown> }[]) {
        expect(Object.keys(item.observation).sort()).toEqual([...OBSERVATION_FIELDS].sort());
      }
      expect(JSON.stringify(uploads)).toContain("req_privacy_1");
      assertClean(uploads);
    } finally {
      await disableAlwaysOn();
      await service.refresh();
    }
  }, 30_000);
});

describe("putting back what was there", () => {
  it("restores a key the user already had, instead of deleting it", async () => {
    await writeSettings({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOG_USER_PROMPTS: "1", OTEL_METRICS_EXPORTER: "otlp" } });
    await enableAlwaysOn();
    const on = await readSettings();
    expect(on.env!.OTEL_LOG_USER_PROMPTS).toBe("0");
    // Their metrics pipeline is untouched while it is on.
    expect(on.env!.OTEL_METRICS_EXPORTER).toBe("otlp");

    await disableAlwaysOn();
    const off = await readSettings();
    expect(off.env).toEqual({ CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOG_USER_PROMPTS: "1", OTEL_METRICS_EXPORTER: "otlp" });
  });

  it("does not mistake its own values for the user's when turned on twice", async () => {
    await writeSettings({ env: {} });
    await enableAlwaysOn();
    await enableAlwaysOn();
    await disableAlwaysOn();
    const off = await readSettings();
    expect(off.env).toBeUndefined();
  });
});


describe("settings safety against a realistic settings.json", () => {
  // What a real, customised Claude Code settings file looks like: plugins,
  // hooks, MCP servers, a model, permissions, a status line, and env keys of
  // the user's own -- including a metrics exporter of theirs and a value for a
  // key USAGE also writes.
  const original = () => ({
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    model: "opus",
    permissions: { allow: ["Bash(npm run test:*)", "Read(~/projects/**)"], deny: ["Read(./.env)"], defaultMode: "acceptEdits" },
    enabledPlugins: { "superpowers@marketplace": true, "context7@marketplace": false },
    plugins: { marketplaces: ["github:someone/plugins"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node C:/hooks/guard.js", timeout: 5 }] }],
      Stop: [{ hooks: [{ type: "command", command: "powershell -File C:/hooks/notify.ps1" }] }],
    },
    mcpServers: { local: { command: "node", args: ["C:/mcp/server.js"], env: { MCP_TOKEN_FILE: "C:/mcp/token" } } },
    statusLine: { type: "command", command: "node C:/statusline.js", padding: 0 },
    includeCoAuthoredBy: false,
    env: {
      MY_PROJECT_ROOT: "C:/work",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://localhost:4318/v1/metrics",
      // The user already had this one; USAGE writes "0" while on and must put "1" back.
      OTEL_LOG_TOOL_DETAILS: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  });

  it("ON then OFF leaves the file exactly as it was", async () => {
    await writeSettings(original());
    expect((await enableAlwaysOn()).ok).toBe(true);
    const on = await readSettings();
    // Nothing of theirs moves while it is on, except the keys USAGE writes.
    const { env: onEnv, ...onRest } = on;
    const { env: origEnv, ...origRest } = original();
    expect(onRest).toEqual(origRest);
    expect(onEnv!.OTEL_METRICS_EXPORTER).toBe("otlp");
    expect(onEnv!.OTEL_LOG_TOOL_DETAILS).toBe("0");
    expect(onEnv!.MY_PROJECT_ROOT).toBe(origEnv.MY_PROJECT_ROOT);

    expect(await disableAlwaysOn()).toMatchObject({ ok: true, changed: true });
    expect(await readSettings()).toEqual(original());
    expect(await verifyAlwaysOn("off")).toEqual({ ok: true });
  });

  it("ON, OFF, ON, OFF ends where it started, with one stable receiver key", async () => {
    await writeSettings(original());
    await enableAlwaysOn();
    const key1 = (await alwaysOnStatus()).receiverKey;
    await disableAlwaysOn();
    await enableAlwaysOn();
    const key2 = (await alwaysOnStatus()).receiverKey;
    expect(key2).toBe(key1);
    expect((await readSettings()).env!.OTEL_LOG_TOOL_DETAILS).toBe("0");
    await disableAlwaysOn();
    expect(await readSettings()).toEqual(original());
  });

  it("OFF when already OFF changes nothing and does not rewrite the file", async () => {
    // Formatting the user chose (tabs, no trailing newline) survives, because
    // the file is not written at all.
    const text = JSON.stringify(original(), null, "\t");
    await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    await writeFile(settingsFile(), text, "utf8");
    expect(await disableAlwaysOn()).toMatchObject({ ok: true, changed: false });
    expect(await readFile(settingsFile(), "utf8")).toBe(text);

    // And after a real ON/OFF, a second OFF is a no-op too.
    await enableAlwaysOn();
    await disableAlwaysOn();
    const after = await readFile(settingsFile(), "utf8");
    expect(await disableAlwaysOn()).toMatchObject({ ok: true, changed: false });
    expect(await readFile(settingsFile(), "utf8")).toBe(after);
  });

  it("a key the user changed while ON keeps the user's value after OFF", async () => {
    await writeSettings(original());
    await enableAlwaysOn();
    const on = await readSettings();
    on.env!.OTEL_LOG_TOOL_DETAILS = "2";
    on.env!.OTEL_LOGS_EXPORTER = "console";
    on.model = "sonnet";
    await writeSettings(on);

    expect((await disableAlwaysOn()).ok).toBe(true);
    const off = await readSettings();
    expect(off.env!.OTEL_LOG_TOOL_DETAILS).toBe("2");
    expect(off.env!.OTEL_LOGS_EXPORTER).toBe("console");
    expect(off.model).toBe("sonnet");
    // Everything still exactly ours went.
    expect(off.env!.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    expect(off.env!.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBeUndefined();
    expect(await verifyAlwaysOn("off")).toEqual({ ok: true });
  });

  it("never overwrites a malformed settings.json, on the way on or off", async () => {
    await writeSettings(original());
    await enableAlwaysOn();
    const broken = '{ "model": "opus", "env": { "OTEL_LOGS_EXPORTER": "otlp", ';
    await writeFile(settingsFile(), broken, "utf8");

    const off = await disableAlwaysOn();
    expect(off.ok === false && off.reason).toBe("settings_unreadable");
    expect(await readFile(settingsFile(), "utf8")).toBe(broken);
    // Still on record as on: nothing claims it was turned off.
    expect((await alwaysOnStatus()).enabled).toBe(true);

    const on = await enableAlwaysOn();
    expect(on.ok === false && on.reason).toBe("settings_unreadable");
    expect(await readFile(settingsFile(), "utf8")).toBe(broken);

    // JSON that is not an object is just as foreign.
    await writeFile(settingsFile(), "[1, 2, 3]", "utf8");
    expect((await disableAlwaysOn()).ok).toBe(false);
    expect(await readFile(settingsFile(), "utf8")).toBe("[1, 2, 3]");
  });
});

describe("reading the switch back", () => {
  it("on means the record says on and every written key holds its value", async () => {
    await writeSettings({ env: { MINE: "x" } });
    await enableAlwaysOn();
    expect(await verifyAlwaysOn("on")).toEqual({ ok: true });
    expect((await verifyAlwaysOn("off")).ok).toBe(false);

    const on = await readSettings();
    delete on.env!.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    await writeSettings(on);
    expect(await verifyAlwaysOn("on")).toEqual({ ok: false, reason: "keys_missing", keys: ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] });
  });

  it("off fails while a key only USAGE would have written is still there, and OFF clears it", async () => {
    await writeSettings({ env: { MINE: "x" } });
    await enableAlwaysOn();
    const withKeys = await readSettings();
    await disableAlwaysOn();
    // An interrupted earlier switch: the record says off, the file still has ours.
    await writeSettings(withKeys);
    const check = await verifyAlwaysOn("off");
    expect(check.ok === false && check.reason).toBe("keys_remaining");
    expect(check.ok === false && check.keys).toContain("OTEL_EXPORTER_OTLP_LOGS_HEADERS");

    expect(await disableAlwaysOn()).toMatchObject({ ok: true, changed: true });
    expect(await readSettings()).toEqual({ env: { MINE: "x" } });
    expect(await verifyAlwaysOn("off")).toEqual({ ok: true });
  });

  it("does not count a value the user already had before as USAGE's", async () => {
    await writeSettings({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" } });
    await enableAlwaysOn();
    await disableAlwaysOn();
    expect((await readSettings()).env).toEqual({ CLAUDE_CODE_ENABLE_TELEMETRY: "1" });
    expect(await verifyAlwaysOn("off")).toEqual({ ok: true });
  });
});
