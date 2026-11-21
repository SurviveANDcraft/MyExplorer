//! Storage page: what fills a drive (treemap + category breakdown) and what could go
//! (ranked cleanup suggestions).
//!
//! Everything is computed from the in-memory file index — no disk walk — so a whole drive
//! is summarised in tens of milliseconds and stays live as the index watcher applies
//! changes (`disk:changed`). Folders the index lists but never descends into (node_modules,
//! .git, $Recycle.Bin, WinSxS, …) are sized on disk in the background, remembered across
//! sessions, and folded in as they finish.

use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use parking_lot::Mutex;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::index::store::{Index, EXCLUDED_NAMES, EXCLUDED_WINDOWS, F_DELETED, NONE};
use crate::util::*;

const DAY: i64 = 86_400_000;
const MB: u64 = 1 << 20;

// ── categories ──────────────────────────────────────────────────────────────

/// 0 other · 1 video · 2 images · 3 audio · 4 archives · 5 documents · 6 code & dev ·
/// 7 apps · 8 disk images · 9 system & temp. Mirrored in `src/state/storage.ts`.
pub const NCAT: usize = 10;
const C_OTHER: u8 = 0;
const C_IMAGE: u8 = 2;
const C_ARCHIVE: u8 = 4;
const C_DOC: u8 = 5;
const C_CODE: u8 = 6;
const C_APP: u8 = 7;
const C_DISK: u8 = 8;
const C_SYS: u8 = 9;

fn ext_of(lower: &[u8]) -> &[u8] {
    match memchr::memrchr(b'.', lower) {
        Some(i) if i > 0 => &lower[i + 1..],
        _ => b"",
    }
}

fn category(ext: &[u8]) -> u8 {
    match ext {
        b"mp4" | b"mkv" | b"mov" | b"avi" | b"wmv" | b"webm" | b"m4v" | b"flv" | b"mpg" | b"mpeg" | b"mts" | b"m2ts"
        | b"3gp" | b"vob" => 1,
        b"jpg" | b"jpeg" | b"png" | b"gif" | b"bmp" | b"webp" | b"heic" | b"heif" | b"tif" | b"tiff" | b"raw" | b"cr2"
        | b"cr3" | b"nef" | b"arw" | b"dng" | b"psd" | b"svg" | b"ico" | b"avif" | b"exr" | b"hdr" => 2,
        b"mp3" | b"wav" | b"flac" | b"aac" | b"ogg" | b"m4a" | b"wma" | b"opus" | b"aiff" | b"mid" => 3,
        b"zip" | b"rar" | b"7z" | b"tar" | b"gz" | b"tgz" | b"bz2" | b"xz" | b"zst" | b"lz4" | b"lzma" => 4,
        b"pdf" | b"doc" | b"docx" | b"xls" | b"xlsx" | b"ppt" | b"pptx" | b"odt" | b"ods" | b"odp" | b"txt" | b"rtf"
        | b"md" | b"epub" | b"csv" | b"one" | b"pst" | b"ost" => 5,
        b"js" | b"mjs" | b"cjs" | b"jsx" | b"ts" | b"tsx" | b"py" | b"rs" | b"go" | b"java" | b"kt" | b"c" | b"cc"
        | b"cpp" | b"h" | b"hpp" | b"cs" | b"rb" | b"php" | b"swift" | b"json" | b"xml" | b"yaml" | b"yml" | b"toml"
        | b"lock" | b"html" | b"css" | b"scss" | b"map" | b"wasm" | b"pdb" | b"obj" | b"o" | b"lib" | b"a" | b"rlib"
        | b"rmeta" | b"class" | b"jar" | b"pyc" | b"node" | b"sql" | b"db" | b"sqlite" | b"ipynb" | b"pack" | b"idx"
        | b"pch" | b"ipch" | b"ilk" | b"gguf" | b"safetensors" | b"onnx" | b"pt" | b"ckpt" | b"bin" => 6,
        b"exe" | b"dll" | b"msi" | b"msix" | b"msixbundle" | b"appx" | b"appxbundle" | b"sys" | b"drv" | b"ocx"
        | b"cpl" | b"mui" | b"so" | b"dylib" | b"apk" | b"pak" | b"asar" => 7,
        b"iso" | b"img" | b"vhd" | b"vhdx" | b"vmdk" | b"vdi" | b"qcow2" | b"wim" | b"esd" | b"ova" | b"dmg" | b"avhdx" => 8,
        b"log" | b"tmp" | b"temp" | b"dmp" | b"mdmp" | b"hdmp" | b"etl" | b"evtx" | b"bak" | b"old" | b"cab" | b"chk"
        | b"blf" | b"cache" | b"crdownload" | b"part" | b"partial" => 9,
        _ => C_OTHER,
    }
}

