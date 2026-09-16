import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { probeVersion } from "./adapter.js";
import type {
  EnableResult,
  LocalToolAdapter,
  RoutingState,
  TelemetryPreflight,
  ToolDetection,
} from "./adapter.js";

/**
 * Gemini CLI.
 *
 * Metered through its official OpenTelemetry support -- docs/cli/telemetry.md
 * in google-gemini/gemini-cli -- and nothing else. USAGE does not route Gemini
 * traffic and does not edit its settings file: every setting below is an
 * environment variable applied to one launched session.
 *
 * Audited against v0.60.0 (docs/COVERAGE.md has the line references):
 *
 *   PRECEDENCE  packages/core/src/telemetry/config.ts resolves every telemetry
 *               setting as `env ?? settings.json`, and parses a boolean env var
 *               as `value === 'true' || value === '1'`. A defined env var --
 *               "false" included -- therefore beats every settings file (user,
 *               workspace and system). The old `--telemetry-*` flags are gone.
 *   DEFAULT     logPrompts defaults to TRUE (core/config/config.ts). Left
 *               alone, prompts (`prompt`), request contents (`request_text`),
 *               responses (`response_text`) and tool arguments
 *               (`function_args`) are all exported.
 *   ENDPOINT    with protocol "http" the exporter appends `/v1/logs`,
 *               `/v1/traces` and `/v1/metrics` to the endpoint itself, and
 *               encodes OTLP as JSON. So the endpoint is the bare origin.
 *   RESOURCE    the Node SDK's default process detector puts the full argv --
 *               `gemini -p "<prompt>"` -- in `process.command_args` on every
 *               export, whatever logPrompts says. OTEL_NODE_RESOURCE_DETECTORS
 *               =none turns the detectors off. (The receiver never reads
 *               resource attributes either.)
 *
 * So, for one launched session: telemetry on, prompts off, traces off, resource
 * detectors off, OTLP/HTTP JSON to the loopback receiver with the session
 * bearer. The receiver's allowlist would drop the content anyway -- the adapter
 * and the parser each refuse independently.
 *
 * The preflight is defence in depth on top of that precedence: a settings file
 * that turns prompt logging on is refused outright rather than trusted to lose,
 * because a precedence rule is a thing that changes in a release note. A
 * settings `outfile` is refused too: it outranks the endpoint, so the session
 * would export to a file and USAGE would receive nothing while saying it tracks.
 *
 * Gemini's `gemini_cli.api_response` event carries no upstream request id, so
 * nothing from this adapter can ever be correlated with an authoritative
 * record. It is honestly analytics: what the user did, on their own dashboard,
 * earning nothing.
 */

/** Where Gemini CLI reads settings from (packages/cli/src/config/settings.ts, v0.60.0). */
export function geminiSettingsPaths(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const home = env.GEMINI_CLI_HOME || homedir();
  const systemDir =
    process.platform === "win32"
      ? "C:\\ProgramData\\gemini-cli"
      : process.platform === "darwin"
        ? "/Library/Application Support/GeminiCli"
        : "/etc/gemini-cli";
  const system = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || path.join(systemDir, "settings.json");
  const systemDefaults = env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(system), "system-defaults.json");
  return [
    path.join(home, ".gemini", "settings.json"),
    path.join(cwd, ".gemini", "settings.json"),
    system,
    systemDefaults,
  ];
}

/**
 * Presence only. The file is searched for two keys and nothing else is read,
 * kept or logged -- a settings file can hold MCP server commands and API keys,
 * and none of that is the miner's business. A regex rather than a JSON parse,
 * because Gemini accepts comments in settings files and a parse failure must
 * not read as "safe".
 */
export function scanGeminiSettingsText(text: string): { logPrompts: boolean; outfile: boolean } {
  return {
    // Any value but a literal `false`: `true`, and also a string such as
    // "$VAR", which Gemini interpolates and then treats as truthy.
    logPrompts: /"logPrompts"\s*:\s*(?!false\b)\S/.test(text),
    outfile: /"outfile"\s*:\s*"[^"\s]/.test(text),
  };
}

