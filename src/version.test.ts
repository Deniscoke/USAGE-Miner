import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { diagnosticsLine, launchSource } from "./diagnostics.js";
import { PROTOCOL_VERSION, VERSION } from "./version.js";

/**
 * Which build is running must be answerable from the build itself.
 *
 * Two miner windows of different versions ran at once on the owner's PC, and
 * the window's diagnostics line printed the app version labelled "protocol".
 * The version shown is the one compiled into the running code, kept equal to
 * package.json here -- including the compiled dist that npm actually ships.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
const distVersion = path.join(root, "dist", "version.js");
const distApp = path.join(root, "dist", "app.js");

describe("the version this build reports", () => {
  it("is package.json's version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is a protocol id, not the app version, in the protocol slot", () => {
    expect(PROTOCOL_VERSION).toMatch(/^miner-protocol-v\d+$/);
    expect(diagnosticsLine({ version: VERSION, protocol: PROTOCOL_VERSION, launch: "npx" })).toBe(
      `Miner ${VERSION} · protocol ${PROTOCOL_VERSION} · launch: npx`,
    );
  });

  // `npm test` runs before `npm run build` in the checks, so a checkout that
  // has never been built has no dist to ask. Once built, a stale dist -- one
  // compiled before a version bump -- fails here instead of shipping.
  it.skipIf(!existsSync(distVersion))("is what the compiled dist says", async () => {
    const built = (await import(pathToFileURL(distVersion).href)) as { VERSION: string; PROTOCOL_VERSION: string };
    expect(built.VERSION).toBe(pkg.version);
    expect(built.PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });

  it.skipIf(!existsSync(distApp))("is what `usage --version` prints from the compiled dist", () => {
    const env = { ...process.env };
    // app.ts does not run main() under vitest; the child is not under vitest.
    delete env.VITEST;
    for (const flag of ["--version", "version"]) {
      const result = spawnSync(process.execPath, [distApp, flag], { env, encoding: "utf8", timeout: 20_000 });
      expect(result.status, flag).toBe(0);
      expect(result.stdout.trim(), flag).toBe(`USAGE Miner ${pkg.version} · protocol ${PROTOCOL_VERSION} · launch: source checkout`);
    }
  });
});

describe("where the running miner was started from", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const env = { APPDATA: "C:\\Users\\denis\\AppData\\Roaming" };

  it("npx: the script is inside an npm-cache _npx directory", () => {
    expect(launchSource({
      execPath: node,
      scriptPath: "C:\\Users\\denis\\AppData\\Local\\npm-cache\\_npx\\3f2a9c1d\\node_modules\\usage-miner\\dist\\app.js",
      env,
    })).toBe("npx");
  });

  it("npm global: the script is under the npm global prefix", () => {
    expect(launchSource({
      execPath: node,
      scriptPath: "C:\\Users\\denis\\AppData\\Roaming\\npm\\node_modules\\usage-miner\\dist\\app.js",
      env,
    })).toBe("npm global");
    expect(launchSource({
      execPath: node,
      scriptPath: "D:\\tools\\node_modules\\usage-miner\\dist\\app.js",
      env: { ...env, npm_config_prefix: "D:\\tools" },
    })).toBe("npm global");
  });

  it("a project's node_modules is an npm install, not global", () => {
    expect(launchSource({ execPath: node, scriptPath: "C:\\work\\app\\node_modules\\usage-miner\\dist\\app.js", env })).toBe("npm install");
  });

  it("source checkout otherwise, and the packaged exe when not run by node", () => {
    expect(launchSource({ execPath: node, scriptPath: "C:\\Users\\denis\\Desktop\\USAGE-Miner\\dist\\app.js", env })).toBe("source checkout");
    expect(launchSource({ execPath: "C:\\Users\\denis\\AppData\\Local\\Programs\\USAGE Miner\\USAGE-Miner.exe", scriptPath: undefined, env })).toBe("packaged exe");
  });
});
