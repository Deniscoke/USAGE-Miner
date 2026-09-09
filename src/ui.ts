import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname, platform, release } from "node:os";
import { fetchConfig, pollPairing, sendHeartbeat, startPairing, type MinerConfig } from "./api.js";
import { logEvent } from "./log.js";
import { clearCredential, loadCredential, saveCredential, type StoredCredential } from "./secrets.js";
import { claudeCodeAdapter } from "./tools/claude-code.js";
import { codexAdapter } from "./tools/codex.js";
import { geminiCliAdapter } from "./tools/gemini-cli.js";
import { cursorAdapter } from "./tools/cursor.js";
import { isMapped, setMapped } from "./mappings.js";
import { fetchDeviceUsage, setMapping, type DeviceUsageSummary } from "./api.js";
import type { LocalToolAdapter } from "./tools/adapter.js";
import { VERSION } from "./version.js";
import { renderApp } from "./ui-page.js";
import { migrateInsecureConfig } from "./migrate.js";

/**
 * The desktop window.
 *
 * A tiny HTTP server on loopback, opened in the user's default browser. That
 * choice is deliberate rather than lazy:
 *
 *   * it reuses the miner core exactly, so the tested pairing, credential and
 *     tool-adapter logic has one implementation rather than two;
 *   * it needs no GUI toolkit, so the binary stays one file with no runtime to
 *     install and nothing to keep up to date;
 *   * it costs nothing when closed -- the process exits with the window.
 *
 * SECURITY. The server binds to 127.0.0.1 only, on an ephemeral port, and every
 * request must carry a session nonce generated at startup. That nonce is what
 * stops another program on the machine (or a web page in the same browser)
 * driving the miner: a random page can reach 127.0.0.1, but it cannot guess the
 * nonce, and every state-changing route is POST with an origin check.
 */

const ADAPTERS: LocalToolAdapter[] = [claudeCodeAdapter, geminiCliAdapter, codexAdapter, cursorAdapter];

interface ToolView {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  mining: boolean;
  conflict: string | null;
  experimental: boolean;
  /**
   * "launch"    started by USAGE; the credential lives in the child process
   * "configure" its own config file can name the credential without holding it
   */
  mode: "launch" | "configure";
  /** The user opted this tool in to metering on this device. */
  mapped: boolean;
  meterable: boolean;
  availabilityNote: string | null;
  verificationCeiling: string;
  reads: readonly string[];
  neverReads: readonly string[];
}

export interface AppState {
  version: string;
  signedIn: boolean;
  deviceName: string | null;
  accountLabel: string | null;
  network: string | null;
  providers: { label: string; miningLabel: string }[];
  tools: ToolView[];
  pairing: { userCode: string; verificationUrl: string } | null;
  error: string | null;
  updateAvailable: boolean;
  /** Set once, after an older build's credential has been cleaned up. */
  securityNotice: string | null;
  /** Today's figures, as the SERVER computed them. Null when signed out or offline. */
  usage: DeviceUsageSummary | null;
}

async function readTools(): Promise<ToolView[]> {
  const views: ToolView[] = [];
  for (const adapter of ADAPTERS) {
    const detection = await adapter.detect();
    const routing = detection.installed
      ? await adapter.inspectRouting()
      : ({ state: "off" } as const);

    views.push({
      id: adapter.id,
      name: adapter.displayName,
      installed: detection.installed,
      version: detection.version,
      mining: routing.state === "usage",
      conflict:
        routing.state === "foreign"
          ? `Already routed to ${routing.url}`
          : routing.state === "unreadable"
            ? routing.reason
            : null,
      // Honest labelling: Codex has never been run live through USAGE.
      experimental: adapter.id === "codex",
      mode: adapter.persistentConfig === "unsafe" ? "launch" : "configure",
      mapped: await isMapped(adapter.id),
      meterable: !adapter.capabilities().meteringMethods.includes("unsupported"),
      availabilityNote: adapter.capabilities().availabilityNote,
      verificationCeiling: adapter.capabilities().verificationCeiling,
      reads: adapter.privacyProfile().reads,
      neverReads: adapter.privacyProfile().neverReads,
    });
  }
  return views;
}

