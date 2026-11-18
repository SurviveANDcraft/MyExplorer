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
