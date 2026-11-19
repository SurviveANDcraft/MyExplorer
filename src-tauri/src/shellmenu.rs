//! Native Windows shell integration: reading the Explorer context menu (so the app can render
//! every shell-extension entry in its own menu) and dragging files out to other apps.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use crossbeam_channel::{unbounded, Sender};
use parking_lot::Mutex;
use serde::Serialize;
use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Com::{IBindCtx, IDataObject};
use windows::Win32::System::Ole::{OleInitialize, OleUninitialize, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    IContextMenu, IContextMenu2, IContextMenu3, IShellFolder, ILFree, SHBindToParent, SHCreateDataObject, SHDoDragDrop,
    SHGetDesktopFolder, SHParseDisplayName, CMF_CANRENAME, CMF_EXPLORE, CMF_EXTENDEDVERBS, CMF_NORMAL, CMIC_MASK_PTINVOKE,
    CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX, GCS_VERBW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, DispatchMessageW, GetMenuItemCount, GetMenuItemInfoW, PeekMessageW, TranslateMessage, HMENU,
    HBMMENU_POPUP_MINIMIZE, MENUITEMINFOW, MFS_CHECKED, MFS_DISABLED, MFT_OWNERDRAW, MFT_SEPARATOR, MIIM_BITMAP, MIIM_FTYPE,
    MIIM_ID, MIIM_STATE, MIIM_STRING, MIIM_SUBMENU, MSG, PM_REMOVE, SW_SHOWNORMAL, WM_INITMENUPOPUP,
};
use windows_core::{Interface, PCSTR, PCWSTR, PSTR, PWSTR};

use crate::error::{AppError, AppResult};
use crate::util::*;

const CMIC_MASK_UNICODE: u32 = 0x4000;

// ── pidl helpers ────────────────────────────────────────────────────────────

struct Pidl(*mut ITEMIDLIST);
impl Drop for Pidl {
    fn drop(&mut self) {
        // SAFETY: allocated by SHParseDisplayName, freed exactly once.
        unsafe { ILFree(Some(self.0 as *const _)) }
    }
}
fn parse(path: &str) -> AppResult<Pidl> {
    let w = wide(path);
    let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
    // SAFETY: w outlives the call; pidl receives an owned allocation.
    unsafe { SHParseDisplayName(PCWSTR(w.as_ptr()), None::<&IBindCtx>, &mut pidl, 0, None) }
        .map_err(|e| crate::error::win(e, path))?;
    if pidl.is_null() {
        return Err(AppError::not_found(format!("Not found: {path}")));
    }
    Ok(Pidl(pidl))
}

// ── reading the shell menu ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellItem {
    /// Command id to pass back to `menu_invoke` (0 for separators and submenus).
    pub id: u32,
    pub label: String,
    /// Canonical verb when the handler exposes one ("open", "runas", "7-zip.extract"…), lowercase.
    pub verb: String,
    /// data: URL of the item's icon.
    pub icon: Option<String>,
    pub disabled: bool,
    pub checked: bool,
    pub separator: bool,
    pub children: Vec<ShellItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellMenu {
    pub session: u32,
    pub items: Vec<ShellItem>,
}

