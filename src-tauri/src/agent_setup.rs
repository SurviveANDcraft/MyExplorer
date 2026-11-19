//! Settings → AI agents: install the `mx` skill into coding agents, put `mx` on the user
//! PATH, and produce a paste-able prompt for any other agent. Per-user, no admin.

use serde::Serialize;
use std::path::PathBuf;
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Registry::{
    RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_EXPAND_SZ, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
};
use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
use windows_core::PCWSTR;

use crate::error::{AppError, AppResult};
use crate::util::wide;

const SKILL: &str = include_str!("../../mx/SKILL.md");
/// Placeholder in SKILL.md replaced by this install's real mx.exe path.
const PATH_PLACEHOLDER: &str = r"%LOCALAPPDATA%\MyExplorer\mx.exe";

struct Agent {
    id: &'static str,
    name: &'static str,
    /// Folder under the user profile whose presence means the agent is installed.
    root: &'static str,
}
const AGENTS: &[Agent] = &[
    Agent { id: "claude", name: "Claude Code", root: ".claude" },
    Agent { id: "codex", name: "Codex", root: ".codex" },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub id: &'static str,
    pub name: &'static str,
    /// The agent's config folder exists on this PC.
    pub detected: bool,
    pub installed: bool,
    /// Installed skill matches this version of MyExplorer.
    pub current: bool,
    pub skill_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsStatus {
    /// Bundled mx.exe (None if missing, e.g. a dev build without the staged binary).
    pub mx_path: Option<String>,
    pub on_path: bool,
    pub agents: Vec<AgentState>,
    pub dev_build: bool,
}

pub fn mx_path() -> Option<PathBuf> {
    let p = std::env::current_exe().ok()?.parent()?.join("mx.exe");
    p.is_file().then_some(p)
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(&*crate::fs::HOME))
}

fn skill_file(a: &Agent) -> PathBuf {
    home().join(a.root).join("skills").join("mx").join("SKILL.md")
}

fn rendered_skill(mx: &str) -> String {
    SKILL.replace(PATH_PLACEHOLDER, mx).replace("\r\n", "\n")
}

fn is_ours(text: &str) -> bool {
    text.trim_start().starts_with("---") && text.lines().take(4).any(|l| l.trim() == "name: mx")
}

pub fn status() -> AgentsStatus {
    let mx = mx_path().map(|p| p.to_string_lossy().into_owned());
    let want = mx.as_deref().map(rendered_skill);
    let agents = AGENTS
        .iter()
        .map(|a| {
            let f = skill_file(a);
            let text = std::fs::read_to_string(&f).ok();
            AgentState {
                id: a.id,
                name: a.name,
                detected: home().join(a.root).is_dir(),
                installed: text.as_deref().is_some_and(is_ours),
                current: text.is_some() && text == want,
                skill_path: f.to_string_lossy().into_owned(),
            }
        })
        .collect();
    AgentsStatus {
        on_path: mx_path().and_then(|p| p.parent().map(|d| path_has(&user_path(), &d.to_string_lossy()))).unwrap_or(false),
        mx_path: mx,
        agents,
        dev_build: cfg!(debug_assertions),
    }
}

/// `id`: an agent id, or "path" for the user PATH entry.
pub fn set(id: &str, on: bool) -> AppResult<AgentsStatus> {
    let mx = mx_path().ok_or_else(|| AppError::io("mx.exe is missing next to MyExplorer. Reinstall MyExplorer."))?;
    let dir = mx.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    if id == "path" {
        set_on_path(&dir, on)?;
        return Ok(status());
    }
    let a = AGENTS.iter().find(|a| a.id == id).ok_or_else(|| AppError::io(format!("Unknown agent: {id}")))?;
    let f = skill_file(a);
    if on {
        let parent = f.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|e| AppError::io(format!("Can't create {}: {e}", parent.display())))?;
        std::fs::write(&f, rendered_skill(&mx.to_string_lossy()))
            .map_err(|e| AppError::io(format!("Can't write {}: {e}", f.display())))?;
        // Agents run shell commands: make plain `mx` work in new terminals too.
        set_on_path(&dir, true)?;
    } else {
        remove_skill(&f);
    }
    Ok(status())
}

