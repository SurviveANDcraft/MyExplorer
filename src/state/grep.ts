// "Search in files": streams content matches from the backend (`grep:batch`) into per-tab state.
import { createSignal, Signal } from 'solid-js';
import { invoke, listen } from '../ipc/invoke';
import type { FileHit } from '../ipc/types';
import { settings } from './settings';
import { currentDir, SearchState, Tab, tabs } from './tabs';
import { toastError } from './ui';

export interface GrepState { files: FileHit[]; scanned: number; matched: number; done: boolean; tookMs: number; error: string | null; query: string }
const EMPTY: GrepState = { files: [], scanned: 0, matched: 0, done: true, tookMs: 0, error: null, query: '' };

const states = new Map<number, Signal<GrepState>>();
function sig(t: Tab) {
  let s = states.get(t.id);
  if (!s) { s = createSignal<GrepState>(EMPTY); states.set(t.id, s); }
  return s;
}
export const grepState = (t: Tab) => sig(t)[0]();

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  listen('grep:batch', (b) => {
    const t = tabs().find((x) => x.reqId === b.reqId && x.search()?.content);
    if (!t) return;
    const [get, set] = sig(t);
    const cur = get();
    let files = cur.files;
    if (b.files.length) files = [...files, ...b.files].sort((a, c) => c.score - a.score || a.path.length - c.path.length);
    set({ ...cur, files, scanned: b.scanned, matched: b.matched, done: b.done, tookMs: b.tookMs });
    t.setSearchMeta({ total: b.matched, tookMs: b.tookMs, partial: false, terms: [], pending: !b.done, scanned: b.scanned });
  }).catch(() => {});
}

const timers = new Map<number, number>();
export function runGrep(t: Tab, id: number, s: SearchState) {
  hook();
  clearTimeout(timers.get(t.id));
  const q = s.query.trim();
  const [, set] = sig(t);
  if (q.length < (s.regex ? 1 : 2)) {
    invoke('cancel_grep').catch(() => {});
    set({ ...EMPTY, query: q });
    t.setSearchMeta(null);
    return;
  }
  t.setSearchMeta((m) => ({ total: m?.total ?? 0, tookMs: m?.tookMs ?? 0, partial: false, terms: [], pending: true, scanned: m?.scanned }));
  // Short debounce: each keystroke restarts a disk-wide scan, so let typing settle first.
  timers.set(t.id, window.setTimeout(() => {
    if (t.reqId !== id) return;
    set({ ...EMPTY, done: false, query: q });
    const options = {
      scope: s.everywhere ? null : currentDir(t),
      caseSensitive: !!s.caseSensitive, wholeWord: !!s.wholeWord, regex: !!s.regex, includeHidden: settings.showHidden,
    };
    invoke('grep', { reqId: id, query: q, options }).catch((e) => {
      if (t.reqId !== id) return;
      set({ ...EMPTY, query: q, error: (e as { message?: string }).message ?? 'Search failed' });
      t.setSearchMeta(null);
      if ((e as { code?: string }).code !== 'invalid_name') toastError(e, 'Search in files failed');
    });
  }, 160));
}

export function cancelGrep(t: Tab) {
  clearTimeout(timers.get(t.id));
  const s = states.get(t.id);
  if (!s) return;
  if (!s[0]().done) invoke('cancel_grep').catch(() => {});
  s[1](EMPTY);
}
