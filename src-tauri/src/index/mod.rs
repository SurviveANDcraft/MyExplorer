//! Search index engine: sources, freshness, search entry point.

pub mod query;
pub mod rank;
pub mod search;
pub mod store;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use crossbeam_channel::{unbounded, Receiver, RecvTimeoutError, Sender};
use parking_lot::{Mutex, RwLock};
use windows::Win32::Storage::FileSystem::{
    FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
};

use crate::types::{IndexStatus, SearchHit, SearchOptions, SearchResult};
use crate::util::*;
use crate::watch::{self, WatchEvent, WatchHandle};
use store::{Index, WalkCtl, F_DELETED};

// ── sources ─────────────────────────────────────────────────────────────────

/// A way to (re)build the index. `mft` (elevated USN enumeration) is not implemented yet.
pub trait Source {
    fn kind(&self) -> &'static str;
    fn build(&self, roots: &[String], cancel: &AtomicBool) -> Option<Index>;
}

pub struct CacheSource;
impl Source for CacheSource {
    fn kind(&self) -> &'static str {
        "cache"
    }
    fn build(&self, _roots: &[String], _cancel: &AtomicBool) -> Option<Index> {
        Index::load(&cache_path()).ok()
    }
}

pub struct WalkSource;
impl Source for WalkSource {
    fn kind(&self) -> &'static str {
        "walk"
    }
    fn build(&self, roots: &[String], cancel: &AtomicBool) -> Option<Index> {
        let pool = WALK_POOL.as_ref()?;
        let idx = Arc::new(Mutex::new(Index::default()));
        let rs: Vec<(u32, String)> = roots.iter().map(|r| (idx.lock().add_root(r), r.clone())).collect();
        // Published so searches and status can use the index while it is still being built.
        *BUILDING.lock() = Some(idx.clone());
        let ctl = WalkCtl { cancel, deadline: None, exclude: true };
        store::walk_into(pool, &idx, &rs, &ctl);
        *BUILDING.lock() = None;
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let mut ix = std::mem::take(&mut *idx.lock());
        ix.shrink();
        Some(ix)
    }
}

fn cache_path() -> std::path::PathBuf {
    data_dir().join("index.bin")
}

static WALK_POOL: LazyLock<Option<rayon::ThreadPool>> = LazyLock::new(store::walk_pool);
/// Separate pool: live (on-demand) walks must not queue behind the full-drive walk.
static LIVE_POOL: LazyLock<Option<rayon::ThreadPool>> = LazyLock::new(store::walk_pool);
static BUILDING: LazyLock<Mutex<Option<Arc<Mutex<Index>>>>> = LazyLock::new(|| Mutex::new(None));

// ── engine ──────────────────────────────────────────────────────────────────

struct Engine {
    idx: RwLock<Index>,
    status: Mutex<IndexStatus>,
    has_data: AtomicBool,
    dirty: AtomicBool,
    rebuilding: AtomicBool,
    cancel: AtomicBool,
    watchers: Mutex<Vec<WatchHandle>>,
    tx: Sender<Change>,
    rx: Receiver<Change>,
}

enum Change {
    Fs(u32, String),
    Overflow,
}

static ENGINE: LazyLock<Engine> = LazyLock::new(|| {
    let (tx, rx) = unbounded();
    Engine {
        idx: RwLock::new(Index::default()),
        status: Mutex::new(IndexStatus { state: "idle", entries: 0, source: "walk", roots: Vec::new() }),
        has_data: AtomicBool::new(false),
        dirty: AtomicBool::new(false),
        rebuilding: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        watchers: Mutex::new(Vec::new()),
        tx,
        rx,
    }
});

fn set_status(state: &'static str, source: &'static str, entries: usize) {
    let st = {
        let mut s = ENGINE.status.lock();
        s.state = state;
        s.source = source;
        s.entries = entries;
        s.clone()
    };
    emit("index:status", st);
}