fn remove_skill(f: &std::path::Path) {
    if std::fs::read_to_string(f).is_ok_and(|t| is_ours(&t)) {
        let _ = std::fs::remove_file(f);
        if let Some(d) = f.parent() {
            let _ = std::fs::remove_dir(d); // only if empty
        }
    }
}

/// Text to paste into any agent's instructions (AGENTS.md, Cursor rules, custom instructions).
pub fn prompt() -> String {
    let mx = mx_path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| PATH_PLACEHOLDER.into());
    let s = rendered_skill(&mx);
    // Drop the YAML front matter; keep its description as the opening line.
    let (desc, body) = match s.strip_prefix("---\n").and_then(|r| r.split_once("\n---\n")) {
        Some((fm, body)) => (
            fm.lines().find_map(|l| l.strip_prefix("description: ")).unwrap_or("").to_string(),
            body.trim_start().to_string(),
        ),
        None => (String::new(), s.clone()),
    };
    let body = body.replacen("# mx — instant file search", "# Instant file search on this PC: `mx`", 1);
    let mut out = body;
    if !desc.is_empty() {
        if let Some(pos) = out.find('\n') {
            out.insert_str(pos + 1, &format!("\n{desc}\n"));
        }
    }
    out.trim_end().to_string() + "\n"
}

fn restore_marker() -> PathBuf {
    crate::util::data_dir().join("agents-restore.txt")
}

/// After an update, rewrite skills we installed earlier so they match this version. After a
/// reinstall whose uninstall step removed them, put back what was set up before.
pub fn refresh_installed() {
    if cfg!(debug_assertions) {
        return; // never repoint real skills at a dev build
    }
    let Some(mx) = mx_path() else { return };
    if let Ok(list) = std::fs::read_to_string(restore_marker()) {
        for id in list.split_whitespace() {
            let _ = set(id, true);
        }
        let _ = std::fs::remove_file(restore_marker());
    }
    let want = rendered_skill(&mx.to_string_lossy());
    for a in AGENTS {
        let f = skill_file(a);
        if let Ok(t) = std::fs::read_to_string(&f) {
            if is_ours(&t) && t != want {
                let _ = std::fs::write(&f, &want);
            }
        }
    }
}

/// Uninstaller hook (`--agents-uninstall`): remove skills, PATH entry, stop the daemon.
pub fn uninstall_all() {
    // The uninstaller also runs when a manual reinstall chooses "uninstall first": remember
    // the setup so the next launch restores it. After a real uninstall nothing reads this.
    let st = status();
    let mut keep: Vec<&str> = st.agents.iter().filter(|a| a.installed).map(|a| a.id).collect();
    if st.on_path {
        keep.push("path");
    }
    if !keep.is_empty() {
        let _ = std::fs::write(restore_marker(), keep.join(" "));
    }
    for a in AGENTS {
        remove_skill(&skill_file(a));
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned())) {
        let _ = set_on_path(&d, false);
    }
    crate::agent::stop_daemon();
}

/// `--agents-status` | `--agents-set <id|path> <on|off>` | `--agents-uninstall`.
/// Prints JSON status; returns the exit code, or None if no agents flag was given.
pub fn cli(argv: &[String]) -> Option<i32> {
    let a: Vec<&str> = argv.iter().skip(1).map(String::as_str).collect();
    let print = |s: &AgentsStatus| println!("{}", serde_json::to_string_pretty(s).unwrap_or_default());
    match a.as_slice() {
        ["--agents-uninstall", ..] => {
            uninstall_all();
            Some(0)
        }
        ["--agents-status", ..] => {
            print(&status());
            Some(0)
        }
        ["--agents-set", id, v, ..] => match set(id, *v == "on") {
            Ok(s) => {
                print(&s);
                Some(0)
            }
            Err(e) => {
                eprintln!("{}", e.message);
                Some(1)
            }
        },
        _ => None,
    }
}

