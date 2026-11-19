import { createSignal } from 'solid-js';
import { invoke, listen } from '../ipc/invoke';
import type { Drive, Frecent, IndexStatus, KnownFolders } from '../ipc/types';
import { baseName, extOf, isDir, isRoot } from '../lib/fs';
import type { IconName } from '../lib/icons';
import { attempt } from './ui';

export const [drives, setDrives] = createSignal<Drive[]>([]);
export const [known, setKnown] = createSignal<KnownFolders | null>(null);
export const [frecentDirs, setFrecentDirs] = createSignal<Frecent[]>([]);
export const [recentFiles, setRecentFiles] = createSignal<Frecent[]>([]);
export const [indexStatus, setIndexStatus] = createSignal<IndexStatus | null>(null);

export async function loadSystem() {
  const [d, k] = await Promise.all([attempt(invoke('get_drives')), attempt(invoke('get_known_folders'))]);
  if (d) setDrives(d);
  if (k) setKnown(k);
  refreshFrecent();
  attempt(invoke('index_status')).then((s) => s && setIndexStatus(s));
  listen('index:status', setIndexStatus).catch(() => {});
}
let frecTimer = 0;
export function refreshFrecent() {
  clearTimeout(frecTimer);
  frecTimer = window.setTimeout(async () => {
    const [d, f] = await Promise.all([attempt(invoke('get_frecent', { kind: 'dir', limit: 12 })), attempt(invoke('get_frecent', { kind: 'file', limit: 16 }))]);
    if (d) setFrecentDirs(d);
    if (f) setRecentFiles(f);
  }, 250);
}

export interface KnownEntry { key: keyof KnownFolders; label: string; icon: IconName; path: string }
export function knownEntries(): KnownEntry[] {
  const k = known();
  if (!k) return [];
  const list: [keyof KnownFolders, string, IconName][] = [
    ['desktop', 'Desktop', 'pc'], ['downloads', 'Downloads', 'download'], ['documents', 'Documents', 'documents'],
    ['pictures', 'Pictures', 'image'], ['music', 'Music', 'music'], ['videos', 'Videos', 'video'],
  ];
  return list.map(([key, label, icon]) => ({ key, label, icon, path: k[key] as string }));
}

export function driveLabel(d: Drive) {
  const letter = d.path.slice(0, 2);
  const label = d.label || (d.kind === 'removable' ? 'USB Drive' : d.kind === 'network' ? 'Network Drive' : 'Local Disk');
  return `${label} (${letter})`;
}
export function displayName(path: string) {
  if (isRoot(path)) {
    const d = drives().find((x) => x.path.toLowerCase().startsWith(path.slice(0, 2).toLowerCase()));
    return d ? driveLabel(d) : path.slice(0, 2);
  }
  const k = known();
  if (k?.onedrive && path.toLowerCase() === k.onedrive.toLowerCase()) return 'OneDrive';
  return baseName(path);
}
export function iconForPath(path: string): IconName {
  if (isRoot(path)) return 'drive';
  const k = known();
  if (k) {
    const lp = path.toLowerCase();
    for (const e of knownEntries()) if (e.path.toLowerCase() === lp) return e.icon;
    if (k.onedrive && lp === k.onedrive.toLowerCase()) return 'cloud';
    if (lp === k.home.toLowerCase()) return 'home';
  }
  return 'folder';
}

// ── Shell type names (Type column) ───────────────────────────────────────────
const typeCache = new Map<string, string>();
const pending = new Set<string>();
const [typeV, setTypeV] = createSignal(0);
export function typeName(name: string, flags: number) {
  if (isDir(flags)) return 'File folder';
  typeV();
  const e = extOf(name);
  return typeCache.get(e) ?? (e ? `${e.toUpperCase()} File` : 'File');
}
export function ensureTypeNames(names: string[], flags: number[]) {
  const want: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < names.length; i++) {
    if (isDir(flags[i])) continue;
    const e = extOf(names[i]);
    if (seen.has(e)) continue;
    seen.add(e);
    if (!typeCache.has(e) && !pending.has(e)) { want.push(e); pending.add(e); }
  }
  if (!want.length) return;
  invoke('type_names', { exts: want }).then((r) => {
    want.forEach((e, i) => { typeCache.set(e, r[i] || (e ? `${e.toUpperCase()} File` : 'File')); pending.delete(e); });
    setTypeV((v) => v + 1);
  }, () => want.forEach((e) => pending.delete(e)));
}

// ── Clipboard state (dims cut items) ─────────────────────────────────────────
export const [cutSet, setCutSet] = createSignal<Set<string>>(new Set());
export const isCut = (path: string) => cutSet().size > 0 && cutSet().has(path.toLowerCase());

// ── Live drive space ─────────────────────────────────────────────────────────
let driveT = 0, driveBusy = false, driveAgain = false;
/** Re-read free/total space (coalesced: at most one request in flight, trailing 300 ms). */
export function refreshDrives(delay = 300) {
  clearTimeout(driveT);
  driveT = window.setTimeout(async () => {
    if (driveBusy) { driveAgain = true; return; }
    driveBusy = true;
    try {
      const d = await invoke('get_drives').catch(() => null);
      if (d) setDrives((old) => (JSON.stringify(old) === JSON.stringify(d) ? old : d));
    } finally {
      driveBusy = false;
      if (driveAgain) { driveAgain = false; refreshDrives(); }
    }
  }, delay);
}
let liveStarted = false;
/** Keep drive numbers current while the app is in use (other apps change disks too). */
export function startLiveDrives() {
  if (liveStarted) return;
  liveStarted = true;
  window.setInterval(() => { if (document.visibilityState === 'visible') refreshDrives(0); }, 15_000);
  window.addEventListener('focus', () => refreshDrives(0));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshDrives(0); });
}
