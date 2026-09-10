import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "./ui-page.js";
import { DETECT_TIMEOUT_MS, readTools } from "./ui.js";
import type { LocalToolAdapter } from "./tools/adapter.js";
import { claudeCodeAdapter } from "./tools/claude-code.js";

/**
 * The Windows first run.
 *
 * The 0.4.0 installer shipped a window that said "Loading…" forever: a raw
 * newline inside a JS string literal in the inline script, so the browser
 * threw a SyntaxError before the first fetch. Everything here is about that
 * class of failure -- the page must PARSE, every startup operation must be
 * BOUNDED, and a failure must be SHOWN.
 */

function pageScript(): string {
  const html = renderApp("abcdefghijklmnopqrstuvwxyz012345");
  return html.split("<script>")[1].split("</script>")[0];
}

describe("the page script", () => {
  it("parses: a SyntaxError here is a window that never renders", () => {
    // `new Function` compiles without running; the 0.4.0 bug fails right here.
    expect(() => new Function(pageScript())).not.toThrow();
  });

  it("contains no raw line break inside a string literal", () => {
    // Every string literal must stay on one line; a newline inside one is
    // exactly the bug. Crude on purpose: it looks at the emitted text.
    for (const line of pageScript().split("\n")) {
      const quotes = (line.match(/(?<!\\)"/g) ?? []).length;
      expect(quotes % 2, `unbalanced quotes: ${line.trim().slice(0, 80)}`).toBe(0);
    }
  });

  it("bounds every request and replaces Loading on failure", () => {
    const js = pageScript();
    expect(js).toContain("AbortController");
    expect(js).toContain("STARTUP_TIMEOUT_MS");
    expect(js).toContain("Something went wrong while starting.");
    expect(js).toContain('"Retry"');
    expect(js).toContain("bad_json");
    // The failure screen shows a category word, never a message.
    expect(js).toContain('"Technical details: " + category');
  });

  it("renders an offline account and an unavailable detection", () => {
    const js = pageScript();
    expect(js).toContain("Offline — unable to reach USAGE");
    expect(js).toContain("Detection unavailable");
  });
});

function fakeAdapter(id: "codex" | "gemini-cli", detect: LocalToolAdapter["detect"]): LocalToolAdapter {
  return {
    ...claudeCodeAdapter,
    id,
    displayName: id,
    detect,
    inspectRouting: async () => ({ state: "off" }),
  };
}

describe("tool detection cannot block the window", () => {
  let home: string;
  beforeEach(() => {
    home = path.join(process.env.TEMP ?? "/tmp", `usage-first-run-${Date.now()}`);
    process.env.APPDATA = home;
  });
  afterEach(() => {
    delete process.env.APPDATA;
  });

  it("isolates an adapter that hangs, throws, or returns nonsense, and still lists the others", async () => {
    const hang = fakeAdapter("codex", () => new Promise(() => undefined));
    const boom = fakeAdapter("gemini-cli", async () => { throw new Error("shell exploded"); });
    const nonsense = { ...fakeAdapter("codex", async () => ({ nonsense: true }) as never), id: "cursor" as const, displayName: "cursor" };
    const fine = fakeAdapter("gemini-cli", async () => ({ installed: true, version: "1.0.0", configPath: "" }));

    const started = Date.now();
    const tools = await readTools([hang, boom, nonsense, fine]);
    expect(Date.now() - started).toBeLessThan(DETECT_TIMEOUT_MS + 1_000);

    expect(tools.map((t) => t.detectionUnavailable)).toEqual([true, true, true, false]);
    expect(tools[3].installed).toBe(true);
    expect(tools[3].version).toBe("1.0.0");
    expect(tools).toHaveLength(4);
  });

  it("runs the real adapters in bounded time", async () => {
    const started = Date.now();
    const tools = await readTools();
    expect(Date.now() - started).toBeLessThan(DETECT_TIMEOUT_MS * 2);
    expect(tools.length).toBeGreaterThanOrEqual(4);
  }, 15_000);
});

describe("the installer", () => {
  const source = readFileSync(path.resolve(process.cwd(), "scripts/installer.mjs"), "utf8");

  it("carries a modern application manifest: asInvoker, Windows 10/11, DPI aware", async () => {
    const { applicationManifest } = await import("../scripts/installer.mjs");
    const manifest = applicationManifest({ name: "USAGE.Miner", version: "0.4.1" });
    expect(manifest).toContain('requestedExecutionLevel level="asInvoker"');
    expect(manifest).toContain("{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}");
    expect(manifest).not.toMatch(/Vista|Windows 7|Windows 8/);
    expect(manifest).toContain('version="0.4.1.0"');
    expect(source).toContain("/win32manifest:");
  });

  it("uses proper exit semantics and verifies its work before claiming success", async () => {
    const { EXIT_OK, EXIT_CANCELLED, EXIT_FAILED } = await import("../scripts/installer.mjs");
    expect([EXIT_OK, EXIT_CANCELLED, EXIT_FAILED]).toEqual([0, 1223, 1]);
    expect(source).toContain("return ExitCancelled;");
    expect(source).toContain("Installation is incomplete");
    expect(source).toContain("the uninstall entry was not created");
  });

  it("installs a GUI launcher and keeps the console executable for the CLI", async () => {
    const { launcherSource, LAUNCHER_NAME } = await import("../scripts/installer.mjs");
    const launcher = launcherSource({ exeName: "USAGE-Miner-0.4.1.exe" });
    expect(LAUNCHER_NAME).toBe("USAGE Miner.exe");
    expect(launcher).toContain("CreateNoWindow = true");
    expect(launcher).toContain("--desktop");
    // Start menu opens the launcher; the Claude Code shortcut still opens a terminal tool.
    expect(source).toContain("CreateShortcut(StartMenuShortcut, LauncherExe");
    expect(source).toContain('"run claude-code"');
    expect(source).toContain("/target:winexe");
  });

  it("keeps the install per-user with no service, autostart or elevation", () => {
    expect(source).toContain("Registry.CurrentUser");
    expect(source).not.toMatch(/Registry\.LocalMachine|ServiceController|\\Run\\|requireAdministrator/);
  });
});

describe("built artifacts, when present", () => {
  const artifacts = path.resolve(process.cwd(), "dist/artifacts");
  const launcher = path.join(artifacts, "USAGE Miner.exe");

  it.skipIf(!existsSync(launcher))("the launcher is a GUI-subsystem executable and the miner is a console one", async () => {
    const { peSubsystem } = await import("../scripts/inspect-pe.mjs");
    expect(peSubsystem(launcher)).toBe(2);
    const { readdirSync } = await import("node:fs");
    const exe = readdirSync(artifacts).find((f) => /^USAGE-Miner-\d.*[^p]\.exe$/.test(f) && !f.includes("Setup"));
    expect(exe).toBeTruthy();
    expect(peSubsystem(path.join(artifacts, exe!))).toBe(3);
  });
});

describe("startup diagnostics never leak", () => {
  it("logs detection failures by tool id only", () => {
    const ui = readFileSync(path.resolve(process.cwd(), "src/ui.ts"), "utf8");
    expect(ui).toContain('event: "detect", outcome: "error"');
  });

  it("the page never puts the nonce anywhere but the query key", () => {
    const html = renderApp("abcdefghijklmnopqrstuvwxyz012345");
    expect((html.match(/abcdefghijklmnopqrstuvwxyz012345/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/authorization|x-usage-miner-token/i);
  });
});
