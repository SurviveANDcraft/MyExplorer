//! Struct-of-arrays file index.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use parking_lot::Mutex;

use crate::util::*;

pub const F_DELETED: u8 = 64;
pub const NONE: u32 = u32::MAX;

#[derive(Default)]
pub struct Index {
    pub names: Vec<u8>,
    pub lower: Vec<u8>,
    pub name_off: Vec<u32>,
    pub name_len: Vec<u16>,
    pub low_off: Vec<u32>,
    pub low_len: Vec<u16>,
    pub parent: Vec<u32>,
    pub size: Vec<u64>,
    pub modified: Vec<i64>,
    pub flags: Vec<u8>,
    pub first_child: Vec<u32>,
    pub child_count: Vec<u32>,
    pub extra_children: HashMap<u32, Vec<u32>>,
    pub roots: Vec<u32>,
    pub deleted: usize,
}

impl Index {
    pub fn len(&self) -> usize {
        self.parent.len()
    }

    pub fn live_count(&self) -> usize {
        self.len().saturating_sub(self.deleted + self.roots.len())
    }

    #[inline]
    pub fn name(&self, i: u32) -> &str {
        let o = self.name_off[i as usize] as usize;
        let l = self.name_len[i as usize] as usize;
        std::str::from_utf8(&self.names[o..o + l]).unwrap_or("")
    }

    #[inline]
    pub fn name_bytes(&self, i: u32) -> &[u8] {
        let o = self.name_off[i as usize] as usize;
        &self.names[o..o + self.name_len[i as usize] as usize]
    }

    #[inline]
    pub fn lower(&self, i: u32) -> &[u8] {
        let o = self.low_off[i as usize] as usize;
        &self.lower[o..o + self.low_len[i as usize] as usize]
    }

    fn push_names(&mut self, name: &str) -> (u32, u16, u32, u16) {
        let no = self.names.len() as u32;
        let nb = &name.as_bytes()[..name.len().min(u16::MAX as usize)];
        self.names.extend_from_slice(nb);
        let low = name.to_lowercase();
        let lb = &low.as_bytes()[..low.len().min(u16::MAX as usize)];
        let lo = self.lower.len() as u32;
        self.lower.extend_from_slice(lb);
        (no, nb.len() as u16, lo, lb.len() as u16)
    }

    pub fn push(&mut self, parent: u32, name: &str, size: u64, modified: i64, flags: u8) -> u32 {
        let id = self.len() as u32;
        let (no, nl, lo, ll) = self.push_names(name);
        self.name_off.push(no);
        self.name_len.push(nl);
        self.low_off.push(lo);
        self.low_len.push(ll);
        self.parent.push(parent);
        self.size.push(size);
        self.modified.push(modified);
        self.flags.push(flags);
        self.first_child.push(0);
        self.child_count.push(0);
        id
    }

    /// Root entry; name is the path without trailing backslash ("C:" or "C:\Users\me").
    pub fn add_root(&mut self, path: &str) -> u32 {
        let name = path.trim_end_matches('\\').to_string();
        let id = self.push(NONE, &name, 0, 0, F_DIR);
        self.roots.push(id);
        id
    }

    pub fn is_root(&self, i: u32) -> bool {
        self.parent[i as usize] == NONE
    }

    pub fn path(&self, i: u32) -> String {
        let mut chain = Vec::with_capacity(16);
        let mut c = i;
        while c != NONE && chain.len() < 512 {
            chain.push(c);
            c = self.parent[c as usize];
        }
        let mut s = String::with_capacity(chain.len() * 16);
        for (k, id) in chain.iter().rev().enumerate() {
            if k > 0 {
                s.push('\\');
            }
            s.push_str(self.name(*id));
        }
        if chain.len() == 1 && s.ends_with(':') {
            s.push('\\');
        }
        s
    }

