//! Content search ("Search in files"): ripgrep's engine over either a live, .gitignore-aware
//! walk of a folder or the indexed text files of every drive. Results stream to the UI as
//! `grep:batch` events, each file scored for how likely it is what the user is after.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use crossbeam_channel::{unbounded, Sender};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::index::search::{hash_comp, HASH_SEED};
use crate::util::*;

static CURRENT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepOptions {
    pub scope: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub include_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHit {
    pub line: u32,
    pub text: String,
    /// [start, end) in UTF-16 code units of `text`.
    pub ranges: Vec<[u32; 2]>,
    /// Contains the whole query (not just one of its words).
    pub phrase: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: i64,
    pub score: f32,
    pub matches: u32,
    pub lines: Vec<LineHit>,
    /// A matching line looks like where the term is defined (`fn x`, `class X`, `# Heading`).
    pub definition: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Batch {
    req_id: f64,
    files: Vec<FileHit>,
    scanned: usize,
    matched: usize,
    done: bool,
    took_ms: f64,
    /// Searching indexed files ("everywhere") vs a live folder walk.
    source: &'static str,
}

const MAX_LINES: usize = 12;
const MAX_MATCHES: u32 = 5000;
const MAX_SENT: usize = 3000;

/// Formats worth reading when searching everywhere (folder scope reads anything that isn't binary).
static TEXT_EXTS: LazyLock<std::collections::HashSet<&'static [u8]>> = LazyLock::new(|| {
    "txt md markdown mdx rst adoc org tex log csv tsv json jsonc json5 xml yml yaml toml ini cfg conf env properties \
     html htm xhtml css scss sass less ts tsx mts cts js jsx mjs cjs vue svelte astro rs py pyi go c h cpp cc cxx hpp hh \
     cs csx java kt kts groovy gradle scala swift m mm dart rb php pl pm lua r jl ex exs erl hrl hs ml mli fs fsx clj cljs \
     edn nim zig sh bash zsh fish ps1 psm1 psd1 bat cmd sql graphql gql proto cmake mk mak dockerfile tf hcl nix vim \
     srt vtt ipynb csproj sln props targets xaml resx plist gitignore editorconfig"
        .split_whitespace()
        .map(str::as_bytes)
        .collect()
});
/// Never worth opening even in a folder search.
static BINARY_EXTS: LazyLock<std::collections::HashSet<&'static str>> = LazyLock::new(|| {
    "jpg jpeg png gif webp bmp ico heic avif tif tiff psd raw mp4 mov mkv avi webm wmv m4v mp3 flac m4a wav ogg aac wma opus \
     zip 7z rar gz tgz xz bz2 zst tar iso cab exe dll sys msi pdb obj o a lib so dylib class jar pyc wasm node bin dat db \
     sqlite sqlite3 mdb pdf doc docx xls xlsx ppt pptx odt ods odp ttf otf woff woff2 eot dmp vhd vhdx vmdk ova lnk"
        .split_whitespace()
        .collect()
});
const NOISY_FILE: &[&str] = &[".min.js", ".min.css", ".map", ".lock", "-lock.json", ".log", ".snap"];
const DEF_WORDS: &[&str] = &[
    "fn", "function", "def", "class", "struct", "enum", "interface", "type", "trait", "impl", "const", "let", "var", "func",
    "mod", "module", "namespace", "record", "macro", "static", "export",
];

fn ext_of(lower_name: &str) -> &str {
    lower_name.rfind('.').map_or("", |i| &lower_name[i + 1..])
}

struct Query {
    matcher: RegexMatcher,
    phrase: String,     // lowercase
    phrase_raw: String, // as typed
    terms: Vec<String>, // lowercase, only when the query has several words
}

