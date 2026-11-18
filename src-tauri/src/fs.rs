//! Read-only filesystem operations.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::LazyLock;

use parking_lot::Mutex;
use rayon::prelude::*;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
    GetDiskFreeSpaceExW, GetDriveTypeW, GetFileAttributesExW, GetFinalPathNameByHandleW, GetLogicalDrives,
    GetVolumeInformationW, GetFileExInfoStandard, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_NAME_NORMALIZED, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FIND_FIRST_EX_LARGE_FETCH,
    OPEN_EXISTING, WIN32_FILE_ATTRIBUTE_DATA, WIN32_FIND_DATAW,
};
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_Profile, FOLDERID_SkyDrive, FOLDERID_Videos, SHGetFileInfoW, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
    SHFILEINFOW, SHGFI_TYPENAME, SHGFI_USEFILEATTRIBUTES,
};
use windows_core::PCWSTR;

use crate::error::{AppError, AppResult};
use crate::types::*;
use crate::util::*;

/// Raw directory entry from FindFirstFileExW.
pub struct RawEntry<'a> {
    pub name: &'a [u16],
    pub attrs: u32,
    pub size: u64,
    pub modified: i64,
    pub created: i64,
    pub tag: u32,
}

/// Enumerate a directory with one FindFirstFileExW pass. Skips "." and "..".
pub fn for_each_entry(dir: &str, mut f: impl FnMut(&RawEntry)) -> AppResult<()> {
    let pattern = wide(&long_path(&join(dir, "*")));
    let mut data = WIN32_FIND_DATAW::default();
    // SAFETY: pattern is null-terminated and data is a valid out buffer.
    let h = unsafe {
        FindFirstFileExW(
            PCWSTR(pattern.as_ptr()),
            FindExInfoBasic,
            &mut data as *mut _ as *mut _,
            FindExSearchNameMatch,
            None,
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };
    let h = match h {
        Ok(h) => h,
        Err(e) => {
            let code = win32_code(&e);
            // Empty drive root: no entries at all.
            if code == 2 && attributes(dir).is_some_and(|a| a & FA_DIRECTORY != 0) {
                return Ok(());
            }
            return Err(AppError::from_win32(if code == 0 { 5 } else { code }, dir));
        }
    };
    loop {
        let n = data.cFileName.iter().position(|&c| c == 0).unwrap_or(260);
        let name = &data.cFileName[..n];
        let dots = (n == 1 && name[0] == 46) || (n == 2 && name[0] == 46 && name[1] == 46);
        if !dots && n > 0 {
            let attrs = data.dwFileAttributes;
            f(&RawEntry {
                name,
                attrs,
                size: if attrs & FA_DIRECTORY != 0 {
                    0
                } else {
                    ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64
                },
                modified: ft_to_ms(data.ftLastWriteTime.dwLowDateTime, data.ftLastWriteTime.dwHighDateTime),
                created: ft_to_ms(data.ftCreationTime.dwLowDateTime, data.ftCreationTime.dwHighDateTime),
                tag: if attrs & FA_REPARSE != 0 { data.dwReserved0 } else { 0 },
            });
        }
        // SAFETY: h is a valid find handle.
        if unsafe { FindNextFileW(h, &mut data) }.is_err() {
            break;
        }
    }
    // SAFETY: h is a valid find handle.
    unsafe {
        let _ = FindClose(h);
    }
    Ok(())
}

pub fn attributes(path: &str) -> Option<u32> {
    attr_data(path).map(|d| d.dwFileAttributes)
}

pub fn attr_data(path: &str) -> Option<WIN32_FILE_ATTRIBUTE_DATA> {
    let w = wide(&long_path(path));
    let mut d = WIN32_FILE_ATTRIBUTE_DATA::default();
    // SAFETY: w is null-terminated; d is a valid out buffer of the right type.
    unsafe { GetFileAttributesExW(PCWSTR(w.as_ptr()), GetFileExInfoStandard, &mut d as *mut _ as *mut _) }
        .ok()
        .map(|_| d)
}

// ── natural sort ────────────────────────────────────────────────────────────

/// Natural, case-insensitive compare of already-lowercased strings (digit runs compare numerically).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0usize, 0usize);
    while i < x.len() && j < y.len() {
        let (ca, cb) = (x[i], y[j]);
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let (si, sj) = (i, j);
            while i < x.len() && x[i] == b'0' {
                i += 1;
            }
            while j < y.len() && y[j] == b'0' {
                j += 1;
            }
            let (ni, nj) = (i, j);
            while i < x.len() && x[i].is_ascii_digit() {
                i += 1;
            }
            while j < y.len() && y[j].is_ascii_digit() {
                j += 1;
            }
            let c = (i - ni).cmp(&(j - nj)).then_with(|| x[ni..i].cmp(&y[nj..j]));
            if c != Ordering::Equal {
                return c;
            }
            let z = (ni - si).cmp(&(nj - sj));
            if z != Ordering::Equal {
                return z.reverse();
            }
        } else {
            if ca != cb {
                return ca.cmp(&cb);
            }
            i += 1;
            j += 1;
        }
    }
    (x.len() - i).cmp(&(y.len() - j))
}

