import path from "node:path";
import { PROTOCOL_VERSION, VERSION } from "./version.js";

/**
 * Which build is this, and how was it started?
 *
 * Answered from THIS process only: the version compiled into the build that is
 * running (src/version.ts, kept equal to package.json by a test), the protocol
 * constant this miner speaks, and where the running script lives on disk. It
 * never asks the server, which only knows what some miner last told it.
 *
 * Two windows of different versions running at once (an npx one and an
 * installed one) is exactly the case this line exists for.
 */

export type LaunchSource = "npx" | "npm global" | "npm install" | "packaged exe" | "source checkout";

export function launchSource(input: {
  scriptPath?: string | undefined;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): LaunchSource {
  const execPath = input.execPath ?? process.execPath;
  const scriptPath = input.scriptPath ?? process.argv[1] ?? "";
  const env = input.env ?? process.env;

  // The single-file Windows build runs as its own executable, not node.exe.
  const exe = path.win32.basename(execPath).toLowerCase();
  if (exe !== "node.exe" && exe !== "node") return "packaged exe";

  const parts = scriptPath.toLowerCase().split(/[\\/]+/);
  // npm-cache\_npx\<hash>\node_modules\usage-miner\dist\app.js
  if (parts.includes("_npx")) return "npx";

  const moduleIndex = parts.lastIndexOf("node_modules");
  if (moduleIndex === -1) return "source checkout";

  const install = parts.slice(0, moduleIndex);
  const prefixes = [env.npm_config_prefix, env.APPDATA ? path.win32.join(env.APPDATA, "npm") : undefined]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase().split(/[\\/]+/).filter(Boolean).join("/"));
  const here = install.filter(Boolean).join("/");
  // Windows puts global packages in <prefix>\node_modules; elsewhere <prefix>/lib/node_modules.
  if (prefixes.some((prefix) => here === prefix || here === `${prefix}/lib`)) return "npm global";
  return "npm install";
}

export interface Diagnostics {
  version: string;
  protocol: string;
  launch: LaunchSource;
}

export function diagnostics(): Diagnostics {
  return { version: VERSION, protocol: PROTOCOL_VERSION, launch: launchSource() };
}

/** "Miner 0.4.9 · protocol miner-protocol-v2 · launch: npx" */
export function diagnosticsLine(value: Diagnostics = diagnostics()): string {
  return `Miner ${value.version} · protocol ${value.protocol} · launch: ${value.launch}`;
}
