// ─────────────────────────────────────────────────────────────────────────────
// MyExplorer IPC CONTRACT — single source of truth between Rust core and UI.
// READ-ONLY for both agents. If something is missing or wrong, do NOT edit:
// work around it and list the requested change in your final report.
//
// Conventions
//  - Commands are Tauri `invoke(name, args)`. Arg keys are camelCase in JS
//    (Tauri maps them to snake_case Rust params).
//  - All structs serialize camelCase (`#[serde(rename_all = "camelCase")]`).
//  - Paths are absolute Windows paths with backslashes, no trailing slash
//    except drive roots ("C:\\").
//  - Times are milliseconds since Unix epoch (0 = unknown). Sizes are bytes.
//  - Every command rejects with `AppError`.
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'not_found' | 'access_denied' | 'exists' | 'invalid_name'
  | 'cancelled' | 'unsupported' | 'io';
export interface AppError { code: ErrorCode; message: string }

// ── Directory listing ────────────────────────────────────────────────────────
export const enum Flag {
  Dir = 1, Hidden = 2, System = 4, ReadOnly = 8,
  Link = 16,   // symlink / junction / other reparse point
  Cloud = 32,  // cloud placeholder, content NOT on disk (never read content / thumbnail)
}
export type SortKey = 'name' | 'modified' | 'created' | 'size' | 'type';
export interface Sort { key: SortKey; desc: boolean; foldersFirst: boolean }

/** Columnar, already filtered + sorted by the backend (natural, case-insensitive name order). */
/** Recursive folder total. `partial`: some subfolders were unreadable, so this is a lower bound. */
export interface DirSize { size: number; files: number; folders: number; partial: boolean }

export interface DirListing {
  path: string;
  names: string[];
  sizes: number[];     // 0 for directories
  modified: number[];
  created: number[];
  flags: number[];     // bitmask of Flag
}

export interface Drive {
  path: string;        // "C:\\"
  label: string;       // volume label, may be ""
  fs: string;          // "NTFS"
  kind: 'fixed' | 'removable' | 'network' | 'optical' | 'other';
  total: number;
  free: number;
}
export interface KnownFolders {
  home: string; desktop: string; documents: string; downloads: string;
  pictures: string; music: string; videos: string;
  onedrive: string | null;
}
export interface FileInfo {
  path: string; name: string; flags: number;
  size: number; modified: number; created: number; accessed: number;
  typeName: string;    // shell type name, e.g. "PNG File"
  /** Link target for .lnk / symlink / junction, else null. */
  target: string | null;
}

// ── Search ───────────────────────────────────────────────────────────────────
// Query syntax (parsed by backend): space-separated terms are AND-ed, matched
// case-insensitively against the file name (a term containing "\" or "/" matches
// against the full path). "quoted phrase" is literal. Filters:
//   ext:pdf,docx   kind:folder|file|image|video|audio|doc|code|archive
//   size:>10mb size:<1kb   modified:today|week|month|year
export interface SearchOptions {
  /** Restrict to this directory subtree. null = everywhere. */
  scope: string | null;
  limit: number;       // max hits returned
  offset: number;
  includeHidden: boolean;
}
export interface SearchHit {
  path: string; name: string; flags: number;
  size: number; modified: number;
  score: number;
}
export interface SearchResult {
  reqId: number;       // echoed back so the UI can drop stale responses
  hits: SearchHit[];
  total: number;       // total matches (may exceed hits.length)
  terms: string[];     // lowercase name terms, for highlighting
  tookMs: number;
  /** true if index not ready and result came from a live walk (may be partial). */
  partial: boolean;
}
export interface IndexStatus {
  state: 'idle' | 'building' | 'ready';
  entries: number;
  source: 'mft' | 'walk' | 'cache';
  roots: string[];
}

// ── Smart / prediction ───────────────────────────────────────────────────────
export interface Frecent { path: string; isDir: boolean; score: number; lastVisit: number }
export interface Suggestion { path: string; reason: 'history' | 'frecent' | 'sibling' }

export interface TransferResult { destPaths: string[] }   // best-effort, may be []
export interface ClipboardFiles { paths: string[]; cut: boolean }
export interface UndoResult { description: string }        // e.g. "Rename 'a.txt'"

