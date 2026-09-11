import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- a build script, deliberately plain JS with no type surface.
import { SETUP_ASSET, STANDALONE_ASSET, stableNameFor, stageRelease } from "../scripts/stage-release.mjs";

/**
 * M16D §1: what a release publishes.
 *
 * The website shows a checksum beside a download link and asks people to
 * trust that the two describe the same bytes. That promise is kept here or
 * not at all.
 */

let source: string;
let target: string;

const SETUP_BYTES = "installer bytes";
const EXE_BYTES = "standalone bytes";

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-stage-"));
  source = path.join(home, "artifacts");
  target = path.join(home, "release");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "USAGE-Miner-0.4.5-Setup.exe"), SETUP_BYTES);
  await writeFile(path.join(source, "USAGE-Miner-0.4.5.exe"), EXE_BYTES);
  // Build byproducts that share the directory.
  await writeFile(path.join(source, "USAGE Miner.exe"), "gui launcher");
  await writeFile(path.join(source, "launcher.cs"), "// source");
  await writeFile(path.join(source, "launcher.manifest"), "<assembly/>");
  await writeFile(path.join(source, "SHA256SUMS.txt"), "stale  USAGE-Miner-0.4.5-Setup.exe\n");
  await writeFile(
    path.join(source, "release.json"),
    JSON.stringify({
      product: "USAGE Miner",
      version: "0.4.5",
      channel: "beta",
      platform: "win32-x64",
      builtAt: "2026-09-11T00:00:00.000Z",
      nodeVersion: "v24.13.1",
      signed: false,
      files: [
        { name: "USAGE-Miner-0.4.5.exe", bytes: 1, sha256: "stale", reproducible: true },
        { name: "USAGE-Miner-0.4.5-Setup.exe", bytes: 1, sha256: "stale", reproducible: false },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(path.dirname(source), { recursive: true, force: true });
});

describe("stableNameFor", () => {
  it("drops the version from a published name", () => {
    expect(stableNameFor("USAGE-Miner-0.4.5-Setup.exe")).toBe(SETUP_ASSET);
    expect(stableNameFor("USAGE-Miner-0.4.5.exe")).toBe(STANDALONE_ASSET);
    expect(stableNameFor("USAGE-Miner-1.0.0-beta.2-Setup.exe")).toBe(SETUP_ASSET);
  });

  it("leaves an already stable name alone, so staging twice is safe", () => {
    expect(stableNameFor(SETUP_ASSET)).toBe(SETUP_ASSET);
    expect(stableNameFor(STANDALONE_ASSET)).toBe(STANDALONE_ASSET);
  });

  it("publishes nothing that is a build byproduct", () => {
    // The launcher lives inside the installer as a resource. Beside a
    // download it is just a 5 KB file nobody should run.
    expect(stableNameFor("USAGE Miner.exe")).toBeNull();
    expect(stableNameFor("launcher.cs")).toBeNull();
    expect(stableNameFor("launcher.manifest")).toBeNull();
    expect(stableNameFor("SHA256SUMS.txt")).toBeNull();
    expect(stableNameFor("release.json")).toBeNull();
  });
});

describe("stageRelease", () => {
  it("publishes the installer, the standalone, a checksum file and a manifest", async () => {
    stageRelease({ from: source, to: target });
    expect((await readdir(target)).sort()).toEqual(
      [SETUP_ASSET, STANDALONE_ASSET, "SHA256SUMS.txt", "release.json"].sort(),
    );
  });

  it("computes every checksum over the staged bytes, never over a stale manifest", async () => {
    const manifest = stageRelease({ from: source, to: target });
    const expected = createHash("sha256").update(SETUP_BYTES).digest("hex");
    const setup = manifest.files.find((file: { name: string }) => file.name === SETUP_ASSET);
    expect(setup.sha256).toBe(expected);
    expect(setup.bytes).toBe(SETUP_BYTES.length);
    const sums = await readFile(path.join(target, "SHA256SUMS.txt"), "utf8");
    expect(sums).toContain(`${expected}  ${SETUP_ASSET}`);
    expect(sums).not.toContain("stale");
    expect(sums).not.toContain("0.4.5");
  });

  it("keeps the version in the manifest, out of the filenames", async () => {
    const manifest = stageRelease({ from: source, to: target });
    expect(manifest.version).toBe("0.4.5");
    expect(manifest.nodeVersion).toBe("v24.13.1");
    for (const file of manifest.files) expect(file.name).not.toContain("0.4.5");
  });

  it("offers the installer first", () => {
    expect(stageRelease({ from: source, to: target }).files[0].name).toBe(SETUP_ASSET);
  });

  it("never calls a build signed unless the caller just verified it", () => {
    expect(stageRelease({ from: source, to: target }).signed).toBe(false);
    expect(stageRelease({ from: source, to: target }).signingNote).toMatch(/not code-signed/i);
    const signed = stageRelease({ from: source, to: target, signed: true });
    expect(signed.signed).toBe(true);
    expect(signed.signingNote).toMatch(/code-signed/i);
  });

  it("refuses to stage a release with no installer", async () => {
    await rm(path.join(source, "USAGE-Miner-0.4.5-Setup.exe"));
    expect(() => stageRelease({ from: source, to: target })).toThrow(/no installer/);
  });

  it("refuses to stage from a directory that does not exist", () => {
    expect(() => stageRelease({ from: path.join(source, "missing"), to: target })).toThrow(/does not exist/);
  });
});
