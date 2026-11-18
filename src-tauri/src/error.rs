use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new("not_found", m)
    }
    pub fn exists(m: impl Into<String>) -> Self {
        Self::new("exists", m)
    }
    pub fn invalid_name(m: impl Into<String>) -> Self {
        Self::new("invalid_name", m)
    }
    pub fn cancelled() -> Self {
        Self::new("cancelled", "Operation cancelled")
    }
    pub fn unsupported(m: impl Into<String>) -> Self {
        Self::new("unsupported", m)
    }
    pub fn io(m: impl Into<String>) -> Self {
        Self::new("io", m)
    }

    /// Map a Win32 error code to an AppError, with a context string (usually a path).
    pub fn from_win32(code: u32, ctx: &str) -> Self {
        let (c, what): (&'static str, &str) = match code {
            2 | 3 | 15 | 21 | 53 | 67 => ("not_found", "Not found"),
            5 => ("access_denied", "Access denied"),
            32 | 33 => ("io", "The file is in use by another process"),
            80 | 183 => ("exists", "An item with this name already exists"),
            123 | 161 | 206 | 267 => ("invalid_name", "Invalid name"),
            1223 => ("cancelled", "Operation cancelled"),
            50 => ("unsupported", "Not supported"),
            _ => ("io", ""),
        };
        let msg = if what.is_empty() {
            let e = std::io::Error::from_raw_os_error(code as i32);
            if ctx.is_empty() { e.to_string() } else { format!("{e}: {ctx}") }
        } else if ctx.is_empty() {
            what.to_string()
        } else {
            format!("{what}: {ctx}")
        };
        Self::new(c, msg)
    }

    pub fn from_hresult(hr: i32, msg: String, ctx: &str) -> Self {
        let u = hr as u32;
        if u & 0xFFFF_0000 == 0x8007_0000 {
            return Self::from_win32(u & 0xFFFF, ctx);
        }
        // COPYENGINE_E_USER_CANCELLED
        if u == 0x8027_0000 {
            return Self::cancelled();
        }
        let m = if ctx.is_empty() { msg } else { format!("{msg} ({ctx})") };
        Self::io(m)
    }

    pub fn ctx(self, ctx: &str) -> Self {
        if self.message.contains(ctx) {
            self
        } else {
            Self { code: self.code, message: format!("{}: {ctx}", self.message) }
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        if let Some(code) = e.raw_os_error() {
            return Self::from_win32(code as u32, "");
        }
        use std::io::ErrorKind::*;
        let code = match e.kind() {
            NotFound => "not_found",
            PermissionDenied => "access_denied",
            AlreadyExists => "exists",
            InvalidInput => "invalid_name",
            Unsupported => "unsupported",
            _ => "io",
        };
        Self::new(code, e.to_string())
    }
}

impl From<windows_core::Error> for AppError {
    fn from(e: windows_core::Error) -> Self {
        Self::from_hresult(e.code().0, e.message(), "")
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Convert a windows error with a context path.
pub fn win(e: windows_core::Error, ctx: &str) -> AppError {
    AppError::from_hresult(e.code().0, e.message(), ctx)
}