fn build(query: &str, o: &GrepOptions) -> AppResult<Query> {
    let q = query.trim();
    let words: Vec<&str> = if o.regex { Vec::new() } else { q.split_whitespace().collect() };
    let mut alts: Vec<String> = Vec::new();
    if o.regex {
        alts.push(q.to_string());
    } else {
        alts.push(regex_syntax_escape(q));
        if words.len() > 1 {
            alts.extend(words.iter().map(|w| regex_syntax_escape(w)));
        }
    }
    let pat = alts.join("|");
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!o.case_sensitive)
        .word(o.whole_word)
        .build(&pat)
        .map_err(|e| AppError::invalid_name(format!("Invalid pattern: {e}")))?;
    Ok(Query {
        matcher,
        phrase: q.to_lowercase(),
        phrase_raw: q.to_string(),
        terms: if words.len() > 1 { words.iter().map(|w| w.to_lowercase()).collect() } else { Vec::new() },
    })
}

fn regex_syntax_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

// ── per-file search ─────────────────────────────────────────────────────────

struct Collect<'a> {
    q: &'a Query,
    regex: bool,
    lines: Vec<LineHit>,
    matches: u32,
    phrase_lines: u32,
    exact_case: bool,
    definition: bool,
    long_lines: u32,
    term_mask: u64,
}

fn u16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

impl Sink for Collect<'_> {
    type Error = std::io::Error;
    fn matched(&mut self, _s: &Searcher, m: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        self.matches += 1;
        let raw = m.bytes();
        let line = String::from_utf8_lossy(raw);
        let line = line.trim_end_matches(['\r', '\n']);
        if line.len() > 2000 {
            self.long_lines += 1;
        }
        let lower = line.to_lowercase();
        let has_phrase = self.regex || lower.contains(&self.q.phrase);
        if has_phrase {
            self.phrase_lines += 1;
            if !self.regex && line.contains(&self.q.phrase_raw) {
                self.exact_case = true;
            }
        }
        for (i, t) in self.q.terms.iter().enumerate().take(64) {
            if lower.contains(t.as_str()) {
                self.term_mask |= 1 << i;
            }
        }
        // Byte ranges of every match on the line.
        let mut ranges: Vec<(usize, usize)> = Vec::new();
        let _ = self.q.matcher.find_iter(line.as_bytes(), |mm| {
            ranges.push((mm.start(), mm.end()));
            ranges.len() < 64
        });
        if !self.definition && !self.regex && !ranges.is_empty() {
            if let Some(p) = lower.find(&self.q.phrase) {
                let before = lower[..p].trim_end();
                let last = before.rsplit(|c: char| c.is_whitespace() || c == '(' || c == '<').next().unwrap_or("");
                if DEF_WORDS.contains(&last) || (!before.is_empty() && before.chars().all(|c| c == '#')) {
                    self.definition = true;
                }
            }
        }
        // Keep the first MAX_LINES lines, but let whole-phrase lines displace single-word ones.
        let slot = if self.lines.len() < MAX_LINES {
            true
        } else if has_phrase {
            match self.lines.iter().position(|l| !l.phrase) {
                Some(i) => {
                    self.lines.remove(i);
                    true
                }
                None => false,
            }
        } else {
            false
        };
        if slot && !ranges.is_empty() {
            let lead = line.len() - line.trim_start().len();
            let mut start = lead;
            let first = ranges[0].0;
            if first > start + 80 {
                start = first - 60;
                while !line.is_char_boundary(start) {
                    start -= 1;
                }
            }
            let mut end = (start + 300).min(line.len());
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            let text = &line[start..end];
            let mut out = Vec::new();
            for (a, b) in ranges {
                if a < start || a >= end {
                    continue;
                }
                let b = b.min(end);
                let (a, b) = (a - start, b - start);
                if !text.is_char_boundary(a) || !text.is_char_boundary(b) {
                    continue;
                }
                let s = u16_len(&text[..a]);
                out.push([s, s + u16_len(&text[a..b])]);
            }
            let prefix = if start > lead { "…" } else { "" };
            let shift = u16_len(prefix);
            let ranges = out.into_iter().map(|[a, b]| [a + shift, b + shift]).collect();
            self.lines.push(LineHit { line: m.line_number().unwrap_or(0) as u32, text: format!("{prefix}{}", text.trim_end()), ranges, phrase: has_phrase });
        }
        Ok(self.matches < MAX_MATCHES)
    }
}

