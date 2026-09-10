import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMapped, loadMappings, reconcileMappings, setMapped } from "./mappings.js";
import { installationId } from "./installation.js";
import { loadTelemetryStatus, syncOutcomeFrom, updateTelemetryStatus, SYNC_COPY } from "./telemetry/status.js";
import { renderApp } from "./ui-page.js";

/**
 * One account, one device, one metering state.
 *
 * The M13C bug: mappings.json was keyed by tool alone, so a re-paired
 * installation showed "mapping ON" for a device the server had never heard
 * of. Everything here is about the device being the scope and the server
 * being the truth.
 */

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "usage-coherence-"));
  process.env.APPDATA = home;
});
afterEach(async () => {
  delete process.env.APPDATA;
  await rm(home, { recursive: true, force: true });
});

describe("local mapping memory is scoped to the paired device", () => {
  it("a mapping made under one device does not exist for another", async () => {
    await setMapped("device-old", "claude-code", true);
    expect(await isMapped("device-old", "claude-code")).toBe(true);
    expect(await isMapped("device-new", "claude-code")).toBe(false);
  });

  it("ignores the 0.4.1 file format, which carried no device id", async () => {
    await mkdir(path.join(home, "USAGE"), { recursive: true });
    await writeFile(
      path.join(home, "USAGE", "mappings.json"),
      JSON.stringify({ version: 1, mappings: [{ tool: "claude-code", enabledAt: "2026-09-09T22:13:27.461Z" }] }),
      "utf8",
    );
    expect(await loadMappings()).toEqual([]);
    expect(await isMapped("any-device", "claude-code")).toBe(false);
  });

  it("reconciles to the server's word for the current device and leaves other devices alone", async () => {
    await setMapped("device-old", "claude-code", true);
    await setMapped("device-new", "codex", true);
    // The server says: on device-new, only claude-code is enabled.
    const next = await reconcileMappings("device-new", [
      { tool: "claude-code", status: "enabled", updatedAt: "2026-09-10T10:10:24.125Z" },
      { tool: "codex", status: "disabled" },
    ]);
    expect(next.filter((m) => m.deviceId === "device-new").map((m) => m.tool)).toEqual(["claude-code"]);
    expect(await isMapped("device-new", "codex")).toBe(false);
    expect(await isMapped("device-old", "claude-code")).toBe(true);
  });

  it("an empty server list clears the local memory for that device", async () => {
    await setMapped("device-new", "claude-code", true);
    await reconcileMappings("device-new", []);
    expect(await isMapped("device-new", "claude-code")).toBe(false);
  });
});

describe("installation identity", () => {
  it("is a random uuid, minted once and stable across reads", async () => {
    const first = await installationId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await installationId()).toBe(first);
    // Not the hostname, not derived from it.
    expect(first).not.toContain("DESKTOP");
  });
});

describe("telemetry status surfaces every failure", () => {
  it("records per device and tool, and survives a partial update", async () => {
    await updateTelemetryStatus("d1", "claude-code", { active: true, pid: process.pid, eventsThisSession: 1 });
    await updateTelemetryStatus("d1", "claude-code", { lastSyncOutcome: "mapping_disabled", lastSyncAt: "2026-09-10T12:14:00Z" });
    await updateTelemetryStatus("d2", "claude-code", { active: false });
    const all = await loadTelemetryStatus();
    const mine = all.find((s) => s.deviceId === "d1" && s.tool === "claude-code")!;
    expect(mine.active).toBe(true);
    expect(mine.eventsThisSession).toBe(1);
    expect(mine.lastSyncOutcome).toBe("mapping_disabled");
    expect(all).toHaveLength(2);
  });

  it("maps server verdicts and transport errors to one safe word each", () => {
    expect(syncOutcomeFrom({ result: { accepted: 2, duplicate: 0, rejected: 0 } })).toBe("accepted");
    expect(syncOutcomeFrom({ result: { accepted: 0, duplicate: 1, rejected: 0 } })).toBe("duplicate");
    expect(syncOutcomeFrom({ result: { accepted: 0, duplicate: 0, rejected: 1, reasons: { a: "mapping_not_enabled" } } })).toBe("mapping_disabled");
    expect(syncOutcomeFrom({ result: { accepted: 0, duplicate: 0, rejected: 1, reasons: { a: "bad_signature" } } })).toBe("bad_signature");
    expect(syncOutcomeFrom({ result: null, errorCode: "revoked", errorStatus: 403 })).toBe("revoked_device");
    expect(syncOutcomeFrom({ result: null, errorCode: "insufficient_scope", errorStatus: 403 })).toBe("insufficient_scope");
    expect(syncOutcomeFrom({ result: null, errorCode: "unreachable", errorStatus: 0 })).toBe("network");
    for (const word of Object.keys(SYNC_COPY)) expect(SYNC_COPY[word as keyof typeof SYNC_COPY]).not.toMatch(/token|usgm_|req_/);
  });
});

