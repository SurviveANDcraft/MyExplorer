# MyExplorer — Plan

A Windows file explorer that beats File Explorer on speed, search, productivity and feel,
while keeping its familiar layout.

## 1. Architecture

| Layer | Choice | Why |
|---|---|---|
| Core | Rust (`src-tauri/`), Tauri 2 | Native speed, tiny footprint, direct Win32/COM via `windows` crate |
| UI | SolidJS + TypeScript + Vite, plain CSS with CSS variables | Fine-grained reactivity (no VDOM), tiny bundle, full design control |
| Contract | `src/ipc/types.ts` (frozen) | Lets core and UI be built in parallel |
| Window | Undecorated, Mica backdrop, custom title bar with tabs | Premium, native-feeling Win11 look |

Ownership: **Core agent** → `src-tauri/**`. **UI agent** → everything else at the root
(`package.json`, `index.html`, `vite.config.ts`, `tsconfig.json`, `src/**`).
`src/ipc/types.ts`, `PLAN.md`, `.cargo/config.toml` are read-only for both.

Fixed wiring: Vite dev server `http://localhost:1420` (strictPort); `frontendDist: ../dist`;
`beforeDevCommand: pnpm dev`; `beforeBuildCommand: pnpm build`; package manager pnpm;
`@tauri-apps/cli` is a devDependency with script `"tauri": "tauri"`; app identifier
`dev.myexplorer.app`; product name `MyExplorer`.

## 2. Performance budgets (release build)

- Window visible and interactive < 400 ms; no white flash (window created hidden, shown after first paint).
- Folder with 10 000 items: listed, sorted and painted < 60 ms. 100 000 items < 400 ms. Scrolling always 60 fps+ (virtualized, only visible rows in the DOM).
- Search-as-you-type over 1 M indexed files: < 30 ms per keystroke.
- Rust process memory: < 40 MB + ≤ 90 bytes per indexed file. No per-file heap allocations in the index.
- Nothing ever blocks the UI thread: every command is async / runs on a worker; icons and thumbnails load lazily after the list paints.

## 3. Core (Rust)

### 3.1 Search index — the headline feature
- **Storage:** struct-of-arrays. One contiguous byte arena for names (original) and one for lowercased names, plus `parent: u32`, `size: u64`, `modified`, `flags: u8` vectors. Paths are reconstructed by walking parents.
- **Sources** behind one trait:
  1. `cache` — on startup load the last index from `%LOCALAPPDATA%\MyExplorer\index.bin` (search is available in ~1 s), then refresh in the background.
  2. `walk` — parallel directory walk of all fixed drives (non-admin, works everywhere).
  3. `mft` — if the process is elevated, enumerate the NTFS MFT via `FSCTL_ENUM_USN_DATA` (≈ seconds for 1 M files). Stretch goal for M1; the un-elevated helper service is M2.
- **Freshness:** recursive `ReadDirectoryChangesW` watch per drive root applies creates/deletes/renames incrementally; on buffer overflow schedule a background re-walk. Save cache on exit and every few minutes.
- **Matching:** parse query (see contract), scan the lowercase arena in parallel (`rayon` + `memchr::memmem`), all terms must match. Scoped search restricts to a subtree. If the index is not ready, do a live parallel walk of the scope and return `partial: true`.
- **Ranking — "the file I actually wanted":** score = match quality (exact name > name prefix > word-boundary/camelCase start > substring; shorter names win) × boosts: frecency of the file and of its folder, recently modified, inside user profile folders; penalties: hidden/system, and noise paths (`node_modules`, `.git`, `AppData`, `Windows`, `Program Files`, `$Recycle.Bin`, caches). Top-K selection with a bounded heap, never a full sort.