// ── list_dir ────────────────────────────────────────────────────────────────

struct Rec {
    name: String,
    lower: String,
    size: u64,
    modified: i64,
    created: i64,
    flags: u8,
}

pub fn list_dir(path: &str, sort: &Sort, show_hidden: bool) -> AppResult<DirListing> {
    let path = norm_path(path);
    let mut recs: Vec<Rec> = Vec::with_capacity(256);
    for_each_entry(&path, |e| {
        if !show_hidden && e.attrs & FA_HIDDEN != 0 {
            return;
        }
        let name = String::from_utf16_lossy(e.name);
        let lower = name.to_lowercase();
        recs.push(Rec {
            name,
            lower,
            size: e.size,
            modified: e.modified,
            created: e.created,
            flags: attrs_to_flags(e.attrs, if e.attrs & FA_REPARSE != 0 { Some(e.tag) } else { None }),
        });
    })?;

    let key = sort.key;
    let desc = sort.desc;
    let ff = sort.folders_first;
    let cmp = |a: &Rec, b: &Rec| -> Ordering {
        if ff {
            let (da, db) = (a.flags & F_DIR != 0, b.flags & F_DIR != 0);
            if da != db {
                return db.cmp(&da);
            }
        }
        let by_name = || natural_cmp(&a.lower, &b.lower).then_with(|| a.name.cmp(&b.name));
        let o = match key {
            SortKey::Name => by_name(),
            SortKey::Modified => a.modified.cmp(&b.modified).then_with(by_name),
            SortKey::Created => a.created.cmp(&b.created).then_with(by_name),
            SortKey::Size => a.size.cmp(&b.size).then_with(by_name),
            SortKey::Type => {
                let ea = if a.flags & F_DIR != 0 { "" } else { ext_slice(&a.lower) };
                let eb = if b.flags & F_DIR != 0 { "" } else { ext_slice(&b.lower) };
                ((a.flags & F_DIR == 0).cmp(&(b.flags & F_DIR == 0)))
                    .then_with(|| ea.cmp(eb))
                    .then_with(by_name)
            }
        };
        if desc { o.reverse() } else { o }
    };
    if recs.len() > 4000 {
        recs.par_sort_unstable_by(cmp);
    } else {
        recs.sort_unstable_by(cmp);
    }

    let n = recs.len();
    let mut out = DirListing {
        path,
        names: Vec::with_capacity(n),
        sizes: Vec::with_capacity(n),
        modified: Vec::with_capacity(n),
        created: Vec::with_capacity(n),
        flags: Vec::with_capacity(n),
    };
    for r in recs {
        out.names.push(r.name);
        out.sizes.push(r.size);
        out.modified.push(r.modified);
        out.created.push(r.created);
        out.flags.push(r.flags);
    }
    Ok(out)
}

fn ext_slice(lower: &str) -> &str {
    match lower.rfind('.') {
        Some(i) if i > 0 => &lower[i + 1..],
        _ => "",
    }
}

pub fn list_subdirs(path: &str, show_hidden: bool) -> AppResult<Vec<String>> {
    let path = norm_path(path);
    let mut v: Vec<(String, String)> = Vec::new();
    for_each_entry(&path, |e| {
        if e.attrs & FA_DIRECTORY == 0 || (!show_hidden && e.attrs & FA_HIDDEN != 0) {
            return;
        }
        let n = String::from_utf16_lossy(e.name);
        v.push((n.to_lowercase(), n));
    })?;
    v.sort_unstable_by(|a, b| natural_cmp(&a.0, &b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(v.into_iter().map(|x| x.1).collect())
}

// ── drives / known folders ──────────────────────────────────────────────────

pub fn get_drives() -> Vec<Drive> {
    // SAFETY: no preconditions.
    let mask = unsafe { GetLogicalDrives() };
    let letters: Vec<char> = (0..26u8).filter(|i| mask & (1 << i) != 0).map(|i| (b'A' + i) as char).collect();
    letters
        .par_iter()
        .map(|c| {
            let root = format!("{c}:\\");
            let w = wide(&root);
            // SAFETY: w is a null-terminated root path; buffers are valid.
            unsafe {
                let kind = match GetDriveTypeW(PCWSTR(w.as_ptr())) {
                    2 => "removable",
                    3 => "fixed",
                    4 => "network",
                    5 => "optical",
                    _ => "other",
                };
                let mut label = [0u16; 261];
                let mut fsname = [0u16; 261];
                let (lbl, fs) = if GetVolumeInformationW(
                    PCWSTR(w.as_ptr()),
                    Some(&mut label),
                    None,
                    None,
                    None,
                    Some(&mut fsname),
                )
                .is_ok()
                {
                    (from_wide(&label), from_wide(&fsname))
                } else {
                    (String::new(), String::new())
                };
                let (mut free, mut total) = (0u64, 0u64);
                let _ = GetDiskFreeSpaceExW(PCWSTR(w.as_ptr()), Some(&mut free), Some(&mut total), None);
                Drive { path: root, label: lbl, fs, kind, total, free }
            }
        })
        .collect()
}

pub fn fixed_drives() -> Vec<String> {
    // SAFETY: no preconditions.
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| format!("{}:\\", (b'A' + i) as char))
        .filter(|r| {
            let w = wide(r);
            // SAFETY: null-terminated path.
            unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) == 3 }
        })
        .collect()
}

