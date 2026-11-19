//! Agent search server: answers the `mx` CLI over a per-user named pipe, straight from the
//! in-memory index. Runs inside the GUI, or headless (`--mx-daemon`) when the GUI is closed.
//!
//! Wire format. Request: one line, `cwd \x1f arg \x1f arg ... \n` (UTF-8).
//! Response: one status byte (`0` ok, `1` no matches, `2` usage error) + text to print.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::FromRawHandle;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, Instant};

use rayon::prelude::*;
use windows::Win32::Foundation::{ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAGS_AND_ATTRIBUTES, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_core::PCWSTR;

use crate::dirsize::{self, DirSize};
use crate::index::{self, query};
use crate::types::{SearchHit, SearchOptions};
use crate::util::*;

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 5000;
/// Headless daemon exits after this long without a request (GUI never does).
const DAEMON_IDLE: Duration = Duration::from_secs(3600);

static IS_DAEMON: AtomicBool = AtomicBool::new(false);
static LAST_REQ: AtomicI64 = AtomicI64::new(0);

pub fn pipe_name() -> String {
    // Same override as mx.exe: lets a test build serve next to the installed app.
    if let Ok(p) = std::env::var("MX_PIPE") {
        return p;
    }
    let user = std::env::var("USERNAME").unwrap_or_default();
    let tag = if cfg!(debug_assertions) { "-dev" } else { "" };
    format!(r"\\.\pipe\myexplorer-mx{tag}-{user}")
}

// ── server ──────────────────────────────────────────────────────────────────

/// GUI: take over the pipe (asking a running headless daemon to hand over first).
pub fn start_gui() {
    let _ = std::thread::Builder::new().name("mx-pipe".into()).spawn(|| {
        crate::agent_setup::refresh_installed();
        for _ in 0..100 {
            if let Some(first) = create_instance(true) {
                serve(first);
                return;
            }
            // Someone owns it: a daemon (asks it to quit) or a stale instance closing.
            let _ = request("\x1fquit");
            std::thread::sleep(Duration::from_millis(100));
        }
        eprintln!("[mx] could not take over {}", pipe_name());
    });
}

/// Headless mode: index + pipe, no window. Never returns.
pub fn run_daemon() -> ! {
    IS_DAEMON.store(true, Ordering::Relaxed);
    let Some(first) = create_instance(true) else {
        std::process::exit(0); // GUI or another daemon already serves.
    };
    LAST_REQ.store(now_ms(), Ordering::Relaxed);
    index::warmup();
    index::start();
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        if now_ms() - LAST_REQ.load(Ordering::Relaxed) > DAEMON_IDLE.as_millis() as i64 {
            index::shutdown();
            std::process::exit(0);
        }
    });
    serve(first);
    std::process::exit(0);
}

fn create_instance(first: bool) -> Option<File> {
    let name = wide(&pipe_name());
    let mut mode = PIPE_ACCESS_DUPLEX;
    if first {
        mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let h = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(mode.0),
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            1 << 16,
            1 << 12,
            0,
            None,
        )
    };
    if h == INVALID_HANDLE_VALUE || h.is_invalid() {
        return None;
    }
    Some(unsafe { File::from_raw_handle(h.0 as _) })
}

fn serve(mut inst: File) {
    loop {
        let ok = match unsafe { ConnectNamedPipe(handle_of(&inst), None) } {
            Ok(()) => true,
            Err(e) => e.code() == ERROR_PIPE_CONNECTED.to_hresult(),
        };
        // Next instance first, so concurrent clients never see "busy" for long.
        let next = create_instance(false);
        if ok {
            let conn = inst;
            let _ = std::thread::Builder::new().name("mx-conn".into()).spawn(move || handle(conn));
        }
        match next {
            Some(n) => inst = n,
            None => {
                std::thread::sleep(Duration::from_millis(50));
                match create_instance(false) {
                    Some(n) => inst = n,
                    None => return,
                }
            }
        }
    }
}

fn handle_of(f: &File) -> windows::Win32::Foundation::HANDLE {
    use std::os::windows::io::AsRawHandle;
    windows::Win32::Foundation::HANDLE(f.as_raw_handle() as _)
}

