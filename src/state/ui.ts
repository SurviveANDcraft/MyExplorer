import { createSignal } from 'solid-js';
import { toAppError } from '../ipc/invoke';
import type { IconName } from '../lib/icons';

export interface Toast { id: number; kind: 'info' | 'error' | 'success' | 'progress'; text: string; detail?: string; action?: { label: string; run: () => void }; /** 0–1, or null = indeterminate (kind 'progress'). */ progress?: number | null }
const [toasts, setToasts] = createSignal<Toast[]>([]);
export { toasts };
let toastId = 0;
/** ms = 0 keeps the toast until dismissed or updated. */
export function toast(t: Omit<Toast, 'id'>, ms = t.kind === 'error' ? 7000 : t.kind === 'progress' ? 0 : 4000) {
  const id = ++toastId;
  setToasts((l) => [...l.slice(-3), { ...t, id }]);
  if (ms) setTimeout(() => dismissToast(id), ms);
  return id;
}
/** Replace a toast's content in place (e.g. progress → done). Pass ms to schedule its dismissal. */
export function updateToast(id: number, patch: Partial<Omit<Toast, 'id'>>, ms = 0) {
  setToasts((l) => l.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  if (ms) setTimeout(() => dismissToast(id), ms);
}
export const dismissToast = (id: number) => setToasts((l) => l.filter((t) => t.id !== id));
export function toastError(e: unknown, what?: string) {
  const err = toAppError(e);
  if (err.code === 'cancelled') return;
  toast({ kind: 'error', text: what ?? errorTitle(err.code), detail: err.message });
}
export function errorTitle(code: string) {
  switch (code) {
    case 'not_found': return 'Not found';
    case 'access_denied': return 'Access denied';
    case 'exists': return 'An item with that name already exists';
    case 'invalid_name': return 'Invalid name';
    case 'unsupported': return 'Not supported';
    default: return 'Something went wrong';
  }
}
/** Run a promise, surfacing any failure as a toast. */
export async function attempt<T>(p: Promise<T>, what?: string): Promise<T | undefined> {
  try { return await p; } catch (e) { toastError(e, what); return undefined; }
}

// ── Menus ────────────────────────────────────────────────────────────────────
export interface MenuItem {
  label?: string;
  icon?: IconName;
  cmd?: string;          // command id: label/shortcut/run come from the registry
  run?: () => void;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  /** Entries, or a lazy accessor (null = still loading, [] = hide this row). */
  submenu?: SubItems;
  sep?: boolean;
  /** Image URL instead of a built-in icon (shell entries). */
  iconSrc?: string;
}
export type SubItems = MenuItem[] | (() => MenuItem[] | null);
export interface MenuState { x: number; y: number; items: MenuItem[]; anchor?: DOMRect; anchorEl?: HTMLElement; onClose?: () => void; /** Icon-only quick actions shown as a strip above the list. */ bar?: MenuItem[] }
export const [menu, setMenu] = createSignal<MenuState | null>(null);
export const openMenu = (m: MenuState) => setMenu(m);
/** Trigger whose menu was just dismissed by pressing on that same trigger: its next click toggles closed instead of reopening. */
let dismissedBy: { el: HTMLElement; at: number } | null = null;
export const noteMenuDismissedBy = (el: HTMLElement | null) => { dismissedBy = el ? { el, at: performance.now() } : null; };
/** Whether a click on `el` should toggle its menu closed rather than open it. Consumes the flag. */
export function menuToggledOff(el: HTMLElement) {
  const d = dismissedBy;
  dismissedBy = null;
  if (d && d.el === el && performance.now() - d.at < 1500) return true;
  const m = menu();
  if (m?.anchorEl === el) { setMenu(null); m.onClose?.(); return true; }
  return false;
}
/** Open a dropdown under `el`. Clicking the same trigger again closes it. Returns false when it toggled closed. */
export function openMenuAt(el: HTMLElement, items: MenuItem[], onClose?: () => void) {
  if (menuToggledOff(el)) { onClose?.(); return false; }
  const r = el.getBoundingClientRect();
  setMenu({ x: r.left, y: r.bottom + 4, items, anchor: r, anchorEl: el, onClose });
  return true;
}

// ── Overlays ─────────────────────────────────────────────────────────────────
export const [paletteOpen, setPaletteOpen] = createSignal(false);
export const [settingsOpen, setSettingsOpen] = createSignal(false);
export const [quickLook, setQuickLook] = createSignal(false);
export const [picker, setPicker] = createSignal<{ mode: 'move' | 'copy'; paths: string[] } | null>(null);
export const [pathEditing, setPathEditing] = createSignal(false);
export const [searchFocusTick, setSearchFocusTick] = createSignal(0);
export const focusSearch = () => setSearchFocusTick((n) => n + 1);
/** Scope preference for the search box before a query exists. */
export const [searchEverywhere, setSearchEverywhere] = createSignal(false);
/** Mode preference for the search box before a query exists: names (false) or file contents (true). */
export const [searchContent, setSearchContent] = createSignal(false);

/** Registered by the mounted FileView so commands can move focus / reveal rows. */
export const viewApi: { focus: () => void; reveal: (i: number) => void; center: (i: number) => void; toTop: () => void } = {
  focus: () => {}, reveal: () => {}, center: () => {}, toTop: () => {},
};
