//! Prediction store: frecency, folder transitions, transfer destinations. Plus settings persistence.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::types::{Frecent, Suggestion};
use crate::util::*;

const HALF_LIFE_MS: f64 = 7.0 * 86_400_000.0;
const MAX_FRECENT: usize = 3000;
const MAX_EDGES: usize = 40;

#[derive(Serialize, Deserialize, Clone)]
struct FrecEntry {
    path: String,
    is_dir: bool,
    score: f64,
    last: i64,
    count: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct Edge {
    path: String,
    w: f64,
    last: i64,
}

#[derive(Serialize, Deserialize, Default)]
struct State {
    #[serde(default)]
    frecent: HashMap<String, FrecEntry>,
    /// folder → next folder
    #[serde(default)]
    next: HashMap<String, HashMap<String, Edge>>,
    /// "ext|srcdir", "ext|", "|srcdir" → destination folder
    #[serde(default)]
    dest: HashMap<String, HashMap<String, Edge>>,
    #[serde(default)]
    last_dir: Option<String>,
}

struct Store {
    st: State,
    dirty: bool,
    changed: Instant,
}

static VERSION: AtomicU64 = AtomicU64::new(1);

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| {
    let st = std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str::<State>(&s).ok())
        .unwrap_or_default();
    let _ = std::thread::Builder::new().name("state-save".into()).spawn(|| loop {
        std::thread::sleep(Duration::from_millis(1000));
        let pending = {
            let s = STORE.lock();
            s.dirty && s.changed.elapsed() > Duration::from_millis(1500)
        };
        if pending {
            flush();
        }
    });
    Mutex::new(Store { st, dirty: false, changed: Instant::now() })
});

fn state_path() -> std::path::PathBuf {
    data_dir().join("history.json")
}
fn settings_path() -> std::path::PathBuf {
    data_dir().join("prefs.json")
}

