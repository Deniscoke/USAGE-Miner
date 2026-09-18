import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Starting an AI tool with its arguments exactly as given.
 *
 * `spawn(command, args, { shell: true })` joins the argv into ONE command line
 * for cmd.exe without quoting it (Node's DEP0190 warns about exactly this), so
 * `usage run codex exec "Reply only: X"` reached Codex as `exec Reply only: X`
 * -- three arguments -- and Codex refused it. Escaping for cmd.exe by hand is
 * the classic source of injection bugs, so this module does not do it at all:
 * the command is resolved to a real file and started WITHOUT a shell, with the
 * arguments passed as an array.
 *
 * On Windows the tools arrive in two shapes:
 *
 *   native executable   claude.exe          -> started directly
 *   npm cmd-shim        codex.cmd, gemini.cmd
 *                        -> the shim's target script is read out of the shim
 *                           and started with node: node <script> ...args
 *
 * Node refuses to start a .cmd/.bat without a shell (CVE-2024-27980), which is
 * why the old code used `shell: true`. Reading the npm shim's target keeps the
 * same program running without ever building a command string. A shim this
 * module does not recognise is refused with a clear message rather than
 * falling back to a shell.
 */

export class ToolLaunchError extends Error {}

export interface ResolvedTool {
  /** The file actually executed. */
  file: string;
  /** Arguments that come before the user's, e.g. the script for a node shim. */
  prefixArgs: string[];
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The node binary to use for an npm shim with no node.exe beside it. */
  execPath?: string;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * npm's cmd-shim ends with the target in quotes followed by `%*`, e.g.
 *   "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 * or, for a native target,
 *   "%dp0%\node_modules\...\tool.exe" %*
 */
const NPM_SHIM_TARGET = /"%~?dp0%?\\([^"]+)"\s+%\*/i;

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(command) && isFile(command)) return command;
  const dirs = (envValue(env, "PATH") ?? "").split(path.delimiter).filter(Boolean);
  const exts = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const hasExt = exts.includes(path.extname(command).toLowerCase());
  for (const dir of dirs) {
    if (hasExt && isFile(path.join(dir, command))) return path.join(dir, command);
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve an npm cmd-shim to the program it starts. */
export function resolveNpmShim(shimPath: string, execPath: string): ResolvedTool {
  const text = readFileSync(shimPath, "utf8");
  const match = NPM_SHIM_TARGET.exec(text);
  if (!match) {
    throw new ToolLaunchError(
      `${path.basename(shimPath)} is not an npm launcher USAGE Miner recognises, so it is not started through a shell. ` +
        "Start the tool yourself, or reinstall it with npm.",
    );
  }
  const dir = path.dirname(shimPath);
  const target = path.join(dir, match[1]);
  if (!isFile(target)) {
    throw new ToolLaunchError(`${path.basename(shimPath)} points to a file that does not exist.`);
  }
  const ext = path.extname(target).toLowerCase();
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    const bundledNode = path.join(dir, "node.exe");
    return { file: existsSync(bundledNode) ? bundledNode : execPath, prefixArgs: [target] };
  }
  if (ext === ".exe" || ext === ".com") return { file: target, prefixArgs: [] };
  throw new ToolLaunchError(`${path.basename(shimPath)} starts a ${ext || "file"} USAGE Miner does not run directly.`);
}

export function resolveToolCommand(command: string, options: ResolveOptions = {}): ResolvedTool {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { file: command, prefixArgs: [] };

  const env = options.env ?? process.env;
  const found = findOnPath(command, env);
  if (!found) throw new ToolLaunchError(`${command} was not found on PATH.`);

  const ext = path.extname(found).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { file: found, prefixArgs: [] };
  if (ext === ".cmd" || ext === ".bat") return resolveNpmShim(found, options.execPath ?? process.execPath);
  throw new ToolLaunchError(`${path.basename(found)} is not something USAGE Miner starts directly.`);
}

/**
 * Start a tool with `args` delivered to it exactly, element for element. Never
 * through a shell.
 */
export function spawnTool(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; stdio?: StdioOptions; cwd?: string } = {},
): ChildProcess {
  const env = options.env ?? process.env;
  const resolved = resolveToolCommand(command, { env });
  return spawn(resolved.file, [...resolved.prefixArgs, ...args], {
    env,
    cwd: options.cwd,
    stdio: options.stdio ?? "inherit",
    shell: false,
    windowsHide: false,
  });
}