pub fn status() -> IndexStatus {
    let mut s = ENGINE.status.lock().clone();
    if let Some(ix) = ENGINE.idx.try_read() {
        if ENGINE.has_data.load(Ordering::Relaxed) {
            s.entries = ix.live_count();
            return s;
        }
    }
    let building = BUILDING.lock().clone();
    if let Some(b) = building {
        s.entries = b.lock().len();
    }
    s
}

pub fn start() {
    let _ = std::thread::Builder::new().name("index".into()).spawn(|| {
        let roots = crate::fs::fixed_drives();
        ENGINE.status.lock().roots = roots.clone();
        set_status("building", "walk", 0);

        if let Some(ix) = CacheSource.build(&roots, &ENGINE.cancel) {
            let n = ix.live_count();
            *ENGINE.idx.write() = ix;
            ENGINE.has_data.store(true, Ordering::Release);
            set_status("building", "cache", n);
        }

        start_watchers(&roots);
        let _ = std::thread::Builder::new().name("index-apply".into()).spawn(applier);
        rebuild(&roots);

        loop {
            std::thread::sleep(Duration::from_secs(300));
            if ENGINE.cancel.load(Ordering::Relaxed) {
                break;
            }
            save_now();
        }
    });
}

fn rebuild(roots: &[String]) {
    if ENGINE.rebuilding.swap(true, Ordering::AcqRel) {
        return;
    }
    let src = WalkSource;
    if !ENGINE.has_data.load(Ordering::Acquire) {
        set_status("building", src.kind(), 0);
    } else {
        let st = ENGINE.status.lock().clone();
        set_status("building", st.source, st.entries);
    }
    let t = Instant::now();
    // Progress ticker while the walk runs.
    let _ = std::thread::Builder::new().name("index-progress".into()).spawn(|| {
        while ENGINE.rebuilding.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(700));
            if ENGINE.rebuilding.load(Ordering::Acquire) {
                emit("index:status", status());
            }
        }
    });
    if let Some(ix) = src.build(roots, &ENGINE.cancel) {
        let n = ix.live_count();
        *ENGINE.idx.write() = ix;
        ENGINE.has_data.store(true, Ordering::Release);
        ENGINE.dirty.store(true, Ordering::Relaxed);
        ENGINE.rebuilding.store(false, Ordering::Release);
        set_status("ready", src.kind(), n);
        eprintln!("[index] walk: {n} entries in {:?}", t.elapsed());
        save_now();
    } else {
        ENGINE.rebuilding.store(false, Ordering::Release);
    }
}

pub fn save_now() {
    if !ENGINE.has_data.load(Ordering::Acquire) || !ENGINE.dirty.swap(false, Ordering::AcqRel) {
        return;
    }
    let ix = ENGINE.idx.read();
    if let Err(e) = ix.save(&cache_path()) {
        eprintln!("[index] save failed: {e}");
        ENGINE.dirty.store(true, Ordering::Relaxed);
    }
}

pub fn shutdown() {
    save_now();
    ENGINE.cancel.store(true, Ordering::Relaxed);
}

fn start_watchers(roots: &[String]) {
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_DIR_NAME
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_LAST_WRITE
        | FILE_NOTIFY_CHANGE_ATTRIBUTES;
    let mut ws = ENGINE.watchers.lock();
    for r in roots {
        let tx = ENGINE.tx.clone();
        let root = r.clone();
        if let Ok(h) = watch::watch(r, true, filter, move |ev| match ev {
            WatchEvent::Changes(v) => {
                for (a, rel) in v {
                    let _ = tx.send(Change::Fs(a, join(&root, &rel)));
                }
            }
            WatchEvent::Overflow => {
                let _ = tx.send(Change::Overflow);
            }
            WatchEvent::Gone => {}
        }) {
            ws.push(h);
        }
    }
}

struct Meta {
    attrs: u32,
    size: u64,
    modified: i64,
}

