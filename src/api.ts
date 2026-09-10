import { VERSION } from "./version.js";

/**
 * Talking to USAGE.
 *
 * The miner holds exactly one credential -- its own scoped token -- and asks the
 * server for routing configuration. It never receives a provider API key, and
 * it never sends usage: token counts, cost and proofs are measured by USAGE
 * when it observes the upstream request, not reported by this device.
 */

export const DEFAULT_SERVER_URL = "https://usage-ten.vercel.app";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const REQUEST_TIMEOUT_MS = 8_000;

async function request<T>(
  serverUrl: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("content-type", "application/json");
  headers.set("user-agent", `usage-miner/${VERSION}`);
  // The credential travels in its own header, never in a URL or a log line.
  if (token) headers.set("x-usage-miner-token", token);

  let response: Response;
  try {
    // Every call to USAGE is bounded. A request that never answers must not
    // become a window that never renders.
    response = await fetch(new URL(path, serverUrl), {
      ...rest,
      headers,
      signal: rest.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(0, "unreachable", "Could not reach USAGE. Check your connection.");
  }

  if (!response.ok) {
    let code = "error";
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === "string") code = body.error;
    } catch {
      // A non-JSON error body is not worth surfacing verbatim.
    }
    throw new ApiError(response.status, code, describe(response.status, code));
  }

  return (await response.json()) as T;
}

function describe(status: number, code: string): string {
  if (status === 401) return "This device is not connected to USAGE. Run: usage sign-in";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (code === "unavailable") return "USAGE is not available right now.";
  return "USAGE could not complete that request.";
}

export interface PairingStartResponse {
  userCode: string;
  pollToken: string;
  expiresAt: string;
  verificationUrl: string;
  verificationUrlPlain: string;
}

export type PairingPollResponse =
  | { status: "pending" | "denied" | "expired" | "unknown" }
  | { status: "approved"; token: string; deviceId: string; deviceName: string };

export interface MinerRoute {
  connectionId: string;
  label: string;
  protocol: "anthropic_compatible" | "openai_compatible";
  url: string;
  /** ROUTE capability (routable, measurable, priced). Not the reward. */
  miningEligibility: string;
  /** The server's economic verdict for this route: eligible | held | ineligible | unavailable. */
  rewardStatus?: "eligible" | "held" | "ineligible" | "unavailable";
  miningLabel: string;
  /**
   * The wire surface of this entry (M16C0). One connection may appear once per
   * surface -- OpenRouter answers both -- with the same connection id and the
   * same verdict: one connection, one funding context, two wire formats.
   */
  surface?: "anthropic_compatible" | "openai_compatible";
  surfaceLabel?: string;
  /** Registry family ("openrouter"), for display and model defaults. */
  providerFamily?: string;
}

/** A short-lived route credential from the server (M16C0 §10). Never a provider key. */
export interface RouteSession {
  token: string;
  expiresAt: string;
  ttlSeconds: number;
  tool: string;
  connectionId: string;
  surface: "anthropic_compatible" | "openai_compatible";
  wire: string;
  url: string;
  label: string;
  providerFamily: string;
  rewardStatus: "eligible" | "held" | "ineligible" | "unavailable";
  miningLabel: string;
}

export interface MinerToolConfig {
  protocol: string;
  routes: MinerRoute[];
  fallback: { label: string; url: string; miningEligibility: string; note: string } | null;
}

export interface ServerMapping {
  tool: string;
  status: "enabled" | "disabled";
  lastEventAt: string | null;
  updatedAt: string | null;
}

export interface MinerConfig {
  protocolVersion: string;
  minimumMinerVersion: string;
  updateRequired: boolean;
  /** `display` is a safe account identity (masked email); `label` is the credential's name. */
  account: { label: string; display?: string };
  /** The device row this credential belongs to. The window must describe THIS id. */
  device?: { id: string; name: string };
  /** The server's mapping state for this device: the authoritative one. */
  mappings?: ServerMapping[];
  mining: { network: string; networkLabel?: string; scoringVersion: string };
  routes: MinerRoute[];
  /** Whether the server can mint route sessions, and where. */
  routeSessions?: { available: boolean; url: string; ttlSeconds: number };
  tools: Record<string, MinerToolConfig>;
  privacy: { recorded: string[]; neverRecorded: string[] };
}

export function startPairing(
  serverUrl: string,
  device: { deviceName: string; platform: string; appVersion: string; installationId?: string },
): Promise<PairingStartResponse> {
  return request<PairingStartResponse>(serverUrl, "/api/miner/pair", {
    method: "POST",
    body: JSON.stringify(device),
  });
}

/**
 * Collect the credential once the user has approved.
 *
 * POST with the token in the body, never a query string: the poll token is a
 * credential, and query strings end up in access logs, proxy logs and CDN logs.
 */
