//! Tauri command handlers (contract: src/ipc/types.ts `Commands`).

use crate::error::{AppError, AppResult};
use crate::sta::SHELL;
use crate::types::*;
use crate::{fs, index, predict, shellops, watch};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::io(format!("Worker failed: {e}")))?
}

// ── filesystem — read ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_dir(path: String, sort: Sort, show_hidden: bool) -> AppResult<DirListing> {
    blocking(move || fs::list_dir(&path, &sort, show_hidden)).await
}

#[tauri::command]
pub async fn get_drives() -> AppResult<Vec<Drive>> {
    blocking(|| Ok(fs::get_drives())).await
}

#[tauri::command]
pub async fn get_known_folders() -> AppResult<KnownFolders> {
    blocking(|| Ok(fs::get_known_folders())).await
}

#[tauri::command]
pub async fn stat(paths: Vec<String>) -> AppResult<Vec<FileInfo>> {
    SHELL.run(move || paths.iter().map(|p| fs::stat_one(p)).collect::<AppResult<Vec<_>>>()).await?
}

#[tauri::command]
pub async fn type_names(exts: Vec<String>) -> AppResult<Vec<String>> {
    SHELL
        .run(move || exts.iter().map(|e| fs::type_name_for_ext(&e.trim_start_matches('.').to_lowercase())).collect())
        .await
}

#[tauri::command]
pub async fn list_subdirs(path: String, show_hidden: bool) -> AppResult<Vec<String>> {
    blocking(move || fs::list_subdirs(&path, show_hidden)).await
}

#[tauri::command]
pub async fn dir_size(path: String) -> AppResult<Option<crate::dirsize::DirSize>> {
    blocking(move || crate::dirsize::dir_size(&path)).await
}

#[tauri::command]
pub async fn cancel_dir_size() -> AppResult<()> {
    crate::dirsize::cancel();
    Ok(())
}

#[tauri::command]
pub async fn read_text(path: String, max_bytes: usize) -> AppResult<String> {
    blocking(move || fs::read_text(&path, max_bytes)).await
}

#[tauri::command]
pub async fn watch_dir(path: String) -> AppResult<()> {
    blocking(move || watch::watch_dir(&path)).await
}

#[tauri::command]
pub async fn unwatch_dir(path: String) -> AppResult<()> {
    blocking(move || {
        watch::unwatch_dir(&path);
        Ok(())
    })
    .await
}

// ── filesystem — write ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_folder(parent: String, name: String) -> AppResult<String> {
    shellops::create_entry(&parent, &name, true).await
}

#[tauri::command]
pub async fn create_file(parent: String, name: String) -> AppResult<String> {
    shellops::create_entry(&parent, &name, false).await
}

#[tauri::command]
pub async fn rename(path: String, new_name: String) -> AppResult<String> {
    shellops::rename(&path, &new_name).await
}

#[tauri::command]
pub async fn delete(paths: Vec<String>, permanent: bool) -> AppResult<()> {
    shellops::delete(paths, permanent).await
}

#[tauri::command]
pub async fn transfer(paths: Vec<String>, dest_dir: String, mode: String) -> AppResult<TransferResult> {
    shellops::transfer(paths, &dest_dir, &mode).await
}

#[tauri::command]
pub async fn undo() -> AppResult<Option<UndoResult>> {
    shellops::undo().await
}

#[tauri::command]
pub async fn redo() -> AppResult<Option<UndoResult>> {
    shellops::redo().await
}

// ── shell ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open(path: String) -> AppResult<()> {
    shellops::open(&path).await
}

#[tauri::command]
pub async fn open_with(path: String) -> AppResult<()> {
    shellops::open_with(&path).await
}

#[tauri::command]
pub async fn show_properties(paths: Vec<String>) -> AppResult<()> {
    shellops::show_properties(paths).await
}

#[tauri::command]
pub async fn open_terminal(dir: String) -> AppResult<()> {
    blocking(move || shellops::open_terminal(&dir)).await
}

#[tauri::command]
pub async fn clipboard_write_files(paths: Vec<String>, cut: bool) -> AppResult<()> {
    SHELL.run(move || shellops::clipboard_write_files(&paths, cut)).await?
}

#[tauri::command]
pub async fn clipboard_read_files() -> AppResult<Option<ClipboardFiles>> {
    SHELL.run(shellops::clipboard_read_files).await?
}

// ── search ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn search(req_id: f64, query: String, options: SearchOptions) -> AppResult<SearchResult> {
    blocking(move || Ok(index::search(req_id, &query, &options))).await
}

#[tauri::command]
pub async fn index_status() -> AppResult<IndexStatus> {
    Ok(index::status())
}

// ── smart ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn record_visit(path: String, is_dir: bool) -> AppResult<()> {
    blocking(move || {
        predict::record_visit(&path, is_dir);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn get_frecent(kind: String, limit: usize) -> AppResult<Vec<Frecent>> {
    blocking(move || Ok(predict::get_frecent(&kind, limit))).await
}

#[tauri::command]
pub async fn suggest_destinations(paths: Vec<String>, limit: usize) -> AppResult<Vec<Suggestion>> {
    blocking(move || predict::suggest_destinations(&paths, limit)).await
}

#[tauri::command]
pub async fn suggest_next(dir: String, limit: usize) -> AppResult<Vec<Suggestion>> {
    blocking(move || predict::suggest_next(&dir, limit)).await
}

// ── settings ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn load_settings() -> AppResult<Option<String>> {
    blocking(predict::load_settings).await
}

#[tauri::command]
pub async fn take_launch() -> AppResult<Option<crate::launch::LaunchReq>> {
    Ok(crate::launch::take_initial())
}

#[tauri::command]
pub async fn save_settings(json: String) -> AppResult<()> {
    blocking(move || predict::save_settings(&json)).await
}
