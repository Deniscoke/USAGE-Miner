#!/usr/bin/env node
import { runCli } from "./cli.js";
import { startDesktop } from "./ui.js";

/**
 * The entry point of the packaged Windows executable.
 *
 * Double-clicked, it opens the desktop window: that is the whole point of M11,
 * and the path a beta user takes. Run with a command it behaves as the CLI, so
 * support can still ask someone to run `USAGE-Miner.exe status` and read the
 * answer, and so the two surfaces can never disagree -- they are the same code.
 */

const CLI_COMMANDS = new Set([
  "sign-in",
  "status",
  "enable",
  "disable",
  "run",
  "sign-out",
  "version",
  "help",
  "--help",
  "--version",
]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === undefined || first === "--desktop") {
    await startDesktop();
    return;
  }
  if (CLI_COMMANDS.has(first)) {
    await runCli(argv);
    return;
  }

  process.stdout.write(
    `USAGE Miner: unknown command "${first}".\nRun it with no arguments to open the app, or "help" for commands.\n`,
  );
  process.exit(1);
}

main().catch((error: unknown) => {
  // A crash message is not a place for detail: it is the one output most likely
  // to be pasted into a public bug report.
  process.stdout.write(`USAGE Miner could not start: ${(error as Error).message}\n`);
  process.exit(1);
});
