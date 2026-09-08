#!/usr/bin/env node
import { spawn } from "node:child_process";
import { hostname, platform, release } from "node:os";
import {
  DEFAULT_SERVER_URL,
  ApiError,
  fetchConfig,
  pollPairing,
  sendHeartbeat,
  startPairing,
  type MinerConfig,
  type MinerRoute,
} from "./api.js";
import { logEvent } from "./log.js";
import { migrateInsecureConfig } from "./migrate.js";
import {
  clearCredential,
  loadCredential,
  saveCredential,
  secureStorageAvailable,
  SecretStorageError,
  type StoredCredential,
} from "./secrets.js";
import { claudeCodeAdapter } from "./tools/claude-code.js";
import { codexAdapter } from "./tools/codex.js";
import type { LocalToolAdapter } from "./tools/adapter.js";
import { VERSION } from "./version.js";

/**
 * USAGE Miner.
 *
 *   usage sign-in     connect this device through the browser
 *   usage status      what is connected and what is mining
 *   usage enable      route a tool through USAGE
 *   usage disable     put the tool's configuration back
 *   usage run         start a tool with USAGE for this session only
 *   usage sign-out    forget this device's credential
 *
 * The user never sees a base URL, a header or a token. Those exist, they are
 * just not their problem.
 */

const ADAPTERS: LocalToolAdapter[] = [claudeCodeAdapter, codexAdapter];