fn handle(mut f: File) {
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 4096];
    while !buf.contains(&b'\n') && buf.len() < (1 << 20) {
        match f.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let line = String::from_utf8_lossy(&buf);
    let line = line.trim_end_matches(['\n', '\r']);
    let mut parts = line.split('\x1f');
    let cwd = parts.next().unwrap_or("").to_string();
    let args: Vec<String> = parts.map(str::to_string).collect();
    LAST_REQ.store(now_ms(), Ordering::Relaxed);

    if args.len() == 1 && (args[0] == "quit" || args[0] == "stop") {
        let daemon = IS_DAEMON.load(Ordering::Relaxed);
        if daemon {
            index::shutdown();
        }
        let _ = f.write_all(if daemon { b"0stopped\n" } else { b"2served by the MyExplorer window; close it to stop\n" });
        let _ = f.sync_all();
        drop(f);
        if daemon {
            std::process::exit(0);
        }
        return;
    }
    let (code, out) = run(&cwd, &args);
    let mut msg = Vec::with_capacity(out.len() + 1);
    msg.push(b'0' + code);
    msg.extend_from_slice(out.as_bytes());
    let _ = f.write_all(&msg);
    let _ = f.sync_all(); // FlushFileBuffers: wait until the client has read everything.
}

/// Ask a running headless daemon to save and exit (no-op for the GUI).
pub fn stop_daemon() {
    let _ = request("quit");
}

/// Client side of the handshake (used by the GUI to retire a daemon).
fn request(body: &str) -> Option<Vec<u8>> {
    let mut f = std::fs::OpenOptions::new().read(true).write(true).open(pipe_name()).ok()?;
    f.write_all(body.as_bytes()).ok()?;
    f.write_all(b"\n").ok()?;
    let mut out = Vec::new();
    let _ = f.read_to_end(&mut out);
    Some(out)
}

// ── commands ────────────────────────────────────────────────────────────────

const USAGE: &str = "\
mx — instant file search over the MyExplorer index (all fixed drives).
usage: mx [opts] <query> [<query> ...]   each argument is one query; several run in parallel
       mx size [-n N] <path> [<path> ...]   total size on disk; -n N = also the N biggest items inside
       mx status | mx stop
opts:  -n N      results per query (default 20)
       -i PATH   only inside PATH (relative to cwd ok)
       -a        include hidden/system files
       -l        long: modified date + size
       --abs     always absolute paths (default: relative when under cwd)
query: words      all must appear in the name, any order, case-insensitive
                  (if too few hits, words may also match parent folder names)
       \"two words\" exact phrase   src/comp  path fragment
       ext:pdf,docx   kind:folder|file|image|video|audio|doc|code|archive
       size:>10mb     modified:today|week|month|year
skips: node_modules, .git, $Recycle.Bin, WinSxS (use -i inside them for a live scan)
";

struct Req {
    limit: usize,
    scope: Option<String>,
    hidden: bool,
    long: bool,
    abs: bool,
    time: bool,
    queries: Vec<String>,
}

fn parse_args(cwd: &str, args: &[String]) -> Result<Req, String> {
    let mut r = Req { limit: DEFAULT_LIMIT, scope: None, hidden: false, long: false, abs: false, time: false, queries: Vec::new() };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-n" | "--limit" => {
                let v = it.next().ok_or("-n needs a number")?;
                r.limit = v.parse::<usize>().map_err(|_| format!("bad -n value: {v}"))?.clamp(1, MAX_LIMIT);
            }
            "-i" | "--in" => {
                let v = it.next().ok_or("-i needs a path")?;
                r.scope = Some(resolve_path(cwd, v));
            }
            "-a" | "--all" => r.hidden = true,
            "-l" | "--long" => r.long = true,
            "--abs" => r.abs = true,
            "-t" | "--time" => r.time = true,
            "--" => r.queries.extend(it.by_ref().cloned()),
            s if s.len() > 1 && s.starts_with('-') && !s.contains(' ') => {
                if let Some(n) = s.strip_prefix("-n").and_then(|v| v.parse::<usize>().ok()) {
                    r.limit = n.clamp(1, MAX_LIMIT);
                } else {
                    return Err(format!("unknown option {s} (queries starting with '-' go after --)"));
                }
            }
            _ => r.queries.push(a.clone()),
        }
    }
    r.queries.retain(|q| !q.trim().is_empty());
    Ok(r)
}