### 3.2 Filesystem
- `list_dir`: one pass using `FindFirstFileExW` data (no per-file stat), natural case-insensitive sort (like Explorer), folders-first option, done on a blocking worker.
- Watching: ref-counted per-directory watcher → debounced `fs:changed`.
- Write ops through `IFileOperation` (native progress, conflict and elevation UI, Recycle Bin). Undo/redo stack for create, rename, move, copy.
- Explorer-compatible clipboard (CF_HDROP + Preferred DropEffect) so copy/paste works between MyExplorer and every other app.
- Shell: open, Open-with dialog, native Properties dialog, open terminal here.
- **OneDrive safety:** entries with `RECALL_ON_DATA_ACCESS`/`OFFLINE` get `Flag.Cloud`; the core never reads their content or generates thumbnails (no accidental downloads).

### 3.3 Icons and thumbnails
Custom URI protocols `icon` and `thumb` return PNG with immutable caching. Icons cached per extension+size in memory; thumbnails via `IShellItemImageFactory` on a small worker pool with an LRU cache. This gives thumbnails for every format Windows itself supports (images, video, PDF, Office, …).

### 3.4 Prediction store (`%LOCALAPPDATA%\MyExplorer\state.json`, debounced writes)
- **Frecency** per path (visit count × exponential recency decay).
- **Transition tables:** folder → next folder; (extension, source folder) → destination folder, updated on every navigation and transfer.
- Feeds search ranking, Home, path autocomplete, "Move to…" and the palette.

## 4. UI

### 4.1 Layout (Explorer-familiar)
```
┌ Title bar 40px: [tab][tab][+]                              ─ □ ✕ ┐
├ Nav row 44px:  ← → ↑ ⟳  [ breadcrumb path bar          ] [search]┤
├ Command bar 36px: New▾  ✂ ⧉ 📋 ✎ 🗑 │ Sort▾ View▾ │ ⋯     Preview ┤
├ Sidebar 240px     │ File view (details / list / grid)  │ Preview ┤
│  Home             │                                     │  pane   │
│  Pinned           │                                     │ (toggle)│
│  Frequent (auto)  │                                     │         │
│  This PC + drives │                                     │         │
├ Status bar 28px: 42 items · 3 selected · 1.2 MB        view toggle┤
```
- **Tabs:** new/close/reorder/duplicate, per-tab history, middle-click folder opens in new tab.
- **Path bar:** breadcrumbs; each chevron opens sibling folders; click empty area or Ctrl+L to edit; autocomplete from real subfolders + frecent folders.
- **Sidebar:** Home, Pinned (drag to reorder, pin/unpin from context menu), Frequent (auto), known folders, OneDrive, drives with usage bars; lazy expandable folder tree; resizable and collapsible.
- **File view:** Details (resizable, sortable columns: Name, Date modified, Type, Size), List, Grid (S/M/L/XL with thumbnails). Fully virtualized (own fixed-height virtualizer). Multi-select with click, Ctrl, Shift, rubber-band, keyboard. Inline rename. Per-folder remembered view + sort.
- **Search:** search box = current folder subtree, one-key toggle to Everywhere; results appear in the file view as you type with matched text highlighted and the parent path shown; filter chips (kind, date, size).
- **Home:** pinned folders, recent files, drives.
- **Preview:** Quick Look (Space) and preview pane (Alt+P): images, video, audio, PDF, text/code, fonts; everything else falls back to a large shell thumbnail + metadata.
- **Context menu (custom, premium):** Open, Open in new tab, Open with…, Cut, Copy, Paste, Copy as path, Rename, Delete, New ▸ (Folder, Text document, …), Pin to sidebar, Open in Terminal, Move to… / Copy to…, Properties. Background menu: View ▸, Sort ▸, New ▸, Paste, Open in Terminal, Properties.
- **Settings (Ctrl+,):** theme (Light / Dark / System + accent color + density), animation speed (Off / Fast / Normal), default view and sort, show hidden files / extensions, single vs double click, startup folder, full keybinding editor with conflict detection. Everything persisted through `load_settings` / `save_settings`.

