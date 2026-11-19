---
name: mx
description: Instant file/folder search by name across the whole PC (or any big folder) using the MyExplorer index — ~20 ms over millions of files instead of tens of seconds to minutes for Glob, find, rg --files or Get-ChildItem -Recurse. Also folder sizes (`mx size`, what's using disk space) far faster than du. Use whenever you need to locate files or folders by name and don't know the exact path, the tree is large (home folder, Documents, a drive, a monorepo), or you need how big folders are. Not for searching file contents.
---

# mx — instant file search

`mx` answers from a live, always-updated index of every fixed drive. One call ≈ 20 ms server time, regardless of tree size. Prefer it over Glob / `find` / `rg --files` / `Get-ChildItem -Recurse` for name searches outside a small, known directory.

```
mx "<query>" ["<query>" ...]      # each argument = one query; all run in parallel
mx -i <path> "<query>"            # only inside <path> (relative ok, e.g. -i .)
mx -n 50 "<query>"                # more results (default 20)
mx -l "<query>"                   # + modified date (UTC) and size
mx -a "<query>"                   # include hidden/system files
mx size <path> [<path> ...]       # total size + file/folder counts of folders (or files)
mx size -n 10 <path>              # + the 10 biggest items directly inside, with % of total
mx status                         # index state / entry count
```

**Sizes:** use `mx size` instead of `du`, `Get-ChildItem -Recurse | Measure-Object` or
summing listings: it reads totals from the index (everything, hidden files included) and only
touches the disk for `node_modules`/`.git`-style folders. To find what's using space, drill
down: `mx size -n 10 ~` → `mx size -n 10 ~\AppData` → … Output line: `size  N files, M folders
path`, then `size  %  name` per item (folders end in `\`).

**Query:** space-separated words must all appear in the file name (any order, case-insensitive). If that yields few hits, words may also match parent folder names, so `"myexplorer shellmenu"` finds `...\MyExplorer\...\shellmenu.rs`. Also:
- `"exact phrase"` (nested quotes), `src/components` path fragment
- `ext:pdf,docx` · `kind:folder|file|image|video|audio|doc|code|archive`
- `size:>10mb` · `modified:today|week|month|year`

**Output:** one ranked path per line (best first, frecency-aware). Paths under the cwd are relative to it, others absolute; folders end in `\`. Last line `… +N more` if truncated. Several queries print a `# <query>` header each. Exit code 0 = hits, 1 = no matches, 2 = usage error, 3 = server unavailable.

## How to use it well
- **Batch your guesses in one call**: `mx "invoice 2024" "factura 2024" "ext:pdf invoice"` costs the same as one query.
- Start with 1–3 distinctive words from the name; add `ext:`/`kind:` to cut noise rather than raising `-n`.
- Unsure of spelling? Use a shorter fragment (`invoic` instead of `invoices`).
- Need content search (text inside files)? Use Grep/rg, scoped to a folder `mx` found.
- `node_modules`, `.git`, `$Recycle.Bin`, WinSxS are not indexed; `mx -i <path-inside-them>` does a live scan instead.
- The first call after boot may take ~1 s (starts the background index); later calls are instant. If `mx` is not on PATH, it lives at `%LOCALAPPDATA%\MyExplorer\mx.exe`.