/// Category for a folder the index doesn't descend into.
fn excluded_category(lower_name: &[u8]) -> u8 {
    match lower_name {
        b"node_modules" | b".git" | b"__pycache__" | b".pnpm-store" => C_CODE,
        _ => C_SYS,
    }
}

fn is_excluded(ix: &Index, id: u32) -> bool {
    let name = ix.lower(id);
    if EXCLUDED_NAMES.iter().any(|n| n.as_bytes() == name) {
        return true;
    }
    let p = ix.parent[id as usize];
    p != NONE
        && ix.lower(p) == b"windows"
        && ix.parent[p as usize] != NONE
        && ix.is_root(ix.parent[p as usize])
        && EXCLUDED_WINDOWS.iter().any(|n| n.as_bytes() == name)
}

// ── on-disk sizes for excluded folders ──────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Default)]
struct Extra {
    size: u64,
    files: u64,
    at: i64,
}

#[derive(Default)]
struct Extras {
    map: HashMap<String, Extra>,
    pending: Vec<String>,
    queued: HashSet<String>,
}

/// Re-measure remembered totals older than this (the old value is used meanwhile).
const EXTRA_STALE_MS: i64 = 12 * 3_600_000;

static EXTRAS: LazyLock<Mutex<Extras>> = LazyLock::new(|| {
    let map = std::fs::read(extras_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<HashMap<String, Extra>>(&b).ok())
        .unwrap_or_default();
    Mutex::new(Extras { map, ..Default::default() })
});
static EXTRA_VER: AtomicU64 = AtomicU64::new(1);
static MEASURING: AtomicBool = AtomicBool::new(false);

fn extras_path() -> std::path::PathBuf {
    data_dir().join("storage-sizes.json")
}

fn queue_measure(e: &mut Extras, key: String) {
    if e.queued.insert(key.clone()) {
        e.pending.push(key);
    }
}

fn kick_measurer() {
    if MEASURING.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = std::thread::Builder::new().name("storage-measure".into()).spawn(|| {
        let mut last_emit = Instant::now();
        loop {
            let next = EXTRAS.lock().pending.pop();
            let Some(p) = next else {
                MEASURING.store(false, Ordering::Release);
                // A request may have slipped in between the pop and the store.
                if !EXTRAS.lock().pending.is_empty() && !MEASURING.swap(true, Ordering::AcqRel) {
                    continue;
                }
                break;
            };
            let d = crate::dirsize::measure(&p).unwrap_or_default();
            {
                let mut e = EXTRAS.lock();
                e.queued.remove(&p);
                e.map.insert(p, Extra { size: d.size, files: d.files, at: now_ms() });
            }
            EXTRA_VER.fetch_add(1, Ordering::AcqRel);
            if last_emit.elapsed().as_millis() > 600 {
                last_emit = Instant::now();
                emit("disk:changed", 0u64);
            }
        }
        emit("disk:changed", 0u64);
        let snapshot = EXTRAS.lock().map.clone();
        if let Ok(b) = serde_json::to_vec(&snapshot) {
            let _ = std::fs::write(extras_path(), b);
        }
    });
}

/// Something under these folders changed outside the index's view (Recycle Bin emptied,
/// items recycled): re-measure the excluded folders involved.
fn remeasure_where(pred: impl Fn(&str) -> bool) {
    let keys: Vec<String> = {
        let mut e = EXTRAS.lock();
        let keys: Vec<String> = e.map.keys().filter(|k| pred(k)).cloned().collect();
        for k in &keys {
            queue_measure(&mut e, k.clone());
        }
        keys
    };
    if !keys.is_empty() {
        crate::dirsize::invalidate_many(&keys);
        kick_measurer();
    }
}

// ── subtree totals ──────────────────────────────────────────────────────────

struct Agg {
    ver: u64,
    ever: u64,
    epoch: u64,
    at: Instant,
    /// Bytes per category for each index root (drive).
    cats: HashMap<u32, [u64; NCAT]>,
    size: Vec<u64>,
    files: Vec<u32>,
    /// Latest modification anywhere in the subtree (files and folders themselves).
    newest: Vec<i64>,
    /// Excluded folders whose on-disk size isn't known yet.
    pending: usize,
}

impl Agg {
    // Entries added since this was computed read as empty.
    #[inline]
    fn s(&self, i: usize) -> u64 {
        self.size.get(i).copied().unwrap_or(0)
    }
    #[inline]
    fn f(&self, i: usize) -> u32 {
        self.files.get(i).copied().unwrap_or(0)
    }
    #[inline]
    fn m(&self, i: usize) -> i64 {
        self.newest.get(i).copied().unwrap_or(0)
    }
}

static AGG: Mutex<Option<Arc<Agg>>> = Mutex::new(None);
static AGG_BUILD: Mutex<()> = Mutex::new(());
/// Set after the user deletes something: the next request recomputes, whatever its age.
static FORCE: AtomicBool = AtomicBool::new(false);
/// While the disk churns (it always does), totals are reused for this long.
const AGG_MAX_AGE_MS: u128 = 2_500;

