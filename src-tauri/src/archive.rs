//! Compress to .zip / extract archives.
//! .zip is handled in-process (fast, Unicode-safe, progress + cancel). Everything else
//! (7z, rar, tar, gz, xz, bz2, zst, cab, iso) goes through Windows' built-in tar.exe (libarchive).

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime};

use parking_lot::Mutex;
use serde::Serialize;
use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
use windows::Win32::Storage::FileSystem::{FileTimeToLocalFileTime, LocalFileTimeToFileTime};
use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToFileTime};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

use crate::error::{AppError, AppResult};
use crate::shellops::unique_path;
use crate::util::*;

static CANCELLED: LazyLock<Mutex<HashSet<u32>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

pub fn cancel(id: u32) {
    CANCELLED.lock().insert(id);
}
fn is_cancelled(id: u32) -> bool {
    CANCELLED.lock().contains(&id)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: u32,
    done: u64,
    total: u64,
}

struct Reporter {
    id: u32,
    total: u64,
    done: u64,
    last: Instant,
}
impl Reporter {
    fn new(id: u32, total: u64) -> Self {
        Self { id, total, done: 0, last: Instant::now() }
    }
    fn add(&mut self, n: u64) -> AppResult<()> {
        self.done += n;
        if self.last.elapsed() >= Duration::from_millis(80) {
            self.last = Instant::now();
            emit("archive:progress", Progress { id: self.id, done: self.done, total: self.total });
            if is_cancelled(self.id) {
                return Err(AppError::cancelled());
            }
        }
        Ok(())
    }
}

/// Already-compressed formats: storing them is far faster and the archive is no bigger.
const STORED: &[&str] = &[
    "zip", "7z", "rar", "gz", "tgz", "xz", "bz2", "zst", "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "mp4", "mkv",
    "mov", "webm", "avi", "m4v", "mp3", "m4a", "aac", "ogg", "opus", "flac", "docx", "xlsx", "pptx", "jar", "apk", "msi",
    "cab", "woff", "woff2",
];

fn local_dt(t: SystemTime) -> Option<DateTime> {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    let v = d.as_nanos() as u64 / 100 + EPOCH_DIFF_100NS;
    let ft = FILETIME { dwLowDateTime: v as u32, dwHighDateTime: (v >> 32) as u32 };
    let (mut lft, mut st) = (FILETIME::default(), SYSTEMTIME::default());
    // SAFETY: plain conversions on stack values.
    unsafe {
        FileTimeToLocalFileTime(&ft, &mut lft).ok()?;
        FileTimeToSystemTime(&lft, &mut st).ok()?;
    }
    DateTime::from_date_and_time(st.wYear.clamp(1980, 2107), st.wMonth as u8, st.wDay as u8, st.wHour as u8, st.wMinute as u8, st.wSecond as u8).ok()
}

fn system_time(dt: DateTime) -> Option<SystemTime> {
    let st = SYSTEMTIME {
        wYear: dt.year(),
        wMonth: dt.month() as u16,
        wDay: dt.day() as u16,
        wHour: dt.hour() as u16,
        wMinute: dt.minute() as u16,
        wSecond: dt.second() as u16,
        ..Default::default()
    };
    let (mut lft, mut ft) = (FILETIME::default(), FILETIME::default());
    // SAFETY: plain conversions on stack values.
    unsafe {
        SystemTimeToFileTime(&st, &mut lft).ok()?;
        LocalFileTimeToFileTime(&lft, &mut ft).ok()?;
    }
    let v = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    let since = v.checked_sub(EPOCH_DIFF_100NS)?;
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_nanos(since.saturating_mul(100)))
}

