#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createRequire } from "node:module";

// rcedit is CommonJS; `createRequire` is the documented way to load one from an
// ES module without a build step.
const { rcedit } = createRequire(import.meta.url)("rcedit");

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
/** Only a deliberate release rewrites the manifest the website serves. */
const publishing = process.argv.includes("--publish");
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

async function inject(blobPath) {
  mkdirSync(artifacts, { recursive: true });
  const exePath = path.join(artifacts, EXE_NAME);
  rmSync(exePath, { force: true });
  copyFileSync(process.execPath, exePath);
  stripSignature(exePath);
  // Before the blob, not after: rewriting resources on a file that already
  // carries the injected SEA resource does not complete.
  await stampIdentity(exePath, "USAGE Miner");

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

/**
 * Say who this program is, in the place Windows looks.
 *
 * The artifact is a copy of node.exe, so without this it reports itself as
 * "Node.js / node.exe" in file properties, in Task Manager and in any
 * SmartScreen or antivirus prompt. Signing such a file would be worse than
 * leaving it unsigned: a binary carrying USAGE's certificate while claiming to
 * be somebody else's product is exactly the confusion a signature exists to
 * prevent.
 *
 * SignPath also enforces product name and version as file restrictions on
 * signed artifacts, so this is a prerequisite for signing rather than polish.
 *
 * Runs BEFORE signing, and nothing touches the PE afterwards -- editing a
 * resource in a signed file invalidates the signature.
 */
async function stampIdentity(exePath, description) {
  await rcedit(exePath, {
    "version-string": {
      ProductName: "USAGE Miner",
      FileDescription: description,
      CompanyName: "USAGE",
      LegalCopyright: "Copyright 2026 USAGE. Apache License 2.0.",
      OriginalFilename: path.basename(exePath),
      InternalName: "USAGE Miner",
    },
    "file-version": `${VERSION}.0`,
    "product-version": `${VERSION}.0`,
  });
  log(`stamp   ${path.basename(exePath)} identifies as USAGE Miner ${VERSION}`);
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

  // `release.json` beside the binaries IS the manifest the USAGE website reads,
  // fetched from the published release asset rather than from this repository.
  // That keeps the direction of dependency right: the site consumes what this
  // build produced, and this build knows nothing about the site.
  //
  // `--publish` no longer rewrites anything outside dist/, but it is kept as an
  // explicit signal that a release is being cut rather than a build checked.
  if (publishing) log("release.json is the manifest to publish alongside the binaries");

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
  const exePath = await inject(blobPath);

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
