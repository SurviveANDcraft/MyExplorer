// One-command update: `pnpm release`
//   1. builds the release installer (NSIS)
//   2. closes the running installed copy
//   3. installs silently over it (settings, history and index are kept)
//   4. makes sure folders still open in MyExplorer
//   5. relaunches it
// Flags: --no-install (just build), --no-shell (don't touch folder association), --no-launch.
//
// Later, for public releases: add tauri-plugin-updater + signing key + GitHub
// latest.json like TerminalOrganizer's scripts/release.mjs. This script stays the local path.

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { findInstalledExe, installDir, latestInstaller } from "./paths.mjs";
import { register } from "./shell-integration.mjs";

const flags = new Set(process.argv.slice(2));
const step = (s) => console.log(`\n\x1b[1;36m▸ ${s}\x1b[0m`);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) { console.error(`\n✗ ${cmd} ${args.join(" ")} failed (${r.status})`); process.exit(r.status ?? 1); }
};

const t0 = Date.now();
step("Building release installer");
run("pnpm", ["tauri", "build", "--bundles", "nsis"], {
  shell: true,
  env: {
    ...process.env,
    // Keep the build machine's paths out of the binary (matters once this is open source).
    RUSTFLAGS: [process.env.RUSTFLAGS, `--remap-path-prefix=${join(homedir(), ".cargo")}=cargo`, `--remap-path-prefix=${join(process.cwd(), "src-tauri")}=src-tauri`]
      .filter(Boolean).join(" "),
  },
});
const setup = latestInstaller();
if (!setup) { console.error("✗ No installer found after build."); process.exit(1); }
console.log(`  ${setup}`);
if (flags.has("--no-install")) process.exit(0);

step("Closing running MyExplorer");
spawnSync("powershell", ["-NoProfile", "-Command",
  `Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${installDir().replace(/'/g, "''")}\\', 'OrdinalIgnoreCase') } | Stop-Process -Force`], { stdio: "inherit" });

step("Installing");
run(setup, ["/S"]);
const exe = findInstalledExe();
if (!exe) { console.error(`✗ Installed exe not found in ${installDir()}`); process.exit(1); }
console.log(`  ${exe}`);

if (!flags.has("--no-shell")) { step("Folder association"); register(exe); }

if (!flags.has("--no-launch")) {
  step("Launching");
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
}
console.log(`\n\x1b[1;32m✓ MyExplorer updated in ${Math.round((Date.now() - t0) / 1000)}s\x1b[0m`);
