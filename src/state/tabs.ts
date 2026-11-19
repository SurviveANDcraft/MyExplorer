import { Accessor, batch, createSignal, Setter } from 'solid-js';
import { invoke, IS_TAURI } from '../ipc/invoke';
import type { AppError, DirListing, SearchHit, Sort } from '../ipc/types';
import { baseName, extOf, isDir, join, parentOf, samePath } from '../lib/fs';
import { folderView, FolderView, rememberFolderView, settings } from './settings';
import { displayName, ensureTypeNames, refreshFrecent } from './system';
import { cancelGrep, runGrep } from './grep';
import { searchContent, toastError, viewApi } from './ui';

export interface Model {
  dir: string | null;
  count: number;
  names: string[]; sizes: number[]; modified: number[]; flags: number[];
  paths: string[] | null;   // search results carry full paths
}
export const emptyModel = (dir: string | null = null): Model => ({ dir, count: 0, names: [], sizes: [], modified: [], flags: [], paths: null });
export const pathAt = (m: Model, i: number) => (m.paths ? m.paths[i] : join(m.dir!, m.names[i]));

export type Loc = { kind: 'home' } | { kind: 'dir'; path: string };
interface Hist { loc: Loc; sel: string[]; scroll: number }
export type Status = 'ready' | 'pending' | 'loading' | 'error';
/** content: search inside files (see state/grep.ts) instead of names. */
export interface SearchState { query: string; everywhere: boolean; kind: string; date: string; size: string; content?: boolean; caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }
export interface SearchMeta { total: number; tookMs: number; partial: boolean; terms: string[]; pending: boolean; scanned?: number }

export interface Tab {
  id: number;
  loc: Accessor<Loc>; setLoc: Setter<Loc>;
  back: Hist[]; fwd: Hist[]; hist: Accessor<number>; setHist: Setter<number>;
  model: Accessor<Model>; setModel: Setter<Model>;
  status: Accessor<Status>; setStatus: Setter<Status>;
  error: Accessor<AppError | null>; setError: Setter<AppError | null>;
  view: Accessor<FolderView>; setView: Setter<FolderView>;
  sel: Set<number>; selV: Accessor<number>; setSelV: Setter<number>;
  anchor: number;
  focus: Accessor<number>; setFocus: Setter<number>;
  navSeq: Accessor<{ n: number; dir: 'fwd' | 'back' | 'none' }>; setNavSeq: Setter<{ n: number; dir: 'fwd' | 'back' | 'none' }>;
  search: Accessor<SearchState | null>; setSearch: Setter<SearchState | null>;
  searchMeta: Accessor<SearchMeta | null>; setSearchMeta: Setter<SearchMeta | null>;
  searchSort: Accessor<Sort | null>; setSearchSort: Setter<Sort | null>;
  renaming: Accessor<number>; setRenaming: Setter<number>;
  scroll: number;
  token: number; reqId: number; watched: string | null;
  pendingSel: string[] | null; pendingFocusIndex: number; pendingRename: boolean;
  rawHits: SearchHit[];
}

let nextId = 1;
function createTab(loc: Loc): Tab {
  const s = <T,>(v: T, eq?: false) => createSignal<T>(v, eq === false ? { equals: false } : undefined);
  const [l, setLoc] = s<Loc>(loc);
  const [hist, setHist] = s(0);
  const [model, setModel] = s<Model>(emptyModel());
  const [status, setStatus] = s<Status>('ready');
  const [error, setError] = s<AppError | null>(null);
  const [view, setView] = s<FolderView>(folderView(loc.kind === 'dir' ? loc.path : null));
  const [selV, setSelV] = s(0);
  const [focus, setFocus] = s(-1);
  const [navSeq, setNavSeq] = s({ n: 0, dir: 'none' as 'fwd' | 'back' | 'none' });
  const [search, setSearch] = s<SearchState | null>(null);
  const [searchMeta, setSearchMeta] = s<SearchMeta | null>(null);
  const [searchSort, setSearchSort] = s<Sort | null>(null);
  const [renaming, setRenaming] = s(-1);
  return {
    id: nextId++, loc: l, setLoc, back: [], fwd: [], hist, setHist, model, setModel, status, setStatus, error, setError, view, setView,
    sel: new Set(), selV, setSelV, anchor: -1, focus, setFocus, navSeq, setNavSeq, search, setSearch, searchMeta, setSearchMeta,
    searchSort, setSearchSort, renaming, setRenaming, scroll: 0, token: 0, reqId: 0, watched: null, pendingSel: null, pendingFocusIndex: -1,
    pendingRename: false, rawHits: [],
  };
}

