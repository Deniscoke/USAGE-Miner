import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Choose what a release publishes, and under what names.
 *
 * Built artifacts carry the version in their filename, which is useful while
 * they sit in a directory and unhelpful the moment they are published: a
 * versioned asset name means every release changes every download link, and a
 * link that changes cannot be printed in documentation or typed from memory.
 *
 * So published assets have stable names. The version has not gone anywhere --
 * it is the release tag, the PE version resource stamped during packaging, and
 * release.json. It is simply not in the URL.
 *
 * This also decides what is NOT published. `USAGE Miner.exe` is the GUI
 * launcher, and the installer carries its own copy as an embedded resource;
 * beside a download it is only a 5 KB file nobody should run. The intermediate
 * .cs and .manifest files are build inputs. A release lists what a person
 * should download and nothing else.
 *
 * Checksums and release.json are regenerated here rather than copied, because
 * both must describe the files as published -- these exact bytes, under these
 * exact names. That is the whole reason the website can show a hash beside a
 * download link and mean it.
 */

export const SETUP_ASSET = "USAGE-Miner-Windows-x64-Setup.exe";
export const STANDALONE_ASSET = "USAGE-Miner-Windows-x64.exe";
export const CHECKSUMS_ASSET = "SHA256SUMS.txt";
export const MANIFEST_ASSET = "release.json";

/** The published name for a built artifact, or null if it is not published. */
export function stableNameFor(name) {
  if (name === SETUP_ASSET || name === STANDALONE_ASSET) return name;
  if (/^USAGE-Miner-\d+\.\d+\.\d+(-[\w.]+)?-Setup\.exe$/i.test(name)) return SETUP_ASSET;
  if (/^USAGE-Miner-\d+\.\d+\.\d+(-[\w.]+)?\.exe$/i.test(name)) return STANDALONE_ASSET;
  return null;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Copy the publishable artifacts of `from` into `to` under their stable names,
 * and write the checksum file and manifest that describe them.
 *
 * Fails rather than publishing something incomplete: no installer means no
 * release, because the installer is what the download page offers.
 */
export function stageRelease({ from, to, signed = false }) {
  if (!existsSync(from)) throw new Error(`nothing to stage: ${from} does not exist`);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });

  const source = readdirSync(from);
  const sourceManifest = source.includes(MANIFEST_ASSET)
    ? JSON.parse(readFileSync(path.join(from, MANIFEST_ASSET), "utf8"))
    : {};

  const staged = [];
  for (const name of source) {
    const published = stableNameFor(name);
    if (!published) continue;
    const target = path.join(to, published);
    copyFileSync(path.join(from, name), target);
    const before = (sourceManifest.files ?? []).find((file) => file.name === name);
    staged.push({
      name: published,
      bytes: statSync(target).size,
      // Recomputed over the staged copy. A checksum inherited from a manifest
      // would survive a truncated copy; this does not.
      sha256: sha256(target),
      // The miner executable rebuilds byte-for-byte from the same source; the
      // installer wrapper does not, because the in-box C# compiler stamps a
      // fresh module id into every build. Unknown counts as not reproducible.
      reproducible: before?.reproducible ?? !published.toLowerCase().includes("setup"),
    });
  }

  if (!staged.some((file) => file.name === SETUP_ASSET)) {
    throw new Error("refusing to stage a release with no installer");
  }

  // Installer first: it is what a person should download.
  staged.sort((a, b) => Number(b.name === SETUP_ASSET) - Number(a.name === SETUP_ASSET));

  const manifest = {
    product: sourceManifest.product ?? "USAGE Miner",
    version: sourceManifest.version ?? "unknown",
    channel: sourceManifest.channel ?? "beta",
    platform: sourceManifest.platform ?? "win32-x64",
    builtAt: sourceManifest.builtAt ?? new Date().toISOString(),
    nodeVersion: sourceManifest.nodeVersion ?? process.version,
    // Never a guess and never inherited: the caller states it, and the only
    // caller that states true is the workflow step that has just verified an
    // Authenticode signature against the expected publisher.
    signed: signed === true,
    signingNote: signed
      ? "Code-signed. Verify the publisher in the file properties, or with Get-AuthenticodeSignature."
      : "Not code-signed. Windows SmartScreen will warn about an unrecognised publisher. Verify the SHA-256 before running.",
    files: staged,
  };

  writeFileSync(path.join(to, MANIFEST_ASSET), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    path.join(to, CHECKSUMS_ASSET),
    `${staged.map((file) => `${file.sha256}  ${file.name}`).join("\n")}\n`,
  );

  return manifest;
}

// Run as a script: stage-release.mjs <from> <to> [--signed]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    process.stderr.write("usage: stage-release.mjs <from> <to> [--signed]\n");
    process.exit(2);
  }
  const manifest = stageRelease({ from, to, signed: process.argv.includes("--signed") });
  process.stdout.write(`\n  USAGE Miner ${manifest.version} — ${manifest.signed ? "signed" : "UNSIGNED"}\n\n`);
  for (const file of manifest.files) {
    process.stdout.write(`  ${file.name}\n    sha256  ${file.sha256}\n`);
  }
  process.stdout.write("\n");
}
