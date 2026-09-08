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
    response = await fetch(new URL(path, serverUrl), { ...rest, headers });
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
  miningEligibility: string;
  miningLabel: string;
}

export interface MinerToolConfig {
  protocol: string;
  routes: MinerRoute[];
  fallback: { label: string; url: string; miningEligibility: string; note: string } | null;
}

export interface MinerConfig {
  protocolVersion: string;
  minimumMinerVersion: string;
  updateRequired: boolean;
  account: { label: string };
  mining: { network: string; scoringVersion: string };
  routes: MinerRoute[];
  tools: Record<string, MinerToolConfig>;
  privacy: { recorded: string[]; neverRecorded: string[] };
}

export function startPairing(
  serverUrl: string,
  device: { deviceName: string; platform: string; appVersion: string },
): Promise<PairingStartResponse> {
  return request<PairingStartResponse>(serverUrl, "/api/miner/pair", {
    method: "POST",
    body: JSON.stringify(device),
  });
}

export function pollPairing(serverUrl: string, pollToken: string): Promise<PairingPollResponse> {
  return request<PairingPollResponse>(
    serverUrl,
    `/api/miner/pair?poll_token=${encodeURIComponent(pollToken)}`,
  );
}

export function fetchConfig(serverUrl: string, token: string): Promise<MinerConfig> {
  return request<MinerConfig>(serverUrl, "/api/miner/config", { token });
}

export function sendHeartbeat(
  serverUrl: string,
  token: string,
  enabledTools: string[],
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(serverUrl, "/api/miner/heartbeat", {
    method: "POST",
    token,
    body: JSON.stringify({ enabledTools }),
  });
}
