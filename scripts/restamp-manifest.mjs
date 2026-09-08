#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Rewrite release.json over the SIGNED files.
 *
 *   node scripts/restamp-manifest.mjs <directory>
 *
 * `npm run package` produces a manifest describing what it built. Signing then
 * appends a certificate to each PE and changes every hash in it. Publishing the
 * earlier manifest would put checksums on the download page that match nothing
 * anyone can download -- the same class of mistake as computing a checksum
 * before signing, which is the thing this whole pipeline is arranged to avoid.
 *
 * It recomputes hashes and sizes and records that the files are signed. It does
 * not decide whether they are: the workflow has already run Authenticode
 * verification and failed the build if that did not pass. This step only writes
 * down what is by then established.
 */

const dir = process.argv[2] ?? ".";
const manifestPath = path.join(dir, "release.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

manifest.files = manifest.files.map((file) => {
  const target = path.join(dir, file.name);
  const bytes = readFileSync(target);
  return {
    ...file,
    bytes: statSync(target).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    // A signed PE is not byte-reproducible even when its input was: the
    // signature carries a timestamp. Saying so stops a rebuilder reporting a
    // mismatch that is the countersignature working as designed.
    reproducible: false,
  };
});

manifest.signed = true;
manifest.signingNote =
  "Signed via SignPath Foundation and verified with Authenticode before release. A signature proves publisher identity and file integrity; SmartScreen also weighs publisher reputation, which a new certificate builds over time.";
manifest.signedAt = new Date().toISOString();

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`release.json restamped over the signed files in ${dir}\n`);
for (const file of manifest.files) {
  process.stdout.write(`  ${file.sha256}  ${file.name}\n`);
}
