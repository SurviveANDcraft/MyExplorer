use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicIsize, Ordering};

use tauri::AppHandle;

pub static APP: OnceLock<AppHandle> = OnceLock::new();
static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);

pub fn set_main_hwnd(h: isize) {
    MAIN_HWND.store(h, Ordering::Relaxed);
}

pub fn main_hwnd() -> Option<windows::Win32::Foundation::HWND> {
    let h = MAIN_HWND.load(Ordering::Relaxed);
    if h == 0 { None } else { Some(windows::Win32::Foundation::HWND(h as *mut _)) }
}

pub fn emit<S: serde::Serialize + Clone>(event: &str, payload: S) {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

/// Null-terminated UTF-16.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn from_wide(buf: &[u16]) -> String {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n])
}

/// Take ownership of a COM-allocated PWSTR.
pub fn take_pwstr(p: windows_core::PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: p is a valid, null-terminated, CoTaskMem-allocated string.
    unsafe {
        let s = p.to_string().unwrap_or_default();
        windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

pub const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;

pub fn ft_to_ms(lo: u32, hi: u32) -> i64 {
    let t = ((hi as u64) << 32) | lo as u64;
    if t <= EPOCH_DIFF_100NS { 0 } else { ((t - EPOCH_DIFF_100NS) / 10_000) as i64 }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Milliseconds at local midnight today.
pub fn today_start_ms() -> i64 {
    // SAFETY: GetLocalTime has no preconditions.
    let st = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    let since = (st.wHour as i64 * 3600 + st.wMinute as i64 * 60 + st.wSecond as i64) * 1000
        + st.wMilliseconds as i64;
    now_ms() - since
}

pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    // Dev builds keep separate data so they can run beside the installed app.
    let d = base.join(if cfg!(debug_assertions) { "MyExplorer Dev" } else { "MyExplorer" });
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Normalize: forward slashes to backslashes, no trailing slash except drive roots ("C:\").
pub fn norm_path(p: &str) -> String {
    let mut s: String = p.trim().replace('/', "\\");
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    if s.len() == 2 && s.as_bytes()[1] == b':' {
        s.push('\\');
    }
    if s.len() == 3 && s.as_bytes()[1] == b':' {
        let mut c = s.into_bytes();
        c[0] = c[0].to_ascii_uppercase();
        s = String::from_utf8(c).unwrap_or_default();
    }
    s
}

/// Prefix with \\?\ for long paths.
pub fn long_path(p: &str) -> String {
    if p.len() >= 240 && !p.starts_with("\\\\") {
        format!("\\\\?\\{p}")
    } else {
        p.to_string()
    }
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('\\') { format!("{dir}{name}") } else { format!("{dir}\\{name}") }
}

pub fn parent_of(p: &str) -> Option<&str> {
    let p = p.trim_end_matches('\\');
    let i = p.rfind('\\')?;
    if i == 2 && p.as_bytes().get(1) == Some(&b':') {
        Some(&p[..3])
    } else if i == 0 {
        None
    } else {
        Some(&p[..i])
    }
}

pub fn file_name(p: &str) -> &str {
    let t = p.trim_end_matches('\\');
    match t.rfind('\\') {
        Some(i) => &t[i + 1..],
        None => t,
    }
}

/// Lowercase extension without dot ("" if none). Names starting with '.' and no other dot have no extension.
pub fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = |c: u8| (c as char).to_digit(16);
            if let (Some(a), Some(c)) = (h(b[i + 1]), h(b[i + 2])) {
                out.push((a * 16 + c) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn query_params(uri: &str) -> Vec<(String, String)> {
    let q = match uri.find('?') {
        Some(i) => &uri[i + 1..],
        None => return Vec::new(),
    };
    let q = q.split('#').next().unwrap_or("");
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| match kv.find('=') {
            Some(i) => (percent_decode(&kv[..i]), percent_decode(&kv[i + 1..])),
            None => (percent_decode(kv), String::new()),
        })
        .collect()
}

pub const FA_READONLY: u32 = 0x1;
pub const FA_HIDDEN: u32 = 0x2;
pub const FA_SYSTEM: u32 = 0x4;
pub const FA_DIRECTORY: u32 = 0x10;
pub const FA_NORMAL: u32 = 0x80;
pub const FA_REPARSE: u32 = 0x400;
pub const FA_OFFLINE: u32 = 0x1000;
pub const FA_RECALL_ON_OPEN: u32 = 0x40000;
pub const FA_RECALL_ON_DATA_ACCESS: u32 = 0x400000;

pub const F_DIR: u8 = 1;
pub const F_HIDDEN: u8 = 2;
pub const F_SYSTEM: u8 = 4;
pub const F_READONLY: u8 = 8;
pub const F_LINK: u8 = 16;
pub const F_CLOUD: u8 = 32;

pub fn is_cloud_attrs(attrs: u32) -> bool {
    attrs & FA_DIRECTORY == 0 && attrs & (FA_OFFLINE | FA_RECALL_ON_DATA_ACCESS | FA_RECALL_ON_OPEN) != 0
}

/// Contract flags from attributes and (if reparse) the reparse tag (`None` = unknown).
pub fn attrs_to_flags(attrs: u32, tag: Option<u32>) -> u8 {
    let mut f = 0u8;
    if attrs & FA_DIRECTORY != 0 {
        f |= F_DIR;
    }
    if attrs & FA_HIDDEN != 0 {
        f |= F_HIDDEN;
    }
    if attrs & FA_SYSTEM != 0 {
        f |= F_SYSTEM;
    }
    if attrs & FA_READONLY != 0 {
        f |= F_READONLY;
    }
    if is_cloud_attrs(attrs) {
        f |= F_CLOUD;
    }
    if attrs & FA_REPARSE != 0 {
        let link = match tag {
            Some(t) => matches!(t, 0xA000_000C | 0xA000_0003 | 0x8000_001B | 0xA000_001D),
            None => f & F_CLOUD == 0 && attrs & FA_RECALL_ON_OPEN == 0,
        };
        if link {
            f |= F_LINK;
        }
    }
    f
}

/// Win32 error code from a windows_core::Error (0 if not a Win32 HRESULT).
pub fn win32_code(e: &windows_core::Error) -> u32 {
    let u = e.code().0 as u32;
    if u & 0xFFFF_0000 == 0x8007_0000 { u & 0xFFFF } else { 0 }
}
