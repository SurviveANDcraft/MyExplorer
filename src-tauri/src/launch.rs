//! Opening MyExplorer *at* something: `MyExplorer.exe "C:\some\folder"` (how Windows
//! launches it as the default folder handler) or a file path (opens its folder with
//! the file selected). Only one instance runs: later launches are forwarded to it
//! and open as a new tab.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchReq {
    /// Folder to open; None = Home.
    pub path: Option<String>,
    /// Item to select inside `path`.
    pub select: Option<String>,
}

static INITIAL: Mutex<Option<LaunchReq>> = Mutex::new(None);

/// Parse a launch command line (argv[0] is the exe).
pub fn parse(argv: &[String], cwd: &str) -> LaunchReq {
    let arg = argv.iter().skip(1).find(|a| !a.starts_with('-') && !a.trim().is_empty());
    let Some(raw) = arg else { return LaunchReq { path: None, select: None } };
    let raw = raw.trim().trim_matches('"');
    // `"C:\"` from the shell arrives as `C:"` (the backslash escapes the quote): restore the root.
    let root;
    let raw = if raw.len() == 2 && raw.ends_with(':') { root = format!("{raw}\\"); root.as_str() } else { raw };
    let p = std::path::Path::new(raw);
    let p = if p.is_absolute() { p.to_path_buf() } else { std::path::Path::new(cwd).join(p) };
    if p.is_dir() {
        return LaunchReq { path: Some(crate::util::norm_path(&p.to_string_lossy())), select: None };
    }
    if p.is_file() {
        if let (Some(dir), Some(name)) = (p.parent(), p.file_name()) {
            return LaunchReq {
                path: Some(crate::util::norm_path(&dir.to_string_lossy())),
                select: Some(name.to_string_lossy().into_owned()),
            };
        }
    }
    // Shell namespaces ("::{CLSID}") and missing paths: just open Home.
    LaunchReq { path: None, select: None }
}

pub fn set_initial(r: LaunchReq) {
    *INITIAL.lock().unwrap() = Some(r);
}

/// The request this process was started with (consumed once by the UI at boot).
pub fn take_initial() -> Option<LaunchReq> {
    INITIAL.lock().unwrap().take()
}

/// A second launch was forwarded here: open it in a new tab and bring the window forward.
pub fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let req = parse(&argv, &cwd);
    let _ = app.emit("app:open", req);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
