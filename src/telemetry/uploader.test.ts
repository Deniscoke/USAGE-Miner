import { mkdtemp, rm } from "node:fs/promises";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LocalUsageObservation } from "./observation.js";
import type { SignedObservation } from "./uploader.js";

/**
 * The upload path after an outage.
 *
 * The real failure: a PC offline for a day buffers more observations than the
 * server takes in one request. The uploader sent them all at once, the server
 * refused, the uploader put them all back, and every later attempt was the
 * same request. Syncing stopped permanently and the window said "network".
 */

let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "usage-uploader-"));
  process.env.APPDATA = path.join(home, "AppData");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  const { clearBuffer } = await import("./buffer.js");
  await clearBuffer();
});

const pair = generateKeyPairSync("ed25519");
const key = {
  publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  sign: (payload: string) => nodeSign(null, Buffer.from(payload), pair.privateKey).toString("base64"),
};

function observation(i: number): LocalUsageObservation {
  return {
    schemaVersion: "local-usage-v1",
    adapter: "claude-code-otel",
    toolId: "claude-code",
    toolVersion: null,
    sourceType: "native_otel",
    provider: "anthropic",
    model: "claude-sonnet-4.6",
    upstreamRequestId: `req_${i}`,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    toolTokens: null,
    estimatedCostMicros: null,
    occurredAt: new Date().toISOString(),
    localSessionId: "session",
    localEventId: `evt_${i}`,
  } as unknown as LocalUsageObservation;
}

/** A fake server with the real limit: more than 200 in one request is refused. */
function fakeServer(options: { refuse?: (id: string) => boolean; down?: boolean } = {}) {
  const requests: number[] = [];
  const upload = async (_url: string, _token: string, batch: SignedObservation[]) => {
    if (options.down) throw Object.assign(new Error("fetch failed"), { code: "unreachable", status: 0 });
    requests.push(batch.length);
    if (batch.length > 200) throw Object.assign(new Error("too many"), { code: "too_many_observations", status: 422 });
    if (options.refuse && batch.some((b) => options.refuse!(b.observation.localEventId))) {
      throw Object.assign(new Error("bad"), { code: "invalid_observation", status: 400 });
    }
    return { accepted: batch.length, duplicate: 0, rejected: 0 };
  };
  return { upload, requests };
}

describe("uploading after an outage", () => {
  it("drains a buffer larger than one request in several batches", async () => {
    const { createUploader, MAX_UPLOAD_BATCH } = await import("./uploader.js");
    const { enqueue, pending } = await import("./buffer.js");
    await enqueue(Array.from({ length: 450 }, (_, i) => observation(i)));

    const server = fakeServer();
    const uploader = createUploader({ serverUrl: "https://usage.invalid", token: "t", key, upload: server.upload });
    const outcome = await uploader.flush();

    expect(outcome.uploaded).toBe(450);
    expect(outcome.result?.accepted).toBe(450);
    expect(Math.max(...server.requests)).toBeLessThanOrEqual(MAX_UPLOAD_BATCH);
    expect(await pending()).toEqual([]);
  }, 30_000);

  it("drops only the one observation the server will never accept, and keeps the rest flowing", async () => {
    const { createUploader } = await import("./uploader.js");
    const { enqueue, pending } = await import("./buffer.js");
    await enqueue(Array.from({ length: 10 }, (_, i) => observation(i)));

    const server = fakeServer({ refuse: (id) => id === "evt_7" });
    const uploader = createUploader({ serverUrl: "https://usage.invalid", token: "t", key, upload: server.upload });
    const outcome = await uploader.flush();

    expect(outcome.uploaded).toBe(9);
    expect(outcome.errorCode ?? null).toBeNull();
    expect(await pending()).toEqual([]);
  }, 30_000);

  it("keeps everything and backs off when USAGE cannot be reached", async () => {
    const { createUploader } = await import("./uploader.js");
    const { enqueue, pending } = await import("./buffer.js");
    await enqueue(Array.from({ length: 5 }, (_, i) => observation(i)));

    const server = fakeServer({ down: true });
    const uploader = createUploader({ serverUrl: "https://usage.invalid", token: "t", key, upload: server.upload });
    const outcome = await uploader.flush();

    expect(outcome.uploaded).toBe(0);
    expect(outcome.errorCode).toBe("unreachable");
    expect((await pending()).length).toBe(5);
  }, 30_000);

  it("keeps a failed batch and everything after it, without re-sending what already went", async () => {
    const { createUploader } = await import("./uploader.js");
    const { enqueue, pending } = await import("./buffer.js");
    await enqueue(Array.from({ length: 250 }, (_, i) => observation(i)));

    let calls = 0;
    const upload = async (_u: string, _t: string, batch: SignedObservation[]) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("fetch failed"), { code: "unreachable", status: 0 });
      return { accepted: batch.length, duplicate: 0, rejected: 0 };
    };
    const uploader = createUploader({ serverUrl: "https://usage.invalid", token: "t", key, upload });
    const outcome = await uploader.flush();

    expect(outcome.uploaded).toBe(100);
    expect((await pending()).length).toBe(150);
  }, 30_000);
});

describe("the buffer itself", () => {
  it("never holds the same observation twice, however many times it is re-queued", async () => {
    const { enqueue, pending } = await import("./buffer.js");
    const batch = Array.from({ length: 5 }, (_, i) => observation(i));
    await enqueue(batch);
    await enqueue(batch);
    await enqueue(batch);
    expect((await pending()).length).toBe(5);
  }, 30_000);
});
