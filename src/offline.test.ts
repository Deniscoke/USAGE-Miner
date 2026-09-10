import { describe, expect, it, vi } from "vitest";

/**
 * USAGE unreachable. The window must still render: the account card says
 * so, local detection is untouched, and nothing waits on the network.
 */

vi.mock("./secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./secrets.js")>();
  return {
    ...actual,
    loadCredential: async () => ({
      serverUrl: "https://usage.invalid",
      token: "usgm_test_not_a_real_token",
      deviceName: "DESKTOP-OFFLINE",
      deviceId: "device-offline",
    }),
  };
});

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  const unreachable = () => {
    const error = new Error("Could not reach USAGE. Check your connection.") as Error & { status: number; code: string };
    error.status = 0;
    error.code = "unreachable";
    return Promise.reject(error);
  };
  return { ...actual, fetchConfig: unreachable, fetchDeviceUsage: unreachable, sendHeartbeat: unreachable };
});

describe("offline backend", () => {
  it("renders a signed-in, offline account with local detection intact", async () => {
    const { buildState } = await import("./ui.js");
    const started = Date.now();
    const state = await buildState(null);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(state.signedIn).toBe(true);
    expect(state.offline).toBe(true);
    expect(state.error).toMatch(/Could not reach USAGE/);
    expect(state.tools.length).toBeGreaterThanOrEqual(4);
    expect(state.usage).toBeNull();
    // Nothing secret rides along in the state the page receives.
    expect(JSON.stringify(state)).not.toContain("usgm_test_not_a_real_token");
  }, 15_000);
});
