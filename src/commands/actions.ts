import { invoke, listen } from '../ipc/invoke';
import { baseName, extOf, isDir, isInside, parentOf, samePath } from '../lib/fs';
import { setSettings, settings } from '../state/settings';
import { invalidateSizes } from '../state/dirsize';
import { displayName, refreshDrives, refreshFrecent, setCutSet } from '../state/system';
import {
  activeTab, currentDir, expectSelection, navigate, newTab, openDir, pathAt, refresh, selectedIndices, selectedPaths, Tab, tabs,
} from '../state/tabs';
import { attempt, setPicker, toast, toastError, updateToast } from '../state/ui';

const plural = (n: number, w = 'item') => `${n} ${w}${n === 1 ? '' : 's'}`;
/** Disk contents changed under these folders: sizes and free space must follow. */
export function diskChanged(...paths: (string | null | undefined)[]) {
  invalidateSizes(paths);
  refreshDrives();
}
const refreshDirs = (...dirs: (string | null)[]) => {
  diskChanged(...dirs);
  for (const t of tabs()) {
    const d = currentDir(t);
    if (t.search() || (d && dirs.some((x) => samePath(x, d)))) refresh(t);
  }
};

export function openPath(path: string, dir: boolean, opts: { newTab?: boolean } = {}) {
  if (dir) {
    if (opts.newTab) newTab({ kind: 'dir', path }, { after: activeTab() });
    else openDir(path);
    return;
  }
  attempt(invoke('open', { path }), `Couldn't open ${baseName(path)}`).then(() => {
    invoke('record_visit', { path, isDir: false }).then(refreshFrecent, () => {});
  });
}
export function openIndex(t: Tab, i: number, inNewTab = false) {
  const m = t.model();
  if (i < 0 || i >= m.count) return;
  openPath(pathAt(m, i), isDir(m.flags[i]), { newTab: inNewTab });
}
export function openSelection(inNewTab = false) {
  const t = activeTab();
  const idx = selectedIndices(t);
  const list = idx.length ? idx : t.focus() >= 0 ? [t.focus()] : [];
  const m = t.model();
  const dirs = list.filter((i) => isDir(m.flags[i]));
  // Several folders open as tabs; a single folder navigates in place.
  if (dirs.length > 1 || inNewTab) dirs.forEach((i) => newTab({ kind: 'dir', path: pathAt(m, i) }, { activate: false, after: t }));
  else if (dirs.length === 1) openIndex(t, dirs[0]);
  list.filter((i) => !isDir(m.flags[i])).slice(0, 16).forEach((i) => openIndex(t, i));
}

function targetDir(): string | null {
  const d = currentDir();
  if (!d) toast({ kind: 'info', text: 'Open a folder first' });
  return d;
}

export async function createNew(kind: 'folder' | 'text') {
  const t = activeTab();
  const dir = targetDir();
  if (!dir || t.search()) return;
  const path = await attempt(kind === 'folder'
    ? invoke('create_folder', { parent: dir, name: 'New folder' })
    : invoke('create_file', { parent: dir, name: 'New Text Document.txt' }), `Couldn't create the ${kind === 'folder' ? 'folder' : 'file'}`);
  if (!path) return;
  expectSelection(t, [baseName(path)], true);
  refresh(t);
}

export function startRename() {
  const t = activeTab();
  const idx = selectedIndices(t);
  const i = idx.length === 1 ? idx[0] : t.focus() >= 0 ? t.focus() : idx[0] ?? -1;
  if (i >= 0) t.setRenaming(i);
}
export async function commitRename(t: Tab, i: number, newName: string, moveNext: 0 | 1 | -1 = 0) {
  const m = t.model();
  t.setRenaming(-1);
  const old = m.names[i];
  const next = moveNext ? m.names[i + moveNext] : undefined;
  const name = newName.trim();
  if (!old) return;
  if (!name || name === old) {
    if (next) { expectSelection(t, [next], true); refresh(t); }
    return;
  }
  const path = pathAt(m, i);
  const res = await attempt(invoke('rename', { path, newName: name }), `Couldn't rename "${old}"`);
  if (!res) return;
  if (t.search()) { refresh(t); return; }
  expectSelection(t, [next ?? baseName(res)], !!next);
  refresh(t);
}