    pub fn children(&self, d: u32) -> impl Iterator<Item = u32> + '_ {
        let s = self.first_child[d as usize];
        let n = self.child_count[d as usize];
        let extra = self.extra_children.get(&d).map(|v| v.as_slice()).unwrap_or(&[]);
        (s..s + n)
            .chain(extra.iter().copied())
            .filter(move |&c| self.parent[c as usize] == d && self.flags[c as usize] & F_DELETED == 0)
    }

    pub fn find_child(&self, d: u32, lower_name: &[u8]) -> Option<u32> {
        self.children(d).find(|&c| self.lower(c) == lower_name)
    }

    /// Resolve an absolute path to an entry id.
    pub fn resolve(&self, path: &str) -> Option<u32> {
        let p = norm_path(path).to_lowercase();
        let p = p.trim_end_matches('\\');
        let mut best: Option<(u32, usize)> = None;
        for &r in &self.roots {
            let rn = std::str::from_utf8(self.lower(r)).unwrap_or("");
            if (p == rn || (p.starts_with(rn) && p.as_bytes().get(rn.len()) == Some(&b'\\')))
                && best.is_none_or(|(_, l)| rn.len() > l) {
                    best = Some((r, rn.len()));
                }
        }
        let (mut cur, l) = best?;
        let rest = &p[l..];
        for comp in rest.split('\\').filter(|c| !c.is_empty()) {
            cur = self.find_child(cur, comp.as_bytes())?;
        }
        Some(cur)
    }

    pub fn rename_entry(&mut self, i: u32, new_name: &str) {
        let (no, nl, lo, ll) = self.push_names(new_name);
        let u = i as usize;
        self.name_off[u] = no;
        self.name_len[u] = nl;
        self.low_off[u] = lo;
        self.low_len[u] = ll;
    }

    pub fn mark_deleted(&mut self, i: u32) {
        let u = i as usize;
        if self.flags[u] & F_DELETED == 0 {
            self.flags[u] |= F_DELETED;
            self.deleted += 1;
        }
    }

    pub fn add_child(&mut self, parent: u32, name: &str, size: u64, modified: i64, flags: u8) -> u32 {
        let id = self.push(parent, name, size, modified, flags);
        self.extra_children.entry(parent).or_default().push(id);
        id
    }

    pub fn shrink(&mut self) {
        self.names.shrink_to_fit();
        self.lower.shrink_to_fit();
        self.name_off.shrink_to_fit();
        self.name_len.shrink_to_fit();
        self.low_off.shrink_to_fit();
        self.low_len.shrink_to_fit();
        self.parent.shrink_to_fit();
        self.size.shrink_to_fit();
        self.modified.shrink_to_fit();
        self.flags.shrink_to_fit();
        self.first_child.shrink_to_fit();
        self.child_count.shrink_to_fit();
    }

    // ── cache file ──────────────────────────────────────────────────────────

    pub fn save(&self, path: &Path) -> io::Result<()> {
        let tmp = path.with_extension("tmp");
        {
            let f = std::fs::File::create(&tmp)?;
            let mut w = io::BufWriter::with_capacity(1 << 20, f);
            w.write_all(MAGIC)?;
            w.write_all(&(self.len() as u64).to_le_bytes())?;
            write_bytes(&mut w, &self.names)?;
            write_bytes(&mut w, &self.lower)?;
            write_u32s(&mut w, &self.name_off)?;
            write_u16s(&mut w, &self.name_len)?;
            write_u32s(&mut w, &self.low_off)?;
            write_u16s(&mut w, &self.low_len)?;
            write_u32s(&mut w, &self.parent)?;
            write_u64s(&mut w, &self.size)?;
            write_u64s(&mut w, &self.modified.iter().map(|&x| x as u64).collect::<Vec<_>>())?;
            write_bytes(&mut w, &self.flags)?;
            write_u32s(&mut w, &self.first_child)?;
            write_u32s(&mut w, &self.child_count)?;
            write_u32s(&mut w, &self.roots)?;
            let mut flat: Vec<u32> = Vec::new();
            for (k, v) in &self.extra_children {
                flat.push(*k);
                flat.push(v.len() as u32);
                flat.extend_from_slice(v);
            }
            write_u32s(&mut w, &flat)?;
            w.write_all(&(self.deleted as u64).to_le_bytes())?;
            w.flush()?;
        }
        std::fs::rename(&tmp, path)
    }

    pub fn load(path: &Path) -> io::Result<Index> {
        let mut data = Vec::new();
        std::fs::File::open(path)?.read_to_end(&mut data)?;
        let mut r = Reader { d: &data, p: 0 };
        if r.take(MAGIC.len())? != MAGIC {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad index magic"));
        }
        let n = r.u64()? as usize;
        let mut ix = Index {
            names: r.bytes()?,
            lower: r.bytes()?,
            name_off: r.u32s()?,
            name_len: r.u16s()?,
            low_off: r.u32s()?,
            low_len: r.u16s()?,
            parent: r.u32s()?,
            size: r.u64s()?,
            modified: r.u64s()?.into_iter().map(|x| x as i64).collect(),
            flags: r.bytes()?,
            first_child: r.u32s()?,
            child_count: r.u32s()?,
            roots: r.u32s()?,
            ..Default::default()
        };
        let flat = r.u32s()?;
        ix.deleted = r.u64()? as usize;
        let mut i = 0;
        while i + 1 < flat.len() {
            let k = flat[i];
            let l = flat[i + 1] as usize;
            let end = (i + 2 + l).min(flat.len());
            ix.extra_children.insert(k, flat[i + 2..end].to_vec());
            i = end;
        }
        let ok = [
            ix.name_off.len(),
            ix.name_len.len(),
            ix.low_off.len(),
            ix.low_len.len(),
            ix.size.len(),
            ix.modified.len(),
            ix.flags.len(),
            ix.first_child.len(),
            ix.child_count.len(),
        ]
        .iter()
        .all(|&l| l == n)
            && ix.parent.len() == n;
        let bounds_ok = (0..n).all(|i| {
            (ix.name_off[i] as usize + ix.name_len[i] as usize) <= ix.names.len()
                && (ix.low_off[i] as usize + ix.low_len[i] as usize) <= ix.lower.len()
                && (ix.parent[i] == NONE || (ix.parent[i] as usize) < n)
                && (ix.first_child[i] as usize + ix.child_count[i] as usize) <= n
        }) && ix.roots.iter().all(|&r| (r as usize) < n)
            && ix.extra_children.values().flatten().all(|&c| (c as usize) < n);
        if !ok || !bounds_ok {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "corrupt index"));
        }
        Ok(ix)
    }
}

