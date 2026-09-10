import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The local tool boundary.
 *
 * A tool adapter knows one thing: how a specific AI client is configured to
 * talk to a different endpoint. Adding a tool means writing one adapter; the
 * miner core never learns tool-specific details.
 *
 * TWO RULES EVERY ADAPTER FOLLOWS.
 *
 * 1. NEVER DESTROY A USER'S CONFIGURATION. Read what is there, keep a rollback
 *    copy, make the smallest possible change, and put it back exactly on
 *    disable. If the tool already points somewhere custom, stop and ask -- a
 *    silent overwrite could redirect somebody's work to the wrong provider or
 *    the wrong bill.
 *
 * 2. NOTHING HERE IS REMOTELY STEERABLE. Adapters ship compiled into the miner.
 *    The server sends declarative routing values (a URL, a protocol, a
 *    connection id) and never anything that decides *what runs*.
 *
 * 3. A CREDENTIAL NEVER GOES INTO A FILE. Two ways to route a tool, and an
 *    adapter says which one it can honestly offer:
 *
 *    LAUNCHED   the miner starts the tool and puts the credential in that
 *               child process's environment. It exists while the tool runs and
 *               is gone when it exits. Nothing on disk.
 *
 *    CONFIGURED the tool's own config file is edited -- and may only reference
 *               a credential by name, never contain one. Codex can do this
 *               (`env_key`); Claude Code cannot, so it is launch-only.
 *
 *    An adapter that cannot configure without writing a secret must report
 *    `persistentConfig: "unsafe"` and refuse. That is not a limitation to work
 *    around; it is the rule being enforced.
 */

export type ToolId = "claude-code" | "codex" | "gemini-cli" | "cursor";

/**
 * How USAGE can meter a tool. Declared by the adapter, and the ONLY thing the
 * adapter declares about trust. Verification level and economic eligibility
 * are decided by the server from what it can itself corroborate.
 */
export type MeteringMethod =
  | "native_otel"
  | "routed"
  | "provider_import"
  | "local_observed"
  | "unsupported";

export interface ToolCapabilities {
  meteringMethods: readonly MeteringMethod[];
  /** Which observation fields the tool's telemetry actually supplies. */
  reads: readonly ("model" | "tokens" | "cache" | "reasoning" | "request_id" | "cost_estimate")[];
  /** Honest ceiling for the strongest evidence this tool can produce on its own. */
  verificationCeiling: "local_observed" | "provider_correlated" | "routed_confirmed";
  /** Shown to the user before they enable anything. */
  availabilityNote: string | null;
  experimental: boolean;
}

/**
 * What the miner does and does not read from this tool. Data-driven, so the
 * PRIVACY screen and the website render the same truth from the same source.
 */
export interface PrivacyProfile {
  reads: readonly string[];
  neverReads: readonly string[];
}

/** Environment and arguments that turn a tool's telemetry toward the receiver. */
export interface TelemetryLaunch {
  env: Record<string, string>;
  /** Extra command-line arguments, for tools configured that way (Codex `-c`). */
  args: readonly string[];
}

export interface ToolDetection {
  installed: boolean;
  /** Version string when the tool reports one, else null. */
  version: string | null;
  /** Where its configuration lives, for the UI to explain what will change. */
  configPath: string;
}

export type RoutingState =
  | { state: "off" }
  | { state: "usage"; url: string }
  /** Pointed somewhere that is not USAGE. Never overwritten without consent. */
  | { state: "foreign"; url: string }
  | { state: "unreadable"; reason: string };

export interface RouteConfig {
  /** Where the tool should send requests. Non-secret. */
  url: string;
  /** The device's own scoped credential. Never a provider key. */
  minerToken: string;
  /** Shown to the user so they know which connection they are mining through. */
  label: string;
  /** Registry family of the connection ("openrouter"), when routed to one. */
  providerFamily?: string | null;
  /** The wire surface the tool speaks on this route. */
  surface?: "anthropic_compatible" | "openai_compatible";
  /**
   * A route session (M16C0): a short-lived USAGE credential bound to this
   * route, plus the isolated Claude profile it is launched in. When present,
   * the tool authenticates to USAGE with it instead of carrying the device
   * credential in a custom header, and the user's own login is not used.
   */
  session?: { token: string; expiresAt: string; profileDir: string };
}

export interface EnableResult {
  ok: boolean;
  /** Set when the tool already had a custom endpoint and consent is needed. */
  requiresConfirmation?: boolean;
  message: string;
}

/**
 * Whether this tool can be routed by editing its config file.
 *
 *   "safe"    its config can name a credential rather than contain one
 *   "unsafe"  routing it persistently would mean writing a secret to disk
 */
export type PersistentConfigSupport = "safe" | "unsafe";

/** How the miner starts a tool for one session. */
export interface LaunchPlan {
  /** The executable to run. Fixed per adapter, never server-supplied. */
  command: string;
  /**
   * Environment for the child only. Carries the credential, and dies with the
   * process -- which is the entire point.
   */
  env: Record<string, string>;
}

export interface LocalToolAdapter {
  readonly id: ToolId;
  readonly displayName: string;
  /** The wire format this tool speaks, so the core can pick a valid route. */
  readonly protocol: "anthropic_compatible" | "openai_compatible" | "none";
  /** Whether `enableMining` can work without putting a secret on disk. */
  readonly persistentConfig: PersistentConfigSupport;
  /** Session-scoped routing, for the launcher. Nothing is written anywhere. */
  launchPlan(route: RouteConfig): LaunchPlan;

  capabilities(): ToolCapabilities;
  privacyProfile(): PrivacyProfile;
  /**
   * Session-scoped telemetry configuration pointing at the local receiver.
   * Null when the tool has no local telemetry surface. The session secret is
   * per launch and never the miner credential.
   */
  telemetryLaunch(receiver: { endpoint: string; sessionSecret: string }): TelemetryLaunch | null;

  detect(): Promise<ToolDetection>;
  inspectRouting(): Promise<RoutingState>;
  /** `force` proceeds over a foreign endpoint the user has confirmed. */
  enableMining(route: RouteConfig, force?: boolean): Promise<EnableResult>;
  /** Restores exactly what was there before. */
  disableMining(): Promise<EnableResult>;
  /** Cheap local check: is the configuration still what we wrote? */
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

/** Where a rollback copy of a tool's configuration is kept. */
/**
 * Run `<command> --version` the way the user's shell would.
 *
 * npm installs a CLI on Windows as a `<name>.cmd` shim, and Node refuses to
 * spawn a .cmd/.bat file without a shell (the CVE-2024-27980 hardening).
 * Claude Code ships a native .exe, so `execFile("claude")` works while
 * `execFile("codex")` fails with ENOENT -- which is exactly the bug where
 * `codex --version` worked in a terminal and the packaged miner reported Codex
 * not installed. The command names here are fixed literals, never input, so
 * the shell sees nothing a user typed.
 */
export async function probeVersion(command: "claude" | "codex" | "gemini"): Promise<string | null> {
  try {
    const { stdout } =
      process.platform === "win32"
        ? await run(`${command} --version`, [], { windowsHide: true, timeout: 10_000, shell: true })
        : await run(command, ["--version"], { windowsHide: true, timeout: 10_000 });
    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function backupName(id: ToolId): string {
  return `${id}.backup.json`;
}
