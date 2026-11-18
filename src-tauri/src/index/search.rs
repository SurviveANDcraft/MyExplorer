//! Parallel scan + ranking + bounded top-K.

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap};

use memchr::memmem;
use rayon::prelude::*;

use super::query::{Kind, Period, Query};
use super::rank::{self, Signals};
use super::store::{Index, F_DELETED, NONE};
use crate::util::*;

pub struct Ctx<'a> {
    pub idx: &'a Index,
    pub q: &'a Query,
    pub scope: Option<u32>,
    pub profile: Option<u32>,
    pub frec: &'a HashMap<u64, f32>,
    pub include_hidden: bool,
    pub now: i64,
    pub today_start: i64,
}

#[derive(Clone, Copy, PartialEq)]
struct Scored(f32, u32);
impl Eq for Scored {}
impl PartialOrd for Scored {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Scored {
    fn cmp(&self, o: &Self) -> Ordering {
        self.0.total_cmp(&o.0).then_with(|| o.1.cmp(&self.1))
    }
}

/// Path-component hash (case-insensitive: feed lowercase bytes).
#[inline]
pub fn hash_comp(h: u64, comp: &[u8]) -> u64 {
    let mut h = (h ^ 0x5c).wrapping_mul(0x100_0000_01b3);
    for &b in comp {
        h = (h ^ b as u64).wrapping_mul(0x100_0000_01b3);
    }
    h
}

pub const HASH_SEED: u64 = 0xcbf2_9ce4_8422_2325;

/// Hash of a full path (lowercased), compatible with index chain hashing.
pub fn hash_path(path: &str) -> u64 {
    let p = norm_path(path).to_lowercase();
    p.split('\\').filter(|c| !c.is_empty()).fold(HASH_SEED, |h, c| hash_comp(h, c.as_bytes()))
}

#[derive(Clone, Default)]
struct Anc {
    alive: bool,
    in_scope: bool,
    in_profile: bool,
    noisy: bool,
    hash: u64,
    /// Bitmask: path term j fully contained in this folder's path.
    path_hits: u64,
    /// Lowercase folder path (only when path terms exist).
    path: Vec<u8>,
}

fn ancestor_info(c: &Ctx, p: u32, path_finders: &[memmem::Finder]) -> Anc {
    let idx = c.idx;
    let mut chain: Vec<u32> = Vec::with_capacity(16);
    let mut cur = p;
    let mut a = Anc { alive: true, in_scope: c.scope.is_none(), ..Default::default() };
    while cur != NONE && chain.len() < 512 {
        chain.push(cur);
        let u = cur as usize;
        if idx.flags[u] & F_DELETED != 0 {
            a.alive = false;
        }
        if Some(cur) == c.scope {
            a.in_scope = true;
        }
        if Some(cur) == c.profile {
            a.in_profile = true;
        }
        if !a.noisy && idx.parent[u] != NONE && rank::is_noise_dir(idx.lower(cur)) {
            a.noisy = true;
        }
        cur = idx.parent[u];
    }
    let mut h = HASH_SEED;
    for &id in chain.iter().rev() {
        h = hash_comp(h, idx.lower(id));
    }
    a.hash = h;
    if !path_finders.is_empty() {
        for (k, &id) in chain.iter().rev().enumerate() {
            if k > 0 {
                a.path.push(b'\\');
            }
            a.path.extend_from_slice(idx.lower(id));
        }
        for (j, f) in path_finders.iter().enumerate() {
            if f.find(&a.path).is_some() {
                a.path_hits |= 1 << j;
            }
        }
    }
    a
}

struct Prepared<'a> {
    name_finders: Vec<memmem::Finder<'a>>,
    path_finders: Vec<memmem::Finder<'a>>,
    exts: Vec<&'a [u8]>,
    min_mod: Option<i64>,
    want_dir: Option<bool>,
}

fn prepare<'a>(c: &'a Ctx<'a>) -> Prepared<'a> {
    let q = c.q;
    // Search the longest (most selective) term first.
    let mut terms: Vec<&String> = q.terms.iter().collect();
    terms.sort_by_key(|t| Reverse(t.len()));
    let mut exts: Vec<&[u8]> = q.exts.iter().map(|e| e.as_bytes()).collect();
    if let Some(k) = q.kind_exts() {
        if exts.is_empty() {
            exts = k.iter().map(|e| e.as_bytes()).collect();
        } else {
            exts.retain(|e| k.contains(&std::str::from_utf8(e).unwrap_or("")));
            if exts.is_empty() {
                exts.push(b"\0");
            }
        }
    }
    const DAY: i64 = 86_400_000;
    let min_mod = q.modified.map(|p| match p {
        Period::Today => c.today_start,
        Period::Week => c.now - 7 * DAY,
        Period::Month => c.now - 30 * DAY,
        Period::Year => c.now - 365 * DAY,
    });
    let want_dir = match q.kind {
        Some(Kind::Folder) => Some(true),
        Some(_) => Some(false),
        None if !exts.is_empty() || q.size_min.is_some() || q.size_max.is_some() => Some(false),
        None => None,
    };
    Prepared {
        name_finders: terms.iter().map(|t| memmem::Finder::new(t.as_bytes())).collect(),
        path_finders: q.path_terms.iter().take(64).map(|t| memmem::Finder::new(t.as_bytes())).collect(),
        exts,
        min_mod,
        want_dir,
    }
}

