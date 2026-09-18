/**
 * Kept in step with miner/package.json and src/lib/miner/release.ts; a test
 * (version.test.ts) fails if this and package.json -- or the compiled dist --
 * disagree. Compiled into every build, including the single-file exe, which
 * has no package.json beside it to read.
 */
export const VERSION = "0.4.9";
/** What this miner's heartbeat says it speaks. Not the app version. */
export const PROTOCOL_VERSION = "miner-protocol-v2";