const [tabs, setTabs] = createSignal<Tab[]>([]);
const [activeId, setActiveId] = createSignal(0);
export { tabs, setTabs, activeId };
export const activeTab = (): Tab => tabs().find((t) => t.id === activeId()) ?? tabs()[0];
export const currentDir = (t: Tab = activeTab()) => { const l = t.loc(); return l.kind === 'dir' ? l.path : null; };

export function tabTitle(t: Tab) {
  const l = t.loc();
  return l.kind === 'home' ? 'Home' : displayName(l.path);
}

export function newTab(loc: Loc, opts: { activate?: boolean; after?: Tab } = {}) {
  const t = createTab(loc);
  setTabs((list) => {
    const i = opts.after ? list.indexOf(opts.after) : -1;
    return i < 0 ? [...list, t] : [...list.slice(0, i + 1), t, ...list.slice(i + 1)];
  });
  if (opts.activate !== false) setActiveId(t.id);
  if (loc.kind === 'dir') { watch(t, loc.path); loadDir(t, loc.path, 'nav'); recordVisit(loc.path); }
  return t;
}
export function activate(id: number) {
  setActiveId(id);
}
export async function closeTab(t: Tab) {
  const list = tabs();
  if (list.length === 1) {
    if (IS_TAURI) { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().close(); return; }
    navigate(t, { kind: 'home' });
    return;
  }
  const i = list.indexOf(t);
  watch(t, null);
  setTabs(list.filter((x) => x !== t));
  if (activeId() === t.id) setActiveId(list[i + 1]?.id ?? list[i - 1].id);
}
export function moveTab(from: number, to: number) {
  setTabs((l) => { const c = [...l]; const [t] = c.splice(from, 1); c.splice(to, 0, t); return c; });
}

function watch(t: Tab, path: string | null) {
  if (samePath(t.watched, path)) return;
  if (t.watched) invoke('unwatch_dir', { path: t.watched }).catch(() => {});
  t.watched = path;
  if (path) invoke('watch_dir', { path }).catch(() => {});
}
function recordVisit(path: string) {
  invoke('record_visit', { path, isDir: true }).then(refreshFrecent, () => {});
}

// ── Navigation ───────────────────────────────────────────────────────────────
function snapshot(t: Tab): Hist {
  const m = t.model();
  const sel: string[] = [];
  for (const i of t.sel) { if (sel.length >= 64) break; if (i < m.count) sel.push(m.names[i]); }
  return { loc: t.loc(), sel, scroll: t.scroll };
}

export function navigate(t: Tab, loc: Loc, opts: { push?: boolean; dir?: 'fwd' | 'back'; sel?: string[]; scroll?: number } = {}) {
  const cur = t.loc();
  const same = cur.kind === loc.kind && (loc.kind === 'home' || samePath((cur as { path: string }).path, loc.path));
  if (same && !t.search()) { if (loc.kind === 'dir') refresh(t); return; }
  if (opts.push !== false && !same) { t.back.push(snapshot(t)); if (t.back.length > 100) t.back.shift(); t.fwd.length = 0; }
  t.setHist((n) => n + 1);
  t.setRenaming(-1);
  t.pendingSel = opts.sel ?? null;
  t.pendingFocusIndex = -1;
  t.scroll = opts.scroll ?? 0;
  batch(() => {
    t.setSearch(null);
    t.setSearchMeta(null);
    t.setLoc(loc);
    t.setError(null);
  });
  if (loc.kind === 'home') {
    t.token++;
    watch(t, null);
    batch(() => { t.setStatus('ready'); t.setModel(emptyModel()); t.sel.clear(); t.setSelV((v) => v + 1); });
    return;
  }
  t.setView(folderView(loc.path));
  watch(t, loc.path);
  recordVisit(loc.path);
  loadDir(t, loc.path, 'nav', opts.dir ?? 'fwd');
}
export const openDir = (path: string, t: Tab = activeTab()) => navigate(t, { kind: 'dir', path });

