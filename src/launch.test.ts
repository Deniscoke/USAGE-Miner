import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 0.4.7: a consumer subscription credential never travels toward a USAGE route.
 *
 * Every file-writing primitive is replaced with a spy BEFORE the modules under
 * test load, so "planning a launch writes nothing" is asserted, not assumed.
 */
const writes = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const spy = (name: string) => (...args: unknown[]) => {
    writes.calls.push(`${name}:${String(args[0])}`);
    return Promise.resolve(undefined);
  };
  const wrapped = {
    ...actual,
    writeFile: spy("writeFile"),
    appendFile: spy("appendFile"),
    mkdir: spy("mkdir"),
    rm: spy("rm"),
    rename: spy("rename"),
    copyFile: spy("copyFile"),
    symlink: spy("symlink"),
    unlink: spy("unlink"),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const spy = (name: string) => (...args: unknown[]) => {
    writes.calls.push(`${name}:${String(args[0])}`);
  };
  const wrapped = {
    ...actual,
    writeFileSync: spy("writeFileSync"),
    appendFileSync: spy("appendFileSync"),
    mkdirSync: spy("mkdirSync"),
    rmSync: spy("rmSync"),
    renameSync: spy("renameSync"),
    copyFileSync: spy("copyFileSync"),
    symlinkSync: spy("symlinkSync"),
  };
  return { ...wrapped, default: wrapped };
});

const { childEnvironment, decideLaunch, launchViewFor, TRACK_ONLY_EXPLANATION, notRoutedLine, wantsRouteSession } = await import("./launch.js");
const { claudeCodeAdapter } = await import("./tools/claude-code.js");
const { codexAdapter } = await import("./tools/codex.js");
const { geminiCliAdapter } = await import("./tools/gemini-cli.js");
const { cursorAdapter } = await import("./tools/cursor.js");
type ChosenRoute = import("./route.js").ChosenRoute;
type RouteSessionOutcome = import("./launch.js").RouteSessionOutcome;

const MINER_TOKEN = "usgm_device_credential_value";
const NO_ROUTE = { url: "", minerToken: "", label: "" };

function claudeRoute(overrides: Partial<ChosenRoute> = {}): ChosenRoute {
  return {
    kind: "provider",
    connectionId: "or-1",
    url: "https://usage.example/api/gateway/provider/or-1/anthropic",
    label: "OpenRouter",
    providerFamily: "openrouter",
    surface: "anthropic_compatible",
    surfaceLabel: "Anthropic-compatible",
    rewardStatus: "eligible",
    reason: "Mining eligible",
    ...overrides,
  };
}

function codexRoute(overrides: Partial<ChosenRoute> = {}): ChosenRoute {
  return claudeRoute({ url: "https://usage.example/api/gateway/provider/or-1", surface: "openai_compatible", surfaceLabel: "OpenAI-compatible", ...overrides });
}

const ROUTE_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

function claudePlanFor(route: ChosenRoute | null, session: RouteSessionOutcome) {
  const decision = decideLaunch({ toolId: "claude-code", route, minerToken: MINER_TOKEN, session });
  return { decision, plan: claudeCodeAdapter.launchPlan(decision.routeConfig ?? NO_ROUTE) };
}