fn resolve_path(cwd: &str, p: &str) -> String {
    let p = p.trim_matches('"');
    let p = if p == "~" || p.starts_with("~/") || p.starts_with("~\\") {
        format!("{}{}", *crate::fs::HOME, &p[1..])
    } else {
        p.to_string()
    };
    let b = p.as_bytes();
    let absolute = (b.len() >= 2 && b[1] == b':') || p.starts_with("\\\\") || p.starts_with("//");
    let joined = if absolute || cwd.is_empty() { p } else { format!("{cwd}\\{p}") };
    // Collapse `.` / `..` segments.
    let norm = norm_path(&joined);
    if norm.starts_with("\\\\") {
        return norm; // UNC: leave as is.
    }
    let mut out: Vec<&str> = Vec::new();
    for (k, seg) in norm.split('\\').enumerate() {
        match seg {
            "" | "." if k > 0 => {}
            ".." => {
                if out.len() > 1 {
                    out.pop();
                }
            }
            s => out.push(s),
        }
    }
    let s = out.join("\\");
    if s.len() == 2 && s.as_bytes()[1] == b':' {
        format!("{s}\\")
    } else {
        norm_path(&s)
    }
}

fn run(cwd: &str, args: &[String]) -> (u8, String) {
    match args.first().map(String::as_str) {
        None | Some("-h") | Some("--help") | Some("help") => return (0, USAGE.to_string()),
        Some("status") if args.len() == 1 => return (0, status_line()),
        Some("size") | Some("du") => return run_size(cwd, &args[1..]),
        _ => {}
    }
    let req = match parse_args(cwd, args) {
        Ok(r) => r,
        Err(e) => return (2, format!("mx: {e}\n{USAGE}")),
    };
    if req.queries.is_empty() {
        return (2, USAGE.to_string());
    }
    let t0 = Instant::now();
    index::wait_searchable(Duration::from_secs(60));
    let opts = SearchOptions { scope: req.scope.clone(), limit: req.limit, offset: 0, include_hidden: req.hidden };
    let groups: Vec<Group> = req.queries.par_iter().map(|q| find(q, &opts)).collect();
    let rel = if req.abs { None } else { Some(norm_path(cwd)) };
    let multi = groups.len() > 1;
    let mut out = String::new();
    let mut any = false;
    if groups.iter().any(|g| g.partial) {
        out.push_str("(index still building: results may be incomplete)\n");
    }
    for (q, g) in req.queries.iter().zip(&groups) {
        any |= !g.hits.is_empty();
        if multi {
            out.push_str(&format!("# {q}\n"));
        }
        if g.hits.is_empty() {
            out.push_str("(no matches)\n");
            continue;
        }
        for h in &g.hits {
            if req.long {
                out.push_str(&format!("{} {:>6}  ", fmt_date(h.modified), if h.flags & F_DIR != 0 { "-".into() } else { fmt_size(h.size) }));
            }
            out.push_str(&display_path(&h.path, rel.as_deref()));
            if h.flags & F_DIR != 0 {
                out.push('\\');
            }
            out.push('\n');
        }
        if g.more > 0 {
            out.push_str(&format!("… +{} more (-n to show)\n", g.more));
        } else if g.more_unknown {
            out.push_str("… more (-n to show)\n");
        }
    }
    if req.time {
        out.push_str(&format!("({:.1} ms)\n", t0.elapsed().as_secs_f64() * 1000.0));
    }
    (if any { 0 } else { 1 }, out)
}