### 4.2 Productivity — built to anticipate
- **Command palette (Ctrl+K):** files, folders, and every command in one fuzzy box; empty state shows predicted next folders (`suggest_next`) and recent files.
- **Move to… / Copy to… (Ctrl+Shift+M / Ctrl+Shift+C… see keymap):** picker pre-filled with predicted destinations (`suggest_destinations`), Enter confirms the top guess.
- **Type-ahead:** typing in the file view jumps to the match; no modal needed.
- **Zero-friction defaults:** new folder goes straight into rename; rename pre-selects the name without extension; Tab while renaming moves to the next file; after delete the next item is selected; after paste the new items are selected; Backspace/Alt+Up restores the previous selection when going up.
- **Every action has a shortcut, shown in tooltips and menus.** Explorer-compatible defaults, all rebindable.

Default keymap: Alt+←/→ back/forward · Alt+↑ / Backspace up · Enter open · Ctrl+Enter open in new tab · Ctrl+T / Ctrl+W / Ctrl+Tab / Ctrl+1–9 tabs · Ctrl+L / Alt+D / F4 path · Ctrl+F / Ctrl+E / F3 search · Ctrl+Shift+F search everywhere · Ctrl+K palette · Space Quick Look · Alt+P preview pane · F2 rename · Del / Shift+Del delete · Ctrl+C / X / V · Ctrl+Z / Ctrl+Y · Ctrl+A · Ctrl+Shift+N new folder · Ctrl+Shift+C copy path · Ctrl+Shift+M move to · Ctrl+Shift+1/2/3 views · Ctrl+H hidden files · Ctrl+B sidebar · F5 refresh · Alt+Enter properties · Ctrl+` terminal here · Ctrl+, settings.

### 4.3 Design language — quiet, precise, premium
- **Surfaces:** Mica shows through the title bar and sidebar; the content area is a solid raised surface with a rounded top-left corner. Hairline separators (1 px, low alpha) instead of boxes. No gradients, no heavy shadows; one soft shadow for floating layers (menus, palette, Quick Look).
- **Type:** Segoe UI Variable (Text for UI at 13 px, Display for headings), tabular numbers for sizes and dates, secondary text at reduced contrast. Icons: one consistent 1.5 px line icon set for chrome; system icons/thumbnails for files.
- **Color:** neutral greys + one accent (user-set). Selection = accent tint with rounded rows; hover = faint neutral tint. Every theme is a set of CSS variables, so custom themes are just token maps.
- **Shape and density:** radii 8 (panels) / 6 (rows, controls) / 4 (small); row height 32 (comfortable) or 26 (compact); 4 px spacing grid.
- **Motion:** only `transform` and `opacity`. 90 ms press/hover, 140 ms navigation (content fades + slides 6 px in the direction of travel), 180 ms menus/popovers (scale 0.98→1 from the origin point), 220 ms panes. Enter easing `cubic-bezier(0.2, 0, 0, 1)`, exit `cubic-bezier(0.3, 0, 1, 1)` at ~60 % of the enter time. Animations never delay input and are interruptible; honor the animation-speed setting and `prefers-reduced-motion`.
- **States:** designed empty folder, no-results, access-denied, and loading states (no spinners under 150 ms).

## 5. Milestones

**M1 — prototype (this build):** everything in sections 3 and 4 except the items below.

**M2:** native shell context menu ("Show more options"), drag out to other apps, zip compress/extract, Recycle Bin view, group-by, batch rename, dual pane, elevated MFT helper service + USN journal, stay-resident tray + Win+E takeover, content search, custom theme files, Network locations.

## 6. Quality rules
- No glitches: stale async results are dropped (request ids), listings diff on refresh so selection and scroll survive, every error surfaces as a toast, never a silent failure or a crash.
- Core: no `unwrap` on fallible OS calls; `cargo clippy` clean. Unit tests for the query parser and ranking only.
- UI: TypeScript strict, `pnpm build` clean.