// Consumer and provider credentials present in the miner's own environment,
// the way they are on a machine where Claude Code and Codex are signed in.
const PARENT_SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-api03-parentkeyvalue",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-subscriptiontokenvalue",
  OPENAI_API_KEY: "sk-proj-parentopenaikey",
  OPENROUTER_API_KEY: "sk-or-v1-parentopenrouterkey",
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  writes.calls.length = 0;
  for (const [key, value] of Object.entries(PARENT_SECRETS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of Object.keys(PARENT_SECRETS)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("Claude Code launch decision", () => {
  it("route sessions unavailable → Track only, with no USAGE routing variable", () => {
    const { decision, plan } = claudePlanFor(claudeRoute(), { status: "unavailable" });
    expect(decision.mode).toBe("track_only");
    expect(decision.routeConfig).toBeNull();
    expect(decision.notRoutedReason).toMatch(/unavailable/);
    expect(plan).toEqual({ command: "claude", env: {} });
    for (const key of ROUTE_ENV) expect(plan.env[key], key).toBeUndefined();
  });

  it("route session creation failed → Track only, and the reason is shown", () => {
    const { decision, plan } = claudePlanFor(claudeRoute(), { status: "failed", reason: "route session failed: 503" });
    expect(decision.mode).toBe("track_only");
    expect(plan.env).toEqual({});
    const line = notRoutedLine("Claude Code", decision.notRoutedReason!);
    expect(line).toBe(
      "Routing: not used — USAGE could not start a verified route session (route session failed: 503). Claude Code starts with its own sign-in; usage is tracked locally and does not earn.",
    );
  });

  it("a session without its isolated profile is not used", () => {
    const { decision, plan } = claudePlanFor(claudeRoute(), { status: "created", token: "usgr_s", expiresAt: "2026-09-17T20:00:00Z" });
    expect(decision.mode).toBe("track_only");
    expect(plan.env).toEqual({});
  });

  it("no route, or a route with no connection id → Track only, and no session is asked for", () => {
    expect(wantsRouteSession("claude-code", null)).toBe(false);
    expect(wantsRouteSession("claude-code", claudeRoute({ connectionId: null }))).toBe(false);
    const { decision, plan } = claudePlanFor(null, { status: "not_attempted" });
    expect(decision).toEqual({ mode: "track_only", routeConfig: null, notRoutedReason: null });
    expect(plan.env).toEqual({});
  });

  it("route session with profile → verified route, unchanged: isolated profile, USAGE route, usgr_ token", () => {
    const { decision, plan } = claudePlanFor(claudeRoute(), { status: "created", token: "usgr_session_token", expiresAt: "2026-09-17T20:00:00Z", profileDir: "C:\\USAGE\\claude-profile" });
    expect(decision.mode).toBe("verified_route");
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe("C:\\USAGE\\claude-profile");
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("https://usage.example/api/gateway/provider/or-1/anthropic");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("usgr_session_token");
    expect(plan.env.ANTHROPIC_API_KEY).toBe("");
    expect(plan.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    // The device credential is not handed to Claude Code on this path.
    expect(JSON.stringify(decision.routeConfig)).not.toContain(MINER_TOKEN);
    expect(JSON.stringify(plan)).not.toContain(MINER_TOKEN);
  });
});

describe("Codex launch decision stays as it was, and never uses a fallback", () => {
  it("routes a connected provider with its session, or the device credential without one", () => {
    const withSession = decideLaunch({ toolId: "codex", route: codexRoute(), minerToken: MINER_TOKEN, session: { status: "created", token: "usgr_codex", expiresAt: "x" } });
    expect(withSession.mode).toBe("verified_route");
    expect(codexAdapter.launchPlan(withSession.routeConfig!).env.USAGE_MINER_TOKEN).toBe("usgr_codex");
    const without = decideLaunch({ toolId: "codex", route: codexRoute(), minerToken: MINER_TOKEN, session: { status: "unavailable" } });
    expect(codexAdapter.launchPlan(without.routeConfig!).env.USAGE_MINER_TOKEN).toBe(MINER_TOKEN);
  });

  it("with no route starts Codex untouched", () => {
    const decision = decideLaunch({ toolId: "codex", route: null, minerToken: MINER_TOKEN, session: { status: "not_attempted" } });
    expect(decision.mode).toBe("track_only");
    expect(codexAdapter.launchPlan(decision.routeConfig ?? NO_ROUTE)).toEqual({ command: "codex", env: {} });
  });
});

describe("launch planning never touches a consumer or provider credential, and never writes", () => {
  it("no plan carries an sk-ant-/sk-or-/sk-proj-/oauth-looking value, and nothing is written to disk", () => {
    const sessions: RouteSessionOutcome[] = [
      { status: "not_attempted" },
      { status: "unavailable" },
      { status: "failed", reason: "boom" },
      { status: "created", token: "usgr_a", expiresAt: "x" },
      { status: "created", token: "usgr_b", expiresAt: "x", profileDir: "C:\\p" },
    ];
    const plans: unknown[] = [];
    for (const session of sessions) {
      for (const route of [null, claudeRoute(), claudeRoute({ rewardStatus: "held" }), claudeRoute({ providerFamily: "anthropic" })]) {
        const claude = decideLaunch({ toolId: "claude-code", route, minerToken: MINER_TOKEN, session });
        plans.push(claude, claudeCodeAdapter.launchPlan(claude.routeConfig ?? NO_ROUTE));
        const codex = decideLaunch({ toolId: "codex", route: route && codexRoute(), minerToken: MINER_TOKEN, session });
        plans.push(codex, codexAdapter.launchPlan(codex.routeConfig ?? NO_ROUTE));
      }
    }
    plans.push(geminiCliAdapter.launchPlan(NO_ROUTE), cursorAdapter.launchPlan(NO_ROUTE));

    const all = JSON.stringify(plans);
    expect(all).not.toMatch(/sk-ant-|sk-or-|sk-proj-|oauth|Bearer /i);
    for (const value of Object.values(PARENT_SECRETS)) expect(all).not.toContain(value);
    expect(writes.calls).toEqual([]);
  });

  it("the telemetry environment is metadata switches and a loopback endpoint, nothing else", () => {
    const telemetry = claudeCodeAdapter.telemetryLaunch({ endpoint: "http://127.0.0.1:1", sessionSecret: "local-secret" })!;
    expect(JSON.stringify(telemetry)).not.toMatch(/sk-ant-|sk-or-|oauth|usgm_|usgr_/i);
    expect(writes.calls).toEqual([]);
  });
});

describe("what the window shows per tool", () => {
  it("no route → TRACK ONLY, in exactly these words, and never 'Mining'", () => {
    const view = launchViewFor("claude-code", null, true);
    expect(view).toEqual({
      mode: "track_only",
      account: "your own sign-in (subscription)",
      route: "Direct to Claude",
      verification: "LOCAL ONLY",
      reward: "NOT ELIGIBLE",
      button: "Track only",
      explanation: "USAGE can measure this usage on your PC, but it cannot independently verify the subscription billing, so it does not earn Usage Points.",
    });
    expect(view.explanation).toBe(TRACK_ONLY_EXPLANATION);
    expect(JSON.stringify(view)).not.toMatch(/mining|fallback|gateway/i);
  });

  it("a Claude route the server cannot mint a session for is still TRACK ONLY", () => {
    expect(launchViewFor("claude-code", claudeRoute(), false).mode).toBe("track_only");
  });

  it("a verified route → Route: provider, VERIFIED ROUTE, ELIGIBLE or HELD, Start with USAGE", () => {
    expect(launchViewFor("claude-code", claudeRoute(), true)).toEqual({
      mode: "verified_route",
      account: null,
      route: "OpenRouter",
      verification: "VERIFIED ROUTE",
      reward: "ELIGIBLE",
      button: "Start with USAGE",
      explanation: null,
    });
    expect(launchViewFor("claude-code", claudeRoute({ rewardStatus: "held" }), true).reward).toBe("HELD");
    expect(launchViewFor("codex", codexRoute(), false).mode).toBe("verified_route");
    expect(launchViewFor("codex", null, true).route).toBe("Direct to OpenAI");
  });
});

describe("the environment actually handed to spawn()", () => {
  const SESSION = { status: "created", token: "usgr_session.sig", expiresAt: "2026-09-17T20:00:00Z", profileDir: "C:\\USAGE\\claude-profile" } as const;

  it("a verified Claude route drops an inherited subscription token, custom headers and provider switches", () => {
    const parent = {
      ...process.env,
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-subscriptiontokenvalue",
      ANTHROPIC_CUSTOM_HEADERS: "x-anything: sk-ant-oat01-smuggled",
      CLAUDE_CODE_USE_BEDROCK: "1",
      PATH: "C:\\bin",
    };
    const { plan } = claudePlanFor(claudeRoute(), SESSION);
    const env = childEnvironment("claude-code", parent, plan.env);

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("usgr_session.sig");
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\USAGE\\claude-profile");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.PATH).toBe("C:\\bin");
    expect(JSON.stringify(env)).not.toContain("sk-ant-oat");
    expect(JSON.stringify(env)).not.toContain("sk-ant-api");
  });

  it("track only leaves the user's own environment exactly as it is", () => {
    const parent = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-own-login", PATH: "C:\\bin" };
    const { plan } = claudePlanFor(null, { status: "not_attempted" });
    const env = childEnvironment("claude-code", parent, plan.env);
    expect(env).toEqual(parent);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
