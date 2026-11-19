// Version helpers shared by release.mjs, plus `pnpm bump <x.y.z>`, which sets the version
// in all three places that must agree: package.json, tauri.conf.json, Cargo.toml (+ lock).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILES = { pkg: "package.json", conf: "src-tauri/tauri.conf.json", cargo: "src-tauri/Cargo.toml" };
const CARGO_RE = /^(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/m;

export function readVersions() {
  const all = {
    [FILES.pkg]: JSON.parse(readFileSync(FILES.pkg, "utf8")).version,
    [FILES.conf]: JSON.parse(readFileSync(FILES.conf, "utf8")).version,
    [FILES.cargo]: readFileSync(FILES.cargo, "utf8").match(CARGO_RE)?.[2],
  };
  const vs = Object.values(all);
  return { all, version: vs[0], same: vs.every((x) => x && x === vs[0]) };
}

/** Semver compare (pre-release sorts below its release: 1.0.0-beta.1 < 1.0.0). */
export function cmpSemver(a, b) {
  const parse = (s) => { const [core, pre] = s.split("-", 2); return { n: core.split(".").map(Number), pre: pre ?? null }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) - (y.n[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const pa = x.pre.split("."), pb = y.pre.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb && +pa[i] !== +pb[i]) return +pa[i] - +pb[i];
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function bump(next) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next ?? "")) { console.error("usage: pnpm bump <major.minor.patch[-pre]>"); process.exit(1); }
  const cur = readVersions().version;
  if (cmpSemver(next, cur) <= 0) { console.error(`✗ ${next} is not newer than ${cur}`); process.exit(1); }
  for (const f of [FILES.pkg, FILES.conf]) {
    const s = readFileSync(f, "utf8");
    writeFileSync(f, s.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`));
  }
  const c = readFileSync(FILES.cargo, "utf8");
  writeFileSync(FILES.cargo, c.replace(CARGO_RE, `$1${next}$3`));
  spawnSync("cargo", ["update", "-p", "myexplorer", "--offline", "--manifest-path", FILES.cargo], { stdio: "inherit" });
  const v = readVersions();
  if (!v.same || v.version !== next) { console.error("✗ bump failed:", v.all); process.exit(1); }
  console.log(`✓ ${cur} → ${next} (package.json, tauri.conf.json, Cargo.toml, Cargo.lock)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) bump(process.argv[2]);
