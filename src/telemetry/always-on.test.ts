import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALWAYS_ON_HEADER, alwaysOnClaudeEnv, alwaysOnStatus, disableAlwaysOn, enableAlwaysOn } from "./always-on.js";
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
