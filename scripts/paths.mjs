import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Cargo target dir: $CARGO_TARGET_DIR, else `target-dir` from .cargo/config.toml, else src-tauri/target. */
export function targetDir() {
  if (process.env.CARGO_TARGET_DIR) return process.env.CARGO_TARGET_DIR;
  for (const f of [".cargo/config.toml", "src-tauri/.cargo/config.toml"]) {
    try {
      const m = readFileSync(f, "utf8").match(/^\s*target-dir\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
    } catch {}
  }
  return "src-tauri/target";
}

/** Newest NSIS installer produced by `tauri build`. */
export function latestInstaller() {
  const dir = join(targetDir(), "release", "bundle", "nsis");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith("-setup.exe")).map((f) => join(dir, f));
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

/** Where the per-user NSIS install puts the app: %LOCALAPPDATA%\MyExplorer. */
export const installDir = () => join(process.env.LOCALAPPDATA ?? "", "MyExplorer");

export function findInstalledExe() {
  const dir = installDir();
  if (!existsSync(dir)) return null;
  const exe = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".exe") && !/^uninstall/i.test(f));
  return exe ? join(dir, exe) : null;
}
