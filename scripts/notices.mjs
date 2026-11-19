// Generates THIRD-PARTY-NOTICES.txt: every crate and npm package that ends up in the shipped
// app, with its license and the license/notice texts it ships (identical texts printed once).
// The installer bundles the file and Settings → About opens it.
//
//   node scripts/notices.mjs            write it
//   node scripts/notices.mjs --check    exit 1 if it is out of date (used by release)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const OUT = "THIRD-PARTY-NOTICES.txt";
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

const licenseTexts = (dir) => {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => { try { return readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim(); } catch { return ""; } })
    .filter(Boolean);
};

// ── Rust: normal (runtime) dependencies reachable from the app, for the Windows target ──
function rustPackages() {
  const meta = JSON.parse(execFileSync("cargo", [
    "metadata", "--format-version", "1", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
    "--filter-platform", "x86_64-pc-windows-msvc",
  ], { encoding: "utf8", maxBuffer: 1 << 28 }));
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const root = meta.resolve.root;
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? []) {
      // Runtime deps only: build-scripts and proc-macros don't ship in the binary.
      if (!d.dep_kinds.some((k) => k.kind === null)) continue;
      const pkg = byId.get(d.pkg);
      if (pkg?.targets.every((t) => t.kind.includes("proc-macro"))) continue;
      stack.push(d.pkg);
    }
  }
  seen.delete(root);
  return [...seen].map((id) => byId.get(id)).map((p) => ({
    name: p.name, version: p.version, license: p.license ?? (p.license_file ? `see ${p.license_file}` : "UNKNOWN"),
    authors: (p.authors ?? []).join(", "), url: p.repository ?? "", texts: licenseTexts(join(p.manifest_path, "..")),
  }));
}

// ── npm: production dependencies (bundled into the UI) ──
function npmPackages() {
  const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { encoding: "utf8", shell: true, maxBuffer: 1 << 26 });
  const groups = JSON.parse(raw);
  const out = [];
  for (const [license, list] of Object.entries(groups)) {
    for (const p of list) {
      for (const [i, version] of (p.versions ?? [p.version]).entries()) {
        const dir = (p.paths ?? [])[i] ?? (p.paths ?? [])[0];
        out.push({ name: p.name, version, license, authors: p.author ?? "", url: p.homepage ?? "", texts: licenseTexts(dir) });
      }
    }
  }
  return out;
}

function render(rust, npm) {
  const all = [...rust.map((p) => ({ ...p, eco: "crate" })), ...npm.map((p) => ({ ...p, eco: "npm" }))]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const textIds = new Map();
  const texts = [];
  for (const p of all) {
    p.refs = p.texts.map((t) => {
      const h = createHash("sha256").update(t).digest("hex");
      if (!textIds.has(h)) { textIds.set(h, texts.length + 1); texts.push(t); }
      return textIds.get(h);
    });
  }
  const counts = {};
  for (const p of all) counts[p.license] = (counts[p.license] ?? 0) + 1;
  const lines = [
    "MyExplorer — third-party notices",
    "",
    "MyExplorer is MIT-licensed (see LICENSE). It includes the open-source components",
    "below; their copyright and license notices are reproduced here as their licenses",
    "require. Where a component offers a choice of licenses (\"A OR B\"), MyExplorer uses",
    "it under the first permissive option listed. MPL-2.0 components are used",
    "unmodified; their source code is available from the repository listed with them",
    "and from crates.io. Components that ship no license file link to the standard",
    "text of their license (spdx.org).",
    "",
    `Components: ${rust.length} Rust crates, ${npm.length} npm packages.`,
    "Licenses: " + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n})`).join("; "),
    "",
    "=".repeat(78),
    "COMPONENTS (name version — license — license texts below)",
    "=".repeat(78),
    "",
  ];
  for (const p of all) {
    lines.push(`${p.name} ${p.version} [${p.eco}] — ${p.license}${p.refs.length ? ` — texts ${p.refs.map((r) => `#${r}`).join(", ")}` : ""}`);
    if (p.authors) lines.push(`    ${p.authors}`);
    if (p.url) lines.push(`    ${p.url}`);
    if (!p.refs.length) lines.push(`    License text: https://spdx.org/licenses/${p.license.split(/[ /()]/).find(Boolean)}.html`);
  }
  lines.push("", "=".repeat(78), "LICENSE TEXTS", "=".repeat(78));
  texts.forEach((t, i) => lines.push("", `----- #${i + 1} ${"-".repeat(66)}`, "", t));
  return lines.join("\n") + "\n";
}

const rust = rustPackages();
const npm = npmPackages();
const missing = [...rust, ...npm].filter((p) => !p.texts.length).map((p) => `${p.name} ${p.version} (${p.license})`);
const text = render(rust, npm);
if (process.argv.includes("--check")) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
  if (cur !== text) { console.error(`✗ ${OUT} is out of date: run node scripts/notices.mjs`); process.exit(1); }
  console.log(`✓ ${OUT} up to date`);
} else {
  writeFileSync(OUT, text);
  console.log(`Wrote ${OUT}: ${rust.length} crates, ${npm.length} npm packages, ${text.length >> 10} KB`);
  if (missing.length) console.log(`Note: no license file shipped by ${missing.length} packages (license id listed instead):\n  ${missing.join("\n  ")}`);
}
