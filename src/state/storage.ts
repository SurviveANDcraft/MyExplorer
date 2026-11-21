// Storage page state: treemap of a drive, cleanup suggestions, Recycle Bin. Everything is
// computed by the backend from the file index and pushed live via `disk:changed`.
import { batch, createSignal } from 'solid-js';
import { invoke, listen } from '../ipc/invoke';
import type { CleanupItem, CleanupList, DiskTree, RecycleBin } from '../ipc/types';
import { baseName, isInside, parentOf, samePath } from '../lib/fs';
import { diskChanged, undo } from '../commands/actions';
import { setSettings, settings } from './settings';
import { drives, indexStatus } from './system';
import { toast, toastError } from './ui';

/** Mirrors `disk.rs` categories (index = id). */
export const CATS = [
  { label: 'Other', color: '#9097a3' },
  { label: 'Video', color: '#e5534b' },
  { label: 'Images', color: '#e2a227' },
  { label: 'Audio', color: '#c2418a' },
  { label: 'Archives', color: '#8b6cf6' },
  { label: 'Documents', color: '#3b82f6' },
  { label: 'Code & dev', color: '#22a35a' },
  { label: 'Apps', color: '#14a3a3' },
  { label: 'Disk images', color: '#c0713a' },
  { label: 'System & temp', color: '#6b7a99' },
] as const;

export type SortBy = 'score' | 'size' | 'age';
export type Filter = 'all' | 'rebuildable' | 'temp' | 'installer' | 'archive' | 'duplicate' | 'stale' | 'media' | 'large';
export const FILTERS: { id: Filter; label: string; match: (s: CleanupItem) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'rebuildable', label: 'Rebuildable', match: (s) => s.kind === 'rebuildable' },
  { id: 'temp', label: 'Caches & temp', match: (s) => s.kind === 'temp' || s.kind === 'cache' },
  { id: 'installer', label: 'Installers', match: (s) => s.kind === 'installer' },
  { id: 'archive', label: 'Archives', match: (s) => s.kind === 'archive' || s.kind === 'diskimage' },
  { id: 'duplicate', label: 'Duplicates', match: (s) => s.kind === 'duplicate' },
  { id: 'stale', label: 'Old folders', match: (s) => s.kind === 'stale' },
  { id: 'media', label: 'Media', match: (s) => s.kind === 'media' },
  { id: 'large', label: 'Large files', match: (s) => s.kind === 'large' || s.kind === 'download' },
];

export const [drive, setDrive] = createSignal<string>('C:\\');
export const [zoom, setZoom] = createSignal<string>('C:\\');
export const [tree, setTree] = createSignal<DiskTree | null>(null);
/** Drive-level totals (kept while zoomed in). */
export const [summary, setSummary] = createSignal<{ path: string; size: number; files: number; cats: number[]; pending: number } | null>(null);
export const [sugg, setSugg] = createSignal<CleanupList | null>(null);
/** 'indexing': the file index isn't ready yet; 'missing': drive not indexed (removable, network). */
export const [phase, setPhase] = createSignal<'loading' | 'ready' | 'indexing' | 'missing'>('loading');
export const [minSize, setMinSize] = createSignal(50 * 2 ** 20);
export const [limit, setLimit] = createSignal(400);
export const [recycle, setRecycle] = createSignal<RecycleBin>({ size: 0, items: 0 });
/** Path hovered in the list: highlighted in the treemap. */
export const [hoverPath, setHoverPath] = createSignal<string | null>(null);
/** Category hovered in the legend: everything else dims in the treemap. */
export const [hoverCat, setHoverCat] = createSignal<number | null>(null);

// Optimistic removal: hidden at once, until a refresh started after the backend forgot them.
const gone = new Map<string, number>(); // lowercase path → when forgotten (Infinity while deleting)
const [goneV, setGoneV] = createSignal(0);
export { goneV };
export const isGone = (path: string) => {
  goneV();
  if (!gone.size) return false;
  const k = path.toLowerCase();
  for (const g of gone.keys()) if (k === g || k.startsWith(g + '\\')) return true;
  return false;
};
export const ignored = (path: string) => settings.storageIgnored.includes(path.toLowerCase());
export function ignore(path: string, on = true) {
  const k = path.toLowerCase();
  setSettings('storageIgnored', (l) => (on ? (l.includes(k) ? l : [...l, k].slice(-2000)) : l.filter((x) => x !== k)));
}

// ── Fetching (coalesced: one request in flight, at most ~1/s while things change) ─
let busy = false, again = false, timer = 0, lastAt = 0, mounted = 0, seq = 0;
const GAP = 900;

