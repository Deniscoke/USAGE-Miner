import { access } from "node:fs/promises";
import path from "node:path";
import type { EnableResult, LocalToolAdapter, RoutingState, ToolDetection } from "./adapter.js";

/**
 * Cursor.
 *
 * Detected, and truthfully reported as not meterable from this machine.
 *
 * Cursor's OpenTelemetry export (cursor.com/docs/enterprise/opentelemetry-export,
 * 2026-09) is an Enterprise-plan feature, configured by a team admin, and runs
 * SERVER-SIDE: the data leaves Cursor's servers for the collector the admin
 * names. Nothing is exported from the user's IDE, and a personal account has no
 * export at all. So there is no local surface for this program to receive
 * from, and inventing one -- reading Cursor's local databases, say -- would be
 * exactly the kind of "documented adapter" this project refuses to write
 * without a documented interface.
 *
 * What the user sees is therefore accurate: Cursor is here, USAGE cannot meter
 * it yet, and if their organisation has Enterprise telemetry, a future
 * server-side connector is the path. Nothing is enabled and nothing is read.
 */
export const cursorAdapter: LocalToolAdapter = {
  id: "cursor",
  displayName: "Cursor",
  protocol: "none",
  persistentConfig: "unsafe",

  capabilities() {
    return {
      meteringMethods: ["unsupported"],
      reads: [],
      verificationCeiling: "local_observed",
      availabilityNote:
        "Cursor exports usage only on the Enterprise plan, server-side, via a team admin. There is no local surface for personal accounts. A future connector may support Enterprise telemetry.",
      experimental: false,
    };
  },

  privacyProfile() {
    return { reads: [], neverReads: ["Anything: this tool is detected, not read"] };
  },

  telemetryLaunch() {
    return null;
  },

  launchPlan() {
    return { command: "cursor", env: {} };
  },

  async detect(): Promise<ToolDetection> {
    // Only the documented install location, never a process scan.
    const local = process.env.LOCALAPPDATA;
    if (!local) return { installed: false, version: null, configPath: "" };
    const exe = path.join(local, "Programs", "cursor", "Cursor.exe");
    try {
      await access(exe);
      return { installed: true, version: null, configPath: "" };
    } catch {
      return { installed: false, version: null, configPath: "" };
    }
  },

  async inspectRouting(): Promise<RoutingState> {
    return { state: "off" };
  },

  async enableMining(): Promise<EnableResult> {
    return { ok: false, message: "Cursor cannot be metered from this machine. See its availability note." };
  },

  async disableMining(): Promise<EnableResult> {
    return { ok: true, message: "Cursor was never configured by USAGE." };
  },

  async healthCheck() {
    return { ok: false, detail: "Not meterable locally." };
  },
};
