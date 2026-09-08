#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Build the standalone Windows executable.
 *
 * The requirement is that a beta user installs nothing: no Node, no npm, no
 * terminal. Node's Single Executable Application support gives exactly that --
 * the Node runtime with our bundled script injected as a resource -- and it
 * costs us no second implementation of the miner, which is the part that has
 * tests and has been reviewed.
 *
 * The pipeline:
 *
 *   1. esbuild bundles src/app.ts (and everything it imports) to one CommonJS
 *      file. SEA runs a single script; it does not resolve imports at runtime.
 *   2. node --experimental-sea-config produces a blob from that script.
 *   3. The blob is injected into a copy of this machine's node.exe.
 *
 * Reproducibility is bounded by step 3: the artifact contains the Node build
 * that produced it, so the manifest records that version alongside the hash.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "dist");
const artifacts = path.join(out, "artifacts");

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const VERSION = pkg.version;
const EXE_NAME = `USAGE-Miner-${VERSION}.exe`;

function log(message) {
  process.stdout.write(`  ${message}\n`);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function bundle() {
  const entry = path.join(root, "src", "app.ts");
  const bundlePath = path.join(out, "sea-bundle.cjs");

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    // The floor Node version we support; also what SEA embeds.
    target: "node20",
    format: "cjs",
    outfile: bundlePath,
    // Unminified on purpose. This binary asks people to trust it with a
    // credential and with their tools' configuration, so the blob anyone
    // extracts from it should be readable code with real identifiers -- not a
    // wall of single letters. (esbuild still strips comments; the structure and
    // the names are what make it auditable.)
    minify: false,
    legalComments: "inline",
    define: { "process.env.NODE_ENV": '"production"' },
  });

  log(`bundle  ${(statSync(bundlePath).size / 1024).toFixed(0)} KB`);
  return bundlePath;
}

function buildBlob(bundlePath) {
  const configPath = path.join(out, "sea-config.json");
  const blobPath = path.join(out, "sea-prep.blob");

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: path.relative(root, bundlePath).replaceAll("\\", "/"),
        output: path.relative(root, blobPath).replaceAll("\\", "/"),
        disableExperimentalSEAWarning: true,
        // No snapshot: it forbids top-level await and buys us nothing here.
        useSnapshot: false,
        // No code cache either: V8 bakes machine-specific data into it, and two
        // builds of the same source would then hash differently -- which would
        // make the published checksum unverifiable by anyone rebuilding.
        useCodeCache: false,
      },
      null,
      2,
    ),
  );

  execFileSync(process.execPath, ["--experimental-sea-config", configPath], {
    cwd: root,
    stdio: "inherit",
  });
  log(`blob    ${(statSync(blobPath).size / 1024 / 1024).toFixed(1)} MB`);
  return blobPath;
}

/**
 * Remove the Authenticode signature the Node.js project put on node.exe.
 *
 * Injecting the blob invalidates that signature, and a *broken* signature is
 * worse than none: Windows reports a tampered binary, which is exactly the
 * accusation an unsigned-but-honest build should not be inviting. Stripping it
 * leaves a plainly unsigned executable, which is what this is.
 *
 * The certificate table is the one data directory whose "virtual address" is a
 * file offset, and it lives at the end of the file, so removing it is a
 * truncate plus zeroing the directory entry.
 */
function stripSignature(exePath) {
  const pe = readFileSync(exePath);
  const peHeader = pe.readUInt32LE(0x3c);
  if (pe.readUInt32LE(peHeader) !== 0x00004550) throw new Error("not a PE file");

  const optionalHeader = peHeader + 24;
  const magic = pe.readUInt16LE(optionalHeader);
  // PE32+ puts the data directories 16 bytes further in than PE32 does.
  const directories = optionalHeader + (magic === 0x20b ? 112 : 96);
  const certificateEntry = directories + 4 * 8;

  const offset = pe.readUInt32LE(certificateEntry);
  const size = pe.readUInt32LE(certificateEntry + 4);
  if (offset === 0 || size === 0) return;

  pe.writeUInt32LE(0, certificateEntry);
  pe.writeUInt32LE(0, certificateEntry + 4);
  writeFileSync(exePath, pe.subarray(0, offset));
  log(`strip   removed ${(size / 1024).toFixed(0)} KB signature block`);
}