fn known(id: &windows_core::GUID) -> Option<String> {
    // SAFETY: id is a valid KNOWNFOLDERID; result freed by take_pwstr.
    unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None) }.ok().map(take_pwstr).filter(|s| !s.is_empty())
}

pub fn get_known_folders() -> KnownFolders {
    let home = known(&FOLDERID_Profile)
        .or_else(|| std::env::var("USERPROFILE").ok())
        .unwrap_or_else(|| "C:\\".into());
    let k = |id: &windows_core::GUID, sub: &str| known(id).unwrap_or_else(|| join(&home, sub));
    let onedrive = known(&FOLDERID_SkyDrive)
        .or_else(|| std::env::var("OneDrive").ok())
        .filter(|p| attributes(p).is_some());
    KnownFolders {
        desktop: k(&FOLDERID_Desktop, "Desktop"),
        documents: k(&FOLDERID_Documents, "Documents"),
        downloads: k(&FOLDERID_Downloads, "Downloads"),
        pictures: k(&FOLDERID_Pictures, "Pictures"),
        music: k(&FOLDERID_Music, "Music"),
        videos: k(&FOLDERID_Videos, "Videos"),
        home,
        onedrive,
    }
}

pub static HOME: LazyLock<String> = LazyLock::new(|| get_known_folders().home);

// ── stat / type names ───────────────────────────────────────────────────────

static TYPE_NAMES: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Shell type name for an extension ("" = no extension, ":dir" = folder). Must run with COM initialized.
pub fn type_name_for_ext(ext: &str) -> String {
    if let Some(s) = TYPE_NAMES.lock().get(ext) {
        return s.clone();
    }
    let (name, attrs) = match ext {
        ":dir" => ("folder".to_string(), FA_DIRECTORY),
        "" => ("file".to_string(), FA_NORMAL),
        e => (format!("file.{e}"), FA_NORMAL),
    };
    let w = wide(&name);
    let mut sfi = SHFILEINFOW::default();
    // SAFETY: w null-terminated; sfi valid out struct.
    let r = unsafe {
        SHGetFileInfoW(
            PCWSTR(w.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(attrs),
            Some(&mut sfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_TYPENAME | SHGFI_USEFILEATTRIBUTES,
        )
    };
    let mut s = if r != 0 { from_wide(&sfi.szTypeName) } else { String::new() };
    if s.is_empty() {
        s = match ext {
            ":dir" => "File folder".into(),
            "" => "File".into(),
            e => format!("{} File", e.to_uppercase()),
        };
    }
    TYPE_NAMES.lock().insert(ext.to_string(), s.clone());
    s
}

fn final_path(path: &str) -> Option<String> {
    let w = wide(&long_path(path));
    // SAFETY: opening with no access rights only to query the final path; handle closed below.
    unsafe {
        let h: HANDLE = CreateFileW(
            PCWSTR(w.as_ptr()),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
        .ok()?;
        let mut buf = vec![0u16; 1024];
        let n = GetFinalPathNameByHandleW(h, &mut buf, FILE_NAME_NORMALIZED) as usize;
        let _ = CloseHandle(h);
        if n == 0 || n >= buf.len() {
            return None;
        }
        let s = String::from_utf16_lossy(&buf[..n]);
        Some(if let Some(r) = s.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{r}")
        } else if let Some(r) = s.strip_prefix("\\\\?\\") {
            r.to_string()
        } else {
            s
        })
    }
}

fn lnk_target(path: &str) -> Option<String> {
    use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows_core::Interface;
    let w = wide(path);
    // SAFETY: COM is initialized on this (STA pool) thread; buffers valid.
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let pf: IPersistFile = link.cast().ok()?;
        pf.Load(PCWSTR(w.as_ptr()), STGM_READ).ok()?;
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let s = from_wide(&buf);
        if s.is_empty() { None } else { Some(s) }
    }
}

fn url_target(path: &str) -> Option<String> {
    let text = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&text[..text.len().min(16 * 1024)]).into_owned();
    text.lines()
        .find_map(|l| l.trim().strip_prefix("URL=").map(|u| u.trim().to_string()))
}