export function goBack(t: Tab) {
  const h = t.back.pop();
  if (!h) return;
  t.fwd.push(snapshot(t));
  navigate(t, h.loc, { push: false, dir: 'back', sel: h.sel, scroll: h.scroll });
}
export function goForward(t: Tab) {
  const h = t.fwd.pop();
  if (!h) return;
  t.back.push(snapshot(t));
  navigate(t, h.loc, { push: false, dir: 'fwd', sel: h.sel, scroll: h.scroll });
}
export function goUp(t: Tab) {
  const d = currentDir(t);
  if (t.search()) { exitSearch(t); return; }
  if (!d) return;
  const p = parentOf(d);
  if (p) navigate(t, { kind: 'dir', path: p }, { dir: 'back', sel: [baseName(d)] });
  else navigate(t, { kind: 'home' }, { dir: 'back' });
}
export function refresh(t: Tab) {
  if (t.search()) { runSearch(t); return; }
  const d = currentDir(t);
  if (d) loadDir(t, d, 'refresh');
}

async function loadDir(t: Tab, path: string, mode: 'nav' | 'refresh', dir: 'fwd' | 'back' | 'none' = 'none') {
  const token = ++t.token;
  if (mode === 'nav') t.setStatus('pending');
  const timer = setTimeout(() => { if (token === t.token && mode === 'nav') t.setStatus('loading'); }, 150);
  try {
    const l = await invoke('list_dir', { path, sort: t.view().sort, showHidden: settings.showHidden });
    if (token !== t.token || t.search()) return;
    applyModel(t, fromListing(l), mode, dir);
  } catch (e) {
    if (token !== t.token) return;
    const err = e as AppError;
    if (mode === 'nav') {
      batch(() => { t.setModel(emptyModel(path)); t.setError(err); t.setStatus('error'); t.sel.clear(); t.setSelV((v) => v + 1); t.setNavSeq((s) => ({ n: s.n + 1, dir })); });
    }
    toastError(err, mode === 'nav' ? `Couldn't open ${displayName(path)}` : `Couldn't refresh ${displayName(path)}`);
  } finally {
    clearTimeout(timer);
  }
}

function fromListing(l: DirListing): Model {
  ensureTypeNames(l.names, l.flags);
  return { dir: l.path, count: l.names.length, names: l.names, sizes: l.sizes, modified: l.modified, flags: l.flags, paths: null };
}

/** Tabs whose next listing comes from a sort change: land at the top, or centred on the selection. */
const sortJump = new WeakSet<Tab>();
function jumpAfterSort(t: Tab, focus: number) {
  const target = t.sel.size ? (t.sel.has(focus) ? focus : Math.min(...t.sel)) : -1;
  queueMicrotask(() => (target >= 0 ? viewApi.center(target) : viewApi.toTop()));
}

function applyModel(t: Tab, m: Model, mode: 'nav' | 'refresh', dir: 'fwd' | 'back' | 'none') {
  const jump = sortJump.has(t);
  sortJump.delete(t);
  const old = t.model();
  let want: Set<string> | null = null;
  let focusName: string | null = null;
  let renameName: string | null = null;
  if (mode === 'refresh') {
    if (t.sel.size) want = new Set([...t.sel].filter((i) => i < old.count).map((i) => old.names[i].toLowerCase()));
    const f = t.focus();
    if (f >= 0 && f < old.count) focusName = old.names[f].toLowerCase();
    const r = t.renaming();
    if (r >= 0 && r < old.count) renameName = old.names[r].toLowerCase();
  }
  if (t.pendingSel) {
    want = new Set(t.pendingSel.map((s) => s.toLowerCase()));
    focusName = t.pendingSel[0]?.toLowerCase() ?? null;
    t.pendingSel = null;
  }
  t.sel.clear();
  let focus = -1, rename = -1;
  if (want?.size || focusName || renameName) {
    for (let i = 0; i < m.count; i++) {
      const n = m.names[i].toLowerCase();
      if (want?.has(n)) t.sel.add(i);
      if (n === focusName) focus = i;
      if (n === renameName) rename = i;
    }
  }
  if (focus < 0 && t.sel.size) focus = Math.min(...t.sel);
  if (t.pendingFocusIndex >= 0 && !t.sel.size && m.count) {
    focus = Math.min(t.pendingFocusIndex, m.count - 1);
    t.sel.add(focus);
  }
  t.pendingFocusIndex = -1;
  const startRename = t.pendingRename && t.sel.size === 1;
  t.pendingRename = false;
  batch(() => {
    t.setModel(m);
    t.setStatus('ready');
    t.setError(null);
    t.setFocus(focus);
    t.anchor = focus;
    t.setSelV((v) => v + 1);
    t.setRenaming(startRename ? focus : rename);
    if (mode === 'nav') t.setNavSeq((s) => ({ n: s.n + 1, dir }));
  });
  if (jump) jumpAfterSort(t, focus);
  else if (focus >= 0 && (mode === 'nav' || startRename || t.sel.size)) queueMicrotask(() => viewApi.reveal(focus));
}

