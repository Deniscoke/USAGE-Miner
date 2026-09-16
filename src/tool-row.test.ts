import { describe, expect, it } from "vitest";
import { describeToolRow, type ToolRowContext, type ToolRowInput } from "./tool-row.js";
import { launchViewFor } from "./launch.js";
import { COVERAGE_LABEL, TOOL_COVERAGE, coverageFor } from "./coverage.js";
import type { ChosenRoute } from "./route.js";

/**
 * The home row answers "what is happening right now?" -- and only with what
 * USAGE actually knows. These tests pin the words.
 */

const route = {
  url: "https://usage.invalid/api/route/anthropic",
  label: "OpenRouter",
  connectionId: "conn-1",
  providerFamily: "openrouter",
  surface: "anthropic_compatible",
  surfaceLabel: "Anthropic-compatible",
  rewardStatus: "eligible",
  reason: "Your connected provider",
} as unknown as ChosenRoute;

function tool(overrides: Partial<ToolRowInput> = {}): ToolRowInput {
  return {
    id: "claude-code",
    name: "Claude Code",
    installed: true,
    detectionUnavailable: false,
    meterable: true,
    mapped: true,
    tracking: { active: false, lastEventAt: null, launchMode: null },
    launch: launchViewFor("claude-code", null, true),
    ...overrides,
  };
}

const context = (overrides: Partial<ToolRowContext> = {}): ToolRowContext => ({
  offline: false,
  alwaysOnListening: false,
  todayByTool: null,
  ...overrides,
});

describe("a track-only row", () => {
  it("says detected, tracking off, own sign-in, LOCAL ONLY, NOT ELIGIBLE, and offers Track only", () => {
    const row = describeToolRow(tool(), context());
    expect(row).toMatchObject({
      title: "CLAUDE CODE",
      detected: "YES",
      tracking: "OFF",
      mode: "track_only",
      usageSource: "Your own Claude sign-in",
      route: null,
      verification: "LOCAL ONLY",
      reward: "NOT ELIGIBLE",
    });
    expect(row.actions.startVerifiedRoute.visible).toBe(false);
    expect(row.actions.trackOnly).toEqual({ visible: true, enabled: true, reason: null });
    expect(row.actions.stopTracking.visible).toBe(false);
    // Never a plan the app did not report, and never "mining" for local telemetry.
    expect(JSON.stringify(row)).not.toMatch(/\bMax\b|\bPro\b|\bPlus\b|mining/i);
  });

  it("is ACTIVE while a launched session runs, and offers Stop tracking instead of Track only", () => {
    const row = describeToolRow(tool({ tracking: { active: true, lastEventAt: null, launchMode: "track_only" } }), context());
    expect(row.tracking).toBe("ACTIVE");
    expect(row.trackingVia).toBe("session started from USAGE");
    expect(row.actions.trackOnly.visible).toBe(false);
    expect(row.actions.stopTracking).toEqual({ visible: true, enabled: true, reason: null });
  });

  it("is ACTIVE for Claude Code while measuring everywhere, and only for Claude Code", () => {
    expect(describeToolRow(tool(), context({ alwaysOnListening: true })).tracking).toBe("ACTIVE");
    const codex = tool({ id: "codex", name: "Codex", launch: launchViewFor("codex", null, true) });
    expect(describeToolRow(codex, context({ alwaysOnListening: true })).tracking).toBe("OFF");
  });

  it("is OFF when the app is not mapped, whatever is running", () => {
    const row = describeToolRow(tool({ mapped: false, tracking: { active: true, lastEventAt: null, launchMode: "track_only" } }), context({ alwaysOnListening: true }));
    expect(row.tracking).toBe("OFF");
  });

  it("names whose sign-in each app uses", () => {
    expect(describeToolRow(tool({ id: "codex", name: "Codex" }), context()).usageSource).toBe("Your own ChatGPT / OpenAI sign-in");
    expect(describeToolRow(tool({ id: "gemini-cli", name: "Gemini CLI" }), context()).usageSource).toBe("Your own Google sign-in");
    expect(describeToolRow(tool({ id: "other", name: "Other" }), context()).usageSource).toBe("Your own sign-in");
  });

  it("disables starting anything while USAGE is unreachable, and says why", () => {
    const row = describeToolRow(tool(), context({ offline: true }));
    expect(row.actions.trackOnly).toEqual({ visible: true, enabled: false, reason: "USAGE cannot be reached right now." });
  });

  it("offers nothing for an app that is not detected", () => {
    const row = describeToolRow(tool({ installed: false }), context());
    expect(row.detected).toBe("NO");
    expect(row.actions.trackOnly.visible).toBe(false);
    expect(row.actions.startVerifiedRoute.visible).toBe(false);
    expect(describeToolRow(tool({ installed: false, detectionUnavailable: true }), context()).detected).toBe("UNKNOWN");
  });
});

