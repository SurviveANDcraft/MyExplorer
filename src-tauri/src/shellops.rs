//! Write operations (IFileOperation), undo/redo, shell verbs, clipboard.

use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, POINT};
use windows::Win32::System::Com::{CoCreateInstance, IBindCtx, IDataObject, CLSCTX_ALL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    DragQueryFileW, FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl,
    IShellItem, ILFree, SHCreateDataObject, SHCreateItemFromParsingName, SHMultiFileProperties, SHObjectProperties,
    SHOpenWithDialog, SHParseDisplayName, ShellExecuteExW, DROPFILES, FILEOPERATION_FLAGS, FOFX_RECYCLEONDELETE,
    FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOCONFIRMMKDIR, FOF_RENAMEONCOLLISION, FOF_WANTNUKEWARNING, HDROP,
    OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OAIF_REGISTER_EXT, OPENASINFO, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
    SHOP_FILEPATH, SIGDN_FILESYSPATH,
};
use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE, SW_SHOWNORMAL, WINDOW_EX_STYLE, WINDOW_STYLE};
use windows_core::{implement, Ref, HRESULT, PCWSTR};

use crate::error::{win, AppError, AppResult};
use crate::sta;
use crate::types::{ClipboardFiles, TransferResult, UndoResult};
use crate::util::*;

// ── IFileOperation ──────────────────────────────────────────────────────────

#[derive(Default)]
struct SinkOut {
    /// (source, resulting path) for copy/move/rename; (folder, new item) for new.
    pairs: Vec<(String, String)>,
    deleted: usize,
}

#[implement(IFileOperationProgressSink)]
struct Sink {
    out: Arc<Mutex<SinkOut>>,
}

fn item_path(i: Ref<IShellItem>) -> Option<String> {
    let i = i.as_ref()?;
    // SAFETY: valid shell item; returned string freed by take_pwstr.
    unsafe { i.GetDisplayName(SIGDN_FILESYSPATH) }.ok().map(take_pwstr)
}

impl Sink_Impl {
    fn rec(&self, src: Ref<IShellItem>, hr: HRESULT, newly: Ref<IShellItem>) {
        if hr.is_ok() {
            if let (Some(s), Some(d)) = (item_path(src), item_path(newly)) {
                self.out.lock().pairs.push((s, d));
            }
        }
    }
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for Sink_Impl {
    fn StartOperations(&self) -> windows_core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _hr: HRESULT) -> windows_core::Result<()> {
        Ok(())
    }
    fn PreRenameItem(&self, _f: u32, _i: Ref<IShellItem>, _n: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _f: u32,
        i: Ref<IShellItem>,
        _n: &PCWSTR,
        hr: HRESULT,
        newly: Ref<IShellItem>,
    ) -> windows_core::Result<()> {
        self.rec(i, hr, newly);
        Ok(())
    }
    fn PreMoveItem(&self, _f: u32, _i: Ref<IShellItem>, _d: Ref<IShellItem>, _n: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _f: u32,
        i: Ref<IShellItem>,
        _d: Ref<IShellItem>,
        _n: &PCWSTR,
        hr: HRESULT,
        newly: Ref<IShellItem>,
    ) -> windows_core::Result<()> {
        self.rec(i, hr, newly);
        Ok(())
    }
    fn PreCopyItem(&self, _f: u32, _i: Ref<IShellItem>, _d: Ref<IShellItem>, _n: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _f: u32,
        i: Ref<IShellItem>,
        _d: Ref<IShellItem>,
        _n: &PCWSTR,
        hr: HRESULT,
        newly: Ref<IShellItem>,
    ) -> windows_core::Result<()> {
        self.rec(i, hr, newly);
        Ok(())
    }
    fn PreDeleteItem(&self, _f: u32, _i: Ref<IShellItem>) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostDeleteItem(
        &self,
        _f: u32,
        _i: Ref<IShellItem>,
        hr: HRESULT,
        _newly: Ref<IShellItem>,
    ) -> windows_core::Result<()> {
        if hr.is_ok() {
            self.out.lock().deleted += 1;
        }
        Ok(())
    }
    fn PreNewItem(&self, _f: u32, _d: Ref<IShellItem>, _n: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _f: u32,
        d: Ref<IShellItem>,
        _n: &PCWSTR,
        _t: &PCWSTR,
        _a: u32,
        hr: HRESULT,
        item: Ref<IShellItem>,
    ) -> windows_core::Result<()> {
        self.rec(d, hr, item);
        Ok(())
    }
    fn UpdateProgress(&self, _t: u32, _s: u32) -> windows_core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows_core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows_core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows_core::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug)]
