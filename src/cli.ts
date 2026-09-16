#!/usr/bin/env node
import { spawn } from "node:child_process";
import { hostname, platform, release } from "node:os";
import {
  DEFAULT_SERVER_URL,
  ApiError,
  createRouteSession,
  fetchConfig,
  pollPairing,
  sendHeartbeat,
  startPairing,
  type RouteSession,
} from "./api.js";
import { chooseRoute } from "./route.js";
import { prepareUsageClaudeProfile } from "./tools/claude-profile.js";
import type { LaunchPlan } from "./tools/adapter.js";
import {
  childEnvironment,
  decideLaunch,
  directProviderLabel,
  notRoutedLine,
  TRACK_ONLY_EXPLANATION,
  wantsRouteSession,
  type RouteSessionOutcome,
} from "./launch.js";
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
import { geminiCliAdapter } from "./tools/gemini-cli.js";
import { cursorAdapter } from "./tools/cursor.js";
import type { LocalToolAdapter } from "./tools/adapter.js";
import { VERSION } from "./version.js";
import { isMapped, setMapped } from "./mappings.js";
import { loadDeviceKey } from "./device-key.js";
import { startMeteringSession } from "./telemetry/session.js";
import { setMapping, registerDeviceKey } from "./api.js";
import { startBackgroundLoop } from "./background.js";
import { disableAlwaysOn } from "./telemetry/always-on.js";
import { platform as osPlatform, release as osRelease } from "node:os";

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

const ADAPTERS: LocalToolAdapter[] = [claudeCodeAdapter, geminiCliAdapter, codexAdapter, cursorAdapter];

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
  // `label` is the credential's name, which for a paired device is the device
  // name -- printing it here repeated the line above and told nobody which
  // USAGE account this PC belongs to. `display` is the masked email.
  out(`  Account     ${config.account.display ?? config.account.label}`);
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
    // One line per CONNECTION, not per route. A connection that answers both
    // wire surfaces -- OpenRouter does -- produces two routes with the same id
    // and the same verdict, and listing both read as two separate accounts.
    const seen = new Set<string>();
    for (const route of config.routes) {
      if (seen.has(route.connectionId)) continue;
      seen.add(route.connectionId);
      const surfaces = config.routes
        .filter((other) => other.connectionId === route.connectionId)
        .map((other) => other.surfaceLabel ?? other.protocol)
        .join(", ");
      out(`    ${route.label.padEnd(24)} ${route.miningLabel}`);
      out(`    ${" ".repeat(24)} carries: ${surfaces}`);
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
    // A tool USAGE starts rather than configures has no persistent on/off to
    // report: its routing lives in the session USAGE launches and is gone when
    // that session ends. Printing "off" suggested something was switched off
    // and could be switched on, which is not how Claude Code works here.
    const launchOnly = adapter.persistentConfig === "unsafe";
    const meterable = !adapter.capabilities().meteringMethods.includes("unsupported");
    const reported =
      !meterable
        // Says what it is instead of implying a switch, and never invites
        // someone to route a tool USAGE cannot measure.
        ? "cannot be metered here"
        : launchOnly && routing.state !== "foreign"
          ? "start it with: usage run " + adapter.id
          : state;
    out(
      `    ${adapter.displayName.padEnd(14)} installed${
        detection.version ? ` ${detection.version}` : ""
      }  ·  ${reported}`,
    );
  }
  out("");
  out("  USAGE measures compute metadata, not your prompts.");
  out("");

  await sendHeartbeat(
    serverUrl(credential),
    credential.token,
    await heartbeatTools(credential.deviceId),
    `${osPlatform()} ${osRelease()}`,
    VERSION,
  ).catch(() => undefined);
}

/** Safe device state for the heartbeat: ids, versions, flags. Nothing else. */
async function heartbeatTools(deviceId: string) {
  const tools = [];
  for (const adapter of ADAPTERS) {
    const detection = await adapter.detect();
    tools.push({
      tool: adapter.id,
      version: detection.version,
      detected: detection.installed,
      mapped: await isMapped(deviceId, adapter.id),
    });
  }
  return tools;
}

