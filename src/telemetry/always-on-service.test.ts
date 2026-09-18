import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALWAYS_ON_HEADER, alwaysOnStatus, disableAlwaysOn, enableAlwaysOn } from "./always-on.js";
import { createAlwaysOnService, WATCH_INTERVAL_MS, type AlwaysOnService } from "./always-on-service.js";
import { pending } from "./buffer.js";

/**
 * "Measure everywhere" with more than one miner window open.
 *
 * The owner ran an npx 0.4.6 window and a 0.4.8 window at once. One held port
 * 47823; the other said "port in use". The switch is a file, so turning it off
 * in one window never reached the receiver the other window held. Here every
 * window follows the file on its own clock, and nothing received after the
 * file says off is kept or uploaded.
 */

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "usage-always-on-svc-"));
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.APPDATA = path.join(home, "AppData");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A timer that fires only when the test says so. */
function manualClock() {
  const fns = new Set<() => void>();
  return {
    schedule: (fn: () => void, ms: number) => {
      expect(ms).toBeLessThanOrEqual(15_000);
      fns.add(fn);
      return fn;
    },
    cancel: (handle: unknown) => void fns.delete(handle as () => void),
    get armed() {
      return fns.size;
    },
    /** Fire every armed timer once. */
    tick: () => {
      for (const fn of [...fns]) fn();
    },
  };
}

const pair = generateKeyPairSync("ed25519");
const deviceKey = async () => ({
  publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  sign: (payload: string) => sign(null, Buffer.from(payload), pair.privateKey).toString("base64"),
});

function window(port: number, clock: ReturnType<typeof manualClock>, uploads: unknown[]): AlwaysOnService {
  return createAlwaysOnService({
    port,
    loadCredential: async () => ({ token: "usgm_test", deviceId: "device-1", deviceName: "PC", serverUrl: "https://usage.invalid" }),
    loadDeviceKey: deviceKey,
    upload: async (_url, _token, batch) => {
      uploads.push(...batch);
      return { accepted: batch.length, duplicate: 0, rejected: 0 };
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
}

function claudeExport(requestId: string) {
  const attr = (k: string, v: string | number) => ({ key: k, value: typeof v === "number" ? { intValue: v } : { stringValue: v } });
  return {
    resourceLogs: [{
      resource: { attributes: [attr("service.name", "claude-code")] },
      scopeLogs: [{
        scope: { name: "com.anthropic.claude_code.events" },
        logRecords: [{
          timeUnixNano: String(Date.now()) + "000000",
          body: { stringValue: "claude_code.api_request" },
          attributes: [attr("event.name", "api_request"), attr("model", "claude-sonnet-5"), attr("input_tokens", 10), attr("output_tokens", 5), attr("request_id", requestId)],
        }],
      }],
    }],
  };
}

/** What a Claude Code session started while ON keeps doing after OFF. */
function exportFromOldSession(port: number, key: string, requestId: string) {
  return fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", [ALWAYS_ON_HEADER]: key },
    body: JSON.stringify(claudeExport(requestId)),
  });
}

describe("every window follows the switch file", () => {
  it("watches on an interval of at most 15 seconds", () => {
    expect(WATCH_INTERVAL_MS).toBeLessThanOrEqual(15_000);
  });

  it("OFF in any window stops the receiver in the window that holds the port; old sessions are refused and nothing is uploaded", async () => {
    await enableAlwaysOn();
    const key = (await alwaysOnStatus()).receiverKey!;
    const port = await freePort();
    const uploads: unknown[] = [];
    const clockA = manualClock();
    const clockB = manualClock();
    const a = window(port, clockA, uploads);
    const b = window(port, clockB, uploads);
    a.watch();
    b.watch();
    try {
      await a.refresh();
      await b.refresh();
      expect(a.state().listening).toBe("listening");
      expect(b.state().listening).toBe("port_in_use");

      // Window B turns it off. B's own refresh does nothing for A's port.
      expect((await disableAlwaysOn()).ok).toBe(true);
      await b.refresh();
      expect(b.state().listening).toBe("off");
      expect(a.state().listening).toBe("listening");

      // A's next check closes it -- no click in A needed.
      clockA.tick();
      await vi.waitFor(() => expect(a.state().listening).toBe("off"));

      // A Claude Code session started while it was ON still exports to the
      // port. Nothing listens: the connection is refused, nothing is received.
      await expect(exportFromOldSession(port, key, "req_after_off")).rejects.toThrow();
      await a.idle();
      await b.idle();
      expect(uploads).toHaveLength(0);
      expect(await pending()).toHaveLength(0);
      expect(a.state().eventsSinceStart).toBe(0);
    } finally {
      await a.stop();
      await b.stop();
    }
    // Stopping a window cancels its timer.
    expect(clockA.armed).toBe(0);
    expect(clockB.armed).toBe(0);
  }, 30_000);

  it("drops anything received after the file says off, before that window's next check", async () => {
    await enableAlwaysOn();
    const key = (await alwaysOnStatus()).receiverKey!;
    const port = await freePort();
    const uploads: unknown[] = [];
    const clock = manualClock();
    const a = window(port, clock, uploads);
    try {
      await a.refresh();
      expect((await exportFromOldSession(port, key, "req_while_on")).status).toBe(200);
      await a.idle();
      expect(uploads).toHaveLength(1);

      // Turned off elsewhere; this window has not looked yet.
      await disableAlwaysOn();
      expect((await exportFromOldSession(port, key, "req_in_the_gap")).status).toBe(200);
      await a.idle();
      expect(uploads).toHaveLength(1);
      expect(JSON.stringify(uploads)).not.toContain("req_in_the_gap");
      expect(await pending()).toHaveLength(0);

      // And that export made it close without waiting for the timer.
      await vi.waitFor(() => expect(a.state().listening).toBe("off"));
      await expect(exportFromOldSession(port, key, "req_later")).rejects.toThrow();
    } finally {
      await a.stop();
    }
  }, 30_000);

  it("ON in any window starts a receiver in a window whose port is free, and a busy port is retried", async () => {
    const port = await freePort();
    const uploads: unknown[] = [];
    const clockA = manualClock();
    const clockB = manualClock();
    const a = window(port, clockA, uploads);
    const b = window(port, clockB, uploads);
    a.watch();
    b.watch();
    try {
      await a.refresh();
      await b.refresh();
      expect(a.state().listening).toBe("off");

      await enableAlwaysOn();
      clockB.tick();
      await vi.waitFor(() => expect(b.state().listening).toBe("listening"));
      clockA.tick();
      await vi.waitFor(() => expect(a.state().listening).toBe("port_in_use"));

      // B's window closes; A takes over on its next check.
      await b.stop();
      clockA.tick();
      await vi.waitFor(() => expect(a.state().listening).toBe("listening"));
    } finally {
      await a.stop();
      await b.stop();
    }
  }, 30_000);
});