const MAGIC: &[u8; 8] = b"MXIDX003";

fn write_bytes(w: &mut impl Write, v: &[u8]) -> io::Result<()> {
    w.write_all(&(v.len() as u64).to_le_bytes())?;
    w.write_all(v)
}
fn write_u16s(w: &mut impl Write, v: &[u16]) -> io::Result<()> {
    w.write_all(&(v.len() as u64).to_le_bytes())?;
    for x in v {
        w.write_all(&x.to_le_bytes())?;
    }
    Ok(())
}
fn write_u32s(w: &mut impl Write, v: &[u32]) -> io::Result<()> {
    w.write_all(&(v.len() as u64).to_le_bytes())?;
    for x in v {
        w.write_all(&x.to_le_bytes())?;
    }
    Ok(())
}
fn write_u64s(w: &mut impl Write, v: &[u64]) -> io::Result<()> {
    w.write_all(&(v.len() as u64).to_le_bytes())?;
    for x in v {
        w.write_all(&x.to_le_bytes())?;
    }
    Ok(())
}

struct Reader<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> io::Result<&'a [u8]> {
        if self.p + n > self.d.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated index"));
        }
        let s = &self.d[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn u64(&mut self) -> io::Result<u64> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
    fn len(&mut self, elem: usize) -> io::Result<usize> {
        let n = self.u64()? as usize;
        if n.saturating_mul(elem) > self.d.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad length"));
        }
        Ok(n)
    }
    fn bytes(&mut self) -> io::Result<Vec<u8>> {
        let n = self.len(1)?;
        Ok(self.take(n)?.to_vec())
    }
    fn u16s(&mut self) -> io::Result<Vec<u16>> {
        let n = self.len(2)?;
        Ok(self.take(n * 2)?.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect())
    }
    fn u32s(&mut self) -> io::Result<Vec<u32>> {
        let n = self.len(4)?;
        Ok(self.take(n * 4)?.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    }
    fn u64s(&mut self) -> io::Result<Vec<u64>> {
        let n = self.len(8)?;
        Ok(self
            .take(n * 8)?
            .chunks_exact(8)
            .map(|c| u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]))
            .collect())
    }
}

