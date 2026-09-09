import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { flattenOtlpLogs, type FlatLogRecord } from "./otlp.js";

/**
 * The local telemetry receiver.
 *
 * An OTLP/HTTP endpoint that an AI tool sends its usage telemetry to instead of
 * a vendor's collector. It lives inside the miner process for exactly as long
 * as one launched tool session, on 127.0.0.1, on a port nobody chose.
 *
 * LOCALHOST IS NOT TRUSTED. Every other program running as this user can reach
 * 127.0.0.1 too, and "a program on the same machine" is precisely the attacker
 * who would like to inject a million tokens of fictional usage. So:
 *
 *   * each session gets a fresh random bearer secret, handed only to the child
 *     process through its environment, and every request must carry it;
 *   * the long-lived miner credential is never the secret, never checked here,
 *     and never present in this module;
 *   * bodies are capped, requests are rate-limited, and the server dies with
 *     the session;
 *   * only /v1/logs is parsed. /v1/metrics and /v1/traces are acknowledged and
 *     discarded, so a tool configured to send them does not error, and nothing
 *     in them is ever read.
 *
 * None of that makes local telemetry TRUE. A user who owns the machine can run
 * the tool with a fake endpoint, or patch the tool. The receiver's job is to
 * keep a bystander process from forging usage in the user's name; deciding
 * whether the user's own numbers earn anything is the server's job, and the
 * answer is no unless something the server trusts corroborates them.
 */

export const RECEIVER_LIMITS = {
  maxBodyBytes: 1024 * 1024,
  /** Per second. Claude Code exports every 5 s; this is generous by design. */
  maxRequestsPerSecond: 20,
} as const;

export interface TelemetryReceiver {
  /** What the launched tool is told: endpoint and the session secret. */
  endpoint: string;
  sessionSecret: string;
  port: number;
  /** Diagnostics, never content. */
  stats: { accepted: number; rejected: number; recordsSeen: number };
  close(): Promise<void>;
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop reading and let the caller answer 413. The rest of the body is
        // the sender's problem.
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", () => resolve(null));
  });
}

function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1]);
  const expected = Buffer.from(secret);
  // Constant-time, so a local process cannot learn the secret a byte at a time
  // from response latency.
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Start a receiver for one session.
 *
 * `onRecords` is called with flattened records only. The raw envelope is not
 * retained, not logged, and not available to the callback.
 */
export async function startTelemetryReceiver(
  onRecords: (records: FlatLogRecord[]) => void,
): Promise<TelemetryReceiver> {
  const sessionSecret = randomBytes(32).toString("base64url");
  const stats = { accepted: 0, rejected: 0, recordsSeen: 0 };
  const window = { second: 0, count: 0 };

  const server: Server = createServer(async (request, response) => {
    const now = Math.floor(Date.now() / 1000);
    if (window.second !== now) {
      window.second = now;
      window.count = 0;
    }
    window.count += 1;
    if (window.count > RECEIVER_LIMITS.maxRequestsPerSecond) {
      stats.rejected += 1;
      response.writeHead(429).end();
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }

    // Authentication before reading a body: an unauthenticated sender does not
    // get to make the miner buffer a megabyte.
    if (!bearerMatches(request.headers.authorization, sessionSecret)) {
      stats.rejected += 1;
      response.writeHead(401).end();
      return;
    }

    const path = (request.url ?? "").split("?")[0];
    if (path !== "/v1/logs") {
      // Metrics and traces: accepted so the tool does not retry, never read.
      if (path === "/v1/metrics" || path === "/v1/traces") {
        await readBody(request, RECEIVER_LIMITS.maxBodyBytes);
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      response.writeHead(404).end();
      return;
    }

    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      // Protobuf is a legitimate OTLP encoding we do not parse. Refusing it
      // cleanly tells the tool to use JSON, which every supported tool can.
      stats.rejected += 1;
      response.writeHead(415).end();
      return;
    }

    const body = await readBody(request, RECEIVER_LIMITS.maxBodyBytes);
    if (body === null) {
      stats.rejected += 1;
      response.writeHead(413).end();
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      stats.rejected += 1;
      response.writeHead(400).end();
      return;
    }

    const records = flattenOtlpLogs(payload);
    stats.accepted += 1;
    stats.recordsSeen += records.length;
    if (records.length > 0) onRecords(records);

    // OTLP's success response is an empty ExportLogsServiceResponse.
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });

  // Loopback only. Not 0.0.0.0, not the machine's LAN address, not "localhost"
  // (which may resolve to an IPv6 address a tool then cannot reach).
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    sessionSecret,
    port,
    stats,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
