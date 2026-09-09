import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderApp } from "./ui-page.js";
import { startDesktop, type DesktopHandle } from "./ui.js";
import { CLI_COMMANDS } from "./app.js";
import { CLI_COMMAND_NAMES } from "./cli.js";

describe("the packaged entry point", () => {
  it("accepts every CLI command, so none is silently unreachable from the exe", () => {
    // Found by the M13 acceptance run: `map` existed in the CLI and the
    // installed executable answered "unknown command".
    for (const name of CLI_COMMAND_NAMES) expect(CLI_COMMANDS.has(name), name).toBe(true);
  });
});

/**
 * The desktop window is a local HTTP server, which makes it the one part of the
 * miner that is reachable by something other than the user. These tests are
 * about that boundary: who can talk to it, and what it will do when asked.
 */

describe("renderApp", () => {
  it("refuses a nonce that could break out of the script literal", () => {
    expect(() => renderApp('";alert(1);//')).toThrow(/unsafe nonce/);
    expect(() => renderApp("abc<script>")).toThrow(/unsafe nonce/);
  });

  it("embeds a well-formed nonce and loads nothing from the network", () => {
    const html = renderApp("aB3-_x");
    expect(html).toContain('var K = "aB3-_x"');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).toContain("default-src 'none'");
  });

  it("never renders untrusted values as markup", () => {
    // The page builds every node with textContent. An assignment to innerHTML
    // (or a document.write) would let a provider label become script.
    const html = renderApp("k");
    expect(html).not.toMatch(/\.innerHTML\s*=/);
    expect(html).not.toMatch(/document\.write/);
    expect(html).not.toMatch(/insertAdjacentHTML/);
  });
});

describe("the local desktop server", () => {
  let app: DesktopHandle;
  let base: string;
  let nonce: string;

  let home: string;

  beforeAll(async () => {
    process.env.USAGE_NO_BROWSER = "1";
    // Redirect the credential store into a temp directory. Without this the
    // suite reads whatever the developer's own machine happens to be signed in
    // as, and "not signed in" stops being a property of the code.
    home = await mkdtemp(path.join(tmpdir(), "usage-miner-ui-"));
    process.env.APPDATA = path.join(home, "AppData");

    app = await startDesktop();
    const url = new URL(app.url);
    base = url.origin;
    nonce = url.searchParams.get("k") ?? "";
  });

  afterAll(async () => {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  });

  it("binds to loopback only", () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(nonce.length).toBeGreaterThanOrEqual(24);
  });

  it("serves the page only to a request carrying the session nonce", async () => {
    expect((await fetch(`${base}/`)).status).toBe(403);
    expect((await fetch(`${base}/?k=wrong`)).status).toBe(403);

    const ok = await fetch(`${base}/?k=${nonce}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("USAGE Miner");
  });

  it("refuses every control route without the nonce", async () => {
    for (const path of ["/state", "/sign-in", "/enable", "/disable", "/open", "/quit"]) {
      const response = await fetch(`${base}${path}`, { method: "POST" });
      expect(response.status, path).toBe(403);
    }
  });

  it("refuses a cross-origin request even with the nonce", async () => {
    // The realistic attack: a page the user has open guesses nothing, but a
    // malicious local program that read the nonce still has to come from
    // somewhere. Origin is the second lock.
    const response = await fetch(`${base}/sign-out?k=${nonce}`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("reports local state without a credential, rather than failing", async () => {
    const state = await (await fetch(`${base}/state?k=${nonce}`)).json();
    expect(state.signedIn).toBe(false);
    expect(Array.isArray(state.tools)).toBe(true);
    // Tool identity is compiled in; the server cannot introduce a new one.
    expect(state.tools.map((tool: { id: string }) => tool.id).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
    ]);
  });

  it("never returns a credential to the page", async () => {
    const body = await (await fetch(`${base}/state?k=${nonce}`)).text();
    expect(body).not.toMatch(/usgm_/);
    expect(body).not.toMatch(/sessionSecret|Bearer /);
    // The word "token" is legitimate copy ("Token counts"); the credential
    // prefix and the receiver's session secret are what must never appear.
  });

  it("opens only allowlisted destinations", async () => {
    const attempts = [
      { target: "https://evil.example" },
      { target: "../../etc/passwd" },
      { target: "file:///C:/Windows" },
      {},
    ];
    for (const body of attempts) {
      const response = await fetch(`${base}/open?k=${nonce}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(await response.json()).toEqual({ error: "unknown_target" });
    }
  });

  it("rejects an unknown tool id", async () => {
    const response = await fetch(`${base}/enable?k=${nonce}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "../../evil" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown_tool" });
  });

  it("refuses to persistently configure Claude Code at all", async () => {
    // The M12 rule, enforced at the loopback boundary as well as in the
    // adapter: a local caller must not reach a path the UI does not offer.
    const response = await fetch(`${base}/enable?k=${nonce}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude-code" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("launch_only");
  });

  it("will not write a config file for a tool that is not installed", async () => {
    const response = await fetch(`${base}/enable?k=${nonce}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "codex" }),
    });
    // Codex is absent on the machine running these tests; if it were present
    // the next gate is sign-in, which is equally a refusal.
    expect([400, 401]).toContain(response.status);
    expect(["not_installed", "not_signed_in"]).toContain((await response.json()).error);
  });

  it("refuses to launch a tool before the device is signed in", async () => {
    const response = await fetch(`${base}/launch?k=${nonce}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude-code" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not_signed_in" });
  });

  it("says which tools are launched rather than configured", async () => {
    const state = await (await fetch(`${base}/state?k=${nonce}`)).json();
    const claude = state.tools.find((tool: { id: string }) => tool.id === "claude-code");
    const codex = state.tools.find((tool: { id: string }) => tool.id === "codex");
    expect(claude.mode).toBe("launch");
    expect(codex.mode).toBe("configure");
  });
});