struct Ctx {
    req: u64,
    req_f: f64,
    q: Query,
    regex: bool,
    frec: Arc<HashMap<u64, f32>>,
    now: i64,
    tx: Sender<FileHit>,
    scanned: AtomicUsize,
    /// Private stop flag (mx grep); None = cancelled when a newer UI search starts.
    stop: Option<Arc<AtomicBool>>,
}

impl Ctx {
    fn cancelled(&self) -> bool {
        match &self.stop {
            Some(s) => s.load(Ordering::Relaxed),
            None => CURRENT.load(Ordering::Relaxed) != self.req,
        }
    }
}

fn noisy_path(lower: &str) -> bool {
    lower.split('\\').any(|c| crate::index::rank::is_noise_dir(c.as_bytes()) || matches!(c, "dist" | "build" | "out" | "vendor" | "target" | "obj" | "bin" | "coverage"))
}

fn search_file(c: &Ctx, s: &mut Searcher, path: &str, size: u64, modified: i64) {
    c.scanned.fetch_add(1, Ordering::Relaxed);
    let mut sink = Collect {
        q: &c.q,
        regex: c.regex,
        lines: Vec::new(),
        matches: 0,
        phrase_lines: 0,
        exact_case: false,
        definition: false,
        long_lines: 0,
        term_mask: 0,
    };
    if s.search_path(&c.q.matcher, long_path(path), &mut sink).is_err() || sink.matches == 0 {
        return;
    }
    let all_terms = !c.q.terms.is_empty() && sink.term_mask.count_ones() as usize >= c.q.terms.len().min(64);
    if sink.phrase_lines == 0 && !all_terms {
        return;
    }
    let name = file_name(path).to_string();
    let lower_path = path.to_lowercase();
    let lower_name = name.to_lowercase();

    // ── score: how likely is this the file the user means? ──
    let mut score = if sink.phrase_lines > 0 { 100.0 } else { 55.0 };
    if sink.exact_case {
        score += 12.0;
    }
    if sink.definition {
        score += 28.0;
    }
    if !c.regex && lower_name.contains(&c.q.phrase) {
        score += 40.0;
    } else if !c.regex && c.q.terms.iter().any(|t| lower_name.contains(t.as_str())) {
        score += 15.0;
    }
    score += (1.0 + sink.phrase_lines.max(1) as f32).ln() * 7.0;
    let age_days = (c.now - modified).max(0) as f32 / 86_400_000.0;
    score += if age_days < 1.0 { 14.0 } else if age_days < 7.0 { 10.0 } else if age_days < 30.0 { 6.0 } else if age_days < 365.0 { 2.0 } else { 0.0 };
    // Frecency of the file and its folders.
    let mut h = HASH_SEED;
    let mut frec = 0.0f32;
    for comp in lower_path.split('\\').filter(|x| !x.is_empty()) {
        h = hash_comp(h, comp.as_bytes());
        frec = frec.max(c.frec.get(&h).copied().unwrap_or(0.0));
    }
    score += (frec * 3.0).min(22.0);
    if noisy_path(&lower_path) {
        score -= 30.0;
    }
    if NOISY_FILE.iter().any(|n| lower_name.ends_with(n)) {
        score -= 22.0;
    }
    if sink.long_lines > 0 {
        score -= 15.0;
    }
    if size > 2 << 20 {
        score -= 8.0;
    }
    let _ = c.tx.send(FileHit { path: path.to_string(), name, size, modified, score, matches: sink.matches, lines: sink.lines, definition: sink.definition });
}

fn new_searcher() -> Searcher {
    SearcherBuilder::new().line_number(true).binary_detection(BinaryDetection::quit(0)).build()
}

fn cloud_attrs(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    is_cloud_attrs(m.file_attributes())
}

// ── runners ─────────────────────────────────────────────────────────────────