/// `mx size`: recursive totals read from disk (everything, including node_modules/.git), not
/// the index. Paths run in parallel; big subtrees stay cached 90 s (shared with the GUI).
fn run_size(cwd: &str, args: &[String]) -> (u8, String) {
    let mut top = 0usize;
    let mut time = false;
    let mut paths: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-n" | "--top" => match it.next().and_then(|v| v.parse::<usize>().ok()) {
                Some(n) => top = n.min(MAX_LIMIT),
                None => return (2, format!("mx size: -n needs a number\n{USAGE}")),
            },
            "-t" | "--time" => time = true,
            s if s.starts_with("-n") && s[2..].parse::<usize>().is_ok() => top = s[2..].parse::<usize>().unwrap().min(MAX_LIMIT),
            s if s.len() > 1 && s.starts_with('-') && !s.contains(['\\', '/']) => return (2, format!("mx size: unknown option {s}\n{USAGE}")),
            _ => paths.push(a.clone()),
        }
    }
    if paths.is_empty() {
        paths.push(".".into());
    }
    let t0 = Instant::now();
    let rel = norm_path(cwd);
    let results: Vec<(String, Result<(DirSize, Vec<dirsize::Child>), String>)> = paths
        .par_iter()
        .map(|p| {
            let full = resolve_path(cwd, p);
            let r = (|| -> Result<_, String> {
                let attrs = crate::fs::attributes(&full).ok_or("not found")?;
                if attrs & FA_DIRECTORY == 0 {
                    let size = std::fs::metadata(&full).map(|m| m.len()).map_err(|e| e.to_string())?;
                    return Ok((DirSize { size, files: 1, ..Default::default() }, Vec::new()));
                }
                let kids = match index::child_sizes(&full) {
                    // From the index (instant), plus the folders it doesn't descend into
                    // (node_modules, .git, …) measured on disk.
                    Some(v) => {
                        let mut kids: Vec<dirsize::Child> = v
                            .into_par_iter()
                            .map(|(name, dir, t)| {
                                let own = DirSize { size: t.size, files: t.files, folders: t.folders, partial: false };
                                let size = t.skipped.par_iter()
                                    .map(|s| dirsize::measure(s).unwrap_or(DirSize { partial: true, ..Default::default() }))
                                    .reduce(DirSize::default, DirSize::add)
                                    .add(own);
                                dirsize::Child { name, dir, size }
                            })
                            .collect();
                        kids.sort_by(|a, b| b.size.size.cmp(&a.size.size));
                        kids
                    }
                    None => dirsize::children(&full).map_err(|e| e.to_string())?,
                };
                let d = kids.iter().fold(DirSize::default(), |mut a, c| {
                    a.size += c.size.size;
                    a.files += c.size.files;
                    a.folders += c.size.folders + c.dir as u64;
                    a.partial |= c.size.partial;
                    a
                });
                Ok((d, kids))
            })();
            (full, r)
        })
        .collect();
    let mut out = String::new();
    let mut ok = false;
    for (full, r) in results {
        let shown = if full.trim_end_matches('\\').eq_ignore_ascii_case(rel.trim_end_matches('\\')) { ".".to_string() } else { display_path(&full, Some(&rel)) };
        match r {
            Err(e) => out.push_str(&format!("{shown}: {e}\n")),
            Ok((d, kids)) => {
                ok = true;
                out.push_str(&format!("{:>6}  {} file{}, {} folder{}  {shown}{}\n", fmt_size(d.size), group(d.files), plural(d.files), group(d.folders), plural(d.folders),
                    if d.partial { "  (partial: some folders unreadable)" } else { "" }));
                for c in kids.iter().take(top) {
                    let pct = if d.size > 0 { c.size.size as f64 * 100.0 / d.size as f64 } else { 0.0 };
                    out.push_str(&format!("{:>6} {:>3.0}%  {}{}\n", fmt_size(c.size.size), pct, c.name, if c.dir { "\\" } else { "" }));
                }
                if kids.len() > top && top > 0 {
                    out.push_str(&format!("… +{} more\n", kids.len() - top));
                }
            }
        }
    }
    if time {
        out.push_str(&format!("({:.1} ms)\n", t0.elapsed().as_secs_f64() * 1000.0));
    }
    (if ok { 0 } else { 1 }, out)
}

