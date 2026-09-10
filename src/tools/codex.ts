import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { configDir } from "../secrets.js";
import {
  backupName,
  probeVersion,
  type EnableResult,
  type LocalToolAdapter,
  type RouteConfig,
  type RoutingState,
  type ToolDetection,
} from "./adapter.js";

/**
 * Codex.
 *
 * Configured through `~/.codex/config.toml`. Codex supports custom
 * OpenAI-compatible providers via a `[model_providers.<id>]` table, which is
 * exactly the shape USAGE's universal route serves:
 *
 *   model_provider = "usage"
 *
 *   [model_providers.usage]
 *   name = "USAGE"
 *   base_url = "<route>/v1"
 *   wire_api = "chat"
 *   env_key = "USAGE_MINER_TOKEN"
 *
 * `env_key` names the environment variable holding the credential rather than
 * embedding it, so the token never lands in a config file at all -- which is
 * the same promise the rest of the miner makes.
 *
 * HONEST LIMITATION: this adapter writes the documented configuration, and the
 * shape is verified against current Codex docs, but USAGE has not yet run a
 * live Codex session end to end. It is reported as EXPERIMENTAL rather than
 * claimed to work, and every change is backed up and reversible.
 *
 * The TOML is edited by block, not parsed: adding a TOML library to write four
 * keys would be a dependency for its own sake, and the block is delimited by
 * markers so removal is exact.
 */

interface CodexBackup {
  existed: boolean;
  text: string;
}

const PROVIDER_ID = "usage";
const BEGIN_MARKER = "# >>> USAGE Miner (managed) >>>";
const END_MARKER = "# <<< USAGE Miner (managed) <<<";