/** Select these names after the next refresh (paste, new folder, …). */
export function expectSelection(t: Tab, names: string[], rename = false) {
  t.pendingSel = names;
  t.pendingRename = rename;
}

// ── View / sort ──────────────────────────────────────────────────────────────
export function updateView(t: Tab, patch: Partial<FolderView>) {
  const v = { ...t.view(), ...patch };
  t.setView(v);
  const d = currentDir(t);
  if (d) rememberFolderView(d, v);
  if (patch.sort && !t.search()) { sortJump.add(t); refresh(t); }
}
export function sortBy(t: Tab, key: Sort['key']) {
  if (t.search()) {
    const cur = t.searchSort();
    const next = cur?.key === key ? (cur.desc ? null : { ...cur, desc: true }) : { key, desc: key === 'modified' || key === 'size', foldersFirst: false };
    t.setSearchSort(next);
    applyHits(t);
    queueMicrotask(() => viewApi.toTop());
    return;
  }
  const s = t.view().sort;
  updateView(t, { sort: { ...s, key, desc: s.key === key ? !s.desc : key === 'modified' || key === 'size' } });
}

// ── Search ───────────────────────────────────────────────────────────────────
let reqCounter = 0;
export function setSearchQuery(t: Tab, patch: Partial<SearchState>) {
  const cur = t.search() ?? { query: '', everywhere: t.loc().kind === 'home', kind: '', date: '', size: '', content: searchContent() };
  const next = { ...cur, ...patch };
  if (!settings.contentSearch) next.content = false;
  if (!next.query.trim() && (next.content || (!next.kind && !next.date && !next.size))) { if (t.search()) exitSearch(t); return; }
  if (!t.search()) { t.back.push(snapshot(t)); t.fwd.length = 0; t.setHist((n) => n + 1); t.scroll = 0; t.setSearchSort(null); }
  t.setSearch(next);
  runSearch(t);
}
export function exitSearch(t: Tab) {
  if (!t.search()) return;
  if (t.search()!.content) cancelGrep(t);
  t.reqId = ++reqCounter;
  const h = t.back[t.back.length - 1];
  if (h && h.loc === t.loc()) t.back.pop();
  batch(() => { t.setSearch(null); t.setSearchMeta(null); });
  const d = currentDir(t);
  t.pendingSel = h?.sel ?? null;
  t.scroll = h?.scroll ?? 0;
  if (d) loadDir(t, d, 'nav', 'none');
  else batch(() => { t.setModel(emptyModel()); t.sel.clear(); t.setSelV((v) => v + 1); });
}
const buildQuery = (s: SearchState) =>
  [s.query.trim(), s.kind && `kind:${s.kind}`, s.date && `modified:${s.date}`, s.size && `size:${s.size}`].filter(Boolean).join(' ');

export async function runSearch(t: Tab) {
  const s = t.search();
  if (!s) return;
  const id = ++reqCounter;
  t.reqId = id;
  if (s.content) { runGrep(t, id, s); return; }
  cancelGrep(t);
  const scope = s.everywhere ? null : currentDir(t);
  t.setSearchMeta((m) => ({ total: m?.total ?? 0, tookMs: m?.tookMs ?? 0, partial: m?.partial ?? false, terms: m?.terms ?? [], pending: true }));
  try {
    const r = await invoke('search', { reqId: id, query: buildQuery(s), options: { scope, limit: 2000, offset: 0, includeHidden: settings.showHidden } });
    if (r.reqId !== id || t.reqId !== id || !t.search()) return;
    t.rawHits = r.hits;
    batch(() => {
      applyHits(t);
      t.setSearchMeta({ total: r.total, tookMs: r.tookMs, partial: r.partial, terms: r.terms, pending: false });
      t.setNavSeq((x) => ({ n: x.n + 1, dir: 'none' }));
    });
  } catch (e) {
    if (t.reqId !== id) return;
    t.setSearchMeta((m) => (m ? { ...m, pending: false } : null));
    toastError(e, 'Search failed');
  }
}