fn build_menu(paths: &[String], dir: Option<&str>) -> AppResult<IContextMenu> {
    let owner = main_hwnd().unwrap_or_default();
    // SAFETY: shell calls on an OLE-initialized STA thread; pidls outlive their use.
    unsafe {
        if let Some(dir) = dir {
            let pidl = parse(dir)?;
            let desktop: IShellFolder = SHGetDesktopFolder()?;
            let folder: IShellFolder = if (*pidl.0).mkid.cb == 0 { desktop } else { desktop.BindToObject(pidl.0, None::<&IBindCtx>)? };
            return folder.CreateViewObject::<IContextMenu>(owner).map_err(AppError::from);
        }
        let pidls: Vec<Pidl> = paths.iter().map(|p| parse(p)).collect::<AppResult<_>>()?;
        let mut child: *mut ITEMIDLIST = std::ptr::null_mut();
        let parent: IShellFolder = SHBindToParent(pidls[0].0, Some(&mut child))?;
        // Items sharing the first item's folder (search results can span folders).
        let first_parent = parent_of(&paths[0]).map(str::to_lowercase);
        let mut children: Vec<*const ITEMIDLIST> = vec![child as *const _];
        for (i, p) in pidls.iter().enumerate().skip(1) {
            if parent_of(&paths[i]).map(str::to_lowercase) == first_parent {
                let mut c: *mut ITEMIDLIST = std::ptr::null_mut();
                let _: IShellFolder = SHBindToParent(p.0, Some(&mut c))?;
                children.push(c as *const _);
            }
        }
        parent.GetUIObjectOf::<IContextMenu>(owner, &children, None).map_err(AppError::from)
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn base64(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= c.len() {
                s.push(B64[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// "&Open with\tCtrl+O" → "Open with".
fn clean_label(raw: &str) -> String {
    let raw = raw.split('\t').next().unwrap_or("");
    let mut out = String::with_capacity(raw.len());
    let mut it = raw.chars().peekable();
    while let Some(c) = it.next() {
        if c == '&' {
            if it.peek() == Some(&'&') {
                out.push('&');
                it.next();
            }
            continue;
        }
        out.push(c);
    }
    // "(&N)" style accelerators left as "(N)" in CJK locales.
    out.trim().to_string()
}

unsafe fn init_popup(cm: &IContextMenu, sub: HMENU, pos: u32) {
    // SAFETY: lets lazy submenus ("Send to", "Open with") fill themselves in.
    unsafe {
        if let Ok(c3) = cm.cast::<IContextMenu3>() {
            let mut r = LRESULT(0);
            let _ = c3.HandleMenuMsg2(WM_INITMENUPOPUP, WPARAM(sub.0 as usize), LPARAM(pos as isize), Some(&mut r));
        } else if let Ok(c2) = cm.cast::<IContextMenu2>() {
            let _ = c2.HandleMenuMsg(WM_INITMENUPOPUP, WPARAM(sub.0 as usize), LPARAM(pos as isize));
        }
    }
}

unsafe fn read_menu(cm: &IContextMenu, h: HMENU, depth: u32) -> Vec<ShellItem> {
    let mut out = Vec::new();
    // SAFETY: h is a live menu owned by this thread's session.
    unsafe {
        let n = GetMenuItemCount(Some(h)).max(0) as u32;
        for i in 0..n {
            let mut buf = [0u16; 260];
            let mut mii = MENUITEMINFOW {
                cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                fMask: MIIM_FTYPE | MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_STRING | MIIM_BITMAP,
                dwTypeData: PWSTR(buf.as_mut_ptr()),
                cch: buf.len() as u32 - 1,
                ..Default::default()
            };
            if GetMenuItemInfoW(h, i, true, &mut mii).is_err() {
                continue;
            }
            if mii.fType.0 & MFT_SEPARATOR.0 != 0 {
                out.push(ShellItem { id: 0, label: String::new(), verb: String::new(), icon: None, disabled: false, checked: false, separator: true, children: Vec::new() });
                continue;
            }
            let label = clean_label(&from_wide(&buf));
            if label.is_empty() && mii.fType.0 & MFT_OWNERDRAW.0 != 0 {
                continue; // owner-drawn without text: nothing we can show
            }
            if label.is_empty() {
                continue;
            }
            let mut children = Vec::new();
            if !mii.hSubMenu.is_invalid() && depth < 4 {
                init_popup(cm, mii.hSubMenu, i);
                children = read_menu(cm, mii.hSubMenu, depth + 1);
                if children.iter().all(|c| c.separator) {
                    continue;
                }
            }
            let mut verb = String::new();
            if mii.hSubMenu.is_invalid() && mii.wID >= 1 {
                let mut vb = [0u16; 128];
                if cm.GetCommandString((mii.wID - 1) as usize, GCS_VERBW, None, PSTR(vb.as_mut_ptr() as *mut u8), vb.len() as u32).is_ok() {
                    verb = from_wide(&vb).to_ascii_lowercase();
                }
            }
            let icon = if !mii.hbmpItem.is_invalid() && mii.hbmpItem.0 as isize > HBMMENU_POPUP_MINIMIZE.0 as isize {
                crate::images::hbitmap_png(mii.hbmpItem).map(|png| format!("data:image/png;base64,{}", base64(&png)))
            } else {
                None
            };
            out.push(ShellItem {
                id: if mii.hSubMenu.is_invalid() { mii.wID } else { 0 },
                label,
                verb,
                icon,
                disabled: mii.fState.0 & MFS_DISABLED.0 != 0,
                checked: mii.fState.0 & MFS_CHECKED.0 != 0,
                separator: false,
                children,
            });
        }
    }
    // Collapse runs of separators and trim the ends.
    let mut clean: Vec<ShellItem> = Vec::with_capacity(out.len());
    for it in out {
        if it.separator && clean.last().is_none_or(|l| l.separator) {
            continue;
        }
        clean.push(it);
    }
    while clean.last().is_some_and(|l| l.separator) {
        clean.pop();
    }
    clean
}

// ── sessions: the menu stays alive on its STA thread until a pick or close ──

enum Req {
    Invoke { id: u32, x: i32, y: i32, reply: tokio::sync::oneshot::Sender<AppResult<()>> },
    Close,
}
static SESSIONS: LazyLock<Mutex<HashMap<u32, Sender<Req>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT: AtomicU32 = AtomicU32::new(1);

fn pump() {
    let mut msg = MSG::default();
    // SAFETY: standard message pump on this thread.
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Builds the Explorer menu for `paths` (or the `dir` background) and returns its entries.
pub async fn menu_open(paths: Vec<String>, dir: Option<String>, extended: bool) -> AppResult<ShellMenu> {
    let paths: Vec<String> = paths.iter().map(|p| norm_path(p)).collect();
    let dir = dir.map(|d| norm_path(&d));
    if paths.is_empty() && dir.is_none() {
        return Ok(ShellMenu { session: 0, items: Vec::new() });
    }
    let session = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = unbounded::<Req>();
    let (rtx, rrx) = tokio::sync::oneshot::channel::<AppResult<Vec<ShellItem>>>();
    SESSIONS.lock().insert(session, tx);
    std::thread::Builder::new()
        .name("shell-menu".into())
        .spawn(move || {
            // SAFETY: OLE init for this thread; balanced at the end.
            let ole = unsafe { OleInitialize(None) }.is_ok();
            let built = (|| -> AppResult<(IContextMenu, HMENU)> {
                let cm = build_menu(&paths, dir.as_deref())?;
                // SAFETY: menu owned by this thread, destroyed below.
                unsafe {
                    let h = CreatePopupMenu()?;
                    let mut flags = CMF_NORMAL | CMF_EXPLORE;
                    if dir.is_none() {
                        flags |= CMF_CANRENAME;
                    }
                    if extended {
                        flags |= CMF_EXTENDEDVERBS;
                    }
                    if cm.QueryContextMenu(h, 0, 1, 0x7FFF, flags).is_err() {
                        let _ = DestroyMenu(h);
                        return Err(AppError::io("The Windows menu could not be built"));
                    }
                    Ok((cm, h))
                }
            })();
            match built {
                Err(e) => {
                    let _ = rtx.send(Err(e));
                }
                Ok((cm, h)) => {
                    // SAFETY: h is live until DestroyMenu below.
                    let items = unsafe { read_menu(&cm, h, 0) };
                    let _ = rtx.send(Ok(items));
                    let deadline = Instant::now() + Duration::from_secs(180);
                    let mut invoked = false;
                    while Instant::now() < deadline {
                        pump();
                        match rx.recv_timeout(Duration::from_millis(30)) {
                            Ok(Req::Invoke { id, x, y, reply }) => {
                                let mut pt = POINT { x, y };
                                // SAFETY: invoke the chosen command; directory buffer outlives the call.
                                let r = unsafe {
                                    if let Some(m) = main_hwnd() {
                                        let _ = ClientToScreen(m, &mut pt);
                                    }
                                    let dirw = dir.as_deref().or_else(|| paths.first().and_then(|p| parent_of(p))).map(wide);
                                    let info = CMINVOKECOMMANDINFOEX {
                                        cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
                                        fMask: CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE,
                                        hwnd: main_hwnd().unwrap_or_default(),
                                        lpVerb: PCSTR((id - 1) as usize as *const u8),
                                        lpVerbW: PCWSTR((id - 1) as usize as *const u16),
                                        lpDirectoryW: dirw.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
                                        nShow: SW_SHOWNORMAL.0,
                                        ptInvoke: pt,
                                        ..Default::default()
                                    };
                                    cm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO).map_err(AppError::from)
                                };
                                let _ = reply.send(r);
                                invoked = true;
                                break;
                            }
                            Ok(Req::Close) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                        }
                    }
                    SESSIONS.lock().remove(&session);
                    // Some verbs open UI on this thread (Properties, dialogs): keep it serviced.
                    if invoked {
                        crate::sta::pump_until_no_windows(Duration::from_secs(3));
                    }
                    // SAFETY: menu created above on this thread.
                    unsafe {
                        let _ = DestroyMenu(h);
                    }
                    drop(cm);
                }
            }
            SESSIONS.lock().remove(&session);
            if ole {
                // SAFETY: balanced with OleInitialize.
                unsafe { OleUninitialize() };
            }
        })
        .map_err(|e| AppError::io(e.to_string()))?;
    let items = rrx.await.map_err(|_| AppError::io("Shell menu thread stopped"))??;
    Ok(ShellMenu { session, items })
}

/// Runs entry `id` of an open session at client point (physical px). Ends the session.
pub async fn menu_invoke(session: u32, id: u32, x: i32, y: i32) -> AppResult<()> {
    let tx = SESSIONS.lock().get(&session).cloned().ok_or_else(|| AppError::io("This menu has expired, open it again"))?;
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(Req::Invoke { id, x, y, reply }).map_err(|_| AppError::io("This menu has expired, open it again"))?;
    rx.await.map_err(|_| AppError::io("Shell menu thread stopped"))?
}

pub fn menu_close(session: u32) {
    if let Some(tx) = SESSIONS.lock().remove(&session) {
        let _ = tx.send(Req::Close);
    }
}

// ── drag out ────────────────────────────────────────────────────────────────

/// Starts a native OLE drag of `paths` (call while the mouse button is still down).
/// Blocks the UI thread's modal drag loop until the drop; returns "copy" | "move" | "link" | "none".
pub async fn drag_out(paths: Vec<String>) -> AppResult<String> {
    let paths: Vec<String> = paths.iter().map(|p| norm_path(p)).collect();
    if paths.is_empty() {
        return Ok("none".into());
    }
    let app = APP.get().ok_or_else(|| AppError::io("App not ready"))?.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let r = (|| -> AppResult<DROPEFFECT> {
            let pidls: Vec<Pidl> = paths.iter().map(|p| parse(p)).collect::<AppResult<_>>()?;
            let raw: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| p.0 as *const _).collect();
            // SAFETY: the UI thread is OLE-initialized (WebView2 needs it for drag & drop).
            unsafe {
                let data: IDataObject = SHCreateDataObject(None, Some(&raw), None::<&IDataObject>)?;
                SHDoDragDrop(main_hwnd(), &data, None, DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK).map_err(AppError::from)
            }
        })();
        let _ = tx.send(r);
    })
    .map_err(|e| AppError::io(e.to_string()))?;
    let eff = rx.await.map_err(|_| AppError::io("Drag was interrupted"))??;
    Ok(if eff.0 & DROPEFFECT_MOVE.0 != 0 {
        "move"
    } else if eff.0 & DROPEFFECT_COPY.0 != 0 {
        "copy"
    } else if eff.0 & DROPEFFECT_LINK.0 != 0 {
        "link"
    } else {
        "none"
    }
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dump(items: &[ShellItem], depth: usize) {
        for it in items {
            if it.separator {
                eprintln!("{}----", "  ".repeat(depth));
                continue;
            }
            eprintln!("{}[{}] {:?} verb={:?} icon={} dis={}", "  ".repeat(depth), it.id, it.label, it.verb, it.icon.as_ref().map_or(0, |i| i.len()), it.disabled);
            dump(&it.children, depth + 1);
        }
    }
    #[test]
    #[ignore]
    fn print_menu() {
        let p = std::env::var("MX_MENU_PATH").unwrap();
        let dir = std::env::var("MX_MENU_DIR").ok();
        let t0 = Instant::now();
        let m = tauri::async_runtime::block_on(menu_open(if dir.is_some() { vec![] } else { vec![p] }, dir, false)).unwrap();
        eprintln!("took {:?}", t0.elapsed());
        dump(&m.items, 0);
        menu_close(m.session);
    }
}