enum OpItem {
    Copy { src: String, dest_dir: String, name: Option<String> },
    Move { src: String, dest_dir: String, name: Option<String> },
    Delete { src: String },
    Rename { src: String, name: String },
    New { dest_dir: String, name: String, dir: bool },
}

struct OpOutcome {
    out: SinkOut,
    aborted: bool,
}

fn shell_item(path: &str) -> AppResult<IShellItem> {
    let w = wide(path);
    // SAFETY: w null-terminated; COM initialized on calling STA thread.
    unsafe { SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(w.as_ptr()), None::<&IBindCtx>) }
        .map_err(|e| win(e, path))
}

/// Must run on an STA thread.
fn perform(items: &[OpItem], flags: FILEOPERATION_FLAGS) -> AppResult<OpOutcome> {
    // SAFETY: COM calls on an initialized STA thread; all strings outlive the calls.
    unsafe {
        let fo: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
        fo.SetOperationFlags(flags)?;
        if let Some(h) = main_hwnd() {
            let _ = fo.SetOwnerWindow(h);
        }
        let out = Arc::new(Mutex::new(SinkOut::default()));
        let sink: IFileOperationProgressSink = Sink { out: out.clone() }.into();
        let cookie = fo.Advise(&sink)?;
        let none = None::<&IFileOperationProgressSink>;
        for it in items {
            match it {
                OpItem::Copy { src, dest_dir, name } | OpItem::Move { src, dest_dir, name } => {
                    let s = shell_item(src)?;
                    let d = shell_item(dest_dir)?;
                    let nw = name.as_deref().map(wide);
                    let np = nw.as_ref().map(|w| PCWSTR(w.as_ptr())).unwrap_or(PCWSTR::null());
                    if matches!(it, OpItem::Copy { .. }) {
                        fo.CopyItem(&s, &d, np, none)?;
                    } else {
                        fo.MoveItem(&s, &d, np, none)?;
                    }
                }
                OpItem::Delete { src } => {
                    let s = shell_item(src)?;
                    fo.DeleteItem(&s, none)?;
                }
                OpItem::Rename { src, name } => {
                    let s = shell_item(src)?;
                    let w = wide(name);
                    fo.RenameItem(&s, PCWSTR(w.as_ptr()), none)?;
                }
                OpItem::New { dest_dir, name, dir } => {
                    let d = shell_item(dest_dir)?;
                    let w = wide(name);
                    let attrs = if *dir { FA_DIRECTORY } else { FA_NORMAL };
                    fo.NewItem(&d, attrs, PCWSTR(w.as_ptr()), PCWSTR::null(), none)?;
                }
            }
        }
        let r = fo.PerformOperations();
        let aborted = fo.GetAnyOperationsAborted().map(|b| b.as_bool()).unwrap_or(false);
        let _ = fo.Unadvise(cookie);
        drop(sink);
        let out = std::mem::take(&mut *out.lock());
        if let Err(e) = r {
            let err = AppError::from(e);
            if err.code != "cancelled" && out.pairs.is_empty() && out.deleted == 0 {
                return Err(err);
            }
        }
        Ok(OpOutcome { out, aborted })
    }
}

async fn perform_async(items: Vec<OpItem>, flags: FILEOPERATION_FLAGS) -> AppResult<OpOutcome> {
    sta::run_dedicated(move || perform(&items, flags)).await?
}

const RECYCLE_SILENT: FILEOPERATION_FLAGS =
    FILEOPERATION_FLAGS(FOF_ALLOWUNDO.0 | FOFX_RECYCLEONDELETE.0 | FOF_NOCONFIRMATION.0);
