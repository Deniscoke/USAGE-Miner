import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexAdapter, scanCodexConfigText } from "./codex.js";
import { geminiCliAdapter, geminiSettingsPaths, scanGeminiSettingsText } from "./gemini-cli.js";
import { claudeCodeAdapter } from "./claude-code.js";

/**
 * M17B: how each app is told to send telemetry to the loopback receiver, and
 * the checks that refuse to track when the user's own configuration would make
 * that unsafe or pointless. Source references are in docs/COVERAGE.md.
 */

const receiver = { endpoint: "http://127.0.0.1:55555", sessionSecret: "sess-secret-abc" };

describe("Codex telemetry launch (rust-v0.153.3)", () => {
  const launch = codexAdapter.telemetryLaunch(receiver)!;
  const overrides = launch.args.filter((_, i) => launch.args[i - 1] === "-c");

  it("is -c overrides only, one per value, nothing in the environment", () => {
    expect(launch.env).toEqual({});
    expect(launch.args.length).toBe(overrides.length * 2);
  });

  it("names the otlp-http exporter table directly, with the verbatim /v1/logs endpoint and JSON", () => {
    expect(overrides).toContain(`otel.exporter.otlp-http.endpoint="${receiver.endpoint}/v1/logs"`);
    expect(overrides).toContain('otel.exporter.otlp-http.protocol="json"');
    expect(overrides).toContain(`otel.exporter.otlp-http.headers.Authorization="Bearer ${receiver.sessionSecret}"`);
    // The string form was a no-op overwritten by the table, and order-fragile.
    expect(overrides.some((o) => o.startsWith("otel.exporter="))).toBe(false);
  });

  it("forces prompt logging off as a TOML boolean and sends no metrics or traces", () => {
    expect(overrides).toContain("otel.log_user_prompt=false");
    expect(overrides).toContain('otel.metrics_exporter="none"');
    expect(overrides).toContain('otel.trace_exporter="none"');
  });

  it("carries no USAGE credential and no provider routing", () => {
    expect(JSON.stringify(launch)).not.toMatch(/usgm_|usgr_|model_provider/);
  });
});

describe("Codex config presence checks", () => {
  it("finds prompt logging turned on, in a table or dotted, but not in a comment", () => {
    expect(scanCodexConfigText("[otel]\nlog_user_prompt = true\n").logUserPrompt).toBe(true);
    expect(scanCodexConfigText("otel.log_user_prompt=true").logUserPrompt).toBe(true);
    expect(scanCodexConfigText("otel = { log_user_prompt = true }").logUserPrompt).toBe(true);
    expect(scanCodexConfigText("[otel]\nlog_user_prompt = false\n").logUserPrompt).toBe(false);
    expect(scanCodexConfigText("# log_user_prompt = true\n").logUserPrompt).toBe(false);
  });

  it("finds an exporter the session's otlp-http table cannot be merged with", () => {
    expect(scanCodexConfigText('[otel]\nexporter = { otlp-grpc = { endpoint = "https://x" } }').conflictingExporter).toBe(true);
    expect(scanCodexConfigText('[otel.exporter.otlp-http.tls]\nca-certificate = "ca.pem"').conflictingExporter).toBe(true);
    expect(scanCodexConfigText('model = "gpt-5.5-codex"\n[otel]\nexporter = "none"').conflictingExporter).toBe(false);
  });
});

