//! Per-user Windows integration (HKCU only, no admin): default folder handler, Win+E,
//! "Open in MyExplorer" in File Explorer's menu. Plus a global-hotkey availability probe.
//! Mirrors scripts/shell-integration.mjs (same keys) so both stay interchangeable.

use serde::{Deserialize, Serialize};
use windows::Win32::System::Registry::{
    RegDeleteKeyValueW, RegDeleteTreeW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT};
use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
use windows_core::PCWSTR;

use crate::error::{AppError, AppResult};
use crate::util::wide;

const ROOT: &str = r"Software\Classes";
const VERB: &str = "MyExplorer";
const WIN_E: &str = r"Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow";
const CLASSES: [&str; 2] = ["Directory", "Drive"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    /// Double-clicking folders/drives anywhere in Windows opens MyExplorer.
    pub folders: bool,
    /// Win+E and "This PC" open MyExplorer.
    pub win_e: bool,
    /// "Open in MyExplorer" in File Explorer's right-click menu.
    pub context_entry: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    #[serde(flatten)]
    pub state: Integration,
    pub exe: String,
    /// Registered entries point at another copy of the app (e.g. an older install).
    pub stale: bool,
    pub dev_build: bool,
}

fn get(sub: &str, name: Option<&str>) -> Option<String> {
    let s = wide(sub);
    let n = name.map(wide);
    let np = n.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()));
    let mut buf = vec![0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    // SAFETY: buffers valid for the call; len in bytes.
    let r = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, PCWSTR(s.as_ptr()), np, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut len))
    };
    r.is_ok().then(|| crate::util::from_wide(&buf))
}

fn set(sub: &str, name: Option<&str>, value: &str) -> AppResult<()> {
    let s = wide(sub);
    let n = name.map(wide);
    let np = n.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()));
    let v = wide(value);
    // SAFETY: buffers valid for the call; size in bytes incl. terminator.
    let r = unsafe {
        RegSetKeyValueW(HKEY_CURRENT_USER, PCWSTR(s.as_ptr()), np, REG_SZ.0, Some(v.as_ptr() as *const _), (v.len() * 2) as u32)
    };
    r.ok().map_err(|e| AppError::io(format!("Registry write failed ({sub}): {}", e.message())))
}

fn del_tree(sub: &str) {
    let s = wide(sub);
    // SAFETY: plain registry call.
    let _ = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(s.as_ptr())) };
}

fn del_default(sub: &str) {
    let s = wide(sub);
    // SAFETY: plain registry call; null value name = the key's default value.
    let _ = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(s.as_ptr()), PCWSTR::null()) };
}

fn exe() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

fn exe_in(cmd: &str) -> Option<String> {
    let c = cmd.trim();
    let c = c.strip_prefix('"')?;
    Some(c[..c.find('"')?].to_string())
}

pub fn status() -> IntegrationStatus {
    let me = exe();
    let mut registered: Vec<String> = Vec::new();
    let verb_cmd = get(&format!(r"{ROOT}\Directory\shell\{VERB}\command"), None);
    if let Some(c) = &verb_cmd {
        registered.extend(exe_in(c));
    }
    let folders = get(&format!(r"{ROOT}\Directory\shell"), None).is_some_and(|v| v == VERB) && verb_cmd.is_some();
    let win_e_cmd = get(&format!(r"{WIN_E}\command"), None);
    if let Some(c) = &win_e_cmd {
        registered.extend(exe_in(c).or_else(|| Some(c.trim_matches('"').to_string())));
    }
    let stale = registered.iter().any(|r| !r.eq_ignore_ascii_case(&me));
    IntegrationStatus {
        state: Integration { folders, win_e: win_e_cmd.is_some(), context_entry: verb_cmd.is_some() },
        exe: me,
        stale,
        dev_build: cfg!(debug_assertions),
    }
}

pub fn apply(want: Integration) -> AppResult<IntegrationStatus> {
    let exe = exe();
    if exe.is_empty() {
        return Err(AppError::io("Can't find this app's location"));
    }
    let verb = want.folders || want.context_entry;
    for cls in CLASSES {
        let shell = format!(r"{ROOT}\{cls}\shell");
        let key = format!(r"{shell}\{VERB}");
        if verb {
            set(&key, None, "Open in MyExplorer")?;
            set(&key, Some("Icon"), &format!("\"{exe}\",0"))?;
            set(&format!(r"{key}\command"), None, &format!("\"{exe}\" \"%1\""))?;
        } else {
            del_tree(&key);
        }
        if want.folders {
            set(&shell, None, VERB)?;
        } else if get(&shell, None).is_some_and(|v| v == VERB) {
            del_default(&shell);
        }
    }
    if want.win_e {
        set(&format!(r"{WIN_E}\command"), None, &format!("\"{exe}\""))?;
        set(&format!(r"{WIN_E}\command"), Some("DelegateExecute"), "")?;
    } else {
        del_tree(WIN_E);
    }
    // SAFETY: broadcast that associations changed so Explorer picks it up immediately.
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    Ok(status())
}

/// False if another app holds this key combination as a global hotkey (we'd never receive it).
pub fn hotkey_free(mods: u32, vk: u32) -> bool {
    const ID: i32 = 0xB7E1;
    // SAFETY: registers on the calling thread and immediately releases it.
    unsafe {
        if RegisterHotKey(None, ID, HOT_KEY_MODIFIERS(mods) | MOD_NOREPEAT, vk).is_ok() {
            let _ = UnregisterHotKey(None, ID);
            true
        } else {
            false
        }
    }
}