/**
 * The window polls every few seconds so an approval in the browser lands here
 * without the user doing anything. That is a UI concern, not a reason to ask
 * the server thirty times a minute -- routing configuration changes when a
 * provider is connected, which is rare.
 */
const CONFIG_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
let configCache: { at: number; config: MinerConfig } | null = null;
const USAGE_TTL_MS = 20_000;
let usageCache: { at: number; value: DeviceUsageSummary | null } = { at: 0, value: null };
let lastHeartbeatAt = 0;

export function invalidateConfigCache(): void {
  configCache = null;
}

async function currentConfig(credential: StoredCredential): Promise<MinerConfig> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.config;
  const config = await fetchConfig(credential.serverUrl, credential.token);
  configCache = { at: Date.now(), config };
  return config;
}

/**
 * Shown once, after an upgrade cleaned up an older build's credential.
 *
 * Held in memory rather than recomputed: the migration is idempotent, so it
 * would report "nothing to do" on every subsequent poll and the user would
 * never see what happened.
 */
let securityNotice: string | null = null;

export function noteSecurityMigration(detail: string): void {
  securityNotice = detail;
}

export async function buildState(pairing: AppState["pairing"] = null): Promise<AppState> {
  const state: AppState = {
    version: VERSION,
    signedIn: false,
    deviceName: null,
    accountLabel: null,
    network: null,
    providers: [],
    tools: await readTools(),
    pairing,
    error: null,
    updateAvailable: false,
    securityNotice,
    usage: null,
  };

  let credential: StoredCredential | null = null;
  try {
    credential = await loadCredential();
  } catch (error) {
    state.error = (error as Error).message;
    return state;
  }
  if (!credential) return state;

  state.signedIn = true;
  state.deviceName = credential.deviceName;

  let config: MinerConfig;
  try {
    config = await currentConfig(credential);
  } catch (error) {
    // A revoked device and an offline machine look different to a user, and
    // the message already distinguishes them.
    state.error = (error as Error).message;
    return state;
  }

  state.accountLabel = config.account.label;
  state.network = config.mining.network;
  state.providers = config.routes.map((route) => ({
    label: route.label,
    miningLabel: route.miningLabel,
  }));
  state.updateAvailable = config.updateRequired;

  if (Date.now() - lastHeartbeatAt > HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatAt = Date.now();
    await sendHeartbeat(
      credential.serverUrl,
      credential.token,
      state.tools.map((tool) => ({
        tool: tool.id,
        version: tool.version,
        detected: tool.installed,
        mapped: tool.mapped,
      })),
      `${platform()} ${release()}`,
      VERSION,
    ).catch(() => undefined);
  }

  if (Date.now() - usageCache.at > USAGE_TTL_MS) {
    usageCache = {
      at: Date.now(),
      value: await fetchDeviceUsage(credential.serverUrl, credential.token).catch(() => null),
    };
  }
  state.usage = usageCache.value;

  return state;
}

/** The route a tool should use, preferring one that actually earns. */
function chooseRoute(config: MinerConfig, adapter: LocalToolAdapter) {
  const tool = config.tools[adapter.id];
  if (!tool) return null;
  const earning = tool.routes.find((route) => route.miningEligibility === "eligible_route");
  const chosen = earning ?? tool.routes[0];
  if (chosen) return { url: chosen.url, label: chosen.label, note: undefined as string | undefined };
  if (tool.fallback) {
    return { url: tool.fallback.url, label: tool.fallback.label, note: tool.fallback.note };
  }
  return null;
}