fn walk_folder(c: &Arc<Ctx>, root: &str, include_hidden: bool) {
    let root_excluded = crate::index::store::path_excluded(root);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(12);
    let walker = ignore::WalkBuilder::new(root)
        .hidden(!include_hidden)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .threads(threads)
        .filter_entry(move |e| {
            if root_excluded || e.depth() == 0 || !e.file_type().is_some_and(|t| t.is_dir()) {
                return true;
            }
            let parent = e.path().parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            !crate::index::store::excluded_dir(&parent, &e.file_name().to_string_lossy())
        })
        .build_parallel();
    walker.run(|| {
        let c = c.clone();
        let mut s = new_searcher();
        Box::new(move |e| {
            if c.cancelled() {
                return ignore::WalkState::Quit;
            }
            let Ok(e) = e else { return ignore::WalkState::Continue };
            if !e.file_type().is_some_and(|t| t.is_file()) {
                return ignore::WalkState::Continue;
            }
            let lower = e.file_name().to_string_lossy().to_lowercase();
            if BINARY_EXTS.contains(ext_of(&lower)) {
                return ignore::WalkState::Continue;
            }
            let Ok(m) = e.metadata() else { return ignore::WalkState::Continue };
            if m.len() > 64 << 20 || cloud_attrs(&m) {
                return ignore::WalkState::Continue;
            }
            let modified = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
            search_file(&c, &mut s, &e.path().to_string_lossy(), m.len(), modified);
            ignore::WalkState::Continue
        })
    });
}

/// Folders that are never what someone searching their files means.
fn skip_everywhere(lower: &str) -> bool {
    let rest = lower.get(2..).unwrap_or("");
    rest.starts_with("\\windows\\")
        || rest.starts_with("\\program files")
        || rest.starts_with("\\programdata\\")
        || rest.starts_with("\\$recycle.bin")
        || lower.contains("\\appdata\\local\\")
        || lower.contains("\\appdata\\locallow\\")
}

fn search_index(c: &Arc<Ctx>, mut cands: Vec<(String, u64, i64)>) {
    let home = crate::fs::HOME.to_lowercase();
    // Most likely places first, so the best results show up in the first few hundred ms.
    let mut keyed: Vec<(f32, (String, u64, i64))> = cands
        .drain(..)
        .filter_map(|cand| {
            let lower = cand.0.to_lowercase();
            if skip_everywhere(&lower) {
                return None;
            }
            let age_days = (c.now - cand.2).max(0) as f32 / 86_400_000.0;
            let mut k = 30.0 / (1.0 + age_days / 7.0);
            if lower.starts_with(&home) {
                k += 20.0;
            }
            if noisy_path(&lower) {
                k -= 25.0;
            }
            Some((k, cand))
        })
        .collect();
    keyed.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));
    let items: Arc<Vec<(String, u64, i64)>> = Arc::new(keyed.into_iter().map(|x| x.1).collect());
    let next = Arc::new(AtomicUsize::new(0));
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(12);
    std::thread::scope(|sc| {
        for _ in 0..threads {
            let (c, items, next) = (c.clone(), items.clone(), next.clone());
            sc.spawn(move || {
                let mut s = new_searcher();
                loop {
                    if c.cancelled() {
                        return;
                    }
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some((p, size, m)) = items.get(i) else { return };
                    search_file(&c, &mut s, p, *size, *m);
                }
            });
        }
    });
}

fn run_search(ctx: &Arc<Ctx>, scope: Option<&str>, include_hidden: bool) {
    match scope {
        Some(dir) => walk_folder(ctx, dir, include_hidden),
        None => {
            let accept = |lower: &[u8], size: u64| {
                size <= 16 << 20 && lower.iter().rposition(|&b| b == b'.').is_some_and(|i| TEXT_EXTS.contains(&lower[i + 1..]))
            };
            match crate::index::file_candidates(accept, include_hidden) {
                Some(c) => search_index(ctx, c),
                None => walk_folder(ctx, &crate::fs::HOME, include_hidden),
            }
        }
    }
}

