import { describe, expect, it } from "vitest";
import { BACKGROUND_TICK_MS, startBackgroundLoop } from "./background.js";

function manualClock() {
  let fire: (() => void) | null = null;
  let cancelled = false;
  return {
    schedule: (fn: () => void) => {
      fire = fn;
      return 1;
    },
    cancel: () => {
      cancelled = true;
    },
    tick: () => fire?.(),
    get cancelled() {
      return cancelled;
    },
  };
}

describe("startBackgroundLoop", () => {
  it("ticks once immediately, so a freshly started miner reports in at once", async () => {
    let ticks = 0;
    const clock = manualClock();
    const loop = startBackgroundLoop({ tick: async () => void (ticks += 1), schedule: clock.schedule, cancel: clock.cancel });
    await loop.idle();
    expect(ticks).toBe(1);
    loop.stop();
  });

  it("keeps ticking on its own schedule, with no page open", async () => {
    let ticks = 0;
    const clock = manualClock();
    const loop = startBackgroundLoop({ tick: async () => void (ticks += 1), schedule: clock.schedule, cancel: clock.cancel });
    await loop.idle();
    clock.tick();
    await loop.idle();
    clock.tick();
    await loop.idle();
    expect(ticks).toBe(3);
    loop.stop();
  });

  it("skips a tick while the previous one is still running, instead of stacking them", async () => {
    let started = 0;
    let release: () => void = () => undefined;
    const clock = manualClock();
    const loop = startBackgroundLoop({
      tick: () => {
        started += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    clock.tick();
    clock.tick();
    expect(started).toBe(1);
    release();
    await loop.idle();
    loop.stop();
  });

  it("survives a tick that fails, and tries again next time", async () => {
    let ticks = 0;
    const clock = manualClock();
    const loop = startBackgroundLoop({
      tick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error("offline");
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    await loop.idle();
    clock.tick();
    await loop.idle();
    expect(ticks).toBe(2);
    loop.stop();
  });

  it("stops cleanly", async () => {
    let ticks = 0;
    const clock = manualClock();
    const loop = startBackgroundLoop({ tick: async () => void (ticks += 1), schedule: clock.schedule, cancel: clock.cancel });
    await loop.idle();
    loop.stop();
    clock.tick();
    await loop.idle();
    expect(ticks).toBe(1);
    expect(clock.cancelled).toBe(true);
  });

  it("beats well inside the server's five-minute online window", () => {
    expect(BACKGROUND_TICK_MS).toBeLessThanOrEqual(60_000);
  });
});