// ------------------------------------------------------------------ map

/**
 * Opt a tool in to (or out of) metering.
 *
 * Two records, one decision: the device remembers it locally so the launcher
 * honours it, and the server records it so the web account shows it. The
 * server's response says how it will meter the tool and what the ceiling on
 * verification is -- the device never asserts either.
 */
async function map(toolId: string, enabled: boolean): Promise<void> {
  const adapter = adapterFor(toolId);
  if (!adapter) {
    out(`Unknown tool: ${toolId}. Supported: ${ADAPTERS.map((a) => a.id).join(", ")}`);
    process.exit(1);
  }
  const capabilities = adapter.capabilities();
  if (capabilities.meteringMethods.includes("unsupported")) {
    out(`${adapter.displayName} cannot be metered from this machine.`);
    if (capabilities.availabilityNote) out(`  ${capabilities.availabilityNote}`);
    process.exit(1);
  }

  const credential = await requireCredential();
  const detection = await adapter.detect();
  const response = await setMapping(
    serverUrl(credential),
    credential.token,
    adapter.id,
    enabled,
    detection.version,
  );
  await setMapped(credential.deviceId, adapter.id, enabled);
  await logEvent({ event: enabled ? "map" : "unmap", tool: adapter.id, outcome: "ok" });

  out("");
  out(`  ${adapter.displayName}: usage mapping ${enabled ? "ON" : "OFF"}`);
  if (enabled) {
    out(`  Metering:      ${response.meteringMethod}`);
    out(`  Verification:  ${response.verificationCapability}`);
    if (capabilities.availabilityNote) out(`  Note:          ${capabilities.availabilityNote}`);
  }
  out("");
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
  out(`  Reward: ${route.rewardStatus.toUpperCase()} — ${route.reason}`);
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

  // "Measure Claude Code everywhere" is Claude Code's too. The uninstaller runs
  // exactly this command, and settings left behind would keep every Claude
  // Code session exporting to a loopback port nothing of ours listens on --
  // one any other program could then bind.
  if (adapter.id === "claude-code") {
    const always = await disableAlwaysOn().catch(() => null);
    if (always && (always.ok ? always.changed : true)) out(always.message);
  }
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
async function runTool(toolId: string, rawArgs: string[]): Promise<void> {
  const noRoute = rawArgs.includes("--no-route");
  const args = rawArgs.filter((a) => a !== "--no-route");
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
  const detection = await adapter.detect();
  const mapped = await isMapped(credential.deviceId, adapter.id);
  const meterable = !adapter.capabilities().meteringMethods.includes("unsupported");

  // Routing, when the tool speaks a protocol USAGE can carry and the account
  // has a connection for it. Optional: a tool can be metered without being
  // routed, and the user may have connected nothing.
  // `--no-route`: meter only. Native telemetry does not need USAGE in the
  // request path, and a user may prefer their tool to talk to its provider
  // directly while still tracking usage. Routing stays the stronger proof.
  // Resolved FRESH, here, immediately before the spawn: the window's copy of
  // the configuration may be minutes old, and the route that is launched is
  // the one the server names now.
  const config = await fetchConfig(serverUrl(credential), credential.token);
  const route = adapter.protocol === "none" || noRoute ? null : chooseRoute(config, adapter);

  const extraArgs: string[] = [];
  let auth = "none";

  // A route session (M16C0): only for a connected provider route, only when
  // the server can mint one. The token lives in this object and the child's
  // environment, and expires on its own. For Claude Code it is REQUIRED: with
  // no session there is no routing at all (see launch.ts).
  let sessionOutcome: RouteSessionOutcome = { status: "not_attempted" };
  if (route && wantsRouteSession(adapter.id, route)) {
    if (!config.routeSessions?.available) {
      sessionOutcome = { status: "unavailable" };
    } else {
      try {
        const session: RouteSession = await createRouteSession(serverUrl(credential), credential.token, {
          tool: adapter.id,
          connectionId: route.connectionId!,
          surface: route.surface,
        });
        if (adapter.id === "codex") {
          // Codex needs no isolated profile: its provider comes from `-c`
          // overrides for this invocation, and its own login is never read.
          sessionOutcome = { status: "created", token: session.token, expiresAt: session.expiresAt };
          auth = "USAGE route session · routing only, bound to this connection · renewed while this window runs";
        } else {
          const profile = await prepareUsageClaudeProfile();
          sessionOutcome = { status: "created", token: session.token, expiresAt: session.expiresAt, profileDir: profile.dir };
          auth = "USAGE route session · renewed while this window runs · your Claude login is not used or changed" +
            (profile.unshared.length ? ` · not shared: ${profile.unshared.join(", ")}` : "");
          if (profile.removedSavedLogin) auth += " · a login saved inside the USAGE profile was removed";
        }
      } catch (error) {
        sessionOutcome = { status: "failed", reason: `route session failed: ${(error as Error).message}` };
      }
    }
  }
  if (route && adapter.id === "codex" && sessionOutcome.status !== "created") {
    auth = "this device's USAGE credential (no route session)";
  }

  const decision = decideLaunch({ toolId: adapter.id, route, minerToken: credential.token, session: sessionOutcome });

  // The adapter decides what the child needs. In a verified route the session
  // credential exists only in this environment object and in the child's
  // process environment; nothing is written to disk, and both die when the
  // tool exits. Track only hands the adapter nothing to route with.
  const plan: LaunchPlan = adapter.launchPlan(decision.routeConfig ?? { url: "", minerToken: "", label: "" });
  // What spawn() receives, with inherited subscription credentials removed from
  // a verified Claude route (launch.ts childEnvironment).
  const env = childEnvironment(adapter.id, process.env, plan.env);

  // Metering, when the user opted this tool in. The receiver gets its own
  // per-session secret; the miner credential is nowhere in the tool's
  // environment unless routing put it there for the provider header.
  let session: Awaited<ReturnType<typeof startMeteringSession>> | null = null;
  if (mapped && meterable && adapter.telemetryPreflight) {
    // Before any receiver exists: a user's own setting that would make the
    // tool export content is a refusal, not something to outrank and hope.
    const preflight = await adapter.telemetryPreflight({ cwd: process.cwd(), env: process.env });
    if (!preflight.ok) {
      await logEvent({ event: "launch", tool: adapter.id, outcome: "error", detail: "telemetry_preflight_refused" });
      out("");
      out(`  Tracking refused: ${preflight.message}`);
      out("");
      process.exit(1);
    }
  }
  if (mapped && meterable) {
    const key = await loadDeviceKey();
    await registerDeviceKey(serverUrl(credential), credential.token, key.publicKey).catch(() => undefined);
    session = await startMeteringSession({
      adapter,
      toolVersion: detection.version,
      serverUrl: serverUrl(credential),
      token: credential.token,
      key,
      deviceId: credential.deviceId,
      launchMode: decision.mode,
      onObservation: (o) => {
        const tokens = (o.inputTokens ?? 0) + (o.outputTokens ?? 0);
        out(`  [USAGE] tracked ${tokens.toLocaleString()} tokens${o.model ? ` · ${o.model}` : ""}${o.upstreamRequestId ? " · request id" : ""}`);
      },
    });
    const telemetry = adapter.telemetryLaunch({
      endpoint: session.receiver.endpoint,
      sessionSecret: session.receiver.sessionSecret,
    });
    if (telemetry) {
      for (const name of telemetry.unsetEnv ?? []) delete env[name];
      Object.assign(env, telemetry.env);
      extraArgs.push(...telemetry.args);
    }
  }

  out("");
  if (decision.mode === "verified_route" && route) {
    // Exactly what this launch will do, resolved seconds ago. No secrets.
    out(`  Mining: starting ${adapter.displayName} through a verified USAGE route.`);
    out(`  Selected route:  ${route.label} — your connected provider`);
    out(`  Verification:    VERIFIED ROUTE`);
    out(`  Reward:          ${route.rewardStatus.toUpperCase()} — ${route.reason}`);
    out(`  Wire protocol:   ${route.surfaceLabel}`);
    out(`  Auth:            ${auth}`);
    if (plan.env.ANTHROPIC_AUTH_TOKEN) {
      out("  Verify in Claude Code with /status: 'Anthropic base URL' must be the route above,");
      out("  and the credential line must read 'Auth token: ANTHROPIC_AUTH_TOKEN' — not a claude.ai account.");
    }
  } else {
    out(`  Tracking: starting ${adapter.displayName} with its own sign-in (Track only).`);
    if (decision.notRoutedReason) {
      out(`  ${notRoutedLine(adapter.displayName, decision.notRoutedReason)}`);
    } else if (noRoute) {
      out(`  Routing: not used — Track only was chosen. ${adapter.displayName} talks to ${directProviderLabel(adapter.id)} directly.`);
    } else {
      out(`  Routing: not used — no connected provider route for this tool. ${adapter.displayName} talks to ${directProviderLabel(adapter.id)} directly.`);
    }
    out("  Verification:    LOCAL ONLY");
    out("  Reward:          NOT ELIGIBLE");
    out(`  ${TRACK_ONLY_EXPLANATION}`);
  }
  out(`  Metering: ${session ? "on — usage is tracked from the tool's own telemetry" : mapped ? "unavailable for this tool" : "off — enable it with: usage map " + adapter.id}`);
  out("  Session only — no credential is written to disk.");
  out("");

  const child = spawn(plan.command, [...(plan.args ?? []), ...extraArgs, ...args], { stdio: "inherit", env, shell: true });

  // A launched session keeps the device visibly online for as long as the tool
  // runs. It used to send no heartbeat at all, so a PC mining for hours from a
  // console showed OFFLINE on the dashboard unless the window was also open.
  const presence = startBackgroundLoop({
    tick: async () => {
      await sendHeartbeat(
        credential.serverUrl,
        credential.token,
        [{ tool: adapter.id, version: detection.version ?? null, detected: detection.installed, mapped }],
        `${osPlatform()} ${osRelease()}`,
        VERSION,
      );
    },
  });

  // Drop this process's own references once the child holds its copy. It does
  // not scrub the string from the heap -- V8 offers no such guarantee, and
  // pretending otherwise would be theatre -- but nothing here keeps it alive
  // for the lifetime of a session that may run for hours.
  for (const key of Object.keys(plan.env)) delete plan.env[key];

  child.on("exit", async (code) => {
    presence.stop();
    if (session) {
      const summary = await session.end();
      out("");
      out(`  USAGE tracked ${summary.observed} request(s) this session` +
        (summary.buffered ? ` · ${summary.buffered} waiting to sync` : "") + ".");
    }
    process.exit(code ?? 0);
  });
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
                               (--no-route: Track only — own sign-in, local
                               telemetry, does not earn)
    usage map <tool>           allow USAGE to meter this tool (per-tool opt-in)
    usage unmap <tool>         stop metering this tool
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
/** Every command `runCli` understands. The packaged entry point must accept all of them. */
export const CLI_COMMAND_NAMES = ["sign-in", "status", "enable", "disable", "run", "map", "unmap", "sign-out", "version"] as const;

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
      case "map":
        await map(args[0] ?? "", true);
        break;
      case "unmap":
        await map(args[0] ?? "", false);
        break;
      case "sign-out":
        // Leaving the account also takes USAGE's settings out of Claude Code.
        await disableAlwaysOn().catch(() => null);
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
