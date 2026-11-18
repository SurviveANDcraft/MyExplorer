// Make MyExplorer the app Windows opens folders in (per-user, no admin needed).
//
//   node scripts/shell-integration.mjs register [path\to\MyExplorer.exe]
//   node scripts/shell-integration.mjs unregister      ← restores File Explorer
//
// What it sets (all under HKCU\Software\Classes, so only this user is affected):
//   Directory\shell + Drive\shell  default verb → "MyExplorer"  (double-click a folder/drive)
//   CLSID {52205fd8-…}\shell\opennewwindow     → MyExplorer   (Win+E, "This PC")
// `explorer.exe <path>` still opens the real File Explorer, so there is always a way back.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findInstalledExe } from "./paths.mjs";

const ROOT = "HKCU\\Software\\Classes";
const VERB = "MyExplorer";
const WIN_E = `${ROOT}\\CLSID\\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\\shell\\opennewwindow`;

function reg(...args) {
  const r = spawnSync("reg", args, { encoding: "utf8" });
  return r.status === 0;
}
const set = (key, name, value) => reg("add", key, ...(name === null ? ["/ve"] : ["/v", name]), "/d", value, "/f");

export function register(exe) {
  if (!exe || !existsSync(exe)) throw new Error(`MyExplorer.exe not found${exe ? ` at ${exe}` : ""}. Run \`pnpm release\` first.`);
  const ok = [];
  for (const cls of ["Directory", "Drive"]) {
    const shell = `${ROOT}\\${cls}\\shell`;
    ok.push(
      set(`${shell}\\${VERB}`, null, "Open in MyExplorer"),
      set(`${shell}\\${VERB}`, "Icon", `"${exe}",0`),
      set(`${shell}\\${VERB}\\command`, null, `"${exe}" "%1"`),
      set(shell, null, VERB),
    );
  }
  ok.push(set(`${WIN_E}\\command`, null, `"${exe}"`), set(`${WIN_E}\\command`, "DelegateExecute", ""));
  if (ok.includes(false)) throw new Error("Some registry writes failed.");
  console.log(`Folders, drives and Win+E now open in MyExplorer (${exe}).`);
}

export function unregister() {
  for (const cls of ["Directory", "Drive"]) {
    const shell = `${ROOT}\\${cls}\\shell`;
    reg("delete", shell, "/ve", "/f");
    reg("delete", `${shell}\\${VERB}`, "/f");
  }
  reg("delete", WIN_E, "/f");
  console.log("Restored: folders open in File Explorer again.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, exe] = process.argv.slice(2);
  try {
    if (cmd === "register") register(exe ?? findInstalledExe());
    else if (cmd === "unregister") unregister();
    else { console.error("usage: shell-integration.mjs register [exe] | unregister"); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