pub struct BlockingResult {
    /// Best first.
    pub files: Vec<FileHit>,
    pub scanned: usize,
    pub timed_out: bool,
}

/// Runs a search to completion (or `timeout`) on the calling thread, independent of the UI's
/// search: used by `mx grep`.
pub fn search_blocking(query: &str, o: &GrepOptions, timeout: Duration) -> AppResult<BlockingResult> {
    let q = build(query, o)?;
    let (tx, rx) = unbounded::<FileHit>();
    let stop = Arc::new(AtomicBool::new(false));
    let ctx = Arc::new(Ctx {
        req: 0,
        req_f: 0.0,
        q,
        regex: o.regex,
        frec: crate::index::frecency(),
        now: now_ms(),
        tx,
        scanned: AtomicUsize::new(0),
        stop: Some(stop.clone()),
    });
    let scope = o.scope.as_deref().map(norm_path).filter(|s| !s.is_empty());
    let include_hidden = o.include_hidden;
    let worker = {
        let ctx = ctx.clone();
        std::thread::Builder::new()
            .name("mx-grep".into())
            .spawn(move || run_search(&ctx, scope.as_deref(), include_hidden))
            .map_err(|e| AppError::io(e.to_string()))?
    };
    let t0 = Instant::now();
    let mut files = Vec::new();
    let mut timed_out = false;
    loop {
        if let Ok(h) = rx.recv_timeout(Duration::from_millis(15)) {
            files.push(h);
        }
        if worker.is_finished() {
            break;
        }
        if t0.elapsed() >= timeout {
            stop.store(true, Ordering::Relaxed);
            timed_out = true;
            let _ = worker.join();
            break;
        }
    }
    files.extend(rx.try_iter());
    files.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    Ok(BlockingResult { files, scanned: ctx.scanned.load(Ordering::Relaxed), timed_out })
}

pub fn cancel() {
    CURRENT.fetch_add(1, Ordering::Relaxed);
}