fn plural(n: u64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// 1234567 → "1,234,567".
fn group(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

struct Group {
    hits: Vec<SearchHit>,
    more: usize,
    more_unknown: bool,
    partial: bool,
}

/// Strict pass (every word in the name), then — only if that left room — a relaxed pass where
/// one word must be in the name and the rest may be anywhere in the path.
fn find(text: &str, opts: &SearchOptions) -> Group {
    let wait = Duration::from_secs(30);
    let q = query::parse(text);
    let r = index::search_parsed(0.0, &q, opts, wait);
    let mut g = Group { more: r.total.saturating_sub(r.hits.len()), hits: r.hits, more_unknown: false, partial: r.partial };
    if g.hits.len() >= opts.limit || q.terms.len() < 2 {
        return g;
    }
    let n = q.terms.len().min(6);
    let extra: Vec<(Vec<SearchHit>, usize, bool)> = (0..n)
        .into_par_iter()
        .map(|i| {
            let mut q2 = q.clone();
            q2.terms = vec![q.terms[i].clone()];
            q2.path_terms.extend(q.terms.iter().enumerate().filter(|&(j, _)| j != i).map(|(_, t)| t.clone()));
            let r = index::search_parsed(0.0, &q2, opts, wait);
            (r.hits, r.total, r.partial)
        })
        .collect();
    let mut seen: HashSet<String> = g.hits.iter().map(|h| h.path.to_lowercase()).collect();
    let mut pool: Vec<SearchHit> = Vec::new();
    let mut overflow = false;
    for (hits, total, partial) in extra {
        g.partial |= partial;
        overflow |= total > hits.len();
        for h in hits {
            if seen.insert(h.path.to_lowercase()) {
                pool.push(h);
            }
        }
    }
    pool.sort_by(|a, b| b.score.total_cmp(&a.score));
    let room = opts.limit - g.hits.len();
    overflow |= pool.len() > room;
    g.hits.extend(pool.into_iter().take(room));
    g.more_unknown = overflow;
    g
}

fn display_path(p: &str, rel: Option<&str>) -> String {
    if let Some(base) = rel.filter(|b| !b.is_empty()) {
        let base = base.trim_end_matches('\\');
        let n = base.len();
        if p.len() > n + 1
            && p.is_char_boundary(n)
            && p[..n].eq_ignore_ascii_case(base)
            && p.as_bytes()[n] == b'\\'
        {
            return p[n + 1..].to_string();
        }
    }
    p.to_string()
}

fn fmt_size(b: u64) -> String {
    const U: [&str; 5] = ["B", "K", "M", "G", "T"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{b}B")
    } else if v < 10.0 {
        format!("{v:.1}{}", U[i])
    } else {
        format!("{v:.0}{}", U[i])
    }
}

/// UTC date (YYYY-MM-DD) from ms since the Unix epoch.
fn fmt_date(ms: i64) -> String {
    if ms <= 0 {
        return "----------".into();
    }
    let days = ms.div_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

fn status_line() -> String {
    let s = index::status();
    format!(
        "{} · {} entries · source {} · roots {} · served by {}\n",
        s.state,
        s.entries,
        s.source,
        s.roots.join(" "),
        if IS_DAEMON.load(Ordering::Relaxed) { "background daemon" } else { "MyExplorer window" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(resolve_path(r"C:\a\b", "c"), r"C:\a\b\c");
        assert_eq!(resolve_path(r"C:\a\b", ".."), r"C:\a");
        assert_eq!(resolve_path(r"C:\a\b", "."), r"C:\a\b");
        assert_eq!(resolve_path(r"C:\a", "D:/x/y"), r"D:\x\y");
        assert_eq!(resolve_path(r"C:\a", r"..\.."), r"C:\");
        assert_eq!(display_path(r"C:\a\b\c.txt", Some(r"c:\A")), r"b\c.txt");
        assert_eq!(display_path(r"C:\ab\c.txt", Some(r"C:\a")), r"C:\ab\c.txt");
        assert_eq!(display_path(r"C:\x.txt", Some(r"C:\")), r"x.txt");
    }

    #[test]
    fn grouping() {
        assert_eq!(group(0), "0");
        assert_eq!(group(999), "999");
        assert_eq!(group(1000), "1,000");
        assert_eq!(group(1234567), "1,234,567");
    }

    #[test]
    fn formats() {
        assert_eq!(fmt_date(0), "----------");
        assert_eq!(fmt_date(1_700_000_000_000), "2023-11-14");
        assert_eq!(fmt_size(512), "512B");
        assert_eq!(fmt_size(1536), "1.5K");
        assert_eq!(fmt_size(50 * 1024 * 1024), "50M");
    }

    #[test]
    fn args() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let r = parse_args(r"C:\w", &a(&["-n", "5", "-i", "src", "foo bar", "-l", "baz"])).unwrap();
        assert_eq!(r.limit, 5);
        assert_eq!(r.scope.as_deref(), Some(r"C:\w\src"));
        assert_eq!(r.queries, vec!["foo bar", "baz"]);
        assert!(r.long);
        assert!(parse_args("", &a(&["-x"])).is_err());
        assert_eq!(parse_args("", &a(&["-n50", "--", "-x"])).unwrap().queries, vec!["-x"]);
    }
}
