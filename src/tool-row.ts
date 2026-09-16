import type { UsageBreakdown } from "./api.js";
import type { ToolLaunchView } from "./launch.js";
import { coverageFor, type ModeCoverage, type UsageCategory } from "./coverage.js";

/**
 * One row of the window, answering "what is happening right now?" for one AI
 * app. Pure: every word the row shows is decided here, from state the window
 * already holds, so the words are tested rather than eyeballed.
 *
 * Two shapes, never blurred:
 *
 *   TRACK ONLY       the app runs on the user's own sign-in, talking to its own
 *                    provider. USAGE measures it from local telemetry.
 *                    Verification LOCAL ONLY, reward NOT ELIGIBLE.
 *   VERIFIED ROUTE   the app talks to a USAGE route on a connected provider.
 *
 * Local-only telemetry is never called "mining".
 */

export interface ToolRowInput {
  id: string;
  name: string;
  installed: boolean;
  detectionUnavailable: boolean;
  meterable: boolean;
  mapped: boolean;
  tracking: { active: boolean; lastEventAt: string | null; launchMode?: "verified_route" | "track_only" | null };
  launch: ToolLaunchView | null;
}

export interface ToolRowContext {
  offline: boolean;
  /** "Measure Claude Code everywhere": on, and its receiver is listening. */
  alwaysOnListening: boolean;
  /** Per-app figures for today, as the SERVER summed them. Absent from older servers. */
  todayByTool: Record<string, UsageBreakdown> | null;
}

export interface ToolTodayView {
  /** False when USAGE sent no per-app figures; every value is then null. */
  available: boolean;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Null when the app's telemetry has no reasoning figure; the row then hides it. */
  reasoning: number | null;
}

export interface ToolAction {
  visible: boolean;
  enabled: boolean;
  /** Why it is disabled, in words. Null when enabled. */
  reason: string | null;
}

export interface ToolRowView {
  title: string;
  detected: "YES" | "NO" | "UNKNOWN";
  tracking: "ACTIVE" | "OFF";
  /** How it is being tracked, when it is. */
  trackingVia: string | null;
  mode: "track_only" | "verified_route";
  /** Track only: whose sign-in the app uses. Never a plan the app did not report. */
  usageSource: string | null;
  /** Verified route: the provider route label. */
  route: string | null;
  verification: "LOCAL ONLY" | "VERIFIED ROUTE";
  reward: "NOT ELIGIBLE" | "ELIGIBLE" | "HELD";
  today: ToolTodayView;
  /** Per mode of the app: what USAGE can and cannot measure. */
  coverage: readonly ModeCoverage[];
  actions: { startVerifiedRoute: ToolAction; trackOnly: ToolAction; stopTracking: ToolAction };
}

/**
 * Whose sign-in the app uses on Track only. USAGE does not read the app's auth,
 * so it never names a plan (Pro, Max, Plus) -- only whose account it is.
 */
const USAGE_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  "claude-code": "Your own Claude sign-in",
  codex: "Your own ChatGPT / OpenAI sign-in",
  "gemini-cli": "Your own Google sign-in",
});

export function usageSourceFor(toolId: string): string {
  return USAGE_SOURCE[toolId] ?? "Your own sign-in";
}

function todayFor(toolId: string, byTool: ToolRowContext["todayByTool"]): ToolTodayView {
  const entry = byTool?.[toolId];
  if (!entry) {
    return { available: false, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
  }
  // A category the app's telemetry never reports is unknown, not zero. The
  // server stores an absent count as 0, so the row decides from coverage.
  const supplied = new Set<UsageCategory>(coverageFor(toolId).flatMap((mode) => mode.categories));
  const pick = (category: UsageCategory, value: number | undefined) =>
    supplied.has(category) && typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    available: true,
    input: pick("input", entry.inputTokens),
    output: pick("output", entry.outputTokens),
    cacheRead: pick("cache_read", entry.cacheReadTokens),
    cacheWrite: pick("cache_write", entry.cacheWriteTokens),
    reasoning: pick("reasoning", entry.reasoningTokens),
  };
}

export function describeToolRow(tool: ToolRowInput, context: ToolRowContext): ToolRowView {
  const detected = tool.detectionUnavailable ? "UNKNOWN" : tool.installed ? "YES" : "NO";
  const sessionActive = tool.tracking.active;
  const everywhere = tool.id === "claude-code" && context.alwaysOnListening;
  const active = tool.mapped && (sessionActive || everywhere);
  const trackingVia = !active
    ? null
    : sessionActive
      ? "session started from USAGE"
      : "measuring Claude Code everywhere";

  // What is running wins over what a click would start: a live session keeps
  // the mode it was launched in.
  const liveMode = sessionActive ? tool.tracking.launchMode ?? null : null;
  const mode = liveMode ?? tool.launch?.mode ?? "track_only";
  const verified = mode === "verified_route";

  const launchable = tool.installed && tool.meterable;
  const routeAvailable = tool.launch?.mode === "verified_route";
  const offlineReason = context.offline ? "USAGE cannot be reached right now." : null;

  return {
    title: tool.name.toUpperCase(),
    detected,
    tracking: active ? "ACTIVE" : "OFF",
    trackingVia,
    mode,
    usageSource: verified ? null : usageSourceFor(tool.id),
    route: verified ? tool.launch?.route ?? null : null,
    verification: verified ? "VERIFIED ROUTE" : "LOCAL ONLY",
    reward: verified ? (tool.launch?.reward === "ELIGIBLE" ? "ELIGIBLE" : "HELD") : "NOT ELIGIBLE",
    today: todayFor(tool.id, context.todayByTool),
    coverage: coverageFor(tool.id),
    actions: {
      startVerifiedRoute: {
        // Shown only when a verified route exists; nothing to explain otherwise.
        visible: launchable && routeAvailable,
        enabled: launchable && routeAvailable && !context.offline,
        reason: offlineReason,
      },
      trackOnly: {
        visible: launchable && !active,
        enabled: launchable && !active && !context.offline,
        reason: !launchable
          ? tool.installed ? "This app cannot be measured here." : "Not detected on this PC."
          : offlineReason,
      },
      stopTracking: {
        visible: active,
        enabled: active && !context.offline,
        reason: offlineReason,
      },
    },
  };
}