export function pollPairing(serverUrl: string, pollToken: string): Promise<PairingPollResponse> {
  return request<PairingPollResponse>(serverUrl, "/api/miner/pair/poll", {
    method: "POST",
    body: JSON.stringify({ pollToken }),
  });
}

export function fetchConfig(serverUrl: string, token: string): Promise<MinerConfig> {
  return request<MinerConfig>(serverUrl, "/api/miner/config", { token });
}

/**
 * Ask USAGE for a route session: a credential bound to ONE tool, ONE of this
 * account's connections and ONE wire surface, for a few hours. The device
 * credential authenticates the request; the provider credential is never in
 * the answer. The token goes only into the launched child's environment.
 */
export function createRouteSession(
  serverUrl: string,
  token: string,
  input: { tool: string; connectionId: string; surface: "anthropic_compatible" | "openai_compatible" },
): Promise<RouteSession> {
  return request<RouteSession>(serverUrl, "/api/miner/route-session", {
    method: "POST",
    token,
    body: JSON.stringify(input),
  });
}

/**
 * Replace this device's credential.
 *
 * Called after cleaning up a machine where an earlier build left the token in a
 * plaintext config file. The old credential dies server-side in the same
 * operation, so there is never a window with two live tokens.
 */
export function rotateCredential(
  serverUrl: string,
  token: string,
): Promise<{ token: string; credentialId: string; previousRevoked: boolean }> {
  return request(serverUrl, "/api/miner/credential/rotate", { method: "POST", token, body: "{}" });
}

/**
 * Safe device state. Tool ids, versions and mapping flags -- never a process
 * list, a path, a username or anything about the filesystem.
 */
export interface HeartbeatTool {
  tool: string;
  version: string | null;
  detected: boolean;
  mapped: boolean;
}

export function sendHeartbeat(
  serverUrl: string,
  token: string,
  tools: HeartbeatTool[],
  os: string,
  minerVersion: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(serverUrl, "/api/miner/heartbeat", {
    method: "POST",
    token,
    body: JSON.stringify({
      protocolVersion: "miner-protocol-v2",
      minerVersion,
      os,
      tools,
      // Kept for servers that predate v2. Display only either way.
      enabledTools: tools.filter((t) => t.mapped).map((t) => t.tool),
    }),
  });
}

export interface MappingResponse {
  tool: string;
  status: "enabled" | "disabled";
  meteringMethod: string;
  verificationCapability: string;
}

/** Ask the server to record a mapping. The server decides everything else. */
export function setMapping(
  serverUrl: string,
  token: string,
  tool: string,
  enabled: boolean,
  toolVersion: string | null,
): Promise<MappingResponse> {
  return request<MappingResponse>(serverUrl, "/api/miner/mappings", {
    method: "POST",
    token,
    body: JSON.stringify({ tool, enabled, toolVersion }),
  });
}

/** Register (or re-register) this device's public signing key. Idempotent. */
export function registerDeviceKey(
  serverUrl: string,
  token: string,
  publicKey: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(serverUrl, "/api/miner/device-key", {
    method: "POST",
    token,
    body: JSON.stringify({ algorithm: "ed25519", publicKey }),
  });
}

export interface TelemetryUploadResult {
  accepted: number;
  duplicate: number;
  rejected: number;
  /** Per-observation verdicts, by localEventId. Never content. */
  verdicts?: Record<string, "accepted" | "duplicate" | "rejected" | "matched" | "conflict">;
  /** Reasons by localEventId for rejected items: the server's own words, never content. */
  reasons?: Record<string, string>;
}

/**
 * Upload signed, normalized observations.
 *
 * The body is exactly what `stripToSchema` produced plus a signature. There is
 * no field for anything the server would trust on the device's say-so.
 */
export function uploadTelemetry(
  serverUrl: string,
  token: string,
  observations: readonly { observation: unknown; signature: { version: string; value: string } }[],
): Promise<TelemetryUploadResult> {
  return request<TelemetryUploadResult>(serverUrl, "/api/miner/telemetry", {
    method: "POST",
    token,
    body: JSON.stringify({ schema: "local-usage-observation-v1", observations }),
  });
}

/** Today's tracked / verified / eligible figures, as the server computes them. */
export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requestCount: number;
}

export interface DeviceUsageSummary {
  day: string;
  /** Fresh (input + output) tokens. One figure, named as such. */
  trackedTokens: number;
  verifiedTokens: number;
  /** Every category, as the SERVER summed it. The window displays, never adds. */
  tracked?: UsageBreakdown;
  verified?: UsageBreakdown;
  eligibleComputeMicros: number;
  estimatedPoints: string | null;
  recent: { tool: string; model?: string | null; tokens: number; breakdown?: UsageBreakdown; status: "tracked" | "verified" | "routed"; at: string }[];
}

export function fetchDeviceUsage(serverUrl: string, token: string): Promise<DeviceUsageSummary> {
  return request<DeviceUsageSummary>(serverUrl, "/api/miner/usage", { token });
}