fn agg(ix: &Index, ver: u64) -> Arc<Agg> {
    let epoch = crate::index::epoch();
    let ok = |a: &Agg| {
        a.epoch == epoch
            && a.size.len() <= ix.len()
            && ((a.ver == ver && a.ever == EXTRA_VER.load(Ordering::Acquire))
                || (a.at.elapsed().as_millis() < AGG_MAX_AGE_MS && !FORCE.load(Ordering::Acquire)))
    };
    if let Some(a) = AGG.lock().as_ref().filter(|a| ok(a)) {
        return a.clone();
    }
    let _g = AGG_BUILD.lock();
    if let Some(a) = AGG.lock().as_ref().filter(|a| ok(a)) {
        return a.clone();
    }
    FORCE.store(false, Ordering::Release);
    let a = Arc::new(compute(ix, ver, epoch));
    *AGG.lock() = Some(a.clone());
    a
}

fn compute(ix: &Index, ver: u64, epoch: u64) -> Agg {
    let ever = EXTRA_VER.load(Ordering::Acquire);
    let n = ix.len();
    const UNK: u16 = u16::MAX - 1;
    const DEAD: u16 = u16::MAX;
    // Depth of every live entry; DEAD if it or any ancestor is deleted.
    let mut depth = vec![UNK; n];
    // Which root (position in ix.roots) each entry is under.
    let mut root_of = vec![u8::MAX; n];
    let mut chain: Vec<u32> = Vec::with_capacity(64);
    for i in 0..n {
        if depth[i] != UNK {
            continue;
        }
        chain.clear();
        let mut c = i as u32;
        let mut base: i32 = -1;
        let mut dead = false;
        let mut root = u8::MAX;
        while c != NONE {
            let d = depth[c as usize];
            if d == DEAD {
                dead = true;
                break;
            }
            if d != UNK {
                base = d as i32;
                root = root_of[c as usize];
                break;
            }
            chain.push(c);
            if chain.len() > 4_000 {
                dead = true;
                break;
            }
            c = ix.parent[c as usize];
        }
        if c == NONE {
            if let Some(&top) = chain.last() {
                root = ix.roots.iter().position(|&r| r == top).map_or(u8::MAX, |p| p.min(254) as u8);
            }
        }
        for &e in chain.iter().rev() {
            root_of[e as usize] = root;
            if dead || ix.flags[e as usize] & F_DELETED != 0 {
                dead = true;
                depth[e as usize] = DEAD;
            } else {
                base += 1;
                depth[e as usize] = base.min(UNK as i32 - 1) as u16;
            }
        }
    }

    let mut size = vec![0u64; n];
    let mut files = vec![0u32; n];
    let mut newest = vec![0i64; n];
    let mut pending = 0usize;
    let mut cats = vec![[0u64; NCAT]; ix.roots.len().min(255)];
    let now = now_ms();
    let mut buckets: Vec<u32> = Vec::new();
    {
        let mut ex = EXTRAS.lock();
        let mut queued = false;
        for i in 0..n {
            let d = depth[i];
            if d == DEAD {
                continue;
            }
            let f = ix.flags[i];
            if f & F_DIR == 0 {
                size[i] = ix.size[i];
                files[i] = 1;
                newest[i] = ix.modified[i];
                if let Some(c) = cats.get_mut(root_of[i] as usize) {
                    c[category(ext_of(ix.lower(i as u32))) as usize] += ix.size[i];
                }
            } else {
                newest[i] = ix.modified[i];
                if f & F_LINK == 0 && !ix.is_root(i as u32) && is_excluded(ix, i as u32) {
                    let key = ix.path(i as u32).to_lowercase();
                    match ex.map.get(&key).copied() {
                        Some(x) => {
                            if let Some(c) = cats.get_mut(root_of[i] as usize) {
                                c[excluded_category(ix.lower(i as u32)) as usize] += x.size;
                            }
                            size[i] = x.size;
                            files[i] = x.files.min(u32::MAX as u64) as u32;
                            if now - x.at > EXTRA_STALE_MS && !ex.queued.contains(&key) {
                                queue_measure(&mut ex, key);
                                queued = true;
                            }
                        }
                        None => {
                            pending += 1;
                            queue_measure(&mut ex, key);
                            queued = true;
                        }
                    }
                }
            }
            if d as usize >= buckets.len() {
                buckets.resize(d as usize + 1, 0);
            }
            buckets[d as usize] += 1;
        }
        drop(ex);
        if queued {
            kick_measurer();
        }
    }
    // Order ids deepest-first (counting sort), then fold each into its parent: O(n).
    let mut start = vec![0u32; buckets.len() + 1];
    for d in 0..buckets.len() {
        start[d + 1] = start[d] + buckets[d];
    }
    let mut order = vec![0u32; start[buckets.len()] as usize];
    let mut fill = start.clone();
    for i in 0..n {
        let d = depth[i];
        if d != DEAD {
            order[fill[d as usize] as usize] = i as u32;
            fill[d as usize] += 1;
        }
    }
    drop(depth);
    for &i in order.iter().rev() {
        let p = ix.parent[i as usize];
        if p == NONE {
            continue;
        }
        let (i, p) = (i as usize, p as usize);
        size[p] += size[i];
        files[p] = files[p].saturating_add(files[i]);
        if newest[i] > newest[p] {
            newest[p] = newest[i];
        }
    }
    let cats = ix.roots.iter().zip(cats).map(|(&r, c)| (r, c)).collect();
    Agg { ver, ever, epoch, at: Instant::now(), cats, size, files, newest, pending }
}

