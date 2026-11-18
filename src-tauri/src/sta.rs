//! Single-threaded-apartment worker threads for COM / shell work.

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use crossbeam_channel::{unbounded, Sender};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumThreadWindows, MsgWaitForMultipleObjects, PeekMessageW, TranslateMessage, MSG,
    PM_REMOVE, QS_ALLINPUT,
};

use crate::error::{AppError, AppResult};

type Job = Box<dyn FnOnce() + Send + 'static>;

pub struct StaPool {
    tx: Sender<Job>,
}

impl StaPool {
    pub fn new(name: &str, threads: usize) -> Self {
        let (tx, rx) = unbounded::<Job>();
        for i in 0..threads.max(1) {
            let rx = rx.clone();
            let _ = std::thread::Builder::new()
                .name(format!("{name}-{i}"))
                .spawn(move || {
                    // SAFETY: initializing COM for this thread as STA.
                    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
                    while let Ok(job) = rx.recv() {
                        job();
                    }
                    if hr.is_ok() {
                        // SAFETY: balanced with successful CoInitializeEx.
                        unsafe { CoUninitialize() };
                    }
                });
        }
        Self { tx }
    }

    pub fn spawn(&self, f: impl FnOnce() + Send + 'static) {
        let _ = self.tx.send(Box::new(f));
    }

    pub async fn run<T: Send + 'static>(&self, f: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.spawn(move || {
            let _ = tx.send(f());
        });
        rx.await.map_err(|_| AppError::io("Shell worker stopped"))
    }
}

/// Icons, type names, stat, clipboard.
pub static SHELL: LazyLock<StaPool> = LazyLock::new(|| StaPool::new("sta-shell", 2));
/// Thumbnail extraction (can be slow: video, PDF, Office).
pub static THUMBS: LazyLock<StaPool> = LazyLock::new(|| StaPool::new("sta-thumb", 3));

/// Run `f` on a fresh OLE-initialized STA thread (modal shell UI, IFileOperation).
pub async fn run_dedicated<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("sta-op".into())
        .spawn(move || {
            // SAFETY: OLE init for this new thread; balanced below.
            let ok = unsafe { OleInitialize(None) }.is_ok();
            let _ = tx.send(f());
            if ok {
                // SAFETY: balanced with OleInitialize.
                unsafe { OleUninitialize() };
            }
        })
        .map_err(|e| AppError::io(e.to_string()))?;
    rx.await.map_err(|_| AppError::io("Shell operation thread stopped"))
}

/// Like `run_dedicated`, but `f` receives a sender to report its result early;
/// the thread then keeps pumping messages until it owns no windows (non-modal shell UI).
pub async fn run_dedicated_pumped<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> AppResult<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("sta-ui".into())
        .spawn(move || {
            // SAFETY: OLE init for this new thread; balanced below.
            let ok = unsafe { OleInitialize(None) }.is_ok();
            let _ = tx.send(f());
            pump_until_no_windows(Duration::from_secs(3));
            if ok {
                // SAFETY: balanced with OleInitialize.
                unsafe { OleUninitialize() };
            }
        })
        .map_err(|e| AppError::io(e.to_string()))?;
    rx.await.map_err(|_| AppError::io("Shell UI thread stopped"))
}

unsafe extern "system" fn count_windows(_h: HWND, lp: LPARAM) -> windows_core::BOOL {
    // SAFETY: lp points to a usize owned by the caller for the duration of the enumeration.
    unsafe { *(lp.0 as *mut usize) += 1 };
    true.into()
}

fn thread_window_count() -> usize {
    let mut n: usize = 0;
    // SAFETY: callback only writes to `n`, which outlives the call.
    unsafe {
        let _ = EnumThreadWindows(GetCurrentThreadId(), Some(count_windows), LPARAM(&mut n as *mut usize as isize));
    }
    n
}

/// Pump messages; exit once `min` has elapsed and this thread has no windows.
pub fn pump_until_no_windows(min: Duration) {
    let start = Instant::now();
    loop {
        let mut msg = MSG::default();
        // SAFETY: standard message loop on this thread.
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if start.elapsed() >= min && thread_window_count() == 0 {
            break;
        }
        // SAFETY: wait for input or timeout.
        unsafe {
            MsgWaitForMultipleObjects(None, false, 250, QS_ALLINPUT);
        }
    }
}
