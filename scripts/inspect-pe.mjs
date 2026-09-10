// Prints the PE subsystem of each given executable: 2 = GUI (no console),
// 3 = console. Used to check that the installed launcher opens no terminal
// and that the CLI executable still does.
import { readFileSync } from "node:fs";

export function peSubsystem(file) {
  const buf = readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: not a PE file`);
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOffset) !== 0x00004550) throw new Error(`${file}: bad PE signature`);
  // COFF header is 20 bytes; Subsystem sits at optional-header offset 68 (PE32 and PE32+ alike).
  return buf.readUInt16LE(peOffset + 4 + 20 + 68);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  for (const file of process.argv.slice(2)) {
    const subsystem = peSubsystem(file);
    process.stdout.write(`${subsystem === 2 ? "GUI    " : subsystem === 3 ? "CONSOLE" : String(subsystem)}  ${file}\n`);
  }
}