function out(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function serverUrl(credential?: StoredCredential | null): string {
  return process.env.USAGE_SERVER_URL || credential?.serverUrl || DEFAULT_SERVER_URL;
}

function adapterFor(id: string): LocalToolAdapter | null {
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

async function requireCredential(): Promise<StoredCredential> {
  const credential = await loadCredential();
  if (!credential) {
    out("This device is not connected to USAGE.");
    out();
    out("  usage sign-in");
    process.exit(1);
  }
  return credential;
}

/** Pick the route a tool should use, preferring one that actually earns. */
function chooseRoute(config: MinerConfig, adapter: LocalToolAdapter): {
  url: string;
  label: string;
  eligibility: string;
  note?: string;
} | null {
  const tool = config.tools[adapter.id];
  if (!tool) return null;

  const routes: MinerRoute[] = tool.routes;
  const earning = routes.find((route) => route.miningEligibility === "eligible_route");
  const chosen = earning ?? routes[0];
  if (chosen) {
    return { url: chosen.url, label: chosen.label, eligibility: chosen.miningLabel };
  }
  if (tool.fallback) {
    return {
      url: tool.fallback.url,
      label: tool.fallback.label,
      eligibility: "Held",
      note: tool.fallback.note,
    };
  }
  return null;
}

// --------------------------------------------------------------- sign in

async function signIn(): Promise<void> {
  if (!secureStorageAvailable()) {
    out("USAGE Miner stores its credential using Windows DPAPI.");
    out("This beta is Windows-only; it will not write your credential in plain text elsewhere.");
    process.exit(1);
  }

  const url = serverUrl();
  const device = {
    deviceName: hostname(),
    platform: `${platform()} ${release()}`,
    appVersion: VERSION,
  };

  const started = await startPairing(url, device);

  out("");
  out("  Connect this device to USAGE");
  out("  ---------------------------");
  out("");
  out(`  1. Open  ${started.verificationUrlPlain}`);
  out(`  2. Enter code  ${started.userCode}`);
  out("");
  out("  Opening your browser…");
  out("");

  // Best effort. The printed URL is the real instruction.
  spawn("cmd", ["/c", "start", "", started.verificationUrl], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();

  const deadline = new Date(started.expiresAt).getTime();
  process.stdout.write("  Waiting for approval");

  while (Date.now() < deadline) {
    // Two seconds: responsive to a human, gentle on the server.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    process.stdout.write(".");

    const state = await pollPairing(url, started.pollToken).catch(() => null);
    if (!state) continue;

    if (state.status === "approved") {
      await saveCredential({
        token: state.token,
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        serverUrl: url,
      });
      await logEvent({ event: "sign_in", outcome: "ok" });
      out("");
      out("");
      out(`  Connected as ${state.deviceName}.`);
      out("");
      out("  Next:  usage status");
      return;
    }
    if (state.status === "denied") {
      out("\n\n  Rejected in the browser. Nothing was connected.");
      process.exit(1);
    }
    if (state.status === "expired") break;
  }

  await logEvent({ event: "sign_in", outcome: "error", detail: "expired" });
  out("\n\n  That code expired. Run `usage sign-in` again.");
  process.exit(1);
}

// ---------------------------------------------------------------- status

async function status(): Promise<void> {
  const credential = await requireCredential();
  // Cleanup runs where a user will see the result, not silently at startup.
  const migration = await migrateInsecureConfig();
  if (migration.changed) {
    out("");
    out(`  SECURITY UPDATE  ${migration.detail}`);
  }
  const config = await fetchConfig(serverUrl(credential), credential.token);

  out("");
  out("  USAGE MINER");
  out("");
  out(`  Device      ${credential.deviceName}`);
  out(`  Account     ${config.account.label}`);
  out(`  Network     ${config.mining.network}`);
  if (config.updateRequired) {
    out(`  Update      required (minimum ${config.minimumMinerVersion}, this is ${VERSION})`);
  }
  out("");

  if (config.routes.length === 0) {
    out("  No AI provider connected yet.");
    out("  Connect one at /providers — it takes one click for OpenRouter.");
    out("");
  } else {
    out("  CONNECTED PROVIDERS");
    for (const route of config.routes) {
      out(`    ${route.label.padEnd(24)} ${route.miningLabel}`);
    }
    out("");
  }

  out("  TOOLS");
  const enabled: string[] = [];
  for (const adapter of ADAPTERS) {
    const detection = await adapter.detect();
    if (!detection.installed) {
      out(`    ${adapter.displayName.padEnd(14)} not installed`);
      continue;
    }
    const routing = await adapter.inspectRouting();
    const state =
      routing.state === "usage"
        ? "MINING"
        : routing.state === "foreign"
          ? "custom endpoint (not USAGE)"
          : routing.state === "unreadable"
            ? "config unreadable"
            : "off";
    if (routing.state === "usage") enabled.push(adapter.id);
    out(
      `    ${adapter.displayName.padEnd(14)} installed${
        detection.version ? ` ${detection.version}` : ""
      }  ·  ${state}`,
    );
  }
  out("");
  out("  USAGE measures compute metadata, not your prompts.");
  out("");

  await sendHeartbeat(serverUrl(credential), credential.token, enabled).catch(() => undefined);
}

// ---------------------------------------------------------- enable/disable

async function enable(toolId: string, force: boolean): Promise<void> {
  const adapter = adapterFor(toolId);
  if (!adapter) {
    out(`Unknown tool: ${toolId}. Supported: ${ADAPTERS.map((a) => a.id).join(", ")}`);
    process.exit(1);
  }

  if (adapter.persistentConfig === "unsafe") {
    out("");
    out(`  ${adapter.displayName} is started by USAGE rather than configured.`);
    out("  That is deliberate: there is no way to configure it persistently");
    out("  without leaving a credential in a file on this machine.");
    out("");
    out(`  Use:  usage run ${adapter.id}`);
    out("");
    process.exit(1);
  }

  const credential = await requireCredential();
  const detection = await adapter.detect();
  if (!detection.installed) {
    await logEvent({ event: "enable", tool: adapter.id, outcome: "not_installed" });
    out(`${adapter.displayName} is not installed on this machine.`);
    process.exit(1);
  }

  const config = await fetchConfig(serverUrl(credential), credential.token);
  const route = chooseRoute(config, adapter);
  if (!route) {
    out(`No connected provider can carry ${adapter.displayName} yet.`);
    out("Connect one at /providers, then try again.");
    process.exit(1);
  }

  const result = await adapter.enableMining(
    { url: route.url, minerToken: credential.token, label: route.label },
    force,
  );

  if (!result.ok) {
    await logEvent({
      event: "enable",
      tool: adapter.id,
      outcome: result.requiresConfirmation ? "config_conflict" : "error",
      detail: result.message,
    });
    out(result.message);
    process.exit(1);
  }

  await logEvent({ event: "enable", tool: adapter.id, outcome: "ok" });
  out("");
  out(`  ${result.message}`);
  out(`  Mining: ${route.eligibility}`);
  if (route.note) out(`  ${route.note}`);
  out("");
  out(`  Use ${adapter.displayName} normally. Nothing else to do.`);
  out("");
}

async function disable(toolId: string): Promise<void> {
  const adapter = adapterFor(toolId);
  if (!adapter) {
    out(`Unknown tool: ${toolId}. Supported: ${ADAPTERS.map((a) => a.id).join(", ")}`);
    process.exit(1);
  }

  const result = await adapter.disableMining();
  await logEvent({
    event: "disable",
    tool: adapter.id,
    outcome: result.ok ? "ok" : "error",
    detail: result.message,
  });
  out(result.message);
  if (!result.ok) process.exit(1);
}

// ------------------------------------------------------------------- run

/**
 * Start a tool with USAGE for this session only.
 *
 * Nothing on the machine is changed: the routing lives in environment
 * variables that die with the child process. Safer than editing a config file,
 * and the right default for anyone who wants to try mining without committing.
 */
async function runTool(toolId: string, args: string[]): Promise<void> {
  const adapter = adapterFor(toolId);
  if (!adapter) {
    out(`Unknown tool: ${toolId}. Supported: ${ADAPTERS.map((a) => a.id).join(", ")}`);
    process.exit(1);
  }

  // Before anything is launched: if an older build left a credential on disk,
  // remove it and rotate. Launching first would mine with a token that is
  // still sitting in a plaintext file.
  const migration = await migrateInsecureConfig();
  if (migration.changed) out(`
  SECURITY UPDATE  ${migration.detail}`);

  const credential = await requireCredential();
  const config = await fetchConfig(serverUrl(credential), credential.token);
  const route = chooseRoute(config, adapter);
  if (!route) {
    out(`No connected provider can carry ${adapter.displayName} yet.`);
    process.exit(1);
  }

  // The adapter decides what the child needs. The credential exists only in
  // this environment object and in the child's process environment; nothing is
  // written to disk, and both die when the tool exits.
  const plan = adapter.launchPlan({
    url: route.url,
    minerToken: credential.token,
    label: route.label,
  });
  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env };

  out("");
  out(`  Starting ${adapter.displayName} with USAGE (${route.label}).`);
  out(`  Mining: ${route.eligibility}`);
  if (route.note) out(`  ${route.note}`);
  out("  Session only — no credential is written to disk.");
  out("");

  const child = spawn(plan.command, args, { stdio: "inherit", env, shell: true });

  // Drop this process's own references once the child holds its copy. It does
  // not scrub the string from the heap -- V8 offers no such guarantee, and
  // pretending otherwise would be theatre -- but nothing here keeps it alive
  // for the lifetime of a session that may run for hours.
  for (const key of Object.keys(plan.env)) delete plan.env[key];

  child.on("exit", (code) => process.exit(code ?? 0));
}

// ------------------------------------------------------------------ main

function help(): void {
  out(`
  USAGE Miner ${VERSION}

    usage sign-in              connect this device through your browser
    usage status               what is connected, and what is mining
    usage enable <tool>        route a tool through USAGE  (--force to override)
    usage disable <tool>       put the tool's configuration back
    usage run <tool> [args]    start a tool with USAGE for this session only
    usage sign-out             forget this device's credential

  Tools: ${ADAPTERS.map((adapter) => adapter.id).join(", ")}

  USAGE measures compute metadata, not your prompts.
`);
}

/**
 * Run one CLI command.
 *
 * Exported rather than run on import so the packaged desktop executable can
 * share this exact implementation: one binary, one code path, no second copy
 * of the pairing or tool logic to drift.
 */
export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const force = rest.includes("--force");
  const args = rest.filter((arg) => arg !== "--force");

  try {
    switch (command) {
      case "sign-in":
        await signIn();
        break;
      case "status":
        await status();
        break;
      case "enable":
        await enable(args[0] ?? "", force);
        break;
      case "disable":
        await disable(args[0] ?? "");
        break;
      case "run":
        await runTool(args[0] ?? "", args.slice(1));
        break;
      case "sign-out":
        await clearCredential();
        out("This device is no longer connected. Revoke it at /miners to be certain.");
        break;
      case "version":
        out(VERSION);
        break;
      default:
        help();
    }
  } catch (error) {
    if (error instanceof ApiError) {
      await logEvent({ event: command ?? "unknown", outcome: "error", detail: error.code });
      out(error.message);
      process.exit(1);
    }
    if (error instanceof SecretStorageError) {
      await logEvent({ event: command ?? "unknown", outcome: "error", detail: error.code });
      out(error.message);
      process.exit(1);
    }
    throw error;
  }
}
