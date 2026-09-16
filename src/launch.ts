import type { ChosenRoute } from "./route.js";
import type { RouteConfig } from "./tools/adapter.js";

/**
 * How a tool is started: one decision, pure, shared by the CLI and the window.
 *
 * TWO MODES ONLY.
 *
 *   VERIFIED ROUTE  a connected provider route (eligible, or held) exists AND,
 *                   for Claude Code, a USAGE route session with its isolated
 *                   profile was obtained. The tool talks to the USAGE route;
 *                   USAGE uses the server-held provider credential.
 *
 *   TRACK ONLY      everything else. The tool starts on its own sign-in and
 *                   talks to its own provider directly, with no USAGE routing
 *                   variable. USAGE tracks it from local telemetry when the
 *                   tool is mapped. Verification LOCAL ONLY; reward NOT
 *                   ELIGIBLE.
 *
 * A consumer subscription credential (Claude Pro/Max login, ChatGPT login) is
 * never carried toward a USAGE route. For Claude Code that means: no route
 * session with a profile, no routing -- never a "route anyway and let the
 * subscription token ride along" launch.
 *
 * Nothing here does I/O. It cannot write a file, and it is tested as such.
 */

export type LaunchMode = "verified_route" | "track_only";

/** What happened when the launcher tried to obtain a route session. No secrets in `reason`. */
export type RouteSessionOutcome =
  | { status: "created"; token: string; expiresAt: string; profileDir?: string }
  /** The server cannot mint route sessions (too old, or switched off). */
  | { status: "unavailable" }
  | { status: "failed"; reason: string }
  /** Not asked for: no route, or `--no-route`. */
  | { status: "not_attempted" };

export interface LaunchDecision {
  mode: LaunchMode;
  /** What to hand `adapter.launchPlan`. Null means start the tool untouched. */
  routeConfig: RouteConfig | null;
  /** When a route existed but is not used, why, in words. Null otherwise. */
  notRoutedReason: string | null;
}

export const TRACK_ONLY_EXPLANATION =
  "USAGE can measure this usage on your PC, but it cannot independently verify the subscription billing, so it does not earn Usage Points.";

/** The provider a tool talks to on its own sign-in. Display only. */
const DIRECT_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  "claude-code": "Claude",
  codex: "OpenAI",
  "gemini-cli": "Gemini",
  cursor: "Cursor",
});

export function directProviderLabel(toolId: string): string {
  return DIRECT_PROVIDER[toolId] ?? "its own provider";
}

/** Whether this tool may only be routed with a route session (Claude Code). */
export function requiresRouteSession(toolId: string): boolean {
  return toolId === "claude-code";
}

/** Whether the launcher should ask the server for a route session at all. */
export function wantsRouteSession(toolId: string, route: ChosenRoute | null): boolean {
  return (toolId === "claude-code" || toolId === "codex") && route !== null && route.connectionId !== null;
}

function sessionFailureReason(session: RouteSessionOutcome): string {
  switch (session.status) {
    case "unavailable":
      return "route sessions are unavailable on this server";
    case "failed":
      return session.reason || "the route session could not be created";
    case "created":
      return "the route session came without an isolated Claude profile";
    default:
      return "no route session was requested";
  }
}

export function decideLaunch(input: {
  toolId: string;
  route: ChosenRoute | null;
  /** The device credential. Only Codex without a session still uses it. */
  minerToken: string;
  session: RouteSessionOutcome;
}): LaunchDecision {
  const { toolId, route, session } = input;
  if (!route) return { mode: "track_only", routeConfig: null, notRoutedReason: null };

  const base = {
    url: route.url,
    label: route.label,
    providerFamily: route.providerFamily,
    surface: route.surface,
  };

  if (requiresRouteSession(toolId)) {
    if (session.status === "created" && session.profileDir) {
      return {
        mode: "verified_route",
        // The device credential is not handed to Claude Code at all.
        routeConfig: { ...base, minerToken: "", session: { token: session.token, expiresAt: session.expiresAt, profileDir: session.profileDir } },
        notRoutedReason: null,
      };
    }
    return { mode: "track_only", routeConfig: null, notRoutedReason: sessionFailureReason(session) };
  }

  // Codex: unchanged. Its provider comes from `-c` overrides and its own login
  // is never read, so no consumer credential is involved either way.
  if (session.status === "created") {
    return {
      mode: "verified_route",
      routeConfig: { ...base, minerToken: input.minerToken, session: { token: session.token, expiresAt: session.expiresAt } },
      notRoutedReason: null,
    };
  }
  return { mode: "verified_route", routeConfig: { ...base, minerToken: input.minerToken }, notRoutedReason: null };
}

/** The line the launcher prints when a route existed and is not used. */
export function notRoutedLine(displayName: string, reason: string): string {
  return `Routing: not used — USAGE could not start a verified route session (${reason}). ${displayName} starts with its own sign-in; usage is tracked locally and does not earn.`;
}

/**
 * What the window shows for one tool, before anything is launched.
 *
 * Claude Code is shown as a verified route only when the server can mint route
 * sessions; if creating one then fails, the launcher still falls back to Track
 * only and says so.
 */
export interface ToolLaunchView {
  mode: LaunchMode;
  /** Track only: whose account the tool uses. */
  account: string | null;
  route: string;
  verification: "VERIFIED ROUTE" | "LOCAL ONLY";
  reward: "ELIGIBLE" | "HELD" | "NOT ELIGIBLE";
  button: "Start with USAGE" | "Track only";
  explanation: string | null;
}

export function launchViewFor(toolId: string, route: ChosenRoute | null, sessionsAvailable: boolean): ToolLaunchView {
  const routable = route !== null && (!requiresRouteSession(toolId) || (sessionsAvailable && route.connectionId !== null));
  if (route && routable) {
    return {
      mode: "verified_route",
      account: null,
      route: route.label,
      verification: "VERIFIED ROUTE",
      reward: route.rewardStatus === "eligible" ? "ELIGIBLE" : "HELD",
      button: "Start with USAGE",
      explanation: null,
    };
  }
  return {
    mode: "track_only",
    account: "your own sign-in (subscription)",
    route: `Direct to ${directProviderLabel(toolId)}`,
    verification: "LOCAL ONLY",
    reward: "NOT ELIGIBLE",
    button: "Track only",
    explanation: TRACK_ONLY_EXPLANATION,
  };
}

/**
 * Credentials a parent shell may hold that would outrank, or ride alongside, a
 * route session in a verified Claude Code launch. `CLAUDE_CODE_OAUTH_TOKEN`
 * (from `claude setup-token`) is a subscription login that does not depend on
 * the isolated profile's credentials file; the cloud-provider switches would
 * send the session to Bedrock / Vertex / Foundry instead of the route; custom
 * headers could carry anything.
 */
const CLAUDE_ROUTE_EXCLUDED_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/**
 * The environment actually handed to spawn(): the parent environment with the
 * plan laid over it. For a verified Claude Code route, any inherited credential
 * that could carry a subscription toward USAGE is removed rather than trusted
 * to lose on precedence. Track only returns the parent environment unchanged:
 * the tool talks to its own provider, exactly as the user would start it.
 */
export function childEnvironment(
  toolId: string,
  parent: NodeJS.ProcessEnv,
  planEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, ...planEnv };
  if (toolId === "claude-code" && planEnv.ANTHROPIC_AUTH_TOKEN) {
    for (const key of CLAUDE_ROUTE_EXCLUDED_ENV) {
      if (!(key in planEnv)) delete env[key];
    }
  }
  return env;
}
