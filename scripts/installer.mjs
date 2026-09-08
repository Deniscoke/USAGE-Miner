import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The Windows installer.
 *
 * Built with the C# compiler that ships inside Windows itself, so producing a
 * release needs no Inno Setup, no WiX and no toolchain a contributor has to
 * install. The installer is a single executable with the miner embedded as a
 * resource.
 *
 * Deliberate choices, all of them about not being the kind of software people
 * regret installing:
 *
 *   PER-USER.  Installs to %LOCALAPPDATA%\Programs, writes only HKCU, and never
 *              asks for administrator rights. Nothing it does can damage the
 *              machine or another account.
 *   NO SERVICE, NO AUTOSTART, NO SCHEDULED TASK. It is an app you open, not a
 *              thing that runs behind your back.
 *   CLEAN UNINSTALL. Offers to put every AI tool's configuration back before
 *              removing itself, by calling the miner's own tested `disable`
 *              path rather than a second copy of that logic in C#.
 */

const CSC = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
].find((candidate) => existsSync(candidate));

const PRODUCT = "USAGE Miner";
/** HKCU uninstall key name. Stable across versions so upgrades replace it. */
const APP_KEY = "USAGEMiner";

function source({ version, exeName }) {
  return `
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

static class Setup {
    const string Product   = ${JSON.stringify(PRODUCT)};
    const string Version   = ${JSON.stringify(version)};
    const string ExeName   = ${JSON.stringify(exeName)};
    const string AppKey    = ${JSON.stringify(APP_KEY)};

    static string InstallDir {
        get {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", Product);
        }
    }

    static string StartMenuShortcut {
        get {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                Product + ".lnk");
        }
    }

    static string TargetExe { get { return Path.Combine(InstallDir, ExeName); } }
    static string SetupCopy { get { return Path.Combine(InstallDir, "uninstall.exe"); } }

    [STAThread]
    static int Main(string[] args) {
        bool silent = Array.IndexOf(args, "/S") >= 0;
        bool uninstall = Array.IndexOf(args, "/uninstall") >= 0;
        try {
            if (uninstall) return Uninstall(silent);
            return Install(silent);
        } catch (Exception error) {
            // A silent install has nowhere to show a failure, and "it returned
            // 1" is not something anyone can act on. Leave one line where
            // support can ask for it.
            try {
                File.AppendAllText(
                    Path.Combine(Path.GetTempPath(), "usage-miner-setup.log"),
                    DateTime.UtcNow.ToString("o") + "  " + error.GetType().Name + ": " +
                    error.Message + Environment.NewLine);
            } catch {}
            if (!silent) MessageBox.Show(error.Message, Product,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    // ------------------------------------------------------------- install

    static int Install(bool silent) {
        if (!silent) {
            DialogResult answer = MessageBox.Show(
                Product + " " + Version + " will be installed for your account only.\\n\\n" +
                "It installs to:\\n" + InstallDir + "\\n\\n" +
                "It does not require administrator rights, does not install a service, " +
                "and does not start with Windows.\\n\\nContinue?",
                Product, MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
            if (answer != DialogResult.OK) return 1;
        }

        Directory.CreateDirectory(InstallDir);

        // An upgrade over a running copy: the file is locked, so stop it first.
        // Killing our own product by name is safe; nothing else is touched.
        foreach (Process running in Process.GetProcessesByName(
                     Path.GetFileNameWithoutExtension(ExeName))) {
            try { running.Kill(); running.WaitForExit(5000); } catch {}
        }

        Extract("payload", TargetExe);
        File.Copy(Assembly.GetExecutingAssembly().Location, SetupCopy, true);

        CreateShortcut(StartMenuShortcut, TargetExe, InstallDir,
            "Route your AI tools through USAGE");

        // HKCU only: this is a per-user install, and Add/Remove Programs reads
        // the current user's hive as well as the machine's.
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(
                   @"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + AppKey)) {
            key.SetValue("DisplayName", Product);
            key.SetValue("DisplayVersion", Version);
            key.SetValue("Publisher", "USAGE");
            key.SetValue("InstallLocation", InstallDir);
            key.SetValue("UninstallString", "\\"" + SetupCopy + "\\" /uninstall");
            key.SetValue("QuietUninstallString", "\\"" + SetupCopy + "\\" /uninstall /S");
            key.SetValue("DisplayIcon", TargetExe);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            key.SetValue("EstimatedSize", (int)(new FileInfo(TargetExe).Length / 1024),
                RegistryValueKind.DWord);
        }

        if (!silent) {
            Process.Start(new ProcessStartInfo(TargetExe) { WorkingDirectory = InstallDir });
        }
        return 0;
    }

    // ----------------------------------------------------------- uninstall

    static int Uninstall(bool silent) {
        if (!silent) {
            DialogResult answer = MessageBox.Show(
                "Remove " + Product + "?", Product,
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (answer != DialogResult.OK) return 1;
        }

        // The one thing an uninstaller must never do is leave the machine
        // changed. Mining works by editing each AI tool's own config file, so
        // removing the app without restoring those files would leave tools
        // pointing at an endpoint that is no longer supported by anything.
        bool restore = silent || MessageBox.Show(
            "Restore your AI tools' original settings?\\n\\n" +
            "Recommended. Claude Code and Codex are put back exactly as they were " +
            "before mining was enabled. Choosing No leaves them pointing at USAGE.",
            Product, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;

        if (restore && File.Exists(TargetExe)) {
            RunQuietly(TargetExe, "disable claude-code");
            RunQuietly(TargetExe, "disable codex");
        }

        foreach (Process running in Process.GetProcessesByName(
                     Path.GetFileNameWithoutExtension(ExeName))) {
            try { running.Kill(); running.WaitForExit(5000); } catch {}
        }

        try { File.Delete(StartMenuShortcut); } catch {}
        try { File.Delete(TargetExe); } catch {}
        try {
            Registry.CurrentUser.DeleteSubKeyTree(
                @"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + AppKey, false);
        } catch {}

        // The credential and log live in %APPDATA%\\USAGE and are left alone on
        // purpose: they are the user's data, and a reinstall should not force a
        // fresh sign-in. Removing them is offered, never assumed.
        string dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "USAGE");
        if (!silent && Directory.Exists(dataDir) && MessageBox.Show(
                "Also delete this device's saved sign-in?\\n\\n" + dataDir +
                "\\n\\nThe device stays listed in your USAGE account until you revoke it there.",
                Product, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes) {
            try { Directory.Delete(dataDir, true); } catch {}
        }

        // The uninstaller cannot delete itself while running; schedule it.
        SelfDelete();

        if (!silent) MessageBox.Show(Product + " has been removed.", Product,
            MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }

    // -------------------------------------------------------------- helpers

    static void Extract(string resource, string destination) {
        using (Stream input = Assembly.GetExecutingAssembly()
                   .GetManifestResourceStream(resource)) {
            if (input == null) throw new Exception("This installer is incomplete.");
            using (FileStream output = File.Create(destination)) input.CopyTo(output);
        }
    }

    // Late-bound WScript.Shell: a .lnk with no COM reference and no extra
    // assembly to ship.
    static void CreateShortcut(string linkPath, string target, string workingDir, string comment) {
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) return;
        object shell = Activator.CreateInstance(shellType);
        object link = shellType.InvokeMember("CreateShortcut",
            BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
        Type linkType = link.GetType();
        linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link,
            new object[] { target });
        linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link,
            new object[] { workingDir });
        linkType.InvokeMember("Description", BindingFlags.SetProperty, null, link,
            new object[] { comment });
        linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
    }

    // Run the miner's own restore step, with a bound on how long it may take.
    //
    // Routed through cmd with output sent to nul, because this installer is a
    // /target:winexe and therefore has no console: a child started from it
    // would inherit standard handles that go nowhere, and the miner writes a
    // line on every command. Redirecting through cmd gives the child real
    // handles without opening a pipe -- draining a pipe means an unbounded
    // read, which would sit in front of the timeout below and make it
    // unreachable. An uninstall that never returns is worse than one that
    // gives up: it holds open the files it is trying to delete.
    static void RunQuietly(string exe, string arguments) {
        try {
            ProcessStartInfo info = new ProcessStartInfo("cmd.exe",
                "/c \\"\\"" + exe + "\\" " + arguments + "\\" > nul 2>&1");
            info.CreateNoWindow = true;
            info.UseShellExecute = false;
            Process child = Process.Start(info);
            if (!child.WaitForExit(20000)) { try { child.Kill(); } catch {} }
        } catch {}
    }

    static void SelfDelete() {
        string self = Assembly.GetExecutingAssembly().Location;
        string dir = Path.GetDirectoryName(self);
        // cmd waits, deletes the uninstaller, then removes the (now empty)
        // install directory. No installed helper left behind to do it.
        ProcessStartInfo info = new ProcessStartInfo("cmd.exe",
            "/c ping 127.0.0.1 -n 3 > nul & del /f /q \\"" + self + "\\" & rmdir \\"" + dir + "\\"");
        info.CreateNoWindow = true;
        info.UseShellExecute = false;
        try { Process.Start(info); } catch {}
    }
}
`;
}