// ── Commands ─────────────────────────────────────────────────────────────────
export interface Commands {
  // filesystem — read
  list_dir(a: { path: string; sort: Sort; showHidden: boolean }): DirListing;
  get_drives(): Drive[];
  get_known_folders(): KnownFolders;
  stat(a: { paths: string[] }): FileInfo[];
  /** Shell type names for extensions (lowercase, no dot; "" = no extension). Same order. */
  type_names(a: { exts: string[] }): string[];
  /** Child directory names only (sidebar tree, path autocomplete). Sorted. */
  list_subdirs(a: { path: string; showHidden: boolean }): string[];
  /** UTF-8 (lossy) text preview, at most maxBytes. Rejects 'unsupported' if binary or Cloud. */
  read_text(a: { path: string; maxBytes: number }): string;
  /** Recursive total of everything inside a folder. null = superseded by a newer request. */
  dir_size(a: { path: string }): DirSize | null;
  /** Abort the in-flight dir_size, if any. */
  cancel_dir_size(): void;
  /** The launch request this process started with (once; null afterwards). */
  take_launch(): LaunchReq | null;
  /** Emit `fs:changed` (debounced ~100 ms) while watched. Ref-counted per path. */
  watch_dir(a: { path: string }): void;
  unwatch_dir(a: { path: string }): void;

  // filesystem — write (all go through the undo stack where reversible)
  /** Creates with a unique name if taken ("New folder (2)"). Returns final path. */
  create_folder(a: { parent: string; name: string }): string;
  create_file(a: { parent: string; name: string }): string;
  /** Returns new full path. */
  rename(a: { path: string; newName: string }): string;
  /** permanent=false → Recycle Bin. */
  delete(a: { paths: string[]; permanent: boolean }): void;
  /** Copy/move via the Windows shell (native progress + conflict UI). */
  transfer(a: { paths: string[]; destDir: string; mode: 'copy' | 'move' }): TransferResult;
  undo(): UndoResult | null;
  redo(): UndoResult | null;

  // shell
  open(a: { path: string }): void;                 // default app
  open_with(a: { path: string }): void;            // native "Open with" dialog
  show_properties(a: { paths: string[] }): void;   // native Properties dialog
  open_terminal(a: { dir: string }): void;         // Windows Terminal, fallback PowerShell
  clipboard_write_files(a: { paths: string[]; cut: boolean }): void; // Explorer-compatible (CF_HDROP)
  clipboard_read_files(): ClipboardFiles | null;

  // search
  search(a: { reqId: number; query: string; options: SearchOptions }): SearchResult;
  index_status(): IndexStatus;

  // smart
  record_visit(a: { path: string; isDir: boolean }): void;
  get_frecent(a: { kind: 'dir' | 'file' | 'any'; limit: number }): Frecent[];
  /** Likely destinations for moving/copying these paths. */
  suggest_destinations(a: { paths: string[]; limit: number }): Suggestion[];
  /** Folders the user usually goes to after `dir`. */
  suggest_next(a: { dir: string; limit: number }): Suggestion[];

  // settings — opaque JSON owned by the frontend; null if none saved yet
  load_settings(): string | null;
  save_settings(a: { json: string }): void;
}

// ── Events (backend → frontend, via Tauri `listen`) ──────────────────────────
export interface Events {
  'fs:changed': { path: string };   // a watched directory's contents changed
  'index:status': IndexStatus;
  'app:open': LaunchReq;            // another launch (e.g. a folder double-clicked on the desktop) was forwarded here
}

/** What the app was asked to open at launch. path null = Home; select = item to highlight in path. */
export interface LaunchReq { path: string | null; select: string | null }

// ── Image protocols (plain <img src>) — served by the backend ────────────────
//   Icon by extension : http://icon.localhost/?ext=pdf&size=32      ("" ext → generic file)
//   Icon folder       : http://icon.localhost/?ext=:dir&size=32
//   Icon by path      : http://icon.localhost/?path=<encodeURIComponent>&size=32
//                       (use for .exe .lnk .ico .url, drive roots, known folders)
//   Thumbnail         : http://thumb.localhost/?path=<enc>&size=256&m=<modified>
//                       (falls back to the icon; never hydrates Cloud files)
//   Sizes: 16 | 32 | 48 | 96 | 256. Responses are PNG, cache-control immutable.
// Media/PDF preview uses Tauri's asset protocol: convertFileSrc(path).
