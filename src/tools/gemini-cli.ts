import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  EnableResult,
  LocalToolAdapter,
  RoutingState,
  ToolDetection,
} from "./adapter.js";

const run = promisify(execFile);

/**
 * Gemini CLI.
 *
 * Metered through its official OpenTelemetry support -- docs/cli/telemetry.md
 * in google-gemini/gemini-cli -- and nothing else. USAGE does not route Gemini
 * traffic and does not edit its settings file: every setting below is an
 * environment variable applied to one launched session.
 *
 * Two of those settings are the reason this adapter exists at all:
 *
 *   GEMINI_TELEMETRY_LOG_PROMPTS=false    Gemini's default is TRUE. Left alone,
 *                                         every prompt would be sent to the
 *                                         collector as an attribute.
 *   GEMINI_TELEMETRY_TRACES_ENABLED=false Traces carry gen_ai.input.messages
 *                                         and gen_ai.output.messages.
 *
 * Both are set here, and the receiver's allowlist would drop the content anyway
 * -- the adapter and the parser each refuse independently, so a change in one
 * tool's defaults cannot turn USAGE into a prompt collector.
 *
 * Gemini's `gemini_cli.api_response` event carries no upstream request id, so
 * nothing from this adapter can ever be correlated with an authoritative
 * record. It is honestly analytics: what the user did, on their own dashboard,
 * earning nothing.
 */
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
        GEMINI_TELEMETRY_OTLP_ENDPOINT: receiver.endpoint,
        GEMINI_TELEMETRY_OTLP_PROTOCOL: "http",
        GEMINI_TELEMETRY_LOG_PROMPTS: "false",
        GEMINI_TELEMETRY_TRACES_ENABLED: "false",
        GEMINI_TELEMETRY_USE_COLLECTOR: "false",
        // The JS OTLP exporters read this standard variable for the bearer.
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${receiver.sessionSecret}`,
      },
    };
  },

  launchPlan() {
    // No routing for Gemini: nothing to inject. The telemetry env is what
    // matters, and the launcher adds it separately.
    return { command: "gemini", env: {} };
  },

  async detect(): Promise<ToolDetection> {
    try {
      const { stdout } = await run("gemini", ["--version"], { windowsHide: true, timeout: 10_000, shell: true });
      return { installed: true, version: stdout.trim().split(/\s+/).pop() ?? null, configPath: "" };
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
      message: "Gemini CLI is metered through its own telemetry when USAGE starts it. Nothing is configured persistently.",
    };
  },

  async disableMining(): Promise<EnableResult> {
    return { ok: true, message: "Gemini CLI was never configured by USAGE." };
  },

  async healthCheck() {
    return { ok: false, detail: "Metered per session; nothing persistent to check." };
  },
};
