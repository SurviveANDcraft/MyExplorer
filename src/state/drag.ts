import { createSignal } from 'solid-js';
import { transferTo } from '../commands/actions';
import { invoke, IS_TAURI } from '../ipc/invoke';
import { isInside, parentOf, samePath } from '../lib/fs';
import { displayName } from './system';
import { activate, currentDir } from './tabs';
import { toastError } from './ui';

export interface DragInfo { paths: string[]; name: string; flags: number }
export interface DragState extends DragInfo { x: number; y: number; target: string | null; copy: boolean; external?: boolean }
export const [drag, setDrag] = createSignal<DragState | null>(null);

const sameDrive = (a: string, b: string) => a.slice(0, 2).toLowerCase() === b.slice(0, 2).toLowerCase();

function resolveTarget(x: number, y: number, paths: string[]) {
  const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-drop]') ?? null;
  let target = el?.dataset.drop || null;
  if (target && paths.some((p) => samePath(p, target) || isInside(target!, p))) target = null;
  return { el: target ? el : null, target };
}
const decideCopy = (paths: string[], target: string | null, ctrl: boolean, shift: boolean) =>
  ctrl || (!shift && !!target && !!paths[0] && !sameDrive(paths[0], target));

let overEl: HTMLElement | null = null;
function highlight(el: HTMLElement | null) {
  if (el === overEl) return;
  overEl?.classList.remove('drop-over');
  el?.classList.add('drop-over');
  overEl = el;
}
let tabTimer = 0, tabHover: string | null = null;
function springTab(x: number, y: number) {
  const t = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-tab-id]');
  const id = t?.dataset.tabId ?? null;
  if (id === tabHover) return;
  tabHover = id;
  clearTimeout(tabTimer);
  if (id) tabTimer = window.setTimeout(() => activate(Number(id)), 550);
}

/** Starts tracking a potential drag from a pointerdown. Calls `onClick` if the pointer is released without dragging. */
export function trackDrag(e: PointerEvent, info: () => DragInfo, onClick?: (ev: PointerEvent) => void) {
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  let data: DragInfo | null = null;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      data = info();
      if (!data.paths.length) { cleanup(); return; }
      started = true;
      document.documentElement.classList.add('is-dragging');
    }
    // Leaving the window hands the drag to Windows, so files can drop into any app.
    if (IS_TAURI && (ev.clientX <= 0 || ev.clientY <= 0 || ev.clientX >= window.innerWidth - 1 || ev.clientY >= window.innerHeight - 1)) {
      const paths = data!.paths;
      cleanup();
      invoke('drag_out', { paths }).catch((e) => toastError(e, "Couldn't drag these files out"));
      return;
    }
    const { el, target } = resolveTarget(ev.clientX, ev.clientY, data!.paths);
    highlight(el);
    springTab(ev.clientX, ev.clientY);
    setDrag({ ...data!, x: ev.clientX, y: ev.clientY, target, copy: decideCopy(data!.paths, target, ev.ctrlKey, ev.shiftKey) });
  };
  const up = (ev: PointerEvent) => {
    const d = drag();
    cleanup();
    if (!started) { onClick?.(ev); return; }
    if (d?.target) {
      const noop = !d.copy && d.paths.every((p) => samePath(parentOf(p), d.target));
      if (!noop) transferTo(d.paths, d.target, d.copy ? 'copy' : 'move');
    }
  };
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); cleanup(); } };
  function cleanup() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', key, true);
    document.documentElement.classList.remove('is-dragging');
    highlight(null);
    clearTimeout(tabTimer); tabHover = null;
    setDrag(null);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', key, true);
}

export const dropLabel = (d: DragState) => (d.target ? `${d.copy ? 'Copy' : 'Move'} to ${displayName(d.target)}` : '');

/** External files dropped onto the window (Tauri native drag-drop). */
export async function initExternalDrop() {
  if (!IS_TAURI) return;
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  try {
    await getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === 'leave') { highlight(null); setDrag(null); return; }
      const dpr = window.devicePixelRatio || 1;
      const x = p.position.x / dpr, y = p.position.y / dpr;
      const paths = p.type === 'enter' ? p.paths : drag()?.paths ?? [];
      if (p.type === 'enter' || p.type === 'over') {
        const { el, target } = resolveTarget(x, y, paths);
        const dest = target ?? currentDir();
        highlight(el);
        springTab(x, y);
        setDrag({ paths, name: paths[0]?.split('\\').pop() ?? '', flags: 0, x, y, target: dest, copy: decideCopy(paths, dest, false, false), external: true });
        return;
      }
      const d = drag();
      highlight(null);
      setDrag(null);
      const files = p.paths.length ? p.paths : d?.paths ?? [];
      const dest = resolveTarget(x, y, files).target ?? currentDir();
      if (dest && files.length) transferTo(files, dest, decideCopy(files, dest, false, false) ? 'copy' : 'move');
    });
  } catch (e) { toastError(e, 'File drop is unavailable'); }
}
