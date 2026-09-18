import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logPath } from "./log.js";
import { alwaysOnStatus, enableAlwaysOn, verifyAlwaysOn } from "./telemetry/always-on.js";
import { ALWAYS_ON_COPY, startDesktop, type DesktopHandle } from "./ui.js";
import { PROTOCOL_VERSION } from "./version.js";

/**
 * "Measure Claude Code everywhere", through the desktop window's own route.
 *
 * The owner turned it off -- they believed -- and afterwards nothing on disk
 * had changed and the log had no trace of an attempt. So: every attempt is
 * logged with its outcome, every failure is an answer the page can show, and
 * "ok" is only said after the files have been read back.
 */

let app: DesktopHandle;
let base: string;
let nonce: string;
let home: string;

const settingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
const fixture = {
  model: "opus",
  hooks: { Stop: [{ hooks: [{ type: "command", command: "node C:/hooks/notify.js" }] }] },
  env: { MINE: "1", OTEL_LOG_TOOL_DETAILS: "1" },
};
const post = (route: string, body: unknown, withNonce = true) =>
  fetch(`${base}${route}${withNonce ? `?k=${nonce}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const logLines = async () =>
  (await readFile(logPath(), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>);
const last = async (event: string) => (await logLines()).filter((line) => line.event === event).pop();

beforeAll(async () => {
  process.env.USAGE_NO_BROWSER = "1";
  home = await mkdtemp(path.join(tmpdir(), "usage-miner-ui-ao-"));
  process.env.APPDATA = path.join(home, "AppData");
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  // Never the real fixed port: a developer's own miner may be holding it.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const alwaysOnPort = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  app = await startDesktop({ alwaysOnPort });
  const url = new URL(app.url);
  base = url.origin;
  nonce = url.searchParams.get("k") ?? "";
});

afterAll(async () => {
  await app?.close();
  await rm(home, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe("the Measure everywhere switch, through the window", () => {
  it("says exactly what OFF and ON mean", () => {
    expect(ALWAYS_ON_COPY.offTitle).toBe("MEASURE EVERYWHERE OFF");
    expect(ALWAYS_ON_COPY.off).toBe(
      "Claude Code sessions started before this may keep trying to report until you restart them; USAGE Miner no longer receives or uploads them.",
    );
    expect(ALWAYS_ON_COPY.on).toBe("Applies to Claude Code sessions started from now on.");
  });

  it("turns off with no credential, restores settings.json, reads it back, and logs it", async () => {
    await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    await writeFile(settingsFile(), JSON.stringify(fixture), "utf8");
    expect((await enableAlwaysOn()).ok).toBe(true);

    const response = await post("/always-on", { enabled: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, enabled: false, title: ALWAYS_ON_COPY.offTitle, message: ALWAYS_ON_COPY.off });
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toEqual(fixture);
    expect((await alwaysOnStatus()).enabled).toBe(false);
    expect(await verifyAlwaysOn("off")).toEqual({ ok: true });
    expect(await last("always_on_disable")).toMatchObject({ outcome: "ok", detail: "changed" });
    // The log never carries the receiver key or anything from the file.
    expect(await readFile(logPath(), "utf8")).not.toMatch(/X-Usage-Miner=|OTEL_|opus/);

    // Off when already off: still an answer, still logged.
    const again = await post("/always-on", { enabled: false });
    expect((await again.json()).ok).toBe(true);
    expect(await last("always_on_disable")).toMatchObject({ outcome: "ok", detail: "unchanged" });
  });

  it("refuses to turn on while signed out, says so, and logs it", async () => {
    const response = await post("/always-on", { enabled: true });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("not_signed_in");
    expect(await last("always_on_enable")).toMatchObject({ outcome: "error", detail: "not_signed_in" });
    expect((await alwaysOnStatus()).enabled).toBe(false);
  });

  it("answers a settings file it cannot read with an error the page shows, touches nothing, and logs it", async () => {
    await writeFile(settingsFile(), JSON.stringify(fixture), "utf8");
    await enableAlwaysOn();
    await writeFile(settingsFile(), "{ not json", "utf8");

    const response = await post("/always-on", { enabled: false });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("settings_unreadable");
    expect(typeof body.message).toBe("string");
    expect(await readFile(settingsFile(), "utf8")).toBe("{ not json");
    expect(await last("always_on_disable")).toMatchObject({ outcome: "error", detail: "settings_unreadable" });

    // Put right by the user; now it goes off.
    await writeFile(settingsFile(), JSON.stringify(fixture), "utf8");
    expect((await post("/always-on", { enabled: false })).status).toBe(200);
  });

  it("rejects a malformed request and logs the attempt", async () => {
    const response = await post("/always-on", { enabled: "off" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("bad_request");
    expect(await last("always_on_toggle")).toMatchObject({ outcome: "error", detail: "bad_request" });
  });

  it("logs a toggle refused for a wrong nonce, and tells the page why", async () => {
    const response = await post("/always-on", { enabled: false }, false);
    expect(response.status).toBe(403);
    expect((await response.json()).message).toMatch(/Close this tab/);
    expect(await last("ui_forbidden")).toMatchObject({ outcome: "error", detail: "nonce:always-on" });
  });

  it("serves a page whose script compiles, and whose switch stays reachable while it is on", async () => {
    const { Script } = await import("node:vm");
    const html = await (await fetch(`${base}/?k=${nonce}`)).text();
    const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
    expect(() => new Script(script)).not.toThrow();
    // A failed request is shown, never swallowed, and the card is not gated
    // on sign-in or detection while the switch is on.
    expect(script).not.toContain("fn().catch(function () {})");
    expect(script).toContain("if (!ao.enabled && !offerable && !aoNotice) return null;");
  });

  it("reports this build's own version, protocol and launch source", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
    const state = await (await fetch(`${base}/state?k=${nonce}`)).json();
    expect(state.diagnostics).toEqual({ version: pkg.version, protocol: PROTOCOL_VERSION, launch: expect.any(String) });
    // The old line printed the app version where the protocol belonged.
    expect(state.diagnostics.protocol).not.toBe(state.diagnostics.version);
  });
});