describe("the home screen answers the seven questions", () => {
  it("names account, device, mapping, tracking, verification, reward and why", () => {
    const html = renderApp("abcdefghijklmnopqrstuvwxyz012345");
    for (const text of [
      "CONNECTED ✓", "This PC · ", "TRACKING ACTIVE", "Why no USAGE? ", "AI route",
      "USAGE mapping     ", "Tracking          ", "Verification      ", "Reward            ",
      "Track only", "Start with USAGE", "status unavailable (offline)", "Last sync         ",
    ]) {
      expect(html, text).toContain(text);
    }
    // The script still parses.
    expect(() => new Function(html.split("<script>")[1].split("</script>")[0])).not.toThrow();
    // The account card never labels the device as the account.
    expect(html).not.toContain('state.deviceName || "Signed in"');
  });
});

describe("mapping shown is the server's", () => {
  it("buildState takes mapping from the config, not from the local file", async () => {
    vi.resetModules();
    vi.doMock("./secrets.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./secrets.js")>();
      return { ...actual, loadCredential: async () => ({ serverUrl: "https://usage.invalid", token: "usgm_t", deviceName: "PC", deviceId: "device-new" }) };
    });
    vi.doMock("./api.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./api.js")>();
      return {
        ...actual,
        fetchConfig: async () => ({
          protocolVersion: "miner-protocol-v2", minimumMinerVersion: "0.3.0", updateRequired: false,
          account: { label: "PC", display: "de••••@example.com" },
          device: { id: "device-new", name: "PC" },
          mappings: [{ tool: "codex", status: "enabled", lastEventAt: null, updatedAt: null }],
          mining: { network: "development", networkLabel: "USAGE Beta Network", scoringVersion: "usage_score_v1" },
          routes: [],
          tools: { "claude-code": { protocol: "anthropic_compatible", routes: [], fallback: { label: "USAGE gateway", url: "https://usage.invalid/api/gateway/anthropic", miningEligibility: "held", note: "USAGE's own gateway credit pays for this, so it is proven but does not earn." } }, codex: { protocol: "openai_compatible", routes: [], fallback: null } },
          privacy: { recorded: [], neverRecorded: [] },
        }),
        fetchDeviceUsage: async () => ({ day: "2026-09-10", trackedTokens: 0, verifiedTokens: 0, eligibleComputeMicros: 0, estimatedPoints: null, recent: [] }),
        sendHeartbeat: async () => undefined,
      };
    });
    // Stale local memory from the previous device says Claude is mapped.
    const { setMapped: set } = await import("./mappings.js");
    await set("device-old", "claude-code", true);
    const { buildState } = await import("./ui.js");
    const state = await buildState(null);
    const claude = state.tools.find((t) => t.id === "claude-code")!;
    const codex = state.tools.find((t) => t.id === "codex")!;
    expect(claude.mappingStatus).toBe("off");
    expect(codex.mappingStatus).toBe("on");
    expect(state.deviceId).toBe("device-new");
    expect(state.accountDisplay).toBe("de••••@example.com");
    expect(state.networkLabel).toBe("USAGE Beta Network");
    expect(state.route?.kind).toBe("usage_gateway");
    expect(state.route?.rewardStatus).toBe("held");
    expect(state.whyNotEarning).toMatch(/USAGE's own gateway/);
    // And the local file now agrees with the server for this device.
    const { isMapped: mapped } = await import("./mappings.js");
    expect(await mapped("device-new", "codex")).toBe(true);
    expect(await mapped("device-new", "claude-code")).toBe(false);
    vi.doUnmock("./secrets.js");
    vi.doUnmock("./api.js");
  }, 20_000);
});