fn applier() {
    let rx = ENGINE.rx.clone();
    let mut replay: Vec<(u32, String)> = Vec::new();
    loop {
        let first = match rx.recv() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut batch: Vec<Change> = vec![first];
        let deadline = Instant::now() + Duration::from_millis(400);
        loop {
            let now = Instant::now();
            if now >= deadline || batch.len() > 50_000 {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(c) => batch.push(c),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let mut evs: Vec<(u32, String)> = Vec::with_capacity(batch.len());
        let mut overflow = false;
        for c in batch {
            match c {
                Change::Fs(a, p) => evs.push((a, p)),
                Change::Overflow => overflow = true,
            }
        }
        if overflow && !ENGINE.rebuilding.load(Ordering::Acquire) {
            let roots = ENGINE.status.lock().roots.clone();
            let _ = std::thread::Builder::new().name("index-rewalk".into()).spawn(move || rebuild(&roots));
        }
        let rebuilding = ENGINE.rebuilding.load(Ordering::Acquire);
        if rebuilding {
            if replay.len() < 500_000 {
                replay.extend(evs.iter().cloned());
            }
        } else if !replay.is_empty() {
            let mut all = std::mem::take(&mut replay);
            all.extend(evs);
            evs = all;
        }
        if evs.is_empty() || !ENGINE.has_data.load(Ordering::Acquire) {
            continue;
        }
        let metas: Vec<Option<Meta>> = evs
            .iter()
            .map(|(a, p)| match *a {
                watch::ACTION_ADDED | watch::ACTION_MODIFIED | watch::ACTION_RENAMED_NEW => {
                    crate::fs::attr_data(p).map(|d| Meta {
                        attrs: d.dwFileAttributes,
                        size: if d.dwFileAttributes & FA_DIRECTORY != 0 {
                            0
                        } else {
                            ((d.nFileSizeHigh as u64) << 32) | d.nFileSizeLow as u64
                        },
                        modified: ft_to_ms(d.ftLastWriteTime.dwLowDateTime, d.ftLastWriteTime.dwHighDateTime),
                    })
                }
                _ => None,
            })
            .collect();
        {
            let mut ix = ENGINE.idx.write();
            apply(&mut ix, &evs, &metas);
        }
        ENGINE.dirty.store(true, Ordering::Relaxed);
    }
}

fn apply(ix: &mut Index, evs: &[(u32, String)], metas: &[Option<Meta>]) {
    let mut dir_cache: HashMap<String, Option<u32>> = HashMap::new();
    let mut resolve_dir = |ix: &Index, p: &str| -> Option<u32> {
        let key = p.to_lowercase();
        if let Some(&Some(id)) = dir_cache.get(&key) {
            let last = file_name(&key).trim_end_matches('\\');
            if ix.flags[id as usize] & F_DELETED == 0 && (ix.is_root(id) || ix.lower(id) == last.as_bytes()) {
                return Some(id);
            }
        }
        let v = ix.resolve(p);
        dir_cache.insert(key, v);
        v
    };
    let mut pending_old: Option<u32> = None;
    for (k, (action, path)) in evs.iter().enumerate() {
        let meta = metas[k].as_ref();
        let Some(parent_path) = parent_of(path) else { continue };
        if store::path_excluded(parent_path) {
            continue;
        }
        let name = file_name(path);
        match *action {
            watch::ACTION_ADDED | watch::ACTION_MODIFIED => {
                let Some(m) = meta else { continue };
                let Some(par) = resolve_dir(ix, parent_path) else { continue };
                upsert(ix, par, name, m);
            }
            watch::ACTION_REMOVED => {
                if let Some(par) = resolve_dir(ix, parent_path) {
                    if let Some(id) = ix.find_child(par, name.to_lowercase().as_bytes()) {
                        ix.mark_deleted(id);
                    }
                }
            }
            watch::ACTION_RENAMED_OLD => {
                pending_old = resolve_dir(ix, parent_path)
                    .and_then(|par| ix.find_child(par, name.to_lowercase().as_bytes()));
            }
            watch::ACTION_RENAMED_NEW => {
                let par = resolve_dir(ix, parent_path);
                match (pending_old.take(), par) {
                    (Some(id), Some(np)) => {
                        if ix.parent[id as usize] != np {
                            ix.parent[id as usize] = np;
                            ix.extra_children.entry(np).or_default().push(id);
                        }
                        ix.rename_entry(id, name);
                        if let Some(m) = meta {
                            set_meta(ix, id, m);
                        }
                    }
                    (Some(id), None) => ix.mark_deleted(id),
                    (None, Some(np)) => {
                        if let Some(m) = meta {
                            upsert(ix, np, name, m);
                        }
                    }
                    (None, None) => {}
                }
            }
            _ => {}
        }
    }
}

fn set_meta(ix: &mut Index, id: u32, m: &Meta) {
    let u = id as usize;
    ix.size[u] = m.size;
    ix.modified[u] = m.modified;
    ix.flags[u] = attrs_to_flags(m.attrs, None) | (ix.flags[u] & F_DELETED);
}

fn upsert(ix: &mut Index, parent: u32, name: &str, m: &Meta) {
    match ix.find_child(parent, name.to_lowercase().as_bytes()) {
        Some(id) => {
            set_meta(ix, id, m);
            if ix.name(id) != name {
                ix.rename_entry(id, name);
            }
        }
        None => {
            ix.add_child(parent, name, m.size, m.modified, attrs_to_flags(m.attrs, None));
        }
    }
}

// ── search ──────────────────────────────────────────────────────────────────

type FrecMap = Arc<HashMap<u64, f32>>;
static FREC: LazyLock<Mutex<(u64, FrecMap)>> =
    LazyLock::new(|| Mutex::new((u64::MAX, Arc::new(HashMap::new()))));

fn frec_map() -> Arc<HashMap<u64, f32>> {
    let ver = crate::predict::version();
    let mut g = FREC.lock();
    if g.0 != ver {
        let snap = crate::predict::frecency_snapshot();
        let m: HashMap<u64, f32> = snap.into_iter().map(|(p, s)| (search::hash_path(&p), s as f32)).collect();
        *g = (ver, Arc::new(m));
    }
    g.1.clone()
}

struct Live {
    key: String,
    idx: Arc<Mutex<Index>>,
    done: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    started: Instant,
}

static LIVE: LazyLock<Mutex<Option<Live>>> = LazyLock::new(|| Mutex::new(None));

fn live_index(scope: &str) -> (Arc<Mutex<Index>>, Arc<AtomicBool>, Instant) {
    let key = scope.to_lowercase();
    let mut g = LIVE.lock();
    if let Some(l) = g.as_ref() {
        let stale = l.done.load(Ordering::Acquire) && l.started.elapsed() > Duration::from_secs(60);
        if l.key == key && !stale {
            return (l.idx.clone(), l.done.clone(), l.started);
        }
        l.cancel.store(true, Ordering::Relaxed);
    }
    let mut ix = Index::default();
    let root = ix.add_root(scope);
    let idx = Arc::new(Mutex::new(ix));
    let done = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    {
        let (idx, done, cancel, scope) = (idx.clone(), done.clone(), cancel.clone(), scope.to_string());
        let _ = std::thread::Builder::new().name("live-walk".into()).spawn(move || {
            if let Some(pool) = LIVE_POOL.as_ref() {
                let ctl = WalkCtl { cancel: &cancel, deadline: Some(Instant::now() + Duration::from_secs(30)), exclude: false };
                store::walk_into(pool, &idx, &[(root, scope)], &ctl);
            }
            done.store(true, Ordering::Release);
        });
    }
    *g = Some(Live { key, idx: idx.clone(), done: done.clone(), cancel, started });
    (idx, done, started)
}

fn hits_from(ix: &Index, top: &[(f32, u32)], offset: usize, limit: usize) -> Vec<SearchHit> {
    top.iter()
        .skip(offset)
        .take(limit)
        .map(|&(score, id)| {
            let u = id as usize;
            SearchHit {
                path: ix.path(id),
                name: ix.name(id).to_string(),
                flags: ix.flags[u] & 63,
                size: ix.size[u],
                modified: ix.modified[u],
                score,
            }
        })
        .collect()
}

pub fn search(req_id: f64, query: &str, opts: &SearchOptions) -> SearchResult {
    let t0 = Instant::now();
    let q = query::parse(query);
    let terms = q.highlight_terms();
    let limit = opts.limit.min(5000);
    let k = opts.offset.saturating_add(limit);
    let mk = |hits: Vec<SearchHit>, total: usize, partial: bool| SearchResult {
        req_id,
        hits,
        total,
        terms: terms.clone(),
        took_ms: t0.elapsed().as_secs_f64() * 1000.0,
        partial,
    };
    if q.is_empty() || limit == 0 {
        return mk(Vec::new(), 0, false);
    }
    let frec = frec_map();
    let now = now_ms();
    let today_start = today_start_ms();
    let scope = opts.scope.as_deref().map(norm_path).filter(|s| !s.is_empty());

    if ENGINE.has_data.load(Ordering::Acquire) {
        let ix = ENGINE.idx.read();
        let scope_id = scope.as_deref().and_then(|s| ix.resolve(s));
        let excluded = scope.as_deref().is_some_and(store::path_excluded);
        if scope.is_none() || (scope_id.is_some() && !excluded) {
            let profile = ix.resolve(&crate::fs::HOME);
            let ctx = search::Ctx {
                idx: &ix,
                q: &q,
                scope: scope_id,
                profile,
                frec: &frec,
                include_hidden: opts.include_hidden,
                now,
                today_start,
            };
            let (top, total) = search::run(&ctx, k);
            let hits = hits_from(&ix, &top, opts.offset, limit);
            return mk(hits, total, false);
        }
    }

    // First build still running: search what has been indexed so far.
    let building = if ENGINE.has_data.load(Ordering::Acquire) { None } else { BUILDING.lock().clone() };
    if let Some(b) = building {
        let ix = b.lock();
        let scope_id = scope.as_deref().and_then(|s| ix.resolve(s));
        let excluded = scope.as_deref().is_some_and(store::path_excluded);
        if scope.is_none() || (scope_id.is_some() && !excluded) {
            let profile = ix.resolve(&crate::fs::HOME);
            let ctx = search::Ctx {
                idx: &ix,
                q: &q,
                scope: scope_id,
                profile,
                frec: &frec,
                include_hidden: opts.include_hidden,
                now,
                today_start,
            };
            let (top, total) = search::run(&ctx, k);
            let hits = hits_from(&ix, &top, opts.offset, limit);
            return mk(hits, total, true);
        }
    }

    // Index not ready (or scope outside the index): live walk of the scope.
    let scope = scope.unwrap_or_else(|| crate::fs::HOME.clone());
    let (idx, done, started) = live_index(&scope);
    while !done.load(Ordering::Acquire) && started.elapsed() < Duration::from_millis(600) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let ix = idx.lock();
    let profile = ix.resolve(&crate::fs::HOME);
    let ctx = search::Ctx {
        idx: &ix,
        q: &q,
        scope: None,
        profile,
        frec: &frec,
        include_hidden: opts.include_hidden,
        now,
        today_start,
    };
    let (top, total) = search::run(&ctx, k);
    let hits = hits_from(&ix, &top, opts.offset, limit);
    mk(hits, total, true)
}

/// Warm up the rayon pool so the first keystroke is fast.
pub fn warmup() {
    rayon::spawn(|| {});
}
