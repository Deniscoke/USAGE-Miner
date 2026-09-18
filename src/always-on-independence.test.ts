import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnvironment, decideLaunch } from "./launch.js";
import type { ChosenRoute } from "./route.js";
import { ALWAYS_ON_PORT, alwaysOnStatus, disableAlwaysOn, enableAlwaysOn } from "./telemetry/always-on.js";
import { startTelemetryReceiver, type TelemetryReceiver } from "./telemetry/receiver.js";
import { claudeCodeAdapter } from "./tools/claude-code.js";

/**
 * Track only and the verified route do not depend on "Measure everywhere".
 *
 * A launched Claude Code session gets its telemetry settings in its own
 * environment, pointing at a receiver started for that session alone -- never
 * the fixed always-on port -- and a verified route gets its isolated profile.
 * Turning the switch on or off changes neither, and never reaches into the
 * environment of a session already launched.
 */

let home: string;
let receiver: TelemetryReceiver;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "usage-ao-independence-"));
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.APPDATA = path.join(home, "AppData");
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ model: "opus", env: { MINE: "1" } }), "utf8");
  // The per-session receiver `usage run` starts: an ephemeral loopback port.
  receiver = await startTelemetryReceiver(() => undefined);
});

afterEach(async () => {
  await receiver.close();
  await rm(home, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
});

const route: ChosenRoute = {
  kind: "provider",
  connectionId: "or-1",
  url: "https://usage.example/api/gateway/provider/or-1/anthropic",
  label: "OpenRouter",
  providerFamily: "openrouter",
  surface: "anthropic_compatible",
  surfaceLabel: "Anthropic-compatible",
  rewardStatus: "eligible",
  reason: "Mining eligible",
} as ChosenRoute;

const parent: NodeJS.ProcessEnv = { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\denis" };

/** Exactly what `usage run claude-code` hands spawn(), minus the spawn. */
function launchEnv(mode: "track_only" | "verified_route") {
  const decision = decideLaunch({
    toolId: "claude-code",
    route: mode === "track_only" ? null : route,
    minerToken: "usgm_device",
    session: mode === "track_only"
      ? { status: "not_attempted" }
      : { status: "created", token: "usgr_session", expiresAt: "2026-09-18T20:00:00Z", profileDir: "C:\\Users\\denis\\AppData\\Roaming\\USAGE\\claude-profile" },
  });
  const plan = claudeCodeAdapter.launchPlan(decision.routeConfig ?? { url: "", minerToken: "", label: "" });
  const env = childEnvironment("claude-code", parent, plan.env);
  const telemetry = claudeCodeAdapter.telemetryLaunch({ endpoint: receiver.endpoint, sessionSecret: receiver.sessionSecret })!;
  for (const name of telemetry.unsetEnv ?? []) delete env[name];
  Object.assign(env, telemetry.env);
  return { decision, env };
}

describe("with Measure everywhere OFF", () => {
  it("Track only still gets per-session loopback telemetry, on the session's receiver, never port 47823", async () => {
    expect((await alwaysOnStatus()).enabled).toBe(false);
    const { decision, env } = launchEnv("track_only");
    expect(decision.mode).toBe("track_only");
    expect(receiver.port).not.toBe(ALWAYS_ON_PORT);
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`http://127.0.0.1:${receiver.port}/v1/logs`);
    expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe(`Authorization=Bearer ${receiver.sessionSecret}`);
    expect(JSON.stringify(env)).not.toContain(`:${ALWAYS_ON_PORT}`);
    // Track only routes nothing and uses the user's own profile.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("the verified route keeps its route session and isolated profile", () => {
    const { decision, env } = launchEnv("verified_route");
    expect(decision.mode).toBe("verified_route");
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\Users\\denis\\AppData\\Roaming\\USAGE\\claude-profile");
    expect(env.ANTHROPIC_BASE_URL).toBe(route.url);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("usgr_session");
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`http://127.0.0.1:${receiver.port}/v1/logs`);
  });
});

describe("toggling Measure everywhere", () => {
  it("does not change what either launch mode is given", async () => {
    const offTrack = launchEnv("track_only");
    const offRoute = launchEnv("verified_route");
    expect((await enableAlwaysOn()).ok).toBe(true);
    expect(launchEnv("track_only")).toEqual(offTrack);
    expect(launchEnv("verified_route")).toEqual(offRoute);
    expect((await disableAlwaysOn()).ok).toBe(true);
    expect(launchEnv("track_only")).toEqual(offTrack);
    expect(launchEnv("verified_route")).toEqual(offRoute);
  });

  it("never modifies the environment of a session already launched", async () => {
    const { env } = launchEnv("track_only");
    const before = JSON.stringify(env);
    await enableAlwaysOn();
    await disableAlwaysOn();
    await enableAlwaysOn();
    expect(JSON.stringify(env)).toBe(before);
    await disableAlwaysOn();
  });
});
