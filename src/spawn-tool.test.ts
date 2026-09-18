import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolLaunchError, resolveNpmShim, resolveToolCommand, spawnTool } from "./spawn-tool.js";

/**
 * `usage run <tool> …args` must hand the tool its arguments exactly.
 *
 * The regression: `spawn(cmd, args, { shell: true })` flattened the argv into
 * one cmd.exe line, so `codex exec "Reply only: X"` reached Codex as three
 * arguments and Codex exited with `unexpected argument 'only:'`.
 */

// The exact npm cmd-shim body npm writes for a node bin (codex, gemini).
const NPM_SHIM = (target: string) =>
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join("\r\n");

let dir: string;
let argvOut: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "usage-spawn-"));
  argvOut = path.join(dir, "argv.json");
  // A stand-in "codex" that records exactly the argv it received.
  const scriptDir = path.join(dir, "node_modules", "@openai", "codex", "bin");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(
    path.join(scriptDir, "codex.js"),
    "require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n",
  );
  writeFileSync(path.join(dir, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  // A shim that is not npm's: must be refused, never run through a shell.
  writeFileSync(path.join(dir, "weird.cmd"), "@echo off\r\nsomething %*\r\n");
  // A native executable stand-in.
  writeFileSync(path.join(dir, "native.exe"), "");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({ ...process.env, PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD", ARGV_OUT: argvOut });

describe("resolveToolCommand", () => {
  it("starts a native executable directly", () => {
    expect(resolveToolCommand("native", { env: env(), platform: "win32" })).toEqual({
      file: path.join(dir, "native.exe"),
      prefixArgs: [],
    });
  });

  it("turns an npm shim into node + its script, with no shell", () => {
    const resolved = resolveToolCommand("codex", { env: env(), platform: "win32", execPath: "C:\\node\\node.exe" });
    expect(resolved.file).toBe("C:\\node\\node.exe");
    expect(resolved.prefixArgs).toEqual([path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")]);
  });

  it("refuses a .cmd it does not recognise instead of falling back to a shell", () => {
    expect(() => resolveToolCommand("weird", { env: env(), platform: "win32" })).toThrow(ToolLaunchError);
    expect(() => resolveNpmShim(path.join(dir, "weird.cmd"), process.execPath)).toThrow(/not started through a shell/);
  });

  it("reports a tool that is not installed", () => {
    expect(() => resolveToolCommand("gemini", { env: env(), platform: "win32" })).toThrow(/not found on PATH/);
  });

  it("leaves other platforms to the OS lookup", () => {
    expect(resolveToolCommand("codex", { platform: "linux" })).toEqual({ file: "codex", prefixArgs: [] });
  });
});

describe.runIf(process.platform === "win32")("spawnTool on Windows delivers argv exactly", () => {
  async function run(args: string[]): Promise<string[]> {
    rmSync(argvOut, { force: true });
    const child = spawnTool("codex", args, { env: env(), stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
    return JSON.parse(readFileSync(argvOut, "utf8")) as string[];
  }

  it('regression: codex exec "Reply only: X" arrives as ONE argument', async () => {
    expect(await run(["exec", "Reply only: X"])).toEqual(["exec", "Reply only: X"]);
  });

  it("keeps spaces, quotes and cmd.exe metacharacters verbatim", async () => {
    const hostile = ['He said "hi" & echo pwned', "100% ^done | more", "a > b < c", "  padded  ", ""];
    expect(await run(["exec", ...hostile])).toEqual(["exec", ...hostile]);
  });

  it("passes the -c overrides the miner adds before the user's prompt, unchanged", async () => {
    const args = ["-c", 'otel.exporter.otlp-http.endpoint="http://127.0.0.1:5000/v1/logs"', "-c", "otel.log_user_prompt=false", "exec", "Reply only: X"];
    expect(await run(args)).toEqual(args);
  });
});

describe("the run command never launches a tool through a shell", () => {
  it("cli.ts starts tools with spawnTool, not spawn(..., { shell: true })", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "cli.ts"), "utf8");
    expect(source).toContain("spawnTool(plan.command");
    expect(source).not.toMatch(/spawn\(plan\.command[^)]*shell:\s*true/);
  });
});
