// Release builds: `pnpm release [flags]`
//
// Local (default): signed build → install silently over the running copy → relaunch.
// Public:  `pnpm release --publish "One-line notes"` (or --notes-file notes.md)
//          also publishes GitHub release v<version> with the installer + latest.json,
//          which is what every installed copy's updater reads.
//
// Flags: --publish, --notes-file <f>, --no-install, --no-shell (keep folder association
// untouched), --no-launch. Version bumps: `pnpm bump <x.y.z>`.
// Full procedure and pitfalls: .claude/skills/release-myexplorer/SKILL.md

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findInstalledExe, installDir, targetDir } from "./paths.mjs";
import { current, register } from "./shell-integration.mjs";
import { cmpSemver, readVersions } from "./versions.mjs";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const publish = flags.has("--publish");
const notesFileArg = argv[argv.indexOf("--notes-file") + 1];
const notesLine = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--notes-file");

const step = (s) => console.log(`\n\x1b[1;36m▸ ${s}\x1b[0m`);
const fail = (s) => { console.error(`\n\x1b[1;31m✗ ${s}\x1b[0m`); process.exit(1); };
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed (${r.status})`);
};
const out = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const endpoint = conf.plugins.updater.endpoints[0];
const repo = endpoint.match(/github\.com\/([^/]+\/[^/]+)\/releases/)?.[1] ?? fail(`Can't read the GitHub repo from ${endpoint}`);
const v = readVersions();
if (!v.same) fail(`Versions differ: ${JSON.stringify(v.all)}. Run: pnpm bump <version>`);
const version = v.version;
const tag = `v${version}`;

// ── preflight for publishing (fail before a 4-minute build, not after) ──────────
let notes = "";
if (publish) {
  step(`Preflight for ${tag} → ${repo}`);
  if (out("gh", ["--version"]) === null) fail("GitHub CLI (gh) not found");
  if (out("gh", ["auth", "status"]) === null) fail("gh is not logged in: run `gh auth login`");
  if (out("git", ["status", "--porcelain"])) fail("Working tree has uncommitted changes. Commit first: a release must match pushed source.");
  spawnSync("git", ["fetch", "--quiet", "origin"]);
  if (!out("git", ["branch", "-r", "--contains", "HEAD"])) fail("HEAD is not pushed. Run `git push` first.");
  if (out("gh", ["release", "view", tag, "--repo", repo]) !== null) fail(`Release ${tag} already exists. Bump the version: pnpm bump <next>`);
  const latest = out("gh", ["release", "view", "--repo", repo, "--json", "tagName", "-q", ".tagName"]);
  if (latest && cmpSemver(version, latest.replace(/^v/, "")) <= 0)
    fail(`${version} is not newer than the published ${latest}: the updater would ignore it. Bump first.`);
  notes = notesFileArg ? readFileSync(notesFileArg, "utf8").trim() : (notesLine ?? "").trim();
  if (!notes) fail('Release notes required: --publish "What changed" or --notes-file notes.md');
  console.log(`  ok: clean tree, pushed, ${latest ?? "no previous release"} → ${tag}`);
}

// ── signing key ─────────────────────────────────────────────────────────────
const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), ".tauri", "myexplorer.key");
if (!existsSync(keyPath))
  fail(`No updater signing key at ${keyPath}.\nRestore it from your backup. Generating a NEW key means no installed copy can ever update again.`);

const t0 = Date.now();
step("Third-party notices");
run("node", ["scripts/notices.mjs"]);
if (publish && out("git", ["status", "--porcelain", "THIRD-PARTY-NOTICES.txt"]))
  fail("THIRD-PARTY-NOTICES.txt changed. Commit and push it, then publish again.");

step(`Building signed installer ${version}`);
const cwd = process.cwd();
run("pnpm", ["tauri", "build", "--bundles", "nsis"], {
  shell: true,
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8").trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    // Keep the build machine's paths out of the binaries (last matching remap wins).
    RUSTFLAGS: [process.env.RUSTFLAGS, `--remap-path-prefix=${join(homedir(), ".cargo")}=cargo`, `--remap-path-prefix=${cwd}=.`,
      `--remap-path-prefix=${join(cwd, "src-tauri")}=src-tauri`].filter(Boolean).join(" "),
  },
});

const bundleDir = join(targetDir(), "release", "bundle", "nsis");
const files = readdirSync(bundleDir);
// Old builds stay in the bundle dir: match this version exactly.
const setupName = files.find((f) => f.includes(`_${version}_`) && f.endsWith("-setup.exe"));
const sigName = setupName && files.find((f) => f === `${setupName}.sig`);
if (!setupName || !sigName) fail(`No signed installer for ${version} in ${bundleDir}`);
const setup = join(bundleDir, setupName);
const manifestPath = join(bundleDir, "latest.json");
writeFileSync(manifestPath, JSON.stringify({
  version,
  notes: notes || `MyExplorer ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(bundleDir, sigName), "utf8").trim(),
      // The updater downloads this exact URL: the asset name must match the file name.
      url: `https://github.com/${repo}/releases/download/${tag}/${setupName}`,
    },
  },
}, null, 2));
console.log(`  ${setup}\n  ${manifestPath}`);

if (publish) {
  step(`Publishing ${tag} to github.com/${repo}`);
  const notesFile = join(bundleDir, `notes-${version}.md`);
  writeFileSync(notesFile, notes + "\n");
  // Never --prerelease: /releases/latest skips pre-releases and every updater would 404.
  run("gh", ["release", "create", tag, "--repo", repo, "--target", out("git", ["rev-parse", "HEAD"]), "--latest",
    "--title", `MyExplorer ${version}`, "--notes-file", notesFile, setup, manifestPath]);
  step("Verifying the updater endpoint");
  let ok = false;
  for (let i = 0; i < 12 && !ok; i++) {
    const r = spawnSync("curl", ["-sfL", endpoint], { encoding: "utf8" });
    try { ok = JSON.parse(r.stdout).version === version; } catch { ok = false; }
    if (!ok) spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep 5"]);
  }
  console.log(ok ? `  ✓ ${endpoint} serves ${version}`
    : `  ! The endpoint doesn't serve ${version} yet (expected while the repo is private; GitHub can also lag a minute).`);
}

if (!flags.has("--no-install")) {
  step("Closing running MyExplorer");
  spawnSync("powershell", ["-NoProfile", "-Command",
    `Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${installDir().replace(/'/g, "''")}\\', 'OrdinalIgnoreCase') } | Stop-Process -Force`], { stdio: "inherit" });

  step("Installing");
  run(setup, ["/S"]);
  const exe = findInstalledExe();
  if (!exe) fail(`Installed exe not found in ${installDir()}`);
  console.log(`  ${exe}`);

  if (!flags.has("--no-shell")) {
    // Respect the user's choices from Settings → Windows; first install turns everything on.
    step("Folder association");
    const now = current();
    register(exe, now.folders || now.winE || now.contextEntry ? now : undefined);
  }
  if (!flags.has("--no-launch")) {
    step("Launching");
    spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  }
}
console.log(`\n\x1b[1;32m✓ MyExplorer ${version} done in ${Math.round((Date.now() - t0) / 1000)}s\x1b[0m`);