async function fetchNow() {
  if (busy) { again = true; return; }
  busy = true;
  const started = performance.now();
  lastAt = started;
  const my = ++seq;
  const [z, d] = [zoom(), drive()];
  try {
    const [t, s, r] = await Promise.all([
      invoke('disk_tree', { path: z }).catch(() => null),
      invoke('disk_suggest', { scope: d, minSize: minSize(), limit: limit() }).catch(() => null),
      invoke('recycle_bin_info').catch(() => null),
    ]);
    if (my !== seq || !samePath(z, zoom())) { again = true; return; }
    batch(() => {
      if (t) {
        setTree(t); setPhase('ready');
        if (samePath(t.path, d)) setSummary({ path: t.path, size: t.size, files: t.files, cats: t.cats, pending: t.pending });
      }
      else setPhase(indexStatus()?.state === 'ready' ? 'missing' : 'indexing');
      if (s) setSugg(s);
      if (r) setRecycle(r);
      let dropped = false;
      for (const [k, at] of gone) if (at < started) { gone.delete(k); dropped = true; }
      if (dropped) setGoneV((v) => v + 1);
    });
  } finally {
    busy = false;
    if (again) { again = false; schedule(); }
  }
}

/** Refresh soon (throttled). `now` skips the throttle (user action). */
export function schedule(now = false) {
  if (!mounted) return;
  clearTimeout(timer);
  const wait = now ? 0 : Math.max(0, GAP - (performance.now() - lastAt));
  timer = window.setTimeout(fetchNow, wait);
}

let unlisten: (() => void) | null = null;
export function mountStorage() {
  if (mounted++ === 0) {
    listen('disk:changed', () => schedule()).then((u) => { if (mounted) unlisten = u; else u(); }, () => {});
    listen('index:status', (s) => { if (s.state === 'ready' && phase() !== 'ready') schedule(true); }).then((u) => {
      const prev = unlisten; unlisten = () => { prev?.(); u(); };
    }, () => {});
  }
  schedule(true);
}
export function unmountStorage() {
  if (--mounted > 0) return;
  mounted = 0;
  clearTimeout(timer);
  unlisten?.(); unlisten = null;
  invoke('disk_release').catch(() => {});
}

export function chooseDrive(d: string) {
  batch(() => { setDrive(d); setZoom(d); setTree(null); setSugg(null); setSummary(null); setPhase('loading'); setLimit(400); });
  schedule(true);
}
export function zoomTo(path: string) {
  if (samePath(path, zoom())) return;
  setZoom(path);
  schedule(true);
}
export function setMin(v: number) { setMinSize(v); schedule(true); }
export function loadMore() { setLimit((l) => Math.min(5000, l + 400)); schedule(true); }

// ── Actions ──────────────────────────────────────────────────────────────────
/** Drop paths that are inside another path in the list. */
const outermost = (paths: string[]) => paths.filter((p) => !paths.some((q) => q !== p && isInside(p, q)));

export async function removePaths(paths: string[], permanent: boolean) {
  const ps = outermost([...new Set(paths)]);
  if (!ps.length) return;
  for (const p of ps) gone.set(p.toLowerCase(), Infinity);
  setGoneV((v) => v + 1);
  const n = ps.length;
  const what = n === 1 ? `"${baseName(ps[0])}"` : `${n} items`;
  try {
    await invoke('delete', { paths: ps, permanent });
  } catch (e) {
    for (const p of ps) gone.delete(p.toLowerCase());
    setGoneV((v) => v + 1);
    if ((e as { code?: string }).code !== 'cancelled') toastError(e, `Couldn't delete ${what}`);
    return;
  }
  await invoke('disk_forget', { paths: ps }).catch(() => {});
  const t = performance.now() - 1;
  for (const p of ps) gone.set(p.toLowerCase(), t);
  diskChanged(...ps, ...ps.map(parentOf));
  schedule(true);
  toast({
    kind: 'success',
    text: permanent ? `Deleted ${what}` : `Moved ${what} to the Recycle Bin`,
    detail: permanent ? undefined : 'Space is freed when the Recycle Bin is emptied.',
    action: permanent ? undefined : { label: 'Undo', run: () => { undo().then(() => schedule(true)); } },
  });
}

export async function emptyRecycleBin() {
  try {
    await invoke('empty_recycle_bin');
  } catch (e) { toastError(e, "Couldn't empty the Recycle Bin"); return; }
  diskChanged(...drives().map((d) => d.path));
  schedule(true);
}