export function buildInstaller({ artifacts, exePath, version }) {
  if (!CSC) {
    process.stdout.write("  installer  skipped (no in-box C# compiler found)\n");
    return null;
  }

  // NOT byte-reproducible: the in-box Framework compiler has no /deterministic
  // switch, so it stamps a fresh module id and timestamp into every build. The
  // miner executable it wraps IS reproducible, and that is the artifact whose
  // behaviour matters -- anyone can rebuild it and compare hashes. The
  // installer's own checksum still verifies the exact bytes we published.
  const exeName = path.basename(exePath);
  const csPath = path.join(artifacts, "setup.cs");
  const setupPath = path.join(artifacts, `USAGE-Miner-${version}-Setup.exe`);
  writeFileSync(csPath, source({ version, exeName }));

  // The version resource is set from the command line rather than an
  // AssemblyInfo file, so what Windows shows in file properties always matches
  // package.json.
  execFileSync(
    CSC,
    [
      "/nologo",
      "/target:winexe",
      "/platform:anycpu",
      "/optimize+",
      `/out:${setupPath}`,
      "/reference:System.dll",
      "/reference:System.Windows.Forms.dll",
      `/resource:${exePath},payload`,
      csPath,
    ],
    { stdio: "inherit" },
  );

  rmSync(csPath, { force: true });
  const size = readFileSync(setupPath).length;
  process.stdout.write(`  setup   ${(size / 1024 / 1024).toFixed(1)} MB\n`);
  return setupPath;
}