/// Starts a search; results arrive as `grep:batch` events tagged with `req_id`.
pub fn start(req_id: f64, query: String, o: GrepOptions) -> AppResult<()> {
    let q = build(&query, &o)?;
    let req = CURRENT.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = unbounded::<FileHit>();
    let ctx = Arc::new(Ctx {
        req,
        req_f: req_id,
        q,
        regex: o.regex,
        frec: crate::index::frecency(),
        now: now_ms(),
        tx,
        scanned: AtomicUsize::new(0),
        stop: None,
    });
    let scope = o.scope.as_deref().map(norm_path).filter(|s| !s.is_empty());
    let t0 = Instant::now();
    let source: &'static str = if scope.is_some() { "folder" } else { "index" };

    let worker = {
        let ctx = ctx.clone();
        let include_hidden = o.include_hidden;
        std::thread::Builder::new()
            .name("grep".into())
            .spawn(move || run_search(&ctx, scope.as_deref(), include_hidden))
            .map_err(|e| AppError::io(e.to_string()))?
    };

    // Aggregator: batches hits into events (first one fast, then every ~70 ms).
    std::thread::Builder::new()
        .name("grep-agg".into())
        .spawn(move || {
            let mut pending: Vec<FileHit> = Vec::new();
            let (mut sent, mut matched) = (0usize, 0usize);
            let mut last = Instant::now() - Duration::from_secs(1);
            let flush = |pending: &mut Vec<FileHit>, sent: &mut usize, matched: usize, done: bool| {
                let files: Vec<FileHit> = pending.drain(..).take(MAX_SENT.saturating_sub(*sent)).collect();
                *sent += files.len();
                emit(
                    "grep:batch",
                    Batch {
                        req_id: ctx.req_f,
                        files,
                        scanned: ctx.scanned.load(Ordering::Relaxed),
                        matched,
                        done,
                        took_ms: t0.elapsed().as_secs_f64() * 1000.0,
                        source,
                    },
                );
            };
            loop {
                match rx.recv_timeout(Duration::from_millis(70)) {
                    Ok(h) => {
                        matched += 1;
                        pending.push(h);
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
                if CURRENT.load(Ordering::Relaxed) != ctx.req {
                    return;
                }
                if worker.is_finished() && rx.is_empty() {
                    break;
                }
                let gap = if sent == 0 { 40 } else { 90 };
                if last.elapsed() >= Duration::from_millis(gap) {
                    last = Instant::now();
                    flush(&mut pending, &mut sent, matched, false);
                }
            }
            while let Ok(h) = rx.try_recv() {
                matched += 1;
                pending.push(h);
            }
            if CURRENT.load(Ordering::Relaxed) == ctx.req {
                flush(&mut pending, &mut sent, matched, true);
            }
        })
        .map_err(|e| AppError::io(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &std::path::Path, q: &str, o: &GrepOptions) -> Vec<FileHit> {
        let (tx, rx) = unbounded();
        let c = Arc::new(Ctx { req: CURRENT.load(Ordering::Relaxed), req_f: 0.0, q: build(q, o).unwrap(), regex: o.regex, frec: Arc::new(HashMap::new()), now: now_ms(), tx, scanned: AtomicUsize::new(0), stop: None });
        walk_folder(&c, &dir.to_string_lossy(), false);
        drop(c);
        let mut v: Vec<FileHit> = rx.try_iter().collect();
        v.sort_by(|a, b| b.score.total_cmp(&a.score));
        v
    }

    #[test]
    fn finds_ranks_and_marks() {
        let d = std::env::temp_dir().join(format!("mx-grep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("node_modules")).unwrap();
        std::fs::write(d.join("use.ts"), "import { parseInvoice } from './x';\nparseInvoice(a);\n").unwrap();
        std::fs::write(d.join("def.ts"), "// helpers\nexport function parseInvoice(raw: string) {\n  return raw;\n}\n").unwrap();
        std::fs::write(d.join("words.md"), "the invoice was hard to parse\n").unwrap();
        std::fs::write(d.join("node_modules").join("dep.js"), "parseInvoice()").unwrap();
        std::fs::write(d.join("bin.dat2"), b"parseInvoice\0\x01\x02").unwrap();
        let o = GrepOptions { scope: None, case_sensitive: false, whole_word: false, regex: false, include_hidden: false };
        let hits = run(&d, "parseInvoice", &o);
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names[0], "def.ts", "definition ranks first: {names:?}");
        assert!(names.contains(&"use.ts") && !names.contains(&"dep.js") && !names.contains(&"bin.dat2"), "{names:?}");
        let l = &hits[0].lines[0];
        assert_eq!(l.line, 2);
        let [a, b] = l.ranges[0];
        assert_eq!(&l.text.encode_utf16().collect::<Vec<_>>()[a as usize..b as usize], &"parseInvoice".encode_utf16().collect::<Vec<_>>()[..]);
        // Multi-word: file containing all words (not the phrase) still matches.
        let multi = run(&d, "parse invoice", &o);
        assert!(multi.iter().any(|h| h.name == "words.md"));
        let _ = std::fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    #[test]
    #[ignore]
    fn bench_folder() {
        let dir = std::env::var("MX_BENCH_DIR").unwrap();
        let o = GrepOptions { scope: None, case_sensitive: false, whole_word: false, regex: false, include_hidden: false };
        let (tx, rx) = unbounded();
        let t0 = Instant::now();
        let c = Arc::new(Ctx { req: CURRENT.load(Ordering::Relaxed), req_f: 0.0, q: build("function", &o).unwrap(), regex: false, frec: Arc::new(HashMap::new()), now: now_ms(), tx, scanned: AtomicUsize::new(0), stop: None });
        walk_folder(&c, &dir, false);
        let n = rx.try_iter().count();
        eprintln!("BENCH scanned={} matched={} in {:?}", c.scanned.load(Ordering::Relaxed), n, t0.elapsed());
    }
}