// ── treemap ─────────────────────────────────────────────────────────────────

/// One treemap block. Short keys: this is sent thousands at a time.
#[derive(Serialize)]
pub struct Node {
    /// name ("" for the "smaller items" group)
    n: String,
    /// bytes
    s: u64,
    /// files inside
    f: u32,
    /// 0 file · 1 folder · 2 smaller items grouped
    t: u8,
    /// category (files and excluded folders)
    c: u8,
    /// newest modification inside (ms)
    m: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    k: Vec<Node>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskTree {
    pub path: String,
    pub size: u64,
    pub files: u64,
    /// Bytes per category (see NCAT) when `path` is a drive; empty otherwise.
    pub cats: Vec<u64>,
    /// Folders still being sized on disk (numbers will grow).
    pub pending: usize,
    pub root: Node,
    pub took_ms: f64,
}

/// Blocks in one response: plenty for a full-window treemap, still a small payload.
const BUDGET: usize = 3_500;
const MAX_KIDS: usize = 150;

pub fn tree(path: &str) -> Option<DiskTree> {
    let t0 = Instant::now();
    crate::index::read(|ix, ver| {
        let id = ix.resolve(path)?;
        if ix.flags[id as usize] & F_DIR == 0 {
            return None;
        }
        let a = agg(ix, ver);
        let total = a.s(id as usize).max(1);
        let min_block = total / 40_000;

        struct ANode {
            id: u32,
            size: u64,
            files: u32,
            newest: i64,
            t: u8,
            c: u8,
            kids: Vec<usize>,
        }
        let mut nodes = vec![ANode {
            id,
            size: a.s(id as usize),
            files: a.f(id as usize),
            newest: a.m(id as usize),
            t: 1,
            c: C_OTHER,
            kids: Vec::new(),
        }];
        let mut heap: BinaryHeap<(u64, usize)> = BinaryHeap::new();
        heap.push((nodes[0].size, 0));
        while let Some((_, ni)) = heap.pop() {
            if nodes.len() >= BUDGET {
                break;
            }
            let did = nodes[ni].id;
            let mut kids: Vec<u32> = ix.children(did).filter(|&c| a.s(c as usize) > 0).collect();
            kids.sort_unstable_by(|x, y| a.s(*y as usize).cmp(&a.s(*x as usize)));
            let mut out = Vec::with_capacity(kids.len().min(MAX_KIDS + 1));
            let (mut rest_s, mut rest_f, mut rest_m, mut rest_n) = (0u64, 0u32, 0i64, 0usize);
            for (k, &c) in kids.iter().enumerate() {
                let cu = c as usize;
                let s = a.s(cu);
                if k >= MAX_KIDS || (s < min_block && k > 0) || nodes.len() >= BUDGET {
                    rest_s += s;
                    rest_f = rest_f.saturating_add(a.f(cu));
                    rest_m = rest_m.max(a.m(cu));
                    rest_n += 1;
                    continue;
                }
                let dir = ix.flags[cu] & F_DIR != 0;
                let cat = if dir {
                    if is_excluded(ix, c) { excluded_category(ix.lower(c)) } else { C_OTHER }
                } else {
                    category(ext_of(ix.lower(c)))
                };
                let idx = nodes.len();
                nodes.push(ANode { id: c, size: s, files: a.f(cu), newest: a.m(cu), t: dir as u8, c: cat, kids: Vec::new() });
                out.push(idx);
                if dir && s >= min_block.max(1) * 4 && ix.children(c).next().is_some() {
                    heap.push((s, idx));
                }
            }
            if rest_n > 0 {
                let idx = nodes.len();
                nodes.push(ANode { id: rest_n as u32, size: rest_s, files: rest_f, newest: rest_m, t: 2, c: C_OTHER, kids: Vec::new() });
                out.push(idx);
            }
            nodes[ni].kids = out;
        }

        fn build(ix: &Index, nodes: &mut Vec<ANode>, i: usize, root: bool) -> Node {
            let kids = std::mem::take(&mut nodes[i].kids);
            let k: Vec<Node> = kids.into_iter().map(|c| build(ix, nodes, c, false)).collect();
            let a = &nodes[i];
            let n = match a.t {
                2 => a.id.to_string(), // grouped: number of items
                _ if root => ix.path(a.id),
                _ => ix.name(a.id).to_string(),
            };
            Node { n, s: a.size, f: a.files, t: a.t, c: a.c, m: a.newest, k }
        }
        let root = build(ix, &mut nodes, 0, true);

        // Category totals are kept per drive (what the usage bar shows).
        let cats = a.cats.get(&id).map(|c| c.to_vec()).unwrap_or_default();
        Some(DiskTree {
            path: ix.path(id),
            size: a.s(id as usize),
            files: a.f(id as usize) as u64,
            cats,
            pending: a.pending,
            root,
            took_ms: t0.elapsed().as_secs_f64() * 1000.0,
        })
    })
    .flatten()
}

// ── cleanup suggestions ─────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub path: String,
    pub name: String,
    pub dir: bool,
    pub size: u64,
    pub files: u64,
    pub modified: i64,
    /// Latest of modified / created / last opened (ms).
    pub last_used: i64,
    /// rebuildable · cache · temp · installer · archive · duplicate · diskimage · media · stale · download · large
    pub kind: &'static str,
    pub cat: u8,
    pub reasons: Vec<String>,
    pub score: f64,
    /// Inside another suggested folder (don't count its size twice).
    pub nested: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestions {
    pub items: Vec<Suggestion>,
    pub total: usize,
    pub pending: usize,
    pub took_ms: f64,
}

struct Cand {
    id: u32,
    dir: bool,
    kind: &'static str,
    mult: f64,
    reasons: Vec<String>,
    size: u64,
    files: u64,
    modified: i64,
    cat: u8,
    dup_of: Option<usize>,
}

/// Top-level system folders on any drive: never suggested, never descended.
const PROTECTED_TOP: &[&str] = &[
    "windows", "program files", "program files (x86)", "programdata", "system volume information", "$recycle.bin",
    "recovery", "$windows.~bt", "$windows.~ws", "$winreagent", "$sysreset", "msocache", "boot", "efi", "perflogs",
    "config.msi", "onedrivetemp", "$getcurrent",
];

/// Under the profile: rebuildable package/download caches (relative, lowercase).
const HOME_CACHES: &[&str] = &[
    ".cache", ".gradle\\caches", ".nuget\\packages", ".cargo\\registry", ".npm\\_cacache", ".m2\\repository",
    ".pnpm-store", ".bun\\install\\cache", ".android\\avd", "appdata\\local\\npm-cache", "appdata\\local\\pip\\cache",
    "appdata\\local\\yarn\\cache", "appdata\\local\\nuget\\v3-cache", "appdata\\local\\go-build", "appdata\\local\\ms-playwright",
    "appdata\\local\\pnpm\\store", "appdata\\local\\pnpm-cache", "appdata\\local\\electron\\cache", "appdata\\local\\crashdumps",
    "appdata\\local\\d3dscache", "appdata\\local\\microsoft\\windows\\inetcache", "appdata\\local\\temp",
];

struct Places {
    appdata: String,
    downloads: String,
    temp: String,
    /// Known folders themselves (and their ancestors) are never "stale".
    keep: HashSet<String>,
    caches: HashMap<String, &'static str>,
}

static PLACES: LazyLock<Places> = LazyLock::new(|| {
    let k = crate::fs::get_known_folders();
    let lo = |s: &str| norm_path(s).trim_end_matches('\\').to_lowercase();
    let home = lo(&k.home);
    let mut keep = HashSet::new();
    for p in [&k.home, &k.desktop, &k.documents, &k.downloads, &k.pictures, &k.music, &k.videos]
        .into_iter()
        .chain(k.onedrive.as_ref())
    {
        let mut cur = lo(p);
        loop {
            keep.insert(cur.clone());
            match parent_of(&cur) {
                Some(par) if !par.is_empty() => cur = par.trim_end_matches('\\').to_string(),
                _ => break,
            }
        }
    }
    let caches = HOME_CACHES.iter().map(|c| (format!("{home}\\{c}"), *c)).collect();
    Places { appdata: format!("{home}\\appdata"), downloads: lo(&k.downloads), temp: format!("{home}\\appdata\\local\\temp"), keep, caches }
});

fn rebuildable(ix: &Index, id: u32) -> Option<&'static str> {
    let name = ix.lower(id);
    let p = ix.parent[id as usize];
    let sibling = |n: &[u8]| p != NONE && ix.find_child(p, n).is_some();
    let child = |n: &[u8]| ix.find_child(id, n).is_some();
    Some(match name {
        b"node_modules" => "Dependencies — `npm install` brings them back",
        b".pnpm-store" => "pnpm package store — re-downloaded when needed",
        b"__pycache__" => "Python bytecode cache — rebuilt automatically",
        b"target" if sibling(b"cargo.toml") => "Rust build output — `cargo build` recreates it",
        b".next" | b".nuxt" | b".svelte-kit" | b".angular" | b".turbo" | b".parcel-cache" | b".expo" => {
            "Framework build cache — rebuilt on next build"
        }
        b".venv" | b"venv" if child(b"pyvenv.cfg") => "Python virtual environment — recreate from requirements",
        b".terraform" => "Terraform plugins — `terraform init` restores them",
        b".gradle" if sibling(b"build.gradle") || sibling(b"build.gradle.kts") || sibling(b"settings.gradle") => {
            "Gradle project cache — rebuilt on next build"
        }
        _ => return None,
    })
}