// ── user PATH (HKCU\Environment) ────────────────────────────────────────────

const ENV_KEY: &str = "Environment";

fn user_path() -> String {
    let k = wide(ENV_KEY);
    let n = wide("Path");
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    let mut len = 0u32;
    // SAFETY: size query, then read into a buffer of that size.
    unsafe {
        if RegGetValueW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()), PCWSTR(n.as_ptr()), flags, None, None, Some(&mut len)).is_err() {
            return String::new();
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2) + 1];
        let mut len2 = (buf.len() * 2) as u32;
        if RegGetValueW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()), PCWSTR(n.as_ptr()), flags, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut len2))
            .is_err()
        {
            return String::new();
        }
        crate::util::from_wide(&buf)
    }
}

fn expand(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(a) = rest.find('%') {
        let Some(b) = rest[a + 1..].find('%') else { break };
        let var = &rest[a + 1..a + 1 + b];
        out.push_str(&rest[..a]);
        match std::env::var(var) {
            Ok(v) if !var.is_empty() => out.push_str(&v),
            _ => out.push_str(&rest[a..a + 2 + b]),
        }
        rest = &rest[a + 2 + b..];
    }
    out.push_str(rest);
    out
}

fn same_dir(entry: &str, dir: &str) -> bool {
    expand(entry.trim().trim_matches('"')).trim_end_matches('\\').eq_ignore_ascii_case(dir.trim_end_matches('\\'))
}

fn path_has(path: &str, dir: &str) -> bool {
    path.split(';').any(|e| same_dir(e, dir))
}

fn set_on_path(dir: &str, on: bool) -> AppResult<()> {
    let cur = user_path();
    if path_has(&cur, dir) == on {
        return Ok(());
    }
    let mut parts: Vec<&str> = cur.split(';').filter(|e| !e.trim().is_empty()).collect();
    if on {
        parts.push(dir);
    } else {
        parts.retain(|e| !same_dir(e, dir));
    }
    let v = wide(&parts.join(";"));
    let k = wide(ENV_KEY);
    let n = wide("Path");
    // SAFETY: buffers valid for the call; size in bytes incl. terminator. REG_EXPAND_SZ keeps
    // any %VAR% entries working.
    let r = unsafe {
        RegSetKeyValueW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()), PCWSTR(n.as_ptr()), REG_EXPAND_SZ.0, Some(v.as_ptr() as *const _), (v.len() * 2) as u32)
    };
    r.ok().map_err(|e| AppError::io(format!("Couldn't update PATH: {}", e.message())))?;
    let env = wide(ENV_KEY);
    // SAFETY: broadcast so new terminals (and Explorer) see the new PATH.
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(env.as_ptr() as isize), SMTO_ABORTIFHUNG, 2000, None);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_and_prompt() {
        assert!(SKILL.contains(PATH_PLACEHOLDER), "SKILL.md must contain the mx path placeholder");
        assert!(is_ours(&rendered_skill(r"C:\x\mx.exe")));
        assert!(!is_ours("# some other skill"));
        let p = prompt();
        assert!(!p.starts_with("---"));
        assert!(p.starts_with("# Instant file search on this PC"));
        assert!(p.contains("mx \"<query>\""));
    }

    #[test]
    fn path_entries() {
        std::env::set_var("MX_TEST_BASE", r"C:\Base");
        assert!(path_has(r"C:\a;%MX_TEST_BASE%\MyExplorer\;D:\b", r"c:\base\myexplorer"));
        assert!(!path_has(r"C:\a;C:\Base\MyExplorerX", r"C:\Base\MyExplorer"));
        assert_eq!(expand("%NOPE_NOT_SET%\\x"), "%NOPE_NOT_SET%\\x");
    }
}