function inject(blobPath) {
  mkdirSync(artifacts, { recursive: true });
  const exePath = path.join(artifacts, EXE_NAME);
  rmSync(exePath, { force: true });
  copyFileSync(process.execPath, exePath);
  stripSignature(exePath);

  // postject ships as a CLI; calling it through the local install keeps the
  // build honest about its dependencies rather than reaching for npx.
  const postject = path.join(root, "node_modules", "postject", "dist", "cli.js");
  execFileSync(
    process.execPath,
    [
      postject,
      exePath,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { cwd: root, stdio: "inherit" },
  );

  log(`exe     ${(statSync(exePath).size / 1024 / 1024).toFixed(1)} MB`);
  return exePath;
}

function writeManifest(files) {
  const manifest = {
    product: "USAGE Miner",
    version: VERSION,
    channel: "beta",
    platform: "win32-x64",
    builtAt: new Date().toISOString(),
    // Recorded because the artifact literally contains this runtime: a hash
    // only means something next to the Node build it was cut from.
    nodeVersion: process.version,
    signed: false,
    signingNote:
      "Not code-signed. Windows SmartScreen will warn about an unrecognised publisher. Verify the SHA-256 below before running.",
    files: files.map((file) => ({
      name: path.basename(file),
      bytes: statSync(file).size,
      sha256: sha256(file),
      // The miner executable rebuilds byte-for-byte from the same source; the
      // installer wrapper does not, because the in-box C# compiler stamps a
      // fresh module id into every build. Said here rather than implied, so
      // nobody reports a "mismatch" that is the toolchain working as designed.
      reproducible: !path.basename(file).toLowerCase().includes("setup"),
    })),
  };

  writeFileSync(path.join(artifacts, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // The web app must never state a checksum a human typed: a download page that
  // disagrees with the file it links to is worse than one with no checksum at
  // all, because it teaches people that a mismatch is probably a mistake in the
  // page. So the build writes the manifest the site serves, as committed source.
  writeFileSync(
    path.join(root, "..", "src", "lib", "miner", "release.generated.ts"),
    `// Generated by miner/scripts/package.mjs. Do not edit by hand.\n` +
      `import type { MinerReleaseManifest } from "./release";\n\n` +
      `export const GENERATED_MINER_RELEASE: MinerReleaseManifest = ${JSON.stringify(
        manifest,
        null,
        2,
      )};\n`,
  );

  // A plain checksum file, in the format `certutil` and `sha256sum` users
  // already know, so verifying does not require reading our JSON.
  writeFileSync(
    path.join(artifacts, "SHA256SUMS.txt"),
    `${manifest.files.map((file) => `${file.sha256}  ${file.name}`).join("\n")}\n`,
  );

  return manifest;
}

async function main() {
  process.stdout.write(`\nUSAGE Miner ${VERSION} — Windows package\n\n`);
  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const bundlePath = await bundle();
  const blobPath = buildBlob(bundlePath);
  const exePath = inject(blobPath);

  const built = [exePath];
  const installer = process.argv.includes("--with-installer")
    ? (await import("./installer.mjs")).buildInstaller({ artifacts, exePath, version: VERSION })
    : null;
  if (installer) built.push(installer);

  const manifest = writeManifest(built);

  process.stdout.write("\n");
  for (const file of manifest.files) {
    process.stdout.write(`  ${file.name}\n    sha256  ${file.sha256}\n`);
  }
  process.stdout.write(`\n  Artifacts in ${path.relative(root, artifacts)}\n\n`);
}

await main();