fn stem(name: &str, dir: bool) -> &str {
    if dir {
        return name;
    }
    let lower = name.to_ascii_lowercase();
    for multi in [".tar.gz", ".tar.xz", ".tar.bz2", ".tar.zst"] {
        if lower.ends_with(multi) && name.len() > multi.len() {
            return &name[..name.len() - multi.len()];
        }
    }
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

// ── compress ────────────────────────────────────────────────────────────────

struct Entry {
    abs: String,
    rel: String,
    dir: bool,
    size: u64,
    modified: Option<SystemTime>,
}

fn collect(paths: &[String]) -> AppResult<Vec<Entry>> {
    let mut out = Vec::new();
    for top in paths {
        let base = parent_of(top).unwrap_or("").to_string();
        let rel_of = |p: &str| p[base.len()..].trim_start_matches('\\').replace('\\', "/");
        let meta = std::fs::metadata(long_path(top)).map_err(|e| AppError::from(e).ctx(top))?;
        if !meta.is_dir() {
            out.push(Entry { abs: top.clone(), rel: rel_of(top), dir: false, size: meta.len(), modified: meta.modified().ok() });
            continue;
        }
        let walk = ignore::WalkBuilder::new(top).standard_filters(false).hidden(false).follow_links(false).build();
        for e in walk {
            let Ok(e) = e else { continue };
            let p = e.path().to_string_lossy().into_owned();
            let Ok(m) = e.metadata() else { continue };
            let dir = m.is_dir();
            if !dir && !m.is_file() {
                continue;
            }
            out.push(Entry { rel: rel_of(&p), abs: p, dir, size: if dir { 0 } else { m.len() }, modified: m.modified().ok() });
        }
    }
    Ok(out)
}

pub fn compress(id: u32, paths: Vec<String>) -> AppResult<String> {
    let paths: Vec<String> = paths.iter().map(|p| norm_path(p)).collect();
    let first = paths.first().ok_or_else(|| AppError::io("Nothing to compress"))?;
    let parent = parent_of(first).ok_or_else(|| AppError::unsupported("Drives can't be compressed"))?.to_string();
    let first_dir = std::fs::metadata(long_path(first)).map(|m| m.is_dir()).unwrap_or(false);
    let name = format!("{}.zip", stem(file_name(first), first_dir));
    let out = unique_path(&parent, &name, false);
    let r = (|| -> AppResult<()> {
        let entries = collect(&paths)?;
        let total: u64 = entries.iter().map(|e| e.size).sum();
        let mut rep = Reporter::new(id, total);
        let f = File::create(long_path(&out)).map_err(|e| AppError::from(e).ctx(&out))?;
        let mut zw = ZipWriter::new(BufWriter::with_capacity(1 << 20, f));
        let mut buf = vec![0u8; 1 << 18];
        for e in &entries {
            let mut opt = SimpleFileOptions::default().large_file(e.size >= 0xFFFF_0000);
            if let Some(dt) = e.modified.and_then(local_dt) {
                opt = opt.last_modified_time(dt);
            }
            if e.dir {
                zw.add_directory(format!("{}/", e.rel), opt).map_err(zip_err)?;
                continue;
            }
            let ext = e.rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            let method = if STORED.contains(&ext.as_str()) || e.size < 64 { CompressionMethod::Stored } else { CompressionMethod::Deflated };
            zw.start_file(e.rel.as_str(), opt.compression_method(method)).map_err(zip_err)?;
            let mut src = File::open(long_path(&e.abs)).map_err(|er| AppError::from(er).ctx(&e.abs))?;
            loop {
                let n = src.read(&mut buf).map_err(|er| AppError::from(er).ctx(&e.abs))?;
                if n == 0 {
                    break;
                }
                zw.write_all(&buf[..n]).map_err(|er| AppError::from(er).ctx(&out))?;
                rep.add(n as u64)?;
            }
        }
        zw.finish().map_err(zip_err)?.flush().map_err(AppError::from)?;
        Ok(())
    })();
    CANCELLED.lock().remove(&id);
    if let Err(e) = r {
        let _ = std::fs::remove_file(long_path(&out));
        return Err(e);
    }
    Ok(out)
}

fn zip_err(e: zip::result::ZipError) -> AppError {
    match e {
        zip::result::ZipError::Io(io) => AppError::from(io),
        other => AppError::io(other.to_string()),
    }
}

// ── extract ─────────────────────────────────────────────────────────────────


fn extract_zip(id: u32, archive: &str, into: &str) -> AppResult<()> {
    let f = File::open(long_path(archive)).map_err(|e| AppError::from(e).ctx(archive))?;
    let mut za = ZipArchive::new(BufReader::with_capacity(1 << 20, f)).map_err(zip_err)?;
    let mut total = 0u64;
    for i in 0..za.len() {
        if let Ok(f) = za.by_index_raw(i) {
            total += f.size();
        }
    }
    let mut rep = Reporter::new(id, total);
    let mut buf = vec![0u8; 1 << 18];
    let mut times: Vec<(String, SystemTime)> = Vec::new();
    for i in 0..za.len() {
        let mut f = za.by_index(i).map_err(|e| match e {
            zip::result::ZipError::UnsupportedArchive(m) if m.contains("assword") => AppError::unsupported("Password-protected archives aren't supported yet"),
            other => zip_err(other),
        })?;
        // enclosed_name rejects absolute paths and `..` (zip-slip).
        let Some(rel) = f.enclosed_name() else { continue };
        let dest = Path::new(into).join(&rel).to_string_lossy().into_owned();
        if f.is_dir() {
            std::fs::create_dir_all(long_path(&dest)).map_err(|e| AppError::from(e).ctx(&dest))?;
            continue;
        }
        if let Some(p) = parent_of(&dest) {
            std::fs::create_dir_all(long_path(p)).map_err(|e| AppError::from(e).ctx(p))?;
        }
        let mut out = BufWriter::with_capacity(1 << 18, File::create(long_path(&dest)).map_err(|e| AppError::from(e).ctx(&dest))?);
        loop {
            let n = f.read(&mut buf).map_err(|e| AppError::from(e).ctx(archive))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| AppError::from(e).ctx(&dest))?;
            rep.add(n as u64)?;
        }
        out.flush().map_err(AppError::from)?;
        if let Some(t) = f.last_modified().and_then(system_time) {
            times.push((dest, t));
        }
    }
    for (p, t) in times {
        if let Ok(f) = File::options().write(true).open(long_path(&p)) {
            let _ = f.set_modified(t);
        }
    }
    Ok(())
}