export async function deleteSelection(permanent: boolean) {
  const t = activeTab();
  const idx = selectedIndices(t);
  if (!idx.length) return;
  const paths = idx.map((i) => pathAt(t.model(), i));
  t.pendingFocusIndex = idx[0];
  try {
    await invoke('delete', { paths, permanent });
  } catch (e) { t.pendingFocusIndex = -1; toastError(e, `Couldn't delete ${plural(paths.length)}`); diskChanged(...paths); return; }
  diskChanged(...paths, ...paths.map(parentOf));
  toast({
    kind: 'success',
    text: permanent ? `Permanently deleted ${plural(paths.length)}` : `Moved ${plural(paths.length)} to the Recycle Bin`,
    action: permanent ? undefined : { label: 'Undo', run: undo },
  });
  refresh(t);
}

export async function clipboardWrite(cut: boolean) {
  const paths = selectedPaths(activeTab());
  if (!paths.length) return;
  const ok = await attempt(invoke('clipboard_write_files', { paths, cut }).then(() => true), 'Clipboard is unavailable');
  if (ok) setCutSet(cut ? new Set(paths.map((p) => p.toLowerCase())) : new Set<string>());
}
export async function paste() {
  const t = activeTab();
  const dir = targetDir();
  if (!dir) return;
  const clip = await attempt(invoke('clipboard_read_files'), 'Clipboard is unavailable');
  if (clip === undefined) return;
  if (!clip || !clip.paths.length) { toast({ kind: 'info', text: 'Nothing to paste', detail: 'The clipboard has no files.' }); return; }
  await transferTo(clip.paths, dir, clip.cut ? 'move' : 'copy', t);
  if (clip.cut) { setCutSet(new Set<string>()); invoke('clipboard_write_files', { paths: [], cut: false }).catch(() => {}); }
}

export async function transferTo(paths: string[], destDir: string, mode: 'copy' | 'move', t: Tab = activeTab()) {
  if (!paths.length) return;
  if (paths.some((p) => samePath(p, destDir) || isInside(destDir, p))) { toast({ kind: 'error', text: "Can't move a folder into itself" }); return; }
  if (mode === 'move' && paths.every((p) => samePath(parentOf(p), destDir))) return;
  let res;
  try { res = await invoke('transfer', { paths, destDir, mode }); }
  catch (e) { toastError(e, `Couldn't ${mode} ${plural(paths.length)}`); return; }
  if (samePath(currentDir(t), destDir) && res.destPaths.length) expectSelection(t, res.destPaths.map(baseName));
  refreshDirs(destDir, ...paths.map(parentOf));
  toast({ kind: 'success', text: `${mode === 'move' ? 'Moved' : 'Copied'} ${plural(paths.length)} to ${displayName(destDir)}`, action: { label: 'Undo', run: undo } });
}

export async function undo() {
  const r = await attempt(invoke('undo'), "Couldn't undo");
  if (r === undefined) return;
  toast({ kind: 'info', text: r ? `Undone: ${r.description}` : 'Nothing to undo' });
  if (r) refreshDirs(...tabs().map((t) => currentDir(t)));
}
export async function redo() {
  const r = await attempt(invoke('redo'), "Couldn't redo");
  if (r === undefined) return;
  toast({ kind: 'info', text: r ? `Redone: ${r.description}` : 'Nothing to redo' });
  if (r) refreshDirs(...tabs().map((t) => currentDir(t)));
}

export async function copyPaths() {
  const t = activeTab();
  const paths = selectedPaths(t);
  const list = paths.length ? paths : currentDir(t) ? [currentDir(t)!] : [];
  if (!list.length) return;
  try {
    await navigator.clipboard.writeText(list.map((p) => `"${p}"`).join('\r\n'));
    toast({ kind: 'success', text: list.length === 1 ? 'Path copied' : `${list.length} paths copied` }, 2200);
  } catch (e) { toastError(e, "Couldn't copy the path"); }
}

export function openPicker(mode: 'move' | 'copy') {
  const paths = selectedPaths(activeTab());
  if (!paths.length) { toast({ kind: 'info', text: `Select items to ${mode}` }); return; }
  setPicker({ mode, paths });
}

export function properties() {
  const t = activeTab();
  const paths = selectedPaths(t);
  const list = paths.length ? paths : currentDir(t) ? [currentDir(t)!] : [];
  if (list.length) attempt(invoke('show_properties', { paths: list }), "Couldn't show properties");
}
export function terminalHere() {
  const t = activeTab();
  const idx = selectedIndices(t);
  const m = t.model();
  const dir = idx.length === 1 && isDir(m.flags[idx[0]]) ? pathAt(m, idx[0]) : currentDir(t);
  if (dir) attempt(invoke('open_terminal', { dir }), "Couldn't open the terminal");
}
export function openWith() {
  const p = selectedPaths(activeTab())[0];
  if (p) attempt(invoke('open_with', { path: p }), "Couldn't show Open with");
}