export function openBrowser(url: string): void {
  // Tests and headless checks drive the local server directly; they should not
  // pop a browser window on whoever's machine is running them.
  if (process.env.USAGE_NO_BROWSER === "1") return;
  // `start` with an empty title argument, so a URL containing & is not split.
  spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

/**
 * Sign in, from the desktop window.
 *
 * The browser does the authenticating; the desktop polls for the result. The
 * credential is never carried in a URL or pasted by the user -- it is collected
 * over the poll channel exactly as the CLI does it.
 */
async function runPairing(onUpdate: (pairing: AppState["pairing"]) => void): Promise<void> {
  const serverUrl = process.env.USAGE_SERVER_URL || "https://usage-ten.vercel.app";
  const started = await startPairing(serverUrl, {
    deviceName: hostname(),
    platform: `${platform()} ${release()}`,
    appVersion: VERSION,
  });

  onUpdate({ userCode: started.userCode, verificationUrl: started.verificationUrl });
  openBrowser(started.verificationUrl);

  const deadline = new Date(started.expiresAt).getTime();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const state = await pollPairing(serverUrl, started.pollToken).catch(() => null);
    if (!state) continue;

    if (state.status === "approved") {
      await saveCredential({
        token: state.token,
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        serverUrl,
      });
      invalidateConfigCache();
      await logEvent({ event: "sign_in", outcome: "ok" });
      onUpdate(null);
      return;
    }
    if (state.status === "denied" || state.status === "expired") break;
  }
  onUpdate(null);
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    // Nothing here should ever be embedded anywhere.
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
    // A local UI never sends anything large; refuse to buffer if it tries.
    if (chunks.reduce((total, part) => total + part.length, 0) > 64 * 1024) break;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface DesktopHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startDesktop(): Promise<DesktopHandle> {
  // Guessing this is the only thing standing between a hostile local page and
  // the miner's controls, so it is full-strength random, not a counter.
  const nonce = randomBytes(24).toString("base64url");
  let pairing: AppState["pairing"] = null;
  let pairingRunning = false;
  let port = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    // The page itself is the only route that does not require the nonce,
    // because it is what delivers it.
    if (url.pathname === "/" && request.method === "GET") {
      if (url.searchParams.get("k") !== nonce) {
        response.writeHead(403, { "content-type": "text/plain" });
        response.end("USAGE Miner: open this window from the application.");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(renderApp(nonce));
      return;
    }

    if (url.searchParams.get("k") !== nonce) {
      json(response, { error: "forbidden" }, 403);
      return;
    }

    // Defence in depth behind the nonce. A cross-site POST carries an Origin
    // header that is not ours; our own page's fetch carries exactly this one.
    // A request with no Origin at all is not from a browser page, so it cannot
    // be the drive-by case this guards against.
    const origin = request.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}`) {
      json(response, { error: "forbidden" }, 403);
      return;
    }

    try {
      if (url.pathname === "/state" && request.method === "GET") {
        json(response, await buildState(pairing));
        return;
      }

      if (url.pathname === "/sign-in" && request.method === "POST") {
        if (!pairingRunning) {
          pairingRunning = true;
          void runPairing((next) => {
            pairing = next;
          }).finally(() => {
            pairingRunning = false;
          });
        }
        json(response, { ok: true });
        return;
      }

      if (url.pathname === "/sign-out" && request.method === "POST") {
        await clearCredential();
        invalidateConfigCache();
        json(response, { ok: true });
        return;
      }

      if (url.pathname === "/enable" && request.method === "POST") {
        const body = await readBody(request);
        const adapter = ADAPTERS.find((entry) => entry.id === body.tool);
        if (!adapter) return json(response, { error: "unknown_tool" }, 400);

        // Enforced here as well as in the adapter. A local caller must not be
        // able to reach a path the UI does not offer.
        if (adapter.persistentConfig === "unsafe") {
          return json(response, { error: "launch_only", message: "Use Start with USAGE." }, 400);
        }

        // A tool that is not installed gets no config file written for it.
        const detection = await adapter.detect();
        if (!detection.installed) {
          return json(response, { error: "not_installed" }, 400);
        }

        const credential = await loadCredential();
        if (!credential) return json(response, { error: "not_signed_in" }, 401);

        const config = await currentConfig(credential);
        const route = chooseRoute(config, adapter);
        if (!route) {
          return json(
            response,
            { error: "no_provider", message: "Connect an AI provider first." },
            400,
          );
        }

        const result = await adapter.enableMining(
          { url: route.url, minerToken: credential.token, label: route.label },
          body.force === true,
        );
        await logEvent({
          event: "enable",
          tool: adapter.id,
          outcome: result.ok ? "ok" : "config_conflict",
        });
        json(response, { ...result, note: route.note });
        return;
      }

      /**
       * Start a tool with USAGE, in its own window.
       *
       * Spawned detached with a console of its own, because these are terminal
       * programs and the desktop window is a browser tab. The credential goes
       * into the child's environment and nowhere else -- not into a shortcut,
       * not into a config file, not into this response.
       */
      if (url.pathname === "/launch" && request.method === "POST") {
        const body = await readBody(request);
        const adapter = ADAPTERS.find((entry) => entry.id === body.tool);
        if (!adapter) return json(response, { error: "unknown_tool" }, 400);

        const credential = await loadCredential();
        if (!credential) return json(response, { error: "not_signed_in" }, 401);

        const config = await currentConfig(credential);
        const route = chooseRoute(config, adapter);
        if (!route) {
          return json(
            response,
            { error: "no_provider", message: "Connect an AI provider first." },
            400,
          );
        }

        // Through the miner's own executable, so the child is started by the
        // same tested launcher the CLI uses rather than a second copy of it.
        spawn(
          "cmd",
          ["/c", "start", `${adapter.displayName} — USAGE Mining`, process.execPath, "run", adapter.id],
          { detached: true, stdio: "ignore" },
        ).unref();

        await logEvent({ event: "launch", tool: adapter.id, outcome: "ok" });
        json(response, { ok: true, label: route.label, note: route.note });
        return;
      }

      /**
       * Per-tool opt-in. The device records the choice and tells the server;
       * the server answers with how it will meter the tool. Nothing about
       * trust is decided here.
       */
      if (url.pathname === "/mapping" && request.method === "POST") {
        const body = await readBody(request);
        const adapter = ADAPTERS.find((entry) => entry.id === body.tool);
        if (!adapter) return json(response, { error: "unknown_tool" }, 400);
        if (adapter.capabilities().meteringMethods.includes("unsupported")) {
          return json(response, { error: "not_meterable", message: adapter.capabilities().availabilityNote }, 400);
        }
        const enabled = body.enabled === true;

        const credential = await loadCredential();
        if (!credential) return json(response, { error: "not_signed_in" }, 401);

        const detection = await adapter.detect();
        try {
          const result = await setMapping(credential.serverUrl, credential.token, adapter.id, enabled, detection.version);
          await setMapped(adapter.id, enabled);
          await logEvent({ event: enabled ? "map" : "unmap", tool: adapter.id, outcome: "ok" });
          json(response, { ok: true, ...result });
        } catch (error) {
          json(response, { error: "server", message: (error as Error).message }, 502);
        }
        return;
      }

      if (url.pathname === "/disable" && request.method === "POST") {
        const body = await readBody(request);
        const adapter = ADAPTERS.find((entry) => entry.id === body.tool);
        if (!adapter) return json(response, { error: "unknown_tool" }, 400);

        const result = await adapter.disableMining();
        await logEvent({ event: "disable", tool: adapter.id, outcome: result.ok ? "ok" : "error" });
        json(response, result);
        return;
      }

      if (url.pathname === "/open" && request.method === "POST") {
        const body = await readBody(request);
        // An allowlist, not a passthrough: this must never become "open any URL
        // the page asks for".
        const targets: Record<string, string> = {
          dashboard: "/dashboard",
          providers: "/providers/add",
          miners: "/miners",
          privacy: "/miners/install",
        };
        const path = targets[String(body.target)];
        if (!path) return json(response, { error: "unknown_target" }, 400);

        const credential = await loadCredential().catch(() => null);
        const base = credential?.serverUrl ?? "https://usage-ten.vercel.app";
        openBrowser(new URL(path, base).toString());
        json(response, { ok: true });
        return;
      }

      if (url.pathname === "/quit" && request.method === "POST") {
        json(response, { ok: true });
        setTimeout(() => process.exit(0), 100);
        return;
      }

      json(response, { error: "not_found" }, 404);
    } catch (error) {
      await logEvent({ event: "ui", outcome: "error", detail: (error as Error).message });
      // Never a stack trace: it can carry paths and, worse, request bodies.
      json(response, { error: "internal", message: "Something went wrong." }, 500);
    }
  });

  // Clean up an older build's on-disk credential before the window is usable.
  // Not awaited by the listen call, but started here so the notice is present
  // by the time the page makes its first /state request.
  void migrateInsecureConfig()
    .then((result) => {
      if (result.changed) noteSecurityMigration(result.detail);
    })
    .catch(() => undefined);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  const appUrl = `http://127.0.0.1:${port}/?k=${nonce}`;

  process.stdout.write(`USAGE Miner ${VERSION}\nOpening ${appUrl}\n`);
  openBrowser(appUrl);

  return {
    url: appUrl,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