// ── parallel walk ───────────────────────────────────────────────────────────

pub struct WalkCtl<'a> {
    pub cancel: &'a AtomicBool,
    pub deadline: Option<Instant>,
    /// Skip descending into junk directories (see `excluded_dir`).
    pub exclude: bool,
}

pub(crate) const EXCLUDED_NAMES: &[&str] =
    &["node_modules", ".git", "$recycle.bin", "system volume information", "winsxs", "__pycache__", ".pnpm-store"];
pub(crate) const EXCLUDED_WINDOWS: &[&str] = &["servicing", "installer", "softwaredistribution", "assembly"];

/// Directories that are indexed as entries but never descended into: huge, and never what a
/// user is looking for. Searching *inside* one falls back to a live walk.
pub fn excluded_dir(parent: &str, name: &str) -> bool {
    if EXCLUDED_NAMES.iter().any(|n| name.eq_ignore_ascii_case(n)) {
        return true;
    }
    let p = parent.trim_end_matches('\\');
    p.len() == 10
        && p.as_bytes()[1] == b':'
        && p[2..].eq_ignore_ascii_case("\\Windows")
        && EXCLUDED_WINDOWS.iter().any(|n| name.eq_ignore_ascii_case(n))
}

/// True if `path` is, or is inside, an excluded directory.
pub fn path_excluded(path: &str) -> bool {
    let mut cur = path;
    while let Some(par) = parent_of(cur) {
        if excluded_dir(par, file_name(cur)) {
            return true;
        }
        cur = par;
    }
    false
}

impl WalkCtl<'_> {
    fn stop(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) || self.deadline.is_some_and(|d| Instant::now() >= d)
    }
}

/// Walk `root_path` into `idx` under root entry `root_id`, in parallel on `pool`.
pub fn walk_into(pool: &rayon::ThreadPool, idx: &Mutex<Index>, roots: &[(u32, String)], ctl: &WalkCtl) {
    pool.scope(|s| {
        for (id, p) in roots {
            let (id, p) = (*id, p.clone());
            s.spawn(move |s| walk_dir(s, idx, id, p, ctl));
        }
    });
}

fn walk_dir<'s>(s: &rayon::Scope<'s>, idx: &'s Mutex<Index>, id: u32, path: String, ctl: &'s WalkCtl<'s>) {
    if ctl.stop() {
        return;
    }
    struct R {
        name: String,
        size: u64,
        modified: i64,
        flags: u8,
    }
    let mut recs: Vec<R> = Vec::new();
    let _ = crate::fs::for_each_entry(&path, |e| {
        let flags = attrs_to_flags(e.attrs, if e.attrs & FA_REPARSE != 0 { Some(e.tag) } else { None });
        recs.push(R { name: String::from_utf16_lossy(e.name), size: e.size, modified: e.modified, flags });
    });
    if recs.is_empty() {
        return;
    }
    let mut subdirs: Vec<(u32, String)> = Vec::new();
    {
        let mut ix = idx.lock();
        let start = ix.len() as u32;
        for r in &recs {
            let cid = ix.push(id, &r.name, r.size, r.modified, r.flags);
            if r.flags & F_DIR != 0 && r.flags & F_LINK == 0 && !(ctl.exclude && excluded_dir(&path, &r.name)) {
                subdirs.push((cid, r.name.clone()));
            }
        }
        ix.first_child[id as usize] = start;
        ix.child_count[id as usize] = recs.len() as u32;
    }
    for (cid, name) in subdirs {
        let p = join(&path, &name);
        s.spawn(move |s| walk_dir(s, idx, cid, p, ctl));
    }
}

pub fn walk_pool() -> Option<rayon::ThreadPool> {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    rayon::ThreadPoolBuilder::new().num_threads(n).thread_name(|i| format!("walk-{i}")).build().ok()
}