export const isPinned = (path: string) => settings.pinned.some((p) => samePath(p, path));
export function togglePin(path?: string) {
  const t = activeTab();
  const m = t.model();
  const idx = selectedIndices(t).filter((i) => isDir(m.flags[i]));
  const targets = path ? [path] : idx.length ? idx.map((i) => pathAt(m, i)) : currentDir(t) ? [currentDir(t)!] : [];
  if (!targets.length) return;
  const pin = !isPinned(targets[0]);
  setSettings('pinned', (list) => pin ? [...list, ...targets.filter((p) => !list.some((x) => samePath(x, p)))] : list.filter((x) => !targets.some((p) => samePath(x, p))));
}

export function setShowHidden(v: boolean) {
  setSettings('showHidden', v);
  tabs().forEach(refresh);
  toast({ kind: 'info', text: v ? 'Showing hidden items' : 'Hiding hidden items' }, 1800);
}

export function duplicateTab(t: Tab = activeTab()) {
  newTab(t.loc(), { after: t });
}
export function goHome(t: Tab = activeTab()) { navigate(t, { kind: 'home' }); }
export function goStorage(t: Tab = activeTab()) { navigate(t, { kind: 'storage' }); }
export const newTabHere = () => {
  const startup = settings.startup;
  newTab(startup && startup !== 'home' ? { kind: 'dir', path: startup } : { kind: 'home' }, { after: activeTab() });
};

// ── Archives ─────────────────────────────────────────────────────────────────
export const ARCHIVE_EXTS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'zst', 'tzst', 'lz4', 'cab', 'iso']);
export const isArchive = (name: string) => ARCHIVE_EXTS.has(extOf(name));
let archiveSeq = 0;
const progressListeners = new Map<number, (f: number | null) => void>();
let progressHooked = false;
function hookProgress() {
  if (progressHooked) return;
  progressHooked = true;
  listen('archive:progress', (p) => progressListeners.get(p.id)?.(p.total ? p.done / p.total : null)).catch(() => {});
}
async function runArchive(verb: 'Compressing' | 'Extracting', subject: string, call: (id: number) => Promise<string>, t: Tab) {
  hookProgress();
  const id = ++archiveSeq;
  const tid = toast({ kind: 'progress', text: `${verb} ${subject}…`, progress: null, action: { label: 'Cancel', run: () => { invoke('cancel_archive', { id }).catch(() => {}); } } });
  progressListeners.set(id, (f) => updateToast(tid, { progress: f }));
  try {
    const out = await call(id);
    const dir = parentOf(out);
    if (samePath(currentDir(t), dir)) expectSelection(t, [baseName(out)]);
    refreshDirs(dir);
    updateToast(tid, { kind: 'success', text: `${verb === 'Compressing' ? 'Created' : 'Extracted to'} ${baseName(out)}`, progress: undefined, action: undefined }, 3500);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'cancelled') updateToast(tid, { kind: 'info', text: 'Cancelled', progress: undefined, action: undefined }, 2500);
    else updateToast(tid, { kind: 'error', text: `${verb} failed`, detail: err.message, progress: undefined, action: undefined }, 7000);
  } finally { progressListeners.delete(id); }
}
export function compressSelection() {
  const t = activeTab();
  const paths = selectedPaths(t);
  if (!paths.length) return;
  runArchive('Compressing', paths.length === 1 ? baseName(paths[0]) : plural(paths.length), (id) => invoke('compress', { id, paths }), t);
}
export function extractSelection() {
  const t = activeTab();
  const archives = selectedPaths(t).filter((p) => isArchive(baseName(p)));
  for (const path of archives.slice(0, 8)) runArchive('Extracting', baseName(path), (id) => invoke('extract', { id, path }), t);
}

/** Go to the file's folder with it selected. */
/** Go to the folder that contains the (first) selected item, with it selected. */
export function openLocation() {
  const p = selectedPaths(activeTab())[0];
  if (p) revealPath(p);
}
export function revealPath(path: string, t: Tab = activeTab()) {
  const dir = parentOf(path);
  if (dir) navigate(t, { kind: 'dir', path: dir }, { sel: [baseName(path)] });
}
