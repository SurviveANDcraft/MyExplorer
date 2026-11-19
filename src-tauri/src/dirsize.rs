//! Recursive folder size, computed as fast as the disk allows:
//! one FindFirstFileExW (large fetch, basic info) pass per directory, subtrees fanned out
//! across the rayon pool, junctions/symlinks not followed (cloud folders are). A newer request cancels older
//! ones, and results (including big subtrees found along the way) are cached briefly so
//! hovering back or drilling in is instant.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Serialize;

use crate::error::AppResult;
use crate::fs::for_each_entry;
use crate::fs::RawEntry;
use crate::util::{attrs_to_flags, join, FA_DIRECTORY, FA_REPARSE, F_LINK};

/// Junctions and symlinks are not followed (loops, double counting); OneDrive and other
/// cloud folders are reparse points too, but real folders: those are counted.
fn is_link(e: &RawEntry) -> bool {
    e.attrs & FA_REPARSE != 0 && attrs_to_flags(e.attrs, Some(e.tag)) & F_LINK != 0
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DirSize {
    pub size: u64,
    pub files: u64,
    pub folders: u64,
    /// Some subfolders could not be read (access denied, …): the total is a lower bound.
    pub partial: bool,
}

impl DirSize {
    pub fn add(mut self, o: DirSize) -> DirSize {
        self.size += o.size;
        self.files += o.files;
        self.folders += o.folders;
        self.partial |= o.partial;
        self
    }
}

const TTL: Duration = Duration::from_secs(90);
/// Subtrees with at least this many entries are cached on their own while walking a parent.
const CACHE_SUBTREE_MIN: u64 = 2_000;

static GEN: AtomicU64 = AtomicU64::new(0);
static CACHE: Mutex<Option<HashMap<String, (DirSize, Instant)>>> = Mutex::new(None);

fn key(p: &str) -> String {
    p.trim_end_matches(['\\', '/']).to_lowercase()
}

fn cached(k: &str) -> Option<DirSize> {
    let c = CACHE.lock();
    c.as_ref()?.get(k).filter(|(_, at)| at.elapsed() < TTL).map(|(d, _)| *d)
}

fn store(k: String, d: DirSize) {
    let mut c = CACHE.lock();
    let m = c.get_or_insert_with(HashMap::new);
    if m.len() > 4_096 {
        m.retain(|_, (_, at)| at.elapsed() < TTL);
        if m.len() > 4_096 {
            m.clear();
        }
    }
    m.insert(k, (d, Instant::now()));
}

pub fn invalidate(path: &str) {
    // A change anywhere below a cached folder makes it stale: drop it and its ancestors.
    let k = key(path);
    if let Some(m) = CACHE.lock().as_mut() {
        m.retain(|c, _| !(k.starts_with(c.as_str()) && (k.len() == c.len() || k.as_bytes()[c.len()] == b'\\')));
    }
}

/// None when cancelled by a newer request (`gen: None` = never cancelled, for `mx size`).
fn walk(dir: &str, gen: Option<u64>) -> Option<DirSize> {
    if gen.is_some_and(|g| GEN.load(Ordering::Relaxed) != g) {
        return None;
    }
    let k = key(dir);
    if let Some(d) = cached(&k) {
        return Some(d);
    }
    let mut own = DirSize::default();
    let mut subs: Vec<String> = Vec::new();
    let ok = for_each_entry(dir, |e| {
        if e.attrs & FA_DIRECTORY != 0 {
            own.folders += 1;
            if !is_link(e) {
                subs.push(join(dir, &String::from_utf16_lossy(e.name)));
            }
        } else {
            own.files += 1;
            own.size += e.size;
        }
    });
    if ok.is_err() {
        own.partial = true;
    }
    let total = if subs.len() > 1 {
        subs.par_iter()
            .map(|s| walk(s, gen))
            .try_reduce(DirSize::default, |a, b| Some(a.add(b)))?
            .add(own)
    } else if let Some(s) = subs.first() {
        walk(s, gen)?.add(own)
    } else {
        own
    };
    if total.files + total.folders >= CACHE_SUBTREE_MIN {
        store(k, total);
    }
    Some(total)
}

/// Total size of everything inside `path`. Ok(None) when superseded by a newer request.
pub fn dir_size(path: &str) -> AppResult<Option<DirSize>> {
    let gen = GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let k = key(path);
    if let Some(d) = cached(&k) {
        return Ok(Some(d));
    }
    // The root itself must be readable; deeper failures only mark the result partial.
    let _ = crate::fs::attributes(path).ok_or_else(|| crate::error::AppError::from_win32(2, path))?;
    let r = walk(path, Some(gen));
    if let Some(d) = r {
        store(k, d);
    }
    Ok(r)
}

/// Like `dir_size` but never cancelled (agents' `mx size`, which can run in parallel
/// with each other and with the GUI's hover sizes).
pub fn measure(path: &str) -> AppResult<DirSize> {
    let k = key(path);
    if let Some(d) = cached(&k) {
        return Ok(d);
    }
    let _ = crate::fs::attributes(path).ok_or_else(|| crate::error::AppError::from_win32(2, path))?;
    let d = walk(path, None).unwrap_or_default();
    store(k, d);
    Ok(d)
}

/// One entry directly inside a folder, with its total size (`dir` = folder).
pub struct Child {
    pub name: String,
    pub dir: bool,
    pub size: DirSize,
}

/// Direct children of `path`, each sized (subfolders recursively, in parallel), biggest first.
pub fn children(path: &str) -> AppResult<Vec<Child>> {
    let mut out: Vec<Child> = Vec::new();
    let mut subs: Vec<String> = Vec::new();
    for_each_entry(path, |e| {
        let name = String::from_utf16_lossy(e.name);
        if e.attrs & FA_DIRECTORY != 0 {
            if !is_link(e) {
                subs.push(name);
            }
        } else {
            out.push(Child { name, dir: false, size: DirSize { size: e.size, files: 1, ..Default::default() } });
        }
    })?;
    let dirs: Vec<Child> = subs
        .into_par_iter()
        .map(|name| {
            let full = join(path, &name);
            let size = measure(&full).unwrap_or(DirSize { partial: true, ..Default::default() });
            Child { name, dir: true, size }
        })
        .collect();
    out.extend(dirs);
    out.sort_by(|a, b| b.size.size.cmp(&a.size.size));
    Ok(out)
}

/// Cancel any in-flight size computation (pointer left the item).
pub fn cancel() {
    GEN.fetch_add(1, Ordering::Relaxed);
}

/// Forget cached totals that a change at `paths` makes stale: each path, its ancestors and its subtree.
pub fn invalidate_many(paths: &[String]) {
    let mut c = CACHE.lock();
    let Some(m) = c.as_mut() else { return };
    for p in paths {
        let changed = key(p);
        m.retain(|k, _| {
            let ancestor_or_self = changed == *k || (changed.starts_with(k.as_str()) && changed.as_bytes().get(k.len()) == Some(&b'\\'));
            let inside = k.starts_with(changed.as_str()) && k.as_bytes().get(changed.len()) == Some(&b'\\');
            !(ancestor_or_self || inside)
        });
    }
}
