//! Recursive folder size, computed as fast as the disk allows:
//! one FindFirstFileExW (large fetch, basic info) pass per directory, subtrees fanned out
//! across the rayon pool, junctions/symlinks not followed. A newer request cancels older
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
use crate::util::{join, FA_DIRECTORY, FA_REPARSE};

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
    fn add(mut self, o: DirSize) -> DirSize {
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

/// None when cancelled by a newer request.
fn walk(dir: &str, gen: u64) -> Option<DirSize> {
    if GEN.load(Ordering::Relaxed) != gen {
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
            if e.attrs & FA_REPARSE == 0 {
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
    let r = walk(path, gen);
    if let Some(d) = r {
        store(k, d);
    }
    Ok(r)
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
