//! ReadDirectoryChangesW watchers: generic watcher + ref-counted UI directory watchers.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use crossbeam_channel::{unbounded, RecvTimeoutError, Sender};
use parking_lot::Mutex;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY,
    FILE_NOTIFY_CHANGE, FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Threading::{CreateEventW, ResetEvent, SetEvent, WaitForMultipleObjects, INFINITE};
use windows_core::PCWSTR;

use crate::error::{AppError, AppResult};
use crate::types::FsChanged;
use crate::util::*;

pub const ACTION_ADDED: u32 = 1;
pub const ACTION_REMOVED: u32 = 2;
pub const ACTION_MODIFIED: u32 = 3;
pub const ACTION_RENAMED_OLD: u32 = 4;
pub const ACTION_RENAMED_NEW: u32 = 5;

pub enum WatchEvent {
    Changes(Vec<(u32, String)>),
    Overflow,
    Gone,
}

/// Stops the watcher thread on drop.
pub struct WatchHandle {
    stop: isize,
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        // SAFETY: stop is an event handle owned by the watcher thread, which closes it after exiting.
        unsafe {
            let _ = SetEvent(HANDLE(self.stop as *mut _));
        }
    }
}

pub fn watch(
    path: &str,
    recursive: bool,
    filter: FILE_NOTIFY_CHANGE,
    mut cb: impl FnMut(WatchEvent) + Send + 'static,
) -> AppResult<WatchHandle> {
    let w = wide(&long_path(path));
    // SAFETY: opening a directory handle for change notifications.
    let dir = unsafe {
        CreateFileW(
            PCWSTR(w.as_ptr()),
            FILE_LIST_DIRECTORY.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
            None,
        )
    }
    .map_err(|e| crate::error::win(e, path))?;
    // SAFETY: creating unnamed manual-reset events.
    let (io_ev, stop_ev) = unsafe {
        let a = CreateEventW(None, true, false, PCWSTR::null());
        let b = CreateEventW(None, true, false, PCWSTR::null());
        match (a, b) {
            (Ok(a), Ok(b)) => (a, b),
            (a, b) => {
                let _ = CloseHandle(dir);
                if let Ok(a) = a {
                    let _ = CloseHandle(a);
                }
                if let Ok(b) = b {
                    let _ = CloseHandle(b);
                }
                return Err(AppError::io("CreateEvent failed"));
            }
        }
    };
    let (dir_i, io_i, stop_i) = (dir.0 as isize, io_ev.0 as isize, stop_ev.0 as isize);
    let spawned = std::thread::Builder::new().name("watch".into()).spawn(move || {
        let dir = HANDLE(dir_i as *mut _);
        let io_ev = HANDLE(io_i as *mut _);
        let stop_ev = HANDLE(stop_i as *mut _);
        let mut buf = vec![0u32; if recursive { 256 * 1024 } else { 16 * 1024 }];
        let bytes = (buf.len() * 4) as u32;
        loop {
            let mut ov = OVERLAPPED { hEvent: io_ev, ..Default::default() };
            // SAFETY: buffer and overlapped outlive the I/O (we always wait for completion below).
            unsafe {
                let _ = ResetEvent(io_ev);
                if ReadDirectoryChangesW(dir, buf.as_mut_ptr() as *mut _, bytes, recursive, filter, None, Some(&mut ov), None)
                    .is_err()
                {
                    cb(WatchEvent::Gone);
                    break;
                }
                let r = WaitForMultipleObjects(&[io_ev, stop_ev], false, INFINITE);
                let mut n = 0u32;
                if r.0 != 0 {
                    let _ = CancelIoEx(dir, Some(&ov));
                    let _ = GetOverlappedResult(dir, &ov, &mut n, true);
                    break;
                }
                if let Err(e) = GetOverlappedResult(dir, &ov, &mut n, false) {
                    if win32_code(&e) == 1022 {
                        cb(WatchEvent::Overflow);
                        continue;
                    }
                    cb(WatchEvent::Gone);
                    break;
                }
                if n == 0 {
                    cb(WatchEvent::Overflow);
                    continue;
                }
                cb(WatchEvent::Changes(parse_notify(&buf, n as usize)));
            }
        }
        // SAFETY: handles owned by this thread.
        unsafe {
            let _ = CloseHandle(dir);
            let _ = CloseHandle(io_ev);
            let _ = CloseHandle(stop_ev);
        }
    });
    if spawned.is_err() {
        // SAFETY: thread never started; close what we own.
        unsafe {
            let _ = CloseHandle(dir);
            let _ = CloseHandle(io_ev);
            let _ = CloseHandle(stop_ev);
        }
        return Err(AppError::io("Could not start watcher thread"));
    }
    Ok(WatchHandle { stop: stop_i })
}

fn parse_notify(buf: &[u32], len: usize) -> Vec<(u32, String)> {
    let bytes: &[u8] = {
        // SAFETY: reinterpreting a u32 buffer as bytes; length bounded by the buffer.
        unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, (buf.len() * 4).min(len)) }
    };
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 12 <= bytes.len() {
        let rd = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        let next = rd(off) as usize;
        let action = rd(off + 4);
        let nlen = rd(off + 8) as usize;
        let start = off + 12;
        if start + nlen > bytes.len() {
            break;
        }
        let units: Vec<u16> =
            bytes[start..start + nlen].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        out.push((action, String::from_utf16_lossy(&units)));
        if next == 0 {
            break;
        }
        off += next;
    }
    out
}

// ── UI directory watchers (fs:changed) ──────────────────────────────────────

struct UiWatch {
    count: usize,
    _h: WatchHandle,
}

static UI_WATCHES: LazyLock<Mutex<HashMap<String, UiWatch>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

static DEBOUNCE: LazyLock<Sender<String>> = LazyLock::new(|| {
    let (tx, rx) = unbounded::<String>();
    let _ = std::thread::Builder::new().name("fs-debounce".into()).spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut set: HashSet<String> = HashSet::new();
            set.insert(first);
            let deadline = Instant::now() + Duration::from_millis(100);
            loop {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(p) => {
                        set.insert(p);
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            for path in set {
                crate::dirsize::invalidate(&path);
                emit("fs:changed", FsChanged { path });
            }
        }
    });
    tx
});

pub fn watch_dir(path: &str) -> AppResult<()> {
    let mut map = UI_WATCHES.lock();
    if let Some(w) = map.get_mut(path) {
        w.count += 1;
        return Ok(());
    }
    let p = path.to_string();
    let tx = DEBOUNCE.clone();
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_DIR_NAME
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_LAST_WRITE
        | FILE_NOTIFY_CHANGE_ATTRIBUTES;
    let h = watch(&norm_path(path), false, filter, move |_ev| {
        let _ = tx.send(p.clone());
    })?;
    map.insert(path.to_string(), UiWatch { count: 1, _h: h });
    Ok(())
}

pub fn unwatch_dir(path: &str) {
    let mut map = UI_WATCHES.lock();
    if let Some(w) = map.get_mut(path) {
        w.count = w.count.saturating_sub(1);
        if w.count == 0 {
            map.remove(path);
        }
    }
}