const TRANSFER: FILEOPERATION_FLAGS = FILEOPERATION_FLAGS(FOF_ALLOWUNDO.0 | FOF_NOCONFIRMMKDIR.0);

// ── names ───────────────────────────────────────────────────────────────────

pub fn validate_name(name: &str) -> AppResult<()> {
    let bad = |m: &str| Err(AppError::invalid_name(m.to_string()));
    if name.is_empty() || name.trim().is_empty() {
        return bad("Name cannot be empty");
    }
    if name == "." || name == ".." {
        return bad("Invalid name");
    }
    if name.encode_utf16().count() > 255 {
        return bad("Name is too long");
    }
    if let Some(c) = name.chars().find(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (*c as u32) < 32) {
        return Err(AppError::invalid_name(format!("A file name can't contain '{c}'")));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return bad("A file name can't end with a dot or a space");
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return bad("This name is reserved by Windows");
    }
    Ok(())
}

fn exists(p: &str) -> bool {
    crate::fs::attributes(p).is_some()
}

fn unique_path(parent: &str, name: &str, dir: bool) -> String {
    let first = join(parent, name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !dir => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..10_000 {
        let p = join(parent, &format!("{stem} ({n}){ext}"));
        if !exists(&p) {
            return p;
        }
    }
    first
}

// ── undo stack ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
enum UndoOp {
    Create { path: String, dir: bool },
    Rename { from: String, to: String },
    Move { pairs: Vec<(String, String)> },
    Copy { srcs: Vec<String>, dest_dir: String, created: Vec<String> },
}

impl UndoOp {
    fn describe(&self) -> String {
        let many = |n: usize, verb: &str, first: &str| {
            if n == 1 { format!("{verb} '{}'", file_name(first)) } else { format!("{verb} {n} items") }
        };
        match self {
            UndoOp::Create { path, dir } => {
                format!("New {} '{}'", if *dir { "folder" } else { "file" }, file_name(path))
            }
            UndoOp::Rename { from, .. } => format!("Rename '{}'", file_name(from)),
            UndoOp::Move { pairs } => many(pairs.len(), "Move", pairs.first().map(|p| p.0.as_str()).unwrap_or("")),
            UndoOp::Copy { srcs, .. } => many(srcs.len(), "Copy", srcs.first().map(|p| p.as_str()).unwrap_or("")),
        }
    }
}

#[derive(Default)]
struct History {
    undo: Vec<UndoOp>,
    redo: Vec<UndoOp>,
}

static HISTORY: LazyLock<Mutex<History>> = LazyLock::new(|| Mutex::new(History::default()));

fn push_undo(op: UndoOp) {
    let mut h = HISTORY.lock();
    h.undo.push(op);
    if h.undo.len() > 100 {
        h.undo.remove(0);
    }
    h.redo.clear();
}

fn fs_rename(from: &str, to: &str) -> std::io::Result<()> {
    std::fs::rename(long_path(from), long_path(to))
}

async fn rename_any(from: &str, to: &str) -> AppResult<String> {
    match fs_rename(from, to) {
        Ok(()) => Ok(to.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            let item = OpItem::Rename { src: from.to_string(), name: file_name(to).to_string() };
            let r = perform_async(vec![item], FILEOPERATION_FLAGS(FOF_ALLOWUNDO.0)).await?;
            r.out.pairs.first().map(|p| p.1.clone()).ok_or_else(AppError::cancelled)
        }
        Err(e) => Err(AppError::from(e).ctx(from)),
    }
}

async fn run_inverse(op: &UndoOp) -> AppResult<UndoOp> {
    Ok(match op {
        UndoOp::Create { path, .. } => {
            perform_async(vec![OpItem::Delete { src: path.clone() }], RECYCLE_SILENT).await?;
            op.clone()
        }
        UndoOp::Rename { from, to } => {
            rename_any(to, from).await?;
            op.clone()
        }
        UndoOp::Move { pairs } => {
            let items = pairs
                .iter()
                .filter_map(|(src, dst)| {
                    Some(OpItem::Move {
                        src: dst.clone(),
                        dest_dir: parent_of(src)?.to_string(),
                        name: Some(file_name(src).to_string()),
                    })
                })
                .collect();
            perform_async(items, TRANSFER).await?;
            op.clone()
        }
        UndoOp::Copy { created, .. } => {
            let items = created.iter().map(|p| OpItem::Delete { src: p.clone() }).collect();
            perform_async(items, RECYCLE_SILENT).await?;
            op.clone()
        }
    })
}

async fn run_forward(op: &UndoOp) -> AppResult<UndoOp> {
    Ok(match op {
        UndoOp::Create { path, dir } => {
            if *dir {
                std::fs::create_dir(long_path(path)).map_err(|e| AppError::from(e).ctx(path))?;
            } else {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(long_path(path))
                    .map_err(|e| AppError::from(e).ctx(path))?;
            }
            op.clone()
        }
        UndoOp::Rename { from, to } => {
            rename_any(from, to).await?;
            op.clone()
        }
        UndoOp::Move { pairs } => {
            let items = pairs
                .iter()
                .filter_map(|(src, dst)| {
                    Some(OpItem::Move {
                        src: src.clone(),
                        dest_dir: parent_of(dst)?.to_string(),
                        name: Some(file_name(dst).to_string()),
                    })
                })
                .collect();
            perform_async(items, TRANSFER).await?;
            op.clone()
        }
        UndoOp::Copy { srcs, dest_dir, .. } => {
            let items = srcs
                .iter()
                .map(|s| OpItem::Copy { src: s.clone(), dest_dir: dest_dir.clone(), name: None })
                .collect();
            let r = perform_async(items, TRANSFER).await?;
            UndoOp::Copy {
                srcs: srcs.clone(),
                dest_dir: dest_dir.clone(),
                created: r.out.pairs.into_iter().map(|p| p.1).collect(),
            }
        }
    })
}

pub async fn undo() -> AppResult<Option<UndoResult>> {
    let Some(op) = HISTORY.lock().undo.pop() else { return Ok(None) };
    let description = op.describe();
    let done = run_inverse(&op).await?;
    HISTORY.lock().redo.push(done);
    Ok(Some(UndoResult { description }))
}

pub async fn redo() -> AppResult<Option<UndoResult>> {
    let Some(op) = HISTORY.lock().redo.pop() else { return Ok(None) };
    let description = op.describe();
    let done = run_forward(&op).await?;
    HISTORY.lock().undo.push(done);
    Ok(Some(UndoResult { description }))
}

// ── commands ────────────────────────────────────────────────────────────────

pub async fn create_entry(parent: &str, name: &str, dir: bool) -> AppResult<String> {
    validate_name(name)?;
    let parent = norm_path(parent);
    if crate::fs::attributes(&parent).is_none_or(|a| a & FA_DIRECTORY == 0) {
        return Err(AppError::not_found(format!("Folder not found: {parent}")));
    }
    let mut last_err = None;
    for _ in 0..5 {
        let path = unique_path(&parent, name, dir);
        let r = if dir {
            std::fs::create_dir(long_path(&path))
        } else {
            std::fs::OpenOptions::new().write(true).create_new(true).open(long_path(&path)).map(|_| ())
        };
        match r {
            Ok(()) => {
                push_undo(UndoOp::Create { path: path.clone(), dir });
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                // Protected location: let the shell handle elevation.
                let item = OpItem::New { dest_dir: parent.clone(), name: file_name(&path).to_string(), dir };
                let r = perform_async(vec![item], FILEOPERATION_FLAGS(FOF_ALLOWUNDO.0 | FOF_RENAMEONCOLLISION.0)).await?;
                let p = r.out.pairs.into_iter().next().map(|p| p.1).ok_or_else(AppError::cancelled)?;
                push_undo(UndoOp::Create { path: p.clone(), dir });
                return Ok(p);
            }
            Err(e) => {
                last_err = Some(AppError::from(e).ctx(&path));
                break;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::exists("Could not find a free name")))
}

pub async fn rename(path: &str, new_name: &str) -> AppResult<String> {
    validate_name(new_name)?;
    let path = norm_path(path);
    let parent = parent_of(&path).ok_or_else(|| AppError::unsupported("Drives can't be renamed here"))?;
    let dest = join(parent, new_name);
    if dest == path {
        return Ok(dest);
    }
    if dest.to_lowercase() != path.to_lowercase() && exists(&dest) {
        return Err(AppError::exists(format!("'{new_name}' already exists")));
    }
    if !exists(&path) {
        return Err(AppError::not_found(format!("Not found: {path}")));
    }
    let out = rename_any(&path, &dest).await?;
    push_undo(UndoOp::Rename { from: path, to: out.clone() });
    Ok(out)
}

pub async fn delete(paths: Vec<String>, permanent: bool) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let items: Vec<OpItem> = paths.iter().map(|p| OpItem::Delete { src: norm_path(p) }).collect();
    let flags = if permanent {
        FILEOPERATION_FLAGS(0)
    } else {
        FILEOPERATION_FLAGS(FOF_ALLOWUNDO.0 | FOFX_RECYCLEONDELETE.0 | FOF_NOCONFIRMATION.0 | FOF_WANTNUKEWARNING.0)
    };
    let r = perform_async(items, flags).await?;
    if r.aborted && r.out.deleted == 0 {
        return Err(AppError::cancelled());
    }
    Ok(())
}

pub async fn transfer(paths: Vec<String>, dest_dir: &str, mode: &str) -> AppResult<TransferResult> {
    let dest = norm_path(dest_dir);
    if crate::fs::attributes(&dest).is_none_or(|a| a & FA_DIRECTORY == 0) {
        return Err(AppError::not_found(format!("Folder not found: {dest}")));
    }
    let is_move = match mode {
        "move" => true,
        "copy" => false,
        m => return Err(AppError::unsupported(format!("Unknown transfer mode '{m}'"))),
    };
    let dl = dest.to_lowercase();
    let srcs: Vec<(String, bool)> = paths
        .iter()
        .map(|p| norm_path(p))
        .filter(|p| !is_move || parent_of(p).map(|x| x.to_lowercase()) != Some(dl.clone()))
        .map(|p| {
            let d = crate::fs::attributes(&p).is_some_and(|a| a & FA_DIRECTORY != 0);
            (p, d)
        })
        .collect();
    if srcs.is_empty() {
        return Ok(TransferResult { dest_paths: Vec::new() });
    }
    for (s, _) in &srcs {
        let sl = s.to_lowercase();
        if dl == sl || dl.starts_with(&format!("{}\\", sl.trim_end_matches('\\'))) {
            return Err(AppError::unsupported("A folder can't be copied or moved into itself"));
        }
    }
    let same_parent = srcs.iter().all(|(p, _)| parent_of(p).map(|x| x.to_lowercase()) == Some(dl.clone()));
    let mut flags = TRANSFER.0;
    if !is_move && same_parent {
        flags |= FOF_RENAMEONCOLLISION.0;
    }
    let items: Vec<OpItem> = srcs
        .iter()
        .map(|(s, _)| {
            if is_move {
                OpItem::Move { src: s.clone(), dest_dir: dest.clone(), name: None }
            } else {
                OpItem::Copy { src: s.clone(), dest_dir: dest.clone(), name: None }
            }
        })
        .collect();
    let r = perform_async(items, FILEOPERATION_FLAGS(flags)).await?;
    if r.out.pairs.is_empty() && r.aborted {
        return Err(AppError::cancelled());
    }
    let pairs = r.out.pairs;
    let dest_paths: Vec<String> = pairs.iter().map(|p| p.1.clone()).collect();
    if !pairs.is_empty() {
        if is_move {
            push_undo(UndoOp::Move { pairs });
        } else {
            push_undo(UndoOp::Copy {
                srcs: pairs.iter().map(|p| p.0.clone()).collect(),
                dest_dir: dest.clone(),
                created: dest_paths.clone(),
            });
        }
    }
    crate::predict::record_transfer(&srcs, &dest);
    Ok(TransferResult { dest_paths })
}

// ── shell verbs ─────────────────────────────────────────────────────────────

fn hwnd_or_null() -> HWND {
    main_hwnd().unwrap_or_default()
}

pub async fn open(path: &str) -> AppResult<()> {
    let path = norm_path(path);
    sta::run_dedicated(move || {
        let file = wide(&path);
        let dir = parent_of(&path).map(wide);
        let mut sei = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOASYNC,
            hwnd: hwnd_or_null(),
            lpFile: PCWSTR(file.as_ptr()),
            lpDirectory: dir.as_ref().map(|d| PCWSTR(d.as_ptr())).unwrap_or(PCWSTR::null()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        // SAFETY: sei and its strings are valid for the call.
        unsafe { ShellExecuteExW(&mut sei) }.map_err(|e| win(e, &path))
    })
    .await?
    .or_else(|e| if e.code == "cancelled" { Ok(()) } else { Err(e) })
}

pub async fn open_with(path: &str) -> AppResult<()> {
    let path = norm_path(path);
    sta::run_dedicated(move || {
        let file = wide(&path);
        let info = OPENASINFO {
            pcszFile: PCWSTR(file.as_ptr()),
            pcszClass: PCWSTR::null(),
            oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC,
        };
        // SAFETY: info valid for the (modal) call.
        unsafe { SHOpenWithDialog(main_hwnd(), &info) }.map_err(|e| win(e, &path))
    })
    .await?
    .or_else(|e| if e.code == "cancelled" { Ok(()) } else { Err(e) })
}

pub async fn show_properties(paths: Vec<String>) -> AppResult<()> {
    let paths: Vec<String> = paths.iter().map(|p| norm_path(p)).collect();
    if paths.is_empty() {
        return Ok(());
    }
    sta::run_dedicated_pumped(move || -> AppResult<()> {
        // SAFETY: shell calls on an OLE-initialized STA thread; pidls freed after use.
        unsafe {
            if paths.len() == 1 {
                let w = wide(&paths[0]);
                if !SHObjectProperties(main_hwnd(), SHOP_FILEPATH, PCWSTR(w.as_ptr()), PCWSTR::null()).as_bool() {
                    return Err(AppError::io(format!("Could not open properties for {}", paths[0])));
                }
                return Ok(());
            }
            let mut pidls: Vec<*mut ITEMIDLIST> = Vec::new();
            for p in &paths {
                let w = wide(p);
                let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                if SHParseDisplayName(PCWSTR(w.as_ptr()), None::<&IBindCtx>, &mut pidl, 0, None).is_ok() && !pidl.is_null() {
                    pidls.push(pidl);
                }
            }
            let consts: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| *p as *const _).collect();
            let r = SHCreateDataObject::<_, IDataObject>(None, Some(&consts), None::<&IDataObject>)
                .and_then(|d| SHMultiFileProperties(&d, 0));
            for p in pidls {
                ILFree(Some(p as *const _));
            }
            r.map_err(AppError::from)
        }
    })
    .await?
}

pub fn open_terminal(dir: &str) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    let dir = norm_path(dir);
    if crate::fs::attributes(&dir).is_none_or(|a| a & FA_DIRECTORY == 0) {
        return Err(AppError::not_found(format!("Folder not found: {dir}")));
    }
    const CREATE_NEW_CONSOLE: u32 = 0x10;
    let wt = std::process::Command::new("wt.exe")
        .arg("-d")
        .arg(&dir)
        .current_dir(&dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn();
    if wt.is_ok() {
        return Ok(());
    }
    std::process::Command::new("powershell.exe")
        .arg("-NoExit")
        .current_dir(&dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::io(format!("Could not start a terminal: {e}")))
}

// ── clipboard ───────────────────────────────────────────────────────────────

const CF_HDROP: u32 = 15;

fn drop_effect_format() -> u32 {
    let w = wide("Preferred DropEffect");
    // SAFETY: null-terminated string.
    unsafe { RegisterClipboardFormatW(PCWSTR(w.as_ptr())) }
}

fn open_clipboard(owner: Option<HWND>) -> AppResult<()> {
    for _ in 0..20 {
        // SAFETY: plain Win32 call.
        if unsafe { OpenClipboard(owner) }.is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    Err(AppError::io("The clipboard is busy"))
}

fn global_from(bytes: &[u8]) -> AppResult<HGLOBAL> {
    // SAFETY: allocate, copy, unlock; caller owns the handle until handed to the clipboard.
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
        let p = GlobalLock(h) as *mut u8;
        if p.is_null() {
            let _ = GlobalFree(Some(h));
            return Err(AppError::io("GlobalLock failed"));
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(h);
        Ok(h)
    }
}

/// Must run on an STA thread.
pub fn clipboard_write_files(paths: &[String], cut: bool) -> AppResult<()> {
    let mut data: Vec<u8> = Vec::new();
    let hdr = DROPFILES {
        pFiles: std::mem::size_of::<DROPFILES>() as u32,
        pt: POINT::default(),
        fNC: false.into(),
        fWide: true.into(),
    };
    // SAFETY: DROPFILES is POD.
    data.extend_from_slice(unsafe {
        std::slice::from_raw_parts(&hdr as *const _ as *const u8, std::mem::size_of::<DROPFILES>())
    });
    for p in paths {
        for u in norm_path(p).encode_utf16().chain(std::iter::once(0)) {
            data.extend_from_slice(&u.to_le_bytes());
        }
    }
    data.extend_from_slice(&[0, 0]);
    let effect: u32 = if cut { 2 } else { 5 };

    // SAFETY: message-only window as clipboard owner, destroyed at the end.
    unsafe {
        let cls = wide("STATIC");
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(cls.as_ptr()),
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
        .ok();
        let r = (|| -> AppResult<()> {
            open_clipboard(hwnd)?;
            let res = (|| -> AppResult<()> {
                EmptyClipboard()?;
                let h = global_from(&data)?;
                if SetClipboardData(CF_HDROP, Some(HANDLE(h.0))).is_err() {
                    let _ = GlobalFree(Some(h));
                    return Err(AppError::io("Could not write to the clipboard"));
                }
                let h2 = global_from(&effect.to_le_bytes())?;
                if SetClipboardData(drop_effect_format(), Some(HANDLE(h2.0))).is_err() {
                    let _ = GlobalFree(Some(h2));
                }
                Ok(())
            })();
            let _ = CloseClipboard();
            res
        })();
        if let Some(h) = hwnd {
            let _ = DestroyWindow(h);
        }
        r
    }
}

/// Must run on an STA thread.
pub fn clipboard_read_files() -> AppResult<Option<ClipboardFiles>> {
    // SAFETY: clipboard access bracketed by Open/CloseClipboard; handles not freed (owned by clipboard).
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP).is_err() {
            return Ok(None);
        }
        open_clipboard(None)?;
        let r = (|| -> Option<ClipboardFiles> {
            let h = GetClipboardData(CF_HDROP).ok()?;
            let hdrop = HDROP(h.0);
            let n = DragQueryFileW(hdrop, u32::MAX, None);
            let mut paths = Vec::with_capacity(n as usize);
            for i in 0..n {
                let len = DragQueryFileW(hdrop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(hdrop, i, Some(&mut buf));
                paths.push(from_wide(&buf));
            }
            let mut cut = false;
            if let Ok(he) = GetClipboardData(drop_effect_format()) {
                let g = HGLOBAL(he.0);
                let p = GlobalLock(g) as *const u8;
                if !p.is_null() {
                    let mut b = [0u8; 4];
                    std::ptr::copy_nonoverlapping(p, b.as_mut_ptr(), 4);
                    let _ = GlobalUnlock(g);
                    let eff = u32::from_le_bytes(b);
                    cut = eff & 2 != 0 && eff & 1 == 0;
                }
            }
            Some(ClipboardFiles { paths, cut })
        })();
        let _ = CloseClipboard();
        Ok(r)
    }
}