describe("Gemini CLI telemetry launch (v0.60.0)", () => {
  const launch = geminiCliAdapter.telemetryLaunch(receiver)!;

  it("turns prompts, traces and resource detectors off with values Gemini parses as off", () => {
    // parseBooleanEnvFlag: only "true" and "1" are on; any defined value beats settings.json.
    expect(launch.env.GEMINI_TELEMETRY_LOG_PROMPTS).toBe("false");
    expect(launch.env.GEMINI_TELEMETRY_TRACES_ENABLED).toBe("false");
    expect(launch.env.GEMINI_TELEMETRY_USE_COLLECTOR).toBe("false");
    expect(launch.env.GEMINI_TELEMETRY_USE_CLI_AUTH).toBe("false");
    // The process detector would export `gemini -p "<prompt>"` as process.command_args.
    expect(launch.env.OTEL_NODE_RESOURCE_DETECTORS).toBe("none");
  });

  it("sends OTLP/HTTP to the bare loopback origin, which Gemini extends with /v1/logs itself", () => {
    expect(launch.env.GEMINI_TELEMETRY_ENABLED).toBe("true");
    expect(launch.env.GEMINI_TELEMETRY_TARGET).toBe("local");
    expect(launch.env.GEMINI_TELEMETRY_OTLP_PROTOCOL).toBe("http");
    expect(launch.env.GEMINI_TELEMETRY_OTLP_ENDPOINT).toBe(receiver.endpoint);
    expect(launch.env.GEMINI_TELEMETRY_OTLP_ENDPOINT).not.toMatch(/\/v1\//);
    expect(launch.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${receiver.sessionSecret}`);
  });

  it("removes an inherited outfile and per-signal headers from the child", () => {
    expect(launch.unsetEnv).toEqual(expect.arrayContaining(["GEMINI_TELEMETRY_OUTFILE", "OTEL_EXPORTER_OTLP_LOGS_HEADERS"]));
  });
});

describe("Gemini settings presence checks", () => {
  it("treats anything but a literal false as prompt logging on", () => {
    expect(scanGeminiSettingsText('{ "telemetry": { "logPrompts": true } }').logPrompts).toBe(true);
    expect(scanGeminiSettingsText('{ "telemetry": { "logPrompts": "$LOG" } }').logPrompts).toBe(true);
    expect(scanGeminiSettingsText('{ "telemetry": { "logPrompts": false } }').logPrompts).toBe(false);
    expect(scanGeminiSettingsText('{ "telemetry": { "enabled": true } }').logPrompts).toBe(false);
  });

  it("finds a telemetry outfile", () => {
    expect(scanGeminiSettingsText('{ "telemetry": { "outfile": "C:/t.log" } }').outfile).toBe(true);
    expect(scanGeminiSettingsText('{ "telemetry": { "outfile": "" } }').outfile).toBe(false);
  });

  it("reads the user, workspace, system and system-defaults files, honouring Gemini's path overrides", () => {
    const paths = geminiSettingsPaths("C:\\work", { GEMINI_CLI_HOME: "C:\\home", GEMINI_CLI_SYSTEM_SETTINGS_PATH: "C:\\sys\\settings.json" });
    expect(paths).toEqual([
      path.join("C:\\home", ".gemini", "settings.json"),
      path.join("C:\\work", ".gemini", "settings.json"),
      "C:\\sys\\settings.json",
      path.join("C:\\sys", "system-defaults.json"),
    ]);
  });
});

describe("preflight against real files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "usage-preflight-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const geminiEnv = () => ({
    GEMINI_CLI_HOME: path.join(dir, "home"),
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(dir, "system", "settings.json"),
  });

  it("Gemini: allows a clean machine", async () => {
    expect(await geminiCliAdapter.telemetryPreflight!({ cwd: path.join(dir, "work"), env: geminiEnv() })).toEqual({ ok: true });
  });

  it("Gemini: refuses workspace settings that turn prompt logging on, naming the file", async () => {
    const file = path.join(dir, "work", ".gemini", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{\n  // comments are allowed here\n  "telemetry": { "logPrompts": true }\n}', "utf8");
    const result = await geminiCliAdapter.telemetryPreflight!({ cwd: path.join(dir, "work"), env: geminiEnv() });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(file);
    expect(!result.ok && result.message).toMatch(/logPrompts/);
  });

  it("Gemini: refuses a system settings outfile, which would leave USAGE receiving nothing", async () => {
    const file = path.join(dir, "system", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ "telemetry": { "outfile": "C:/ProgramData/gemini.log" } }', "utf8");
    const result = await geminiCliAdapter.telemetryPreflight!({ cwd: path.join(dir, "work"), env: geminiEnv() });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/outfile/);
  });

  it("Codex: refuses prompt logging and a conflicting exporter, allows an ordinary config", async () => {
    const env = { CODEX_HOME: dir };
    await writeFile(path.join(dir, "config.toml"), 'model = "gpt-5.5-codex"\n[otel]\nenvironment = "dev"\n', "utf8");
    expect(await codexAdapter.telemetryPreflight!({ cwd: dir, env })).toEqual({ ok: true });

    await writeFile(path.join(dir, "config.toml"), "[otel]\nlog_user_prompt = true\n", "utf8");
    const prompts = await codexAdapter.telemetryPreflight!({ cwd: dir, env });
    expect(prompts.ok).toBe(false);

    await writeFile(path.join(dir, "config.toml"), "", "utf8");
    await writeFile(path.join(dir, "managed_config.toml"), '[otel.exporter.otlp-grpc]\nendpoint = "https://collector"\n', "utf8");
    const grpc = await codexAdapter.telemetryPreflight!({ cwd: dir, env });
    expect(grpc.ok).toBe(false);
    expect(!grpc.ok && grpc.message).toMatch(/otlp-grpc/);
  });

  it("Claude Code needs no preflight: its content switches are environment only", () => {
    expect(claudeCodeAdapter.telemetryPreflight).toBeUndefined();
  });
});
