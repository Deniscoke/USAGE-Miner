import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What `npx usage-miner` ships.
 *
 * The npm package exists because the Windows installer is unsigned and will
 * warn until a signing identity has reputation. It only helps if the package
 * stays what it claims to be: compiled JavaScript, run by the user's own Node,
 * with nothing opaque inside.
 *
 * The first pack of this package was 140 MB, because `dist/` is also where the
 * packaging script leaves the installer and the SEA blob. These tests are that
 * mistake, written down.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  private?: boolean;
  bin: Record<string, string>;
  files: string[];
  os: string[];
  dependencies?: Record<string, string>;
  scripts: Record<string, string>;
  publishConfig?: { access?: string };
};

describe("the published npm package", () => {
  it("is publishable at all", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("ships compiled JavaScript and papers, never a binary", () => {
    // `dist` on its own would sweep in USAGE-Miner-Windows-x64-Setup.exe, the
    // SEA blob and the esbuild bundle: a 140 MB registry download, and an
    // opaque payload nobody should accept from npm.
    expect(pkg.files).toContain("dist/**/*.js");
    expect(pkg.files).not.toContain("dist");
    for (const entry of pkg.files) {
      expect(entry.startsWith("dist/") || /^[A-Z]+(\.md)?$/.test(entry.replace(".md", ""))).toBe(true);
    }
  });

  it("runs under the name people type", () => {
    // `npx usage-miner` resolves the bin whose name matches the package.
    expect(pkg.bin["usage-miner"]).toBe("dist/app.js");
    // Every command in the docs and in the app's own help says `usage ...`.
    expect(pkg.bin.usage).toBe("dist/app.js");
  });

  it("declares bin targets the way npm will actually accept", () => {
    // npm 11.8 silently DROPS a bin entry whose value starts with "./" --
    // "script name dist/app.js was invalid and removed", a warning among
    // dozens of lines of publish output. The package still publishes, still
    // installs, and has no command in it, so `npx usage-miner` fails for
    // everyone while the tarball looks perfect.
    //
    // It also drops an entry whose target does not exist on disk yet, which is
    // why the publish workflow builds before it publishes rather than relying
    // on the prepack hook: npm validates package.json before prepack runs.
    for (const [name, target] of Object.entries(pkg.bin)) {
      expect(target.startsWith("./"), name).toBe(false);
      expect(target.startsWith("/"), name).toBe(false);
      expect(target.endsWith(".js"), name).toBe(true);
    }
  });

  it("refuses to install where it cannot work", () => {
    // DPAPI, Windows junctions, Windows tool paths. npm says so at install
    // time instead of letting it fail confusingly at runtime.
    expect(pkg.os).toEqual(["win32"]);
  });

  it("asks the user to trust no third-party code at runtime", () => {
    // Zero runtime dependencies is the strongest thing this package can say
    // about its own supply chain, and it is worth a test to keep it true.
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("always publishes freshly compiled output", () => {
    expect(pkg.scripts.prepack).toBe("npm run build");
  });
});
