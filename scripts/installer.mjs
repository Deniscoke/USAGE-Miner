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
/** The GUI entry point installed beside the console executable. */
export const LAUNCHER_NAME = "USAGE Miner.exe";

/**
 * Windows exit codes the installer uses. A cancelled install is not a failed
 * one, and Program Compatibility Assistant treats an unmanifested "setup"
 * that exits oddly as a broken installation; both are avoided by saying
 * exactly what happened.
 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CANCELLED = 1223; // ERROR_CANCELLED

/**
 * The application manifest every executable we compile carries.
 *
 * asInvoker: a per-user install never needs, and never asks for, elevation.
 * supportedOS: only Windows 10 and 11 -- the one family this is tested on
 * (the GUID covers both). Declaring it is what tells Program Compatibility
 * Assistant this is a modern application rather than a legacy installer to
 * be second-guessed. dpiAware keeps the message boxes crisp.
 */
export function applicationManifest({ name, version }) {
  const four = `${version.split(/[-+]/)[0].split(".").concat(["0", "0", "0"]).slice(0, 4).join(".")}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="${name}" version="${four}" processorArchitecture="*"/>
  <description>USAGE Miner</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 10 and Windows 11 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
    </windowsSettings>
  </application>
</assembly>
`;
}

/**
 * The GUI launcher. Double-clicking USAGE Miner must open the app and
 * nothing else -- no console window. The miner itself is a Node SEA, which
 * is a console-subsystem executable and always brings a terminal with it.
 * This tiny /target:winexe program starts it with its console hidden and
 * its output sent nowhere, then exits. The console executable stays exactly
 * as it is for the CLI (`status`, `run claude-code`, ...), which needs a
 * terminal by nature.
 */
