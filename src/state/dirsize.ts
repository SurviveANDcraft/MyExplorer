import { createSignal } from 'solid-js';
import { invoke, toAppError } from '../ipc/invoke';
import type { DirSize } from '../ipc/types';

/** Folder totals computed this session (the backend caches too, so repeat hovers are instant). */
const known = new Map<string, DirSize>();
const failed = new Map<string, string>();
const [ver, setVer] = createSignal(0);
const k = (p: string) => p.toLowerCase();
export const knownSize = (path: string) => { ver(); return known.get(k(path)); };
export const sizeError = (path: string) => { ver(); return failed.get(k(path)); };

export interface SizeTip { path: string; x: number; y: number }
const [tip, setTip] = createSignal<SizeTip | null>(null);
export const sizeTip = tip;

const START_MS = 60;   // skip folders the pointer merely sweeps across
const SHOW_MS = 320;   // card appears after a short, deliberate hover
let cur: string | null = null;
let startT = 0, showT = 0, seq = 0, inflight = false;

/** Pointer is over folder `path` (or nothing: null). Computes its size and shows the hover card. */
export function hoverDir(path: string | null, x = 0, y = 0) {
  if (path === cur) return;
  clearTimeout(startT); clearTimeout(showT);
  if (inflight) { inflight = false; invoke('cancel_dir_size').catch(() => {}); }
  if (tip()) setTip(null);
  cur = path;
  if (!path) return;
  const my = ++seq;
  startT = window.setTimeout(() => {
    inflight = true;
    invoke('dir_size', { path })
      .then((r) => { if (r) { known.set(k(path), r); failed.delete(k(path)); setVer((v) => v + 1); } })
      .catch((e) => { failed.set(k(path), toAppError(e).message); setVer((v) => v + 1); })
      .finally(() => { if (my === seq) inflight = false; });
  }, known.has(k(path)) ? 0 : START_MS);
  showT = window.setTimeout(() => setTip({ path, x, y }), SHOW_MS);
}
export const endHover = () => hoverDir(null);

// ── Keeping totals true ──────────────────────────────────────────────────────
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith('\\') ? root : root + '\\');
const stale = new Set<string>();
let refetchT = 0;
/** Recompute stale totals one at a time, yielding to hover requests (which cancel ours). */
function refetchNext() {
  clearTimeout(refetchT);
  refetchT = window.setTimeout(() => {
    if (inflight || cur) { refetchNext(); return; }
    const path = stale.values().next().value;
    if (!path) return;
    stale.delete(path);
    inflight = true;
    invoke('dir_size', { path })
      .then((r) => { if (r) { known.set(path, r); setVer((v) => v + 1); } else stale.add(path); })
      .catch(() => {})
      .finally(() => { inflight = false; if (stale.size) refetchNext(); });
  }, 250);
}
/** Something changed at `paths`: drop totals for them, their parents and their contents, then recompute the ones on screen. */
export function invalidateSizes(paths: (string | null | undefined)[]) {
  const ps = paths.filter((p): p is string => !!p).map(k);
  if (!ps.length) return;
  let hit = false;
  for (const key of [...known.keys()]) {
    if (ps.some((p) => within(p, key) || within(key, p))) {
      known.delete(key);
      failed.delete(key);
      // Recompute it so the number stays on screen (deleted folders just drop out).
      stale.add(key);
      hit = true;
    }
  }
  invoke('invalidate_dir_sizes', { paths: paths.filter((p): p is string => !!p) }).catch(() => {});
  if (hit) { setVer((v) => v + 1); refetchNext(); }
}