/// Must run with COM initialized (STA pool).
pub fn stat_one(path: &str) -> AppResult<FileInfo> {
    let path = norm_path(path);
    let d = attr_data(&path).ok_or_else(|| {
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(2) as u32;
        AppError::from_win32(code, &path)
    })?;
    let attrs = d.dwFileAttributes;
    let is_root = path.len() == 3 && path.ends_with(":\\");
    let mut tag = None;
    if attrs & FA_REPARSE != 0 && !is_root {
        let mut t = 0;
        // A single-entry find gives us the reparse tag.
        let pattern = wide(&long_path(&path));
        let mut data = WIN32_FIND_DATAW::default();
        // SAFETY: valid pattern and out buffer.
        if let Ok(h) = unsafe {
            FindFirstFileExW(
                PCWSTR(pattern.as_ptr()),
                FindExInfoBasic,
                &mut data as *mut _ as *mut _,
                FindExSearchNameMatch,
                None,
                Default::default(),
            )
        } {
            t = data.dwReserved0;
            // SAFETY: valid find handle.
            unsafe {
                let _ = FindClose(h);
            }
        }
        tag = Some(t);
    }
    let flags = attrs_to_flags(attrs, tag);
    let name = if is_root { path.clone() } else { file_name(&path).to_string() };
    let ext = if flags & F_DIR != 0 { ":dir".to_string() } else { ext_of(&name) };
    let type_name = if is_root { "Local Disk".to_string() } else { type_name_for_ext(&ext) };
    let target = if flags & F_LINK != 0 {
        final_path(&path)
    } else if flags & F_CLOUD == 0 && ext == "lnk" {
        lnk_target(&path)
    } else if flags & F_CLOUD == 0 && ext == "url" {
        url_target(&path)
    } else {
        None
    };
    Ok(FileInfo {
        name,
        flags,
        size: if attrs & FA_DIRECTORY != 0 { 0 } else { ((d.nFileSizeHigh as u64) << 32) | d.nFileSizeLow as u64 },
        modified: ft_to_ms(d.ftLastWriteTime.dwLowDateTime, d.ftLastWriteTime.dwHighDateTime),
        created: ft_to_ms(d.ftCreationTime.dwLowDateTime, d.ftCreationTime.dwHighDateTime),
        accessed: ft_to_ms(d.ftLastAccessTime.dwLowDateTime, d.ftLastAccessTime.dwHighDateTime),
        type_name,
        target,
        path,
    })
}

// ── read_text ───────────────────────────────────────────────────────────────

pub fn read_text(path: &str, max_bytes: usize) -> AppResult<String> {
    use std::io::Read;
    let path = norm_path(path);
    let attrs = attributes(&path).ok_or_else(|| AppError::not_found(format!("Not found: {path}")))?;
    if attrs & FA_DIRECTORY != 0 {
        return Err(AppError::unsupported("Folders have no text preview"));
    }
    if is_cloud_attrs(attrs) {
        return Err(AppError::unsupported("Online-only file: preview would download it"));
    }
    let max = max_bytes.clamp(1, 16 * 1024 * 1024);
    let f = std::fs::File::open(long_path(&path)).map_err(|e| AppError::from(e).ctx(&path))?;
    let mut buf = Vec::with_capacity(max.min(1 << 20));
    f.take(max as u64).read_to_end(&mut buf).map_err(|e| AppError::from(e).ctx(&path))?;

    // UTF-16 with BOM
    if buf.len() >= 2 && (buf[0] == 0xFF && buf[1] == 0xFE || buf[0] == 0xFE && buf[1] == 0xFF) {
        let le = buf[0] == 0xFF;
        let units: Vec<u16> = buf[2..]
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        return Ok(String::from_utf16_lossy(&units));
    }
    let start = if buf.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
    let probe = &buf[start..buf.len().min(start + 8192)];
    let ctrl = probe.iter().filter(|&&b| b < 9 || (b > 13 && b < 32 && b != 27)).count();
    if probe.contains(&0) || ctrl * 20 > probe.len().max(1) {
        return Err(AppError::unsupported("Binary file"));
    }
    let mut body = &buf[start..];
    // drop a trailing partial UTF-8 sequence
    if let Err(e) = std::str::from_utf8(body) {
        if e.error_len().is_none() {
            body = &body[..e.valid_up_to()];
        }
    }
    Ok(String::from_utf8_lossy(body).into_owned())
}
