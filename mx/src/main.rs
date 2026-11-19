//! `mx`: instant file search for AI agents. A thin client: it forwards argv + cwd to the
//! MyExplorer search server over a named pipe and prints the reply. If nothing is serving,
//! it starts MyExplorer headless (`--mx-daemon`) and waits for it. Zero dependencies.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PIPE_BUSY: i32 = 231;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn pipe_name() -> String {
    if let Ok(p) = std::env::var("MX_PIPE") {
        return p;
    }
    let user = std::env::var("USERNAME").unwrap_or_default();
    let tag = if std::env::var_os("MX_DEV").is_some() { "-dev" } else { "" };
    format!(r"\\.\pipe\myexplorer-mx{tag}-{user}")
}

fn connect(deadline: Instant) -> io::Result<File> {
    loop {
        match OpenOptions::new().read(true).write(true).open(pipe_name()) {
            Ok(f) => return Ok(f),
            Err(e) if Instant::now() < deadline
                && matches!(e.raw_os_error(), Some(ERROR_PIPE_BUSY) | Some(ERROR_FILE_NOT_FOUND)) =>
            {
                std::thread::sleep(Duration::from_millis(if e.raw_os_error() == Some(ERROR_PIPE_BUSY) { 2 } else { 25 }));
            }
            Err(e) => return Err(e),
        }
    }
}

fn app_exe() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os("MX_APP") {
        cands.push(p.into());
    }
    if let Ok(me) = std::env::current_exe() {
        if let Some(d) = me.parent() {
            cands.push(d.join("myexplorer-app.exe"));
        }
    }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        cands.push(PathBuf::from(l).join("MyExplorer").join("myexplorer-app.exe"));
    }
    cands.into_iter().find(|p| p.is_file())
}

fn start_daemon() -> bool {
    let Some(exe) = app_exe() else { return false };
    Command::new(exe)
        .arg("--mx-daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let stop = args.len() == 1 && args[0] == "stop";
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let mut req = cwd;
    for a in &args {
        req.push('\x1f');
        // Separators/newlines inside an argument would break framing.
        req.extend(a.chars().map(|c| if c == '\x1f' || c == '\n' || c == '\r' { ' ' } else { c }));
    }
    req.push('\n');

    let mut pipe = match connect(Instant::now() + Duration::from_millis(300)) {
        Ok(p) => p,
        Err(_) if stop => {
            eprintln!("mx: not running");
            return ExitCode::SUCCESS;
        }
        Err(_) => {
            if !start_daemon() {
                eprintln!("mx: MyExplorer not found (install it, or set MX_APP to myexplorer-app.exe)");
                return ExitCode::from(3);
            }
            match connect(Instant::now() + Duration::from_secs(30)) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("mx: search server did not start: {e}");
                    return ExitCode::from(3);
                }
            }
        }
    };
    let mut resp = Vec::with_capacity(8192);
    if pipe.write_all(req.as_bytes()).is_err() || pipe.read_to_end(&mut resp).is_err() && resp.is_empty() {
        eprintln!("mx: connection to search server failed");
        return ExitCode::from(3);
    }
    let Some((&status, body)) = resp.split_first() else {
        eprintln!("mx: empty reply from search server");
        return ExitCode::from(3);
    };
    let code = status.wrapping_sub(b'0');
    if code == 2 {
        let _ = io::stderr().write_all(body);
    } else {
        write_out(body);
    }
    ExitCode::from(code.min(3))
}

// ── output: UTF-16 to a real console (correct non-ASCII names), raw UTF-8 otherwise ─────

#[link(name = "kernel32")]
extern "system" {
    fn GetConsoleMode(h: *mut core::ffi::c_void, mode: *mut u32) -> i32;
    fn WriteConsoleW(h: *mut core::ffi::c_void, buf: *const u16, n: u32, written: *mut u32, r: *mut core::ffi::c_void) -> i32;
}

fn write_out(body: &[u8]) {
    let out = io::stdout();
    let h = out.as_raw_handle() as *mut core::ffi::c_void;
    let mut mode = 0u32;
    if unsafe { GetConsoleMode(h, &mut mode) } != 0 {
        let w: Vec<u16> = String::from_utf8_lossy(body).encode_utf16().collect();
        for chunk in w.chunks(8192) {
            let mut n = 0u32;
            unsafe { WriteConsoleW(h, chunk.as_ptr(), chunk.len() as u32, &mut n, core::ptr::null_mut()) };
        }
    } else {
        let mut lock = out.lock();
        let _ = lock.write_all(body);
        let _ = lock.flush();
    }
}