function applyHits(t: Tab) {
  let hits = t.rawHits;
  const s = t.searchSort();
  if (s) {
    const dir = s.desc ? -1 : 1;
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    hits = [...hits].sort((a, b) => dir * (
      s.key === 'size' ? a.size - b.size : s.key === 'modified' ? a.modified - b.modified :
      s.key === 'type' ? coll.compare(extOf(a.name), extOf(b.name)) || coll.compare(a.name, b.name) : coll.compare(a.name, b.name)));
  }
  const m: Model = {
    dir: null, count: hits.length, names: hits.map((h) => h.name), sizes: hits.map((h) => h.size),
    modified: hits.map((h) => h.modified), flags: hits.map((h) => h.flags), paths: hits.map((h) => h.path),
  };
  ensureTypeNames(m.names, m.flags);
  t.sel.clear();
  t.setModel(m);
  t.setFocus(-1);
  t.anchor = -1;
  t.setStatus('ready');
  t.setSelV((v) => v + 1);
}

// ── Selection ────────────────────────────────────────────────────────────────
const bump = (t: Tab) => t.setSelV((v) => v + 1);
export const isSel = (t: Tab, i: number) => { t.selV(); return t.sel.has(i); };
export function selectOnly(t: Tab, i: number) {
  t.sel.clear();
  if (i >= 0) t.sel.add(i);
  t.anchor = i;
  batch(() => { t.setFocus(i); bump(t); });
}
export function toggleSel(t: Tab, i: number) {
  if (t.sel.has(i)) t.sel.delete(i); else t.sel.add(i);
  t.anchor = i;
  batch(() => { t.setFocus(i); bump(t); });
}
export function selectRange(t: Tab, to: number, additive = false) {
  const from = t.anchor >= 0 ? t.anchor : to;
  if (!additive) t.sel.clear();
  const [lo, hi] = from < to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) t.sel.add(i);
  if (t.anchor < 0) t.anchor = to;
  batch(() => { t.setFocus(to); bump(t); });
}
export function setSelection(t: Tab, s: Set<number>) {
  t.sel = s;
  bump(t);
}
export function selectAll(t: Tab) {
  const n = t.model().count;
  for (let i = 0; i < n; i++) t.sel.add(i);
  bump(t);
}
export function clearSel(t: Tab) {
  if (!t.sel.size) return;
  t.sel.clear();
  bump(t);
}
export function invertSel(t: Tab) {
  const n = t.model().count;
  const s = new Set<number>();
  for (let i = 0; i < n; i++) if (!t.sel.has(i)) s.add(i);
  setSelection(t, s);
}
export const selCount = (t: Tab) => { t.selV(); return t.sel.size; };
/** The item previews act on: the focused row if it's selected (or nothing is), else the first selected row. -1 if none. */
export function previewIndex(t: Tab): number {
  t.selV();
  const f = t.focus();
  let first = -1;
  if (!(f >= 0 && (t.sel.has(f) || !t.sel.size))) for (const x of t.sel) if (first < 0 || x < first) first = x;
  const i = first >= 0 ? first : f;
  return i >= 0 && i < t.model().count ? i : -1;
}
export const selectedIndices = (t: Tab) => { t.selV(); return [...t.sel].filter((i) => i < t.model().count).sort((a, b) => a - b); };
export const selectedPaths = (t: Tab) => { const m = t.model(); return selectedIndices(t).map((i) => pathAt(m, i)); };
export const selectionHasDir = (t: Tab) => { const m = t.model(); return selectedIndices(t).some((i) => isDir(m.flags[i])); };
export function sortByRelevance(t: Tab) {
  t.setSearchSort(null);
  applyHits(t);
}