describe("a verified-route row", () => {
  it("names the route, VERIFIED ROUTE, ELIGIBLE, and offers Start verified route", () => {
    const row = describeToolRow(tool({ launch: launchViewFor("claude-code", route, true) }), context());
    expect(row).toMatchObject({ mode: "verified_route", route: "OpenRouter", usageSource: null, verification: "VERIFIED ROUTE", reward: "ELIGIBLE" });
    expect(row.actions.startVerifiedRoute).toEqual({ visible: true, enabled: true, reason: null });
    // Track only stays available as the other choice.
    expect(row.actions.trackOnly.visible).toBe(true);
  });

  it("says HELD when the server holds the route", () => {
    const held = { ...route, rewardStatus: "held" } as ChosenRoute;
    expect(describeToolRow(tool({ launch: launchViewFor("claude-code", held, true) }), context()).reward).toBe("HELD");
  });

  it("a running track-only session is shown as track only even when a route now exists", () => {
    const row = describeToolRow(
      tool({ launch: launchViewFor("claude-code", route, true), tracking: { active: true, lastEventAt: null, launchMode: "track_only" } }),
      context(),
    );
    expect(row.mode).toBe("track_only");
    expect(row.verification).toBe("LOCAL ONLY");
    expect(row.reward).toBe("NOT ELIGIBLE");
  });
});

describe("today's figures per app", () => {
  const breakdown = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 0, requestCount: 2 };

  it("are all unknown when USAGE sent no per-app figures -- never zero", () => {
    expect(describeToolRow(tool(), context()).today).toEqual({ available: false, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null });
    expect(describeToolRow(tool(), context({ todayByTool: { codex: breakdown } })).today.available).toBe(false);
  });

  it("show only the categories the app reports; the rest stay unknown", () => {
    // Claude Code reports no reasoning figure, so the row hides it.
    expect(describeToolRow(tool(), context({ todayByTool: { "claude-code": breakdown } })).today).toEqual({
      available: true, input: 100, output: 20, cacheRead: 300, cacheWrite: 0, reasoning: null,
    });
    // Gemini has no cache-write figure; its reasoning (thoughts) is real.
    const gemini = tool({ id: "gemini-cli", name: "Gemini CLI" });
    expect(describeToolRow(gemini, context({ todayByTool: { "gemini-cli": breakdown } })).today).toEqual({
      available: true, input: 100, output: 20, cacheRead: 300, cacheWrite: null, reasoning: 0,
    });
  });
});

describe("coverage", () => {
  it("labels every mode with exactly one of two phrases, and no mode is a promise", () => {
    for (const [toolId, modes] of Object.entries(TOOL_COVERAGE)) {
      expect(modes.length, toolId).toBeGreaterThan(0);
      for (const m of modes) {
        expect(Object.values(COVERAGE_LABEL)).toContain(m.label);
        if (m.level === "detected_only") expect(m.categories).toEqual([]);
        else expect(m.categories).toEqual(expect.arrayContaining(["input", "output"]));
        expect(`${m.mode} ${m.limitation ?? ""}`).not.toMatch(/coming soon|soon|planned|mining/i);
      }
    }
    expect(COVERAGE_LABEL.detected_only).toBe("DETECTED · USAGE DETAIL UNAVAILABLE");
  });

  it("marks Codex in an editor as detected without usage detail, and both CLI modes as measured", () => {
    const codex = coverageFor("codex");
    expect(codex.find((m) => m.mode.startsWith("codex exec"))?.level).toBe("usage_detail");
    expect(codex.find((m) => m.mode.startsWith("codex (interactive)"))?.level).toBe("usage_detail");
    expect(codex.find((m) => m.mode.includes("IDE"))?.label).toBe("DETECTED · USAGE DETAIL UNAVAILABLE");
    expect(coverageFor("cursor")).toEqual([]);
  });

  it("is carried on the row", () => {
    expect(describeToolRow(tool({ id: "codex", name: "Codex" }), context()).coverage).toBe(coverageFor("codex"));
  });
});