export function launcherSource({ exeName }) {
  return `
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

static class Launcher {
    [STAThread]
    static int Main(string[] args) {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string exe = Path.Combine(dir, ${JSON.stringify(exeName)});
        if (!File.Exists(exe)) {
            MessageBox.Show("USAGE Miner is not installed correctly: " + exe + " is missing. Reinstall USAGE Miner.",
                "USAGE Miner", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        try {
            // Through cmd with output to nul, so the child has valid standard
            // handles (a Node process writes a line on startup) and no window.
            ProcessStartInfo info = new ProcessStartInfo("cmd.exe",
                "/c \\"\\"" + exe + "\\" --desktop\\" > nul 2>&1");
            info.CreateNoWindow = true;
            info.UseShellExecute = false;
            info.WorkingDirectory = dir;
            Process.Start(info);
            return 0;
        } catch (Exception error) {
            MessageBox.Show("USAGE Miner could not start: " + error.Message,
                "USAGE Miner", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
`;
}

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
    const string Launcher  = ${JSON.stringify(LAUNCHER_NAME)};
    const string AppKey    = ${JSON.stringify(APP_KEY)};
    const int ExitOk = ${EXIT_OK};
    const int ExitFailed = ${EXIT_FAILED};
    const int ExitCancelled = ${EXIT_CANCELLED};

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

    static string ClaudeShortcut {
        get {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                "Claude Code - USAGE Mining.lnk");
        }
    }

    static string TargetExe { get { return Path.Combine(InstallDir, ExeName); } }
    static string LauncherExe { get { return Path.Combine(InstallDir, Launcher); } }
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
            return ExitFailed;
        }
    }

    static void Log(string line) {
        try {
            File.AppendAllText(
                Path.Combine(Path.GetTempPath(), "usage-miner-setup.log"),
                DateTime.UtcNow.ToString("o") + "  " + line + Environment.NewLine);
        } catch {}
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
            if (answer != DialogResult.OK) return ExitCancelled;
        }

        Directory.CreateDirectory(InstallDir);

        // An upgrade over a running copy: the file is locked, so stop it first.
        // Killing our own product by name is safe; nothing else is touched.
        foreach (Process running in Process.GetProcessesByName(
                     Path.GetFileNameWithoutExtension(ExeName))) {
            try { running.Kill(); running.WaitForExit(5000); } catch {}
        }

        // An upgrade replaces the previous version's executable rather than
        // leaving it beside the new one.
        foreach (string old in Directory.GetFiles(InstallDir, "USAGE-Miner-*.exe")) {
            if (!string.Equals(Path.GetFileName(old), ExeName, StringComparison.OrdinalIgnoreCase)) {
                try { File.Delete(old); } catch {}
            }
        }

        Extract("payload", TargetExe);
        Extract("launcher", LauncherExe);
        File.Copy(Assembly.GetExecutingAssembly().Location, SetupCopy, true);

        // The Start menu opens the GUI launcher: no console window.
        CreateShortcut(StartMenuShortcut, LauncherExe, InstallDir,
            "Meter your AI tools with USAGE", "");

        // A second entry that starts Claude Code through USAGE directly.
        //
        // It holds an argument, not a credential: "run claude-code" tells the
        // miner which tool to launch, and the miner then decrypts its own
        // credential with DPAPI and passes it to the child process. A .lnk is
        // world-readable within the profile and gets copied around, so nothing
        // secret may ever be stored in one.
        CreateShortcut(ClaudeShortcut, TargetExe, InstallDir,
            "Start Claude Code with USAGE mining", "run claude-code");

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
            key.SetValue("DisplayIcon", LauncherExe);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            key.SetValue("EstimatedSize", (int)(new FileInfo(TargetExe).Length / 1024),
                RegistryValueKind.DWord);
        }

        // Success means every artifact exists. Returning 0 with a missing
        // shortcut or registry entry would be the lie that PCA exists to catch.
        string[] required = { TargetExe, LauncherExe, SetupCopy, StartMenuShortcut, ClaudeShortcut };
        foreach (string file in required) {
            if (!File.Exists(file)) throw new Exception("Installation is incomplete: " + file + " was not created.");
        }
        using (RegistryKey check = Registry.CurrentUser.OpenSubKey(
                   @"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + AppKey)) {
            if (check == null) throw new Exception("Installation is incomplete: the uninstall entry was not created.");
        }
        Log("installed " + Version + " to " + InstallDir);

        if (!silent) {
            Process.Start(new ProcessStartInfo(LauncherExe) { WorkingDirectory = InstallDir, UseShellExecute = true });
        }
        return ExitOk;
    }

    // ----------------------------------------------------------- uninstall

    static int Uninstall(bool silent) {
        if (!silent) {
            DialogResult answer = MessageBox.Show(
                "Remove " + Product + "?", Product,
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (answer != DialogResult.OK) return ExitCancelled;
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
        try { File.Delete(ClaudeShortcut); } catch {}
        try { File.Delete(TargetExe); } catch {}
        try { File.Delete(LauncherExe); } catch {}
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
        return ExitOk;
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
    static void CreateShortcut(string linkPath, string target, string workingDir, string comment,
                               string arguments) {
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
        // Arguments only ever select a tool. Never a token, never a URL.
        linkType.InvokeMember("Arguments", BindingFlags.SetProperty, null, link,
            new object[] { arguments });
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
  const manifestPath = path.join(artifacts, "app.manifest");
  writeFileSync(manifestPath, applicationManifest({ name: "USAGE.Miner.Setup", version }));

  // The GUI launcher first: it is embedded in the installer as a resource.
  const launcherCs = path.join(artifacts, "launcher.cs");
  const launcherPath = path.join(artifacts, LAUNCHER_NAME);
  writeFileSync(launcherCs, launcherSource({ exeName }));
  const launcherManifest = path.join(artifacts, "launcher.manifest");
  writeFileSync(launcherManifest, applicationManifest({ name: "USAGE.Miner", version }));
  execFileSync(
    CSC,
    [
      "/nologo",
      "/target:winexe",
      "/platform:anycpu",
      "/optimize+",
      `/out:${launcherPath}`,
      `/win32manifest:${launcherManifest}`,
      "/reference:System.dll",
      "/reference:System.Windows.Forms.dll",
      launcherCs,
    ],
    { stdio: "inherit" },
  );
  rmSync(launcherCs, { force: true });
  rmSync(launcherManifest, { force: true });
  process.stdout.write(`  launcher ${(readFileSync(launcherPath).length / 1024).toFixed(0)} KB (GUI subsystem)\n`);

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
      `/win32manifest:${manifestPath}`,
      "/reference:System.dll",
      "/reference:System.Windows.Forms.dll",
      `/resource:${exePath},payload`,
      `/resource:${launcherPath},launcher`,
      csPath,
    ],
    { stdio: "inherit" },
  );

  rmSync(csPath, { force: true });
  rmSync(manifestPath, { force: true });
  const size = readFileSync(setupPath).length;
  process.stdout.write(`  setup   ${(size / 1024 / 1024).toFixed(1)} MB\n`);
  return setupPath;
}