fn write_atomic(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

pub fn flush() {
    let json = {
        let mut s = STORE.lock();
        if !s.dirty {
            return;
        }
        s.dirty = false;
        serde_json::to_vec(&s.st)
    };
    if let Ok(j) = json {
        if let Err(e) = write_atomic(&state_path(), &j) {
            eprintln!("[state] save failed: {e}");
        }
    }
}

pub fn version() -> u64 {
    VERSION.load(Ordering::Relaxed)
}

fn touch(s: &mut Store) {
    s.dirty = true;
    s.changed = Instant::now();
    VERSION.fetch_add(1, Ordering::Relaxed);
}

fn decay(score: f64, last: i64, now: i64) -> f64 {
    let dt = (now - last).max(0) as f64;
    score * 0.5f64.powf(dt / HALF_LIFE_MS)
}

fn bump(map: &mut HashMap<String, Edge>, path: &str, now: i64) {
    let e = map.entry(path.to_lowercase()).or_insert(Edge { path: path.to_string(), w: 0.0, last: now });
    e.w = decay(e.w, e.last, now) + 1.0;
    e.last = now;
    e.path = path.to_string();
    if map.len() > MAX_EDGES {
        if let Some(k) = map
            .iter()
            .min_by(|a, b| decay(a.1.w, a.1.last, now).total_cmp(&decay(b.1.w, b.1.last, now)))
            .map(|(k, _)| k.clone())
        {
            map.remove(&k);
        }
    }
}

pub fn record_visit(path: &str, is_dir: bool) {
    let path = norm_path(path);
    let key = path.to_lowercase();
    let now = now_ms();
    let mut s = STORE.lock();
    let e = s
        .st
        .frecent
        .entry(key.clone())
        .or_insert(FrecEntry { path: path.clone(), is_dir, score: 0.0, last: now, count: 0 });
    e.score = decay(e.score, e.last, now) + 1.0;
    e.last = now;
    e.count = e.count.saturating_add(1);
    e.is_dir = is_dir;
    e.path = path.clone();
    if is_dir {
        if let Some(prev) = s.st.last_dir.clone() {
            if prev != key {
                let m = s.st.next.entry(prev).or_default();
                bump(m, &path, now);
            }
        }
        s.st.last_dir = Some(key);
    }
    if s.st.frecent.len() > MAX_FRECENT {
        let mut v: Vec<(String, f64)> =
            s.st.frecent.iter().map(|(k, e)| (k.clone(), decay(e.score, e.last, now))).collect();
        v.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (k, _) in v.into_iter().skip(MAX_FRECENT * 9 / 10) {
            s.st.frecent.remove(&k);
        }
    }
    touch(&mut s);
}

/// `srcs`: (source path, is_dir) captured before the transfer.
pub fn record_transfer(srcs: &[(String, bool)], dest_dir: &str) {
    let dest = norm_path(dest_dir);
    let now = now_ms();
    let mut s = STORE.lock();
    for (src, is_dir) in srcs {
        let src = norm_path(src);
        let src_dir = parent_of(&src).unwrap_or("").to_lowercase();
        let ext = if *is_dir { ":dir".to_string() } else { ext_of(file_name(&src)) };
        for key in [format!("{ext}|{src_dir}"), format!("{ext}|"), format!("|{src_dir}")] {
            let m = s.st.dest.entry(key).or_default();
            bump(m, &dest, now);
        }
    }
    touch(&mut s);
}

pub fn frecency_snapshot() -> Vec<(String, f64)> {
    let now = now_ms();
    let s = STORE.lock();
    s.st.frecent.values().map(|e| (e.path.clone(), decay(e.score, e.last, now))).collect()
}

/// Lowercase path → when it was last opened in MyExplorer (ms).
pub fn last_visits() -> HashMap<String, i64> {
    let s = STORE.lock();
    s.st.frecent.values().map(|e| (e.path.to_lowercase(), e.last)).collect()
}

pub fn get_frecent(kind: &str, limit: usize) -> Vec<Frecent> {
    let now = now_ms();
    let mut v: Vec<Frecent> = {
        let s = STORE.lock();
        s.st.frecent
            .values()
            .filter(|e| match kind {
                "dir" => e.is_dir,
                "file" => !e.is_dir,
                _ => true,
            })
            .map(|e| Frecent { path: e.path.clone(), is_dir: e.is_dir, score: decay(e.score, e.last, now), last_visit: e.last })
            .collect()
    };
    v.sort_by(|a, b| b.score.total_cmp(&a.score));
    // Drop entries that no longer exist (cheap attribute check on the top slice only).
    let mut out = Vec::with_capacity(limit);
    for f in v {
        if out.len() >= limit {
            break;
        }
        if crate::fs::attributes(&f.path).is_some() {
            out.push(f);
        }
    }
    out
}

struct Cands {
    m: HashMap<String, (String, f64, &'static str)>,
    exclude: Vec<String>,
}

impl Cands {
    fn add(&mut self, path: &str, score: f64, reason: &'static str) {
        let k = path.to_lowercase();
        if self.exclude.iter().any(|e| k == *e || k.starts_with(&format!("{e}\\"))) {
            return;
        }
        let e = self.m.entry(k).or_insert((path.to_string(), 0.0, reason));
        e.1 += score;
        if reason == "history" {
            e.2 = "history";
        }
    }
    fn finish(self, limit: usize) -> Vec<Suggestion> {
        let mut v: Vec<(String, f64, &'static str)> = self.m.into_values().collect();
        v.sort_by(|a, b| b.1.total_cmp(&a.1));
        v.into_iter()
            .filter(|(p, _, _)| crate::fs::attributes(p).is_some_and(|a| a & FA_DIRECTORY != 0))
            .take(limit)
            .map(|(path, _, reason)| Suggestion { path, reason })
            .collect()
    }
}

fn top_frecent_dirs(s: &State, now: i64, n: usize) -> Vec<(String, f64)> {
    let mut v: Vec<(String, f64)> =
        s.frecent.values().filter(|e| e.is_dir).map(|e| (e.path.clone(), decay(e.score, e.last, now))).collect();
    v.sort_by(|a, b| b.1.total_cmp(&a.1));
    v.truncate(n);
    v
}

fn siblings(dir: &str) -> Vec<String> {
    let Some(parent) = parent_of(dir) else { return Vec::new() };
    crate::fs::list_subdirs(parent, false)
        .map(|v| v.into_iter().take(12).map(|n| join(parent, &n)).collect())
        .unwrap_or_default()
}

pub fn suggest_destinations(paths: &[String], limit: usize) -> AppResult<Vec<Suggestion>> {
    let now = now_ms();
    let paths: Vec<String> = paths.iter().map(|p| norm_path(p)).collect();
    let src_dir = paths.first().and_then(|p| parent_of(p)).unwrap_or("").to_string();
    let src_l = src_dir.to_lowercase();
    let mut c = Cands { m: HashMap::new(), exclude: paths.iter().map(|p| p.to_lowercase()).collect() };
    let mut exts: Vec<String> = paths
        .iter()
        .map(|p| {
            if crate::fs::attributes(p).is_some_and(|a| a & FA_DIRECTORY != 0) {
                ":dir".to_string()
            } else {
                ext_of(file_name(p))
            }
        })
        .collect();
    exts.sort();
    exts.dedup();
    {
        let s = STORE.lock();
        let st = &s.st;
        let mut add_table = |key: String, mul: f64| {
            if let Some(m) = st.dest.get(&key) {
                for e in m.values() {
                    if e.path.to_lowercase() != src_l {
                        c.add(&e.path, decay(e.w, e.last, now) * mul, "history");
                    }
                }
            }
        };
        for ext in &exts {
            add_table(format!("{ext}|{src_l}"), 3.0);
            add_table(format!("{ext}|"), 2.0);
        }
        add_table(format!("|{src_l}"), 1.5);
        for (p, sc) in top_frecent_dirs(st, now, 30) {
            if p.to_lowercase() != src_l {
                c.add(&p, sc * 0.3, "frecent");
            }
        }
    }
    if !src_dir.is_empty() {
        for p in siblings(&src_dir) {
            if p.to_lowercase() != src_l {
                c.add(&p, 0.01, "sibling");
            }
        }
    }
    Ok(c.finish(limit))
}

pub fn suggest_next(dir: &str, limit: usize) -> AppResult<Vec<Suggestion>> {
    let now = now_ms();
    let dir = norm_path(dir);
    let dl = dir.to_lowercase();
    let mut c = Cands { m: HashMap::new(), exclude: Vec::new() };
    {
        let s = STORE.lock();
        if let Some(m) = s.st.next.get(&dl) {
            for e in m.values() {
                if e.path.to_lowercase() != dl {
                    c.add(&e.path, decay(e.w, e.last, now) * 3.0, "history");
                }
            }
        }
        for (p, sc) in top_frecent_dirs(&s.st, now, 30) {
            if p.to_lowercase() != dl {
                c.add(&p, sc * 0.3, "frecent");
            }
        }
    }
    for p in siblings(&dir) {
        if p.to_lowercase() != dl {
            c.add(&p, 0.01, "sibling");
        }
    }
    Ok(c.finish(limit))
}

// ── settings ────────────────────────────────────────────────────────────────

pub fn load_settings() -> AppResult<Option<String>> {
    match std::fs::read_to_string(settings_path()) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn save_settings(json: &str) -> AppResult<()> {
    write_atomic(&settings_path(), json.as_bytes())?;
    Ok(())
}