function codexDir(): string {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

function configPath(): string {
  return path.join(codexDir(), "config.toml");
}

function backupPath(): string {
  return path.join(configDir(), backupName("codex"));
}

async function readConfig(): Promise<{ text: string; existed: boolean }> {
  try {
    return { text: await readFile(configPath(), "utf8"), existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", existed: false };
    throw error;
  }
}

/** Everything USAGE wrote, delimited so it can be removed exactly. */
function managedBlock(route: RouteConfig): string {
  return [
    BEGIN_MARKER,
    "# Written by USAGE Miner. Remove with: usage disable codex",
    `model_provider = "${PROVIDER_ID}"`,
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = "USAGE (${route.label})"`,
    `base_url = "${route.url}/v1"`,
    `wire_api = "chat"`,
    `env_key = "USAGE_MINER_TOKEN"`,
    END_MARKER,
    "",
  ].join("\n");
}

function stripManagedBlock(text: string): string {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return text;
  return `${text.slice(0, begin)}${text.slice(end + END_MARKER.length)}`.replace(/\n{3,}/g, "\n\n");
}

/** A `model_provider` set outside our block belongs to the user. */
function foreignProvider(text: string): string | null {
  const withoutOurs = stripManagedBlock(text);
  const match = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(withoutOurs);
  return match ? match[1] : null;
}

export const codexAdapter: LocalToolAdapter = {
  id: "codex",
  displayName: "Codex",
  protocol: "openai_compatible",

  /**
   * Safe, and kept that way.
   *
   * Codex's config names the credential (`env_key = "USAGE_MINER_TOKEN"`)
   * rather than containing it, so persistent configuration here writes no
   * secret to disk. Claude Code's limitation is Claude Code's; there is no
   * reason to inflict it on a tool that got this right.
   *
   * Persistent mode still needs the variable to be set when Codex runs, which
   * is what the launcher does -- so `usage run codex` remains the reliable path
   * and the reason both modes exist.
   */
  persistentConfig: "safe",

  capabilities() {
    return {
      meteringMethods: ["native_otel", "routed"],
      // codex-rs/otel/src/events/session_telemetry.rs and a real wire capture
      // of 0.153.3: codex.sse_event(response.completed) carries the token
      // counts, and `model` rides on every event as a shared attribute. No
      // request or response id anywhere. Counts and a model without an
      // identity are analytics, and are labelled so.
      reads: ["model", "tokens", "cache", "reasoning"],
      verificationCeiling: "local_observed",
      availabilityNote:
        "Codex telemetry reports the model and token counts but no request id, so usage is tracked but cannot be correlated or verified. Routing through USAGE is the stronger option.",
      experimental: true,
    };
  },

  privacyProfile() {
    return {
      reads: ["Token counts (input, output, cached, cache write, reasoning, tool)", "Timing"],
      neverReads: ["Prompts", "Responses", "Tool arguments and output", "File paths", "Source code"],
    };
  },

  /**
   * Codex is configured through `-c key=value` overrides, which live for one
   * invocation -- the same session-scoped property the environment gives the
   * other tools. `log_user_prompt` is set false explicitly; its default is not
   * documented, and undocumented defaults are not privacy controls.
   */
  telemetryLaunch(receiver) {
    return {
      env: {},
      args: [
        "-c", 'otel.exporter="otlp-http"',
        "-c", `otel.exporter.otlp-http.endpoint="${receiver.endpoint}/v1/logs"`,
        "-c", 'otel.exporter.otlp-http.protocol="json"',
        "-c", `otel.exporter.otlp-http.headers.Authorization="Bearer ${receiver.sessionSecret}"`,
        "-c", "otel.log_user_prompt=false",
        "-c", 'otel.metrics_exporter="none"',
        "-c", 'otel.trace_exporter="none"',
      ],
    };
  },

  launchPlan(route: RouteConfig) {
    return {
      command: "codex",
      env: {
        USAGE_MINER_TOKEN: route.minerToken,
        // Codex reads its endpoint from config, not the environment; this is
        // recorded so a launched session is self-describing rather than
        // depending on a config file having been written earlier.
        USAGE_ROUTE_URL: route.url,
      },
    };
  },

  async detect(): Promise<ToolDetection> {
    // "codex-cli 0.153.3" -> "0.153.3". Through probeVersion, because the npm
    // shim is a .cmd on Windows and a bare execFile never finds it.
    const text = await probeVersion("codex");
    return { installed: text !== null, version: text?.split(/\s+/).pop() ?? null, configPath: configPath() };
  },

  async inspectRouting(): Promise<RoutingState> {
    let config: { text: string; existed: boolean };
    try {
      config = await readConfig();
    } catch (error) {
      return { state: "unreadable", reason: (error as Error).message };
    }
    if (!config.existed) return { state: "off" };

    if (config.text.includes(BEGIN_MARKER)) {
      const match = /base_url\s*=\s*"([^"]+)"/.exec(config.text);
      return { state: "usage", url: match?.[1] ?? "USAGE" };
    }

    const foreign = foreignProvider(config.text);
    return foreign ? { state: "foreign", url: foreign } : { state: "off" };
  },

  async enableMining(route: RouteConfig, force = false): Promise<EnableResult> {
    const config = await readConfig();

    const foreign = foreignProvider(config.text);
    if (foreign && !force) {
      return {
        ok: false,
        requiresConfirmation: true,
        message: `Codex already uses the "${foreign}" provider. Enabling USAGE will change that. Re-run with --force to confirm.`,
      };
    }

    await mkdir(configDir(), { recursive: true });
    await writeFile(
      backupPath(),
      JSON.stringify({ existed: config.existed, text: config.text }, null, 2),
      "utf8",
    );

    // Replace any previous managed block rather than stacking them.
    const body = stripManagedBlock(config.text).trimEnd();
    const next = body ? `${body}\n\n${managedBlock(route)}` : managedBlock(route);

    await mkdir(codexDir(), { recursive: true });
    await writeFile(configPath(), next, "utf8");

    return {
      ok: true,
      message: `Codex now mines through ${route.label}. Start it with "usage run codex" so it receives the credential.`,
    };
  },

  async disableMining(): Promise<EnableResult> {
    let backup: CodexBackup | null = null;
    try {
      backup = JSON.parse(await readFile(backupPath(), "utf8")) as CodexBackup;
    } catch {
      backup = null;
    }

    if (backup) {
      if (!backup.existed) {
        await rm(configPath(), { force: true });
      } else {
        await writeFile(configPath(), backup.text, "utf8");
      }
      await rm(backupPath(), { force: true });
      return { ok: true, message: "Codex configuration restored to what it was before." };
    }

    // Nothing of ours is in there. Say so and touch nothing -- `disable` is
    // called unconditionally by the uninstaller, and rewriting a file USAGE
    // never wrote would reformat somebody else's configuration for no reason.
    const routing = await this.inspectRouting();
    if (routing.state !== "usage") {
      return { ok: true, message: "Codex was not configured by USAGE." };
    }

    // No rollback copy: remove only our delimited block.
    const config = await readConfig();
    if (!config.existed) return { ok: true, message: "Codex was not configured by USAGE." };
    await writeFile(configPath(), stripManagedBlock(config.text).trimEnd() + "\n", "utf8");
    return { ok: true, message: "Codex no longer routes through USAGE." };
  },

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const routing = await this.inspectRouting();
    if (routing.state === "usage") return { ok: true, detail: `Routing to ${routing.url}` };
    if (routing.state === "off") return { ok: false, detail: "Mining is not enabled." };
    if (routing.state === "foreign") {
      return { ok: false, detail: `Using the "${routing.url}" provider, which is not USAGE.` };
    }
    return { ok: false, detail: routing.reason };
  },
};

export const CODEX_MANAGED_MARKERS = { BEGIN_MARKER, END_MARKER, stripManagedBlock, foreignProvider };
