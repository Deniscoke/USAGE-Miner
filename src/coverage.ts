/**
 * What USAGE can and cannot measure, per app and per way of running it.
 *
 * Data, not prose, so the window, docs/COVERAGE.md and the tests describe the
 * same thing. Every entry was derived from the app's own source at a pinned
 * version (see docs/COVERAGE.md for the file and line references) and from
 * this miner's mappings -- never from what an app "probably" does. A mode that
 * cannot deliver per-request usage to USAGE says so in exactly these words,
 * and no number is ever shown for it.
 */

export type UsageCategory = "input" | "output" | "cache_read" | "cache_write" | "reasoning" | "tool";

export type CoverageLevel =
  /** Per-request token counts reach USAGE from the app's own telemetry. */
  | "usage_detail"
  /** The app is detected, but this mode gives USAGE no per-request usage. */
  | "detected_only";

export const COVERAGE_LABEL: Readonly<Record<CoverageLevel, string>> = Object.freeze({
  usage_detail: "USAGE DETAIL",
  detected_only: "DETECTED · USAGE DETAIL UNAVAILABLE",
});

export interface ModeCoverage {
  /** How the app is run, in the words a user would use. */
  mode: string;
  level: CoverageLevel;
  label: string;
  /** Categories this mode reports. Anything absent is unknown, never zero. */
  categories: readonly UsageCategory[];
  /** The honest limit, in one sentence. Null only when there is none worth saying. */
  limitation: string | null;
}

function mode(input: Omit<ModeCoverage, "label">): ModeCoverage {
  return Object.freeze({ ...input, label: COVERAGE_LABEL[input.level], categories: Object.freeze([...input.categories]) });
}

export const TOOL_COVERAGE: Readonly<Record<string, readonly ModeCoverage[]>> = Object.freeze({
  "claude-code": Object.freeze([
    mode({
      mode: "Started from USAGE (terminal or -p)",
      level: "usage_detail",
      categories: ["input", "output", "cache_read", "cache_write"],
      limitation: "No reasoning figure is reported.",
    }),
    mode({
      mode: "Started anywhere else (terminal, VS Code)",
      level: "usage_detail",
      categories: ["input", "output", "cache_read", "cache_write"],
      limitation: "Only while \"Measure Claude Code everywhere\" is on and this window is running.",
    }),
  ]),
  codex: Object.freeze([
    mode({
      mode: "codex (interactive), started from USAGE",
      level: "usage_detail",
      categories: ["input", "output", "cache_read", "cache_write", "reasoning"],
      limitation: "No request id; the last export can be lost if Codex takes over half a second to shut down.",
    }),
    mode({
      mode: "codex exec, started from USAGE",
      level: "usage_detail",
      categories: ["input", "output", "cache_read", "cache_write", "reasoning"],
      limitation: "No request id; a run that fails exits without flushing, so its usage can be missing.",
    }),
    mode({
      mode: "Codex in an editor (IDE extension / app-server)",
      level: "detected_only",
      categories: [],
      limitation: "The editor starts Codex itself, and USAGE does not write Codex's config file.",
    }),
  ]),
  "gemini-cli": Object.freeze([
    mode({
      mode: "gemini (interactive or -p), started from USAGE",
      level: "usage_detail",
      categories: ["input", "output", "cache_read", "reasoning", "tool"],
      limitation: "No request id, and Gemini reports a missing count as 0.",
    }),
    mode({
      mode: "gemini started anywhere else",
      level: "detected_only",
      categories: [],
      limitation: "USAGE does not write Gemini's settings file, so only sessions it starts are tracked.",
    }),
  ]),
});

export function coverageFor(toolId: string): readonly ModeCoverage[] {
  return TOOL_COVERAGE[toolId] ?? [];
}