fn in_dir(path: &str, dir: &str) -> bool {
    path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'\\'
}

fn ago(days: i64) -> String {
    if days >= 730 {
        format!("{} years", days / 365)
    } else if days >= 365 {
        "a year".into()
    } else if days >= 60 {
        format!("{} months", days / 30)
    } else {
        format!("{days} days")
    }
}

#[derive(Clone, Copy)]
struct Times {
    created: i64,
    accessed: i64,
    at: i64,
}
static TIMES: LazyLock<Mutex<HashMap<String, Times>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn suggest(scope: Option<&str>, min_size: u64, limit: usize) -> Option<Suggestions> {
    let t0 = Instant::now();
    let now = now_ms();
    let min_size = min_size.max(MB);
    let pl = &*PLACES;

    let (cands, paths, pending) = crate::index::read(|ix, ver| {
        let a = agg(ix, ver);
        let roots: Vec<u32> = match scope {
            Some(s) => vec![ix.resolve(s)?],
            None => ix.roots.clone(),
        };
        let mut cands: Vec<Cand> = Vec::new();
        // (id, lowercase path, inside a stale folder, restricted to known caches)
        let mut stack: Vec<(u32, String, bool, bool)> =
            roots.iter().map(|&r| (r, ix.path(r).trim_end_matches('\\').to_lowercase(), false, false)).collect();
        let stale_min = min_size.max(256 * MB);
        while let Some((d, dpath, stale_above, restricted)) = stack.pop() {
            let depth0 = ix.is_root(d);
            for c in ix.children(d) {
                let cu = c as usize;
                let f = ix.flags[cu];
                let s = a.s(cu);
                if s < min_size || f & F_CLOUD != 0 {
                    continue;
                }
                let lname = ix.lower(c);
                if f & F_DIR != 0 {
                    if f & (F_LINK | F_SYSTEM) != 0 {
                        continue;
                    }
                    let name = std::str::from_utf8(lname).unwrap_or("");
                    if depth0 && PROTECTED_TOP.contains(&name) {
                        continue;
                    }
                    let cpath = format!("{dpath}\\{name}");
                    let newest = a.m(cu);
                    let files = a.f(cu) as u64;
                    // Inside the profile's AppData only the known caches are fair game.
                    if (restricted || cpath == pl.appdata) && !pl.caches.contains_key(&cpath) {
                        if pl.caches.keys().any(|k| in_dir(k, &cpath)) {
                            stack.push((c, cpath, true, true));
                        }
                        continue;
                    }
                    if let Some(why) = rebuildable(ix, c) {
                        cands.push(Cand { id: c, dir: true, kind: "rebuildable", mult: 3.0, reasons: vec![why.into()], size: s, files, modified: newest, cat: C_CODE, dup_of: None });
                        continue;
                    }
                    if let Some(rel) = pl.caches.get(&cpath) {
                        let (kind, why) = match *rel {
                            "appdata\\local\\temp" => ("temp", "Temporary files — apps recreate what they need"),
                            "appdata\\local\\crashdumps" => ("temp", "Crash dumps — only useful for debugging"),
                            _ => ("cache", "Download/package cache — tools fetch it again when needed"),
                        };
                        cands.push(Cand { id: c, dir: true, kind, mult: 2.6, reasons: vec![why.into()], size: s, files, modified: newest, cat: C_SYS, dup_of: None });
                        // Temp: also list its big files one by one.
                        if *rel == "appdata\\local\\temp" {
                            stack.push((c, cpath, true, false));
                        }
                        continue;
                    }
                    let mut stale = stale_above;
                    if !stale_above
                        && !depth0
                        && s >= stale_min
                        && newest > 0
                        && now - newest >= 365 * DAY
                        && !pl.keep.contains(&cpath)
                    {
                        let why = format!("Nothing inside changed in {}", ago((now - newest) / DAY));
                        cands.push(Cand { id: c, dir: true, kind: "stale", mult: 1.3, reasons: vec![why], size: s, files, modified: newest, cat: C_OTHER, dup_of: None });
                        stale = true;
                    }
                    stack.push((c, cpath, stale, false));
                } else {
                    if f & F_SYSTEM != 0 || restricted {
                        continue;
                    }
                    let ext = ext_of(lname);
                    let cat = category(ext);
                    let in_temp = dpath == pl.temp || in_dir(&dpath, &pl.temp);
                    let in_dl = dpath == pl.downloads || in_dir(&dpath, &pl.downloads);
                    let mut reasons: Vec<String> = Vec::new();
                    let (kind, mut mult): (&'static str, f64) = if in_temp {
                        reasons.push("Temporary file".into());
                        ("temp", 2.6)
                    } else if matches!(ext, b"dmp" | b"mdmp" | b"hdmp") {
                        reasons.push("Crash dump — only useful for debugging".into());
                        ("temp", 3.0)
                    } else if matches!(ext, b"log" | b"etl" | b"tmp" | b"temp" | b"crdownload" | b"part" | b"partial") {
                        reasons.push(if matches!(ext, b"log" | b"etl") { "Log file" } else { "Leftover temporary/partial download" }.into());
                        ("temp", 2.2)
                    } else if matches!(ext, b"bak" | b"old") {
                        reasons.push("Backup copy".into());
                        ("temp", 1.8)
                    } else if cat == C_APP && matches!(ext, b"exe" | b"msi" | b"msix" | b"msixbundle" | b"appx" | b"appxbundle") && in_dl {
                        reasons.push("Installer — you can download it again".into());
                        ("installer", 2.6)
                    } else if cat == C_ARCHIVE {
                        let stem = &lname[..lname.len() - ext.len() - 1];
                        let stem = stem.strip_suffix(b".tar").unwrap_or(stem);
                        if ix.find_child(d, stem).is_some_and(|x| ix.flags[x as usize] & F_DIR != 0) {
                            reasons.push("Already extracted next to it".into());
                            ("archive", 3.0)
                        } else {
                            reasons.push("Archive".into());
                            ("archive", 1.3)
                        }
                    } else if cat == C_DISK {
                        reasons.push("Disk image / virtual disk".into());
                        ("diskimage", 1.7)
                    } else if cat == 1 || cat == 3 {
                        ("media", 1.0)
                    } else if cat == C_IMAGE {
                        ("media", 0.45)
                    } else if cat == C_DOC {
                        ("large", 0.55)
                    } else if cat == C_CODE {
                        ("large", 0.7)
                    } else if cat == C_APP {
                        ("large", 0.5)
                    } else {
                        ("large", 1.0)
                    };
                    let kind = if in_dl && kind == "large" { "download" } else { kind };
                    if in_dl {
                        reasons.push("In Downloads".into());
                        mult *= 1.4;
                    }
                    if stale_above && cat != C_IMAGE && cat != C_DOC {
                        mult *= 1.1;
                    }
                    cands.push(Cand { id: c, dir: false, kind, mult, reasons, size: s, files: 1, modified: ix.modified[cu], cat, dup_of: None });
                }
            }
        }

        // Duplicates: same name and size elsewhere. The oldest copy counts as the original.
        let mut groups: HashMap<(u64, &[u8]), Vec<usize>> = HashMap::new();
        for (i, c) in cands.iter().enumerate() {
            if !c.dir && c.size >= 4 * MB {
                groups.entry((c.size, ix.lower(c.id))).or_default().push(i);
            }
        }
        let mut dups: Vec<(usize, usize)> = Vec::new();
        for (_, mut g) in groups {
            if g.len() < 2 {
                continue;
            }
            g.sort_by_key(|&i| cands[i].modified);
            for &i in &g[1..] {
                dups.push((i, g[0]));
            }
        }
        for (i, orig) in dups {
            let c = &mut cands[i];
            c.dup_of = Some(orig);
            if c.kind != "temp" {
                c.kind = "duplicate";
            }
            c.mult = c.mult.max(1.0) * 2.6;
        }
        let paths: Vec<String> = cands.iter().map(|c| ix.path(c.id)).collect();
        Some((cands, paths, a.pending))
    })??;

    // Preliminary rank on modification time; then refine the best with real usage times.
    let score = |c: &Cand, last: i64| {
        let idle_years = ((now - last).max(0) as f64) / (365.0 * DAY as f64);
        // Rebuildable / cache / temp / duplicate items are safe to drop even if recent.
        let safe = matches!(c.kind, "rebuildable" | "cache" | "temp" | "duplicate" | "installer");
        let (floor, fresh) = if safe { (0.8, 0.7) } else { (0.25, 0.25) };
        let fresh = if now - last < 14 * DAY { fresh } else { 1.0 };
        ((c.size as f64) / MB as f64).sqrt() * (floor + idle_years.min(5.0)) * c.mult * fresh
    };
    let mut order: Vec<(f64, usize)> = cands.iter().enumerate().map(|(i, c)| (score(c, c.modified), i)).collect();
    order.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));
    let refine = order.len().min(limit.max(500) * 3);
    let visits = crate::predict::last_visits();
    let ttl = 10 * 60_000;
    let need: Vec<usize> = order[..refine]
        .iter()
        .map(|&(_, i)| i)
        .filter(|&i| !cands[i].dir && TIMES.lock().get(&paths[i]).is_none_or(|t| now - t.at > ttl))
        .collect();
    let fetched: Vec<(usize, Times)> = need
        .par_iter()
        .filter_map(|&i| {
            let d = crate::fs::attr_data(&paths[i])?;
            Some((i, Times {
                created: ft_to_ms(d.ftCreationTime.dwLowDateTime, d.ftCreationTime.dwHighDateTime),
                accessed: ft_to_ms(d.ftLastAccessTime.dwLowDateTime, d.ftLastAccessTime.dwHighDateTime),
                at: now,
            }))
        })
        .collect();
    {
        let mut t = TIMES.lock();
        if t.len() > 50_000 {
            t.clear();
        }
        for (i, tm) in fetched {
            t.insert(paths[i].clone(), tm);
        }
    }
    let times = TIMES.lock();
    let mut items: Vec<Suggestion> = order[..refine]
        .iter()
        .map(|&(_, i)| {
            let c = &cands[i];
            let lp = paths[i].to_lowercase();
            let mut last = c.modified;
            if let Some(t) = times.get(&paths[i]) {
                // Access times can be refreshed by indexers; never trust them beyond "now".
                last = last.max(t.created.min(now)).max(t.accessed.min(now));
            }
            if c.dir {
                for (p, &v) in &visits {
                    if v > last && (*p == lp || in_dir(p, &lp)) {
                        last = v;
                    }
                }
            } else if let Some(&v) = visits.get(&lp) {
                last = last.max(v);
            }
            let mut reasons = c.reasons.clone();
            if let Some(o) = c.dup_of {
                reasons.insert(0, format!("Same name and size as {}", paths[o]));
            }
            Suggestion {
                name: file_name(&paths[i]).to_string(),
                path: paths[i].clone(),
                dir: c.dir,
                size: c.size,
                files: c.files,
                modified: c.modified,
                last_used: last,
                kind: c.kind,
                cat: c.cat,
                reasons,
                score: score(c, last),
                nested: false,
            }
        })
        .collect();
    drop(times);
    items.sort_unstable_by(|a, b| b.score.total_cmp(&a.score));
    let total = cands.len();
    items.truncate(limit);
    let dirs: HashSet<String> = items.iter().filter(|s| s.dir).map(|s| s.path.to_lowercase()).collect();
    for s in &mut items {
        let lp = s.path.to_lowercase();
        let mut cur = parent_of(&lp);
        while let Some(p) = cur {
            if dirs.contains(p.trim_end_matches('\\')) {
                s.nested = true;
                break;
            }
            cur = parent_of(p);
        }
    }
    Some(Suggestions { items, total, pending, took_ms: t0.elapsed().as_secs_f64() * 1000.0 })
}