export const geminiCliAdapter: LocalToolAdapter = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  protocol: "none",
  persistentConfig: "unsafe",

  capabilities() {
    return {
      meteringMethods: ["native_otel"],
      reads: ["model", "tokens", "cache", "reasoning"],
      verificationCeiling: "local_observed",
      availabilityNote: "Telemetry carries no request id, so usage is tracked but cannot be verified.",
      experimental: false,
    };
  },

  privacyProfile() {
    return {
      reads: ["Model", "Token counts (input, output, cached, thinking, tool)", "Timing"],
      neverReads: ["Prompts", "Responses", "Tool arguments", "File paths", "Source code", "Your email"],
    };
  },

  telemetryLaunch(receiver) {
    return {
      args: [],
      env: {
        GEMINI_TELEMETRY_ENABLED: "true",
        GEMINI_TELEMETRY_TARGET: "local",
        // The bare origin: Gemini appends /v1/logs itself for "http".
        GEMINI_TELEMETRY_OTLP_ENDPOINT: receiver.endpoint,
        GEMINI_TELEMETRY_OTLP_PROTOCOL: "http",
        // Exactly "false": Gemini treats only "true" and "1" as on, and any
        // defined value outranks settings.json.
        GEMINI_TELEMETRY_LOG_PROMPTS: "false",
        GEMINI_TELEMETRY_TRACES_ENABLED: "false",
        GEMINI_TELEMETRY_USE_COLLECTOR: "false",
        GEMINI_TELEMETRY_USE_CLI_AUTH: "false",
        // No host/process/env resource detectors: the process detector exports
        // the full command line, and `gemini -p "..."` puts a prompt there.
        OTEL_NODE_RESOURCE_DETECTORS: "none",
        // The JS OTLP exporters read this standard variable for the bearer.
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${receiver.sessionSecret}`,
      },
      // An inherited outfile outranks the endpoint; per-signal headers from the
      // user's shell would replace the session bearer.
      unsetEnv: ["GEMINI_TELEMETRY_OUTFILE", "OTEL_EXPORTER_OTLP_LOGS_HEADERS"],
    };
  },

  async telemetryPreflight({ cwd, env }): Promise<TelemetryPreflight> {
    for (const file of geminiSettingsPaths(cwd, env)) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const found = scanGeminiSettingsText(text);
      if (found.logPrompts) {
        return {
          ok: false,
          message:
            `Gemini CLI prompt logging is turned on in ${file} (telemetry.logPrompts). ` +
            "USAGE will not track Gemini CLI while that setting is on, even though it switches prompt logging off for its own session. " +
            "Remove telemetry.logPrompts or set it to false, then start tracking again.",
        };
      }
      if (found.outfile) {
        return {
          ok: false,
          message:
            `Gemini CLI telemetry is sent to a file by ${file} (telemetry.outfile), which outranks any endpoint, so USAGE would receive nothing. ` +
            "Remove telemetry.outfile to track Gemini CLI.",
        };
      }
    }
    return { ok: true };
  },

  launchPlan() {
    // No routing for Gemini: nothing to inject. The telemetry env is what
    // matters, and the launcher adds it separately.
    return { command: "gemini", env: {} };
  },

  async detect(): Promise<ToolDetection> {
    try {
      const text = await probeVersion("gemini");
      if (text === null) return { installed: false, version: null, configPath: "" };
      return { installed: true, version: text.split(/\s+/).pop() ?? null, configPath: "" };
    } catch {
      return { installed: false, version: null, configPath: "" };
    }
  },

  async inspectRouting(): Promise<RoutingState> {
    return { state: "off" };
  },

  async enableMining(): Promise<EnableResult> {
    return {
      ok: false,
      message: "Gemini CLI is tracked through its own telemetry when USAGE starts it. Nothing is configured persistently.",
    };
  },

  async disableMining(): Promise<EnableResult> {
    return { ok: true, message: "Gemini CLI was never configured by USAGE." };
  },

  async healthCheck() {
    return { ok: false, detail: "Tracked per session; nothing persistent to check." };
  },
};