const CHUNK: usize = 1 << 15;

/// Returns (top hits sorted best-first, total matches).
pub fn run(c: &Ctx, k: usize) -> (Vec<(f32, u32)>, usize) {
    let n = c.idx.len();
    if c.q.is_empty() || n == 0 || k == 0 {
        return (Vec::new(), 0);
    }
    let p = prepare(c);
    let chunks = n.div_ceil(CHUNK);
    let (heap, total) = (0..chunks)
        .into_par_iter()
        .map(|ch| scan_chunk(c, &p, ch * CHUNK, ((ch + 1) * CHUNK).min(n), k))
        .reduce(
            || (BinaryHeap::new(), 0usize),
            |(mut a, ta), (b, tb)| {
                for x in b {
                    push_top(&mut a, x.0, k);
                }
                (a, ta + tb)
            },
        );
    let mut v: Vec<(f32, u32)> = heap.into_iter().map(|Reverse(Scored(s, i))| (s, i)).collect();
    v.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    (v, total)
}

#[inline]
fn push_top(h: &mut BinaryHeap<Reverse<Scored>>, s: Scored, k: usize) {
    if h.len() < k {
        h.push(Reverse(s));
    } else if let Some(top) = h.peek() {
        if s > top.0 {
            h.pop();
            h.push(Reverse(s));
        }
    }
}

fn scan_chunk(c: &Ctx, p: &Prepared, start: usize, end: usize, k: usize) -> (BinaryHeap<Reverse<Scored>>, usize) {
    let idx = c.idx;
    let q = c.q;
    let mut heap: BinaryHeap<Reverse<Scored>> = BinaryHeap::with_capacity(k.min(1024) + 1);
    let mut total = 0usize;
    let mut last_parent = NONE;
    let mut last_anc = Anc::default();
    let mut cache: HashMap<u32, Anc> = HashMap::new();
    let mut buf: Vec<u8> = Vec::new();
    let hidden_mask = F_HIDDEN | F_SYSTEM;

    'entries: for i in start..end {
        let fl = idx.flags[i];
        if fl & F_DELETED != 0 {
            continue;
        }
        let parent = idx.parent[i];
        if parent == NONE {
            continue;
        }
        if !c.include_hidden && fl & hidden_mask != 0 {
            continue;
        }
        let is_dir = fl & F_DIR != 0;
        if let Some(wd) = p.want_dir {
            if wd != is_dir {
                continue;
            }
        }
        if let Some(m) = q.size_min {
            if idx.size[i] < m {
                continue;
            }
        }
        if let Some(m) = q.size_max {
            if idx.size[i] > m {
                continue;
            }
        }
        if let Some(m) = p.min_mod {
            if idx.modified[i] < m {
                continue;
            }
        }
        let id = i as u32;
        let lower = idx.lower(id);
        if !p.exts.is_empty() {
            let ext = match memchr::memrchr(b'.', lower) {
                Some(d) if d > 0 => &lower[d + 1..],
                _ => continue,
            };
            if !p.exts.contains(&ext) {
                continue;
            }
        }
        for f in &p.name_finders {
            if f.find(lower).is_none() {
                continue 'entries;
            }
        }
        // Ancestors (scope, liveness, noise, frecency, path terms).
        if parent != last_parent {
            last_anc = match cache.get(&parent) {
                Some(a) => a.clone(),
                None => {
                    let a = ancestor_info(c, parent, &p.path_finders);
                    if cache.len() < 4096 {
                        cache.insert(parent, a.clone());
                    }
                    a
                }
            };
            last_parent = parent;
        }
        let anc = &last_anc;
        if !anc.alive || !anc.in_scope {
            continue;
        }
        if !p.path_finders.is_empty() {
            for (j, f) in p.path_finders.iter().enumerate() {
                if anc.path_hits & (1 << j) != 0 {
                    continue;
                }
                let tl = q.path_terms[j].len();
                let tail_start = anc.path.len().saturating_sub(tl);
                buf.clear();
                buf.extend_from_slice(&anc.path[tail_start..]);
                buf.push(b'\\');
                buf.extend_from_slice(lower);
                if f.find(&buf).is_none() {
                    continue 'entries;
                }
            }
        }
        total += 1;

        // Score.
        let orig = idx.name_bytes(id);
        let mut terms_len = 0usize;
        let quality = if q.terms.is_empty() {
            rank::Q_FILTER_ONLY
        } else {
            let mut sum = 0.0;
            for t in &q.terms {
                sum += rank::term_quality(lower, orig, t.as_bytes());
                terms_len += t.len();
            }
            sum / q.terms.len() as f32
        };
        let h = hash_comp(anc.hash, lower);
        let s = rank::score(&Signals {
            quality,
            name_len: lower.len(),
            terms_len,
            hidden_or_system: fl & hidden_mask != 0,
            age_ms: if idx.modified[i] > 0 { c.now - idx.modified[i] } else { -1 },
            frec_file: c.frec.get(&h).copied().unwrap_or(0.0),
            frec_dir: c.frec.get(&anc.hash).copied().unwrap_or(0.0),
            in_profile: anc.in_profile,
            noisy: anc.noisy,
        });
        push_top(&mut heap, Scored(s, id), k);
    }
    (heap, total)
}