fn extract_tar(id: u32, archive: &str, into: &str) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let tar = format!(r"{root}\System32\tar.exe");
    if !Path::new(&tar).exists() {
        return Err(AppError::unsupported("This Windows version has no built-in archive tool (tar.exe)"));
    }
    let mut child = std::process::Command::new(tar)
        .args(["-xf", archive, "-C", into])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(AppError::from)?;
    loop {
        if let Some(st) = child.try_wait().map_err(AppError::from)? {
            if st.success() {
                return Ok(());
            }
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            let msg = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().trim_start_matches("tar.exe: ").to_string();
            return Err(if msg.contains("Unrecognized archive format") || msg.contains("not supported") {
                AppError::unsupported("Windows can't open this archive format on this PC")
            } else {
                AppError::io(if msg.is_empty() { "Extraction failed".into() } else { msg })
            });
        }
        if is_cancelled(id) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::cancelled());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// Smart extract next to the archive: a single top-level item lands directly beside it,
/// several items go into a folder named after the archive. Returns the created path.
pub fn extract(id: u32, archive: String) -> AppResult<String> {
    let archive = norm_path(&archive);
    let parent = parent_of(&archive).ok_or_else(|| AppError::io("Invalid archive path"))?.to_string();
    let name = file_name(&archive).to_string();
    let tmp = unique_path(&parent, &format!(".{}.extracting", stem(&name, false)), true);
    std::fs::create_dir_all(long_path(&tmp)).map_err(|e| AppError::from(e).ctx(&tmp))?;
    let is_zip = name.to_ascii_lowercase().ends_with(".zip");
    let r = if is_zip { extract_zip(id, &archive, &tmp) } else { extract_tar(id, &archive, &tmp) };
    CANCELLED.lock().remove(&id);
    if let Err(e) = r {
        let _ = std::fs::remove_dir_all(long_path(&tmp));
        return Err(e);
    }
    let children: Vec<_> = std::fs::read_dir(long_path(&tmp)).map_err(AppError::from)?.flatten().collect();
    let result = if children.len() == 1 {
        let c = &children[0];
        let cname = c.file_name().to_string_lossy().into_owned();
        let dir = c.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let dest = unique_path(&parent, &cname, dir);
        std::fs::rename(c.path(), long_path(&dest)).map_err(|e| AppError::from(e).ctx(&dest))?;
        let _ = std::fs::remove_dir(long_path(&tmp));
        dest
    } else {
        let dest = unique_path(&parent, stem(&name, false), true);
        std::fs::rename(long_path(&tmp), long_path(&dest)).map_err(|e| AppError::from(e).ctx(&dest))?;
        dest
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_roundtrip_and_smart_extract() {
        let base = std::env::temp_dir().join(format!("mx-arch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("Proj ünï");
        std::fs::create_dir_all(src.join("sub").join("empty")).unwrap();
        std::fs::write(src.join("a.txt"), "hello ".repeat(1000)).unwrap();
        std::fs::write(src.join("sub").join("b.png"), [1u8, 2, 3]).unwrap();
        let zip = compress(1, vec![src.to_string_lossy().into_owned()]).unwrap();
        assert!(zip.ends_with("Proj ünï.zip"), "{zip}");
        std::fs::remove_dir_all(&src).unwrap();
        // Single top-level folder → lands directly beside the archive.
        let out = extract(2, zip.clone()).unwrap();
        assert!(out.ends_with("Proj ünï"), "{out}");
        assert_eq!(std::fs::read_to_string(src.join("a.txt")).unwrap(), "hello ".repeat(1000));
        assert_eq!(std::fs::read(src.join("sub").join("b.png")).unwrap(), vec![1, 2, 3]);
        assert!(src.join("sub").join("empty").is_dir());
        let m = std::fs::metadata(src.join("a.txt")).unwrap().modified().unwrap();
        assert!(SystemTime::now().duration_since(m).unwrap() < Duration::from_secs(120), "mtime preserved");
        // Extracting again doesn't clobber: gets a unique name.
        let again = extract(3, zip).unwrap();
        assert!(again.ends_with("Proj ünï (2)"), "{again}");
        let _ = std::fs::remove_dir_all(&base);
    }
}