// ── housekeeping ────────────────────────────────────────────────────────────

/// After a delete: drop what's gone from the index now, and re-measure the Recycle Bin.
pub fn forget(paths: &[String]) {
    crate::index::forget(paths);
    FORCE.store(true, Ordering::Release);
    let drives: HashSet<String> = paths.iter().filter_map(|p| p.get(..2)).map(|d| d.to_lowercase()).collect();
    remeasure_where(|k| k.ends_with("\\$recycle.bin") && drives.iter().any(|d| k.starts_with(d.as_str())));
}

/// Free the per-entry totals (the Storage page closed).
pub fn release() {
    *AGG.lock() = None;
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct RecycleBin {
    pub size: u64,
    pub items: u64,
}

pub fn recycle_bin() -> RecycleBin {
    use windows::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
    let mut i = SHQUERYRBINFO { cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
    // SAFETY: i is a valid, sized out struct; a null root means all drives.
    let _ = unsafe { SHQueryRecycleBinW(windows_core::PCWSTR::null(), &mut i) };
    RecycleBin { size: i.i64Size.max(0) as u64, items: i.i64NumItems.max(0) as u64 }
}

/// Empty the Recycle Bin on every drive (Windows shows its own confirmation).
pub fn empty_recycle_bin() -> crate::error::AppResult<()> {
    use windows::Win32::UI::Shell::SHEmptyRecycleBinW;
    // SAFETY: valid (optional) owner window, null root = all drives, default flags.
    let r = unsafe { SHEmptyRecycleBinW(main_hwnd(), windows_core::PCWSTR::null(), 0) };
    remeasure_where(|k| k.ends_with("\\$recycle.bin"));
    match r {
        Ok(()) => Ok(()),
        // Cancelled in the confirmation, or already empty.
        Err(e) if e.code().0 as u32 == 0x8000FFFF || e.code().0 == 0 => Ok(()),
        Err(e) => Err(crate::error::AppError::io(format!("Couldn't empty the Recycle Bin: {e}"))),
    }
}
