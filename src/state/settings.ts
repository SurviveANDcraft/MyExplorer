import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { invoke } from '../ipc/invoke';
import type { Sort } from '../ipc/types';
import { toastError } from './ui';

export type ViewMode = 'details' | 'list' | 'grid';
export type GridSize = 's' | 'm' | 'l' | 'xl';
export interface FolderView { view: ViewMode; grid: GridSize; sort: Sort }
export type ColumnId = 'name' | 'modified' | 'type' | 'size' | 'folder';

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  accent: string;
  density: 'comfortable' | 'compact';
  anim: 'off' | 'fast' | 'normal';
  defaultView: FolderView;
  showHidden: boolean;
  showExtensions: boolean;
  clickMode: 'double' | 'single';
  startup: string; // 'home' or an absolute path
  keys: Record<string, string[]>;
  pinned: string[];
  folderViews: Record<string, FolderView>;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  previewPane: boolean;
  previewWidth: number;
  grepPreviewWidth: number;
  /** Beta: "Search in files" (content search). Off by default. */
  contentSearch: boolean;
  columns: Record<ColumnId, number>;
  /** Storage page: lowercase paths marked "keep" (never suggested again). */
  storageIgnored: string[];
}

export const ACCENTS = ['#2f6fea', '#0f8a8a', '#16a34a', '#7c5cff', '#c2418a', '#e2564b', '#d97a16', '#5f6b7a'];

export const DEFAULTS: Settings = {
  theme: 'system',
  accent: ACCENTS[0],
  density: 'comfortable',
  anim: 'normal',
  defaultView: { view: 'details', grid: 'm', sort: { key: 'name', desc: false, foldersFirst: true } },
  showHidden: false,
  showExtensions: true,
  clickMode: 'double',
  startup: 'home',
  keys: {},
  pinned: [],
  folderViews: {},
  sidebarWidth: 240,
  sidebarCollapsed: false,
  previewPane: false,
  previewWidth: 320,
  grepPreviewWidth: 560,
  contentSearch: false,
  columns: { name: 340, modified: 172, type: 168, size: 96, folder: 300 },
  storageIgnored: [],
};

export const [settings, setSettings] = createStore<Settings>(structuredClone(DEFAULTS));
const [systemDark, setSystemDark] = createSignal(false);
export const darkMode = () => (settings.theme === 'system' ? systemDark() : settings.theme === 'dark');

const SPEED = { off: 0, fast: 0.6, normal: 1 } as const;
const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Multiplier for JS-driven animations (0 = disabled). */
export const motionScale = () => (reducedMotion ? 0 : SPEED[settings.anim]);
export const rowHeight = () => (settings.density === 'compact' ? 26 : 32);

function luminance(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.2;
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export async function initSettings() {
  try {
    const raw = await invoke('load_settings');
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      setSettings(reconcile({ ...structuredClone(DEFAULTS), ...saved, columns: { ...DEFAULTS.columns, ...saved.columns }, defaultView: { ...DEFAULTS.defaultView, ...saved.defaultView } }));
    }
  } catch { /* keep defaults; a toast is not possible before render */ }

  const mq = matchMedia('(prefers-color-scheme: dark)');
  setSystemDark(mq.matches);
  mq.addEventListener('change', (e) => setSystemDark(e.matches));

  createRoot(() => {
    const root = document.documentElement;
    createEffect(() => { root.dataset.theme = darkMode() ? 'dark' : 'light'; });
    createEffect(() => { root.dataset.density = settings.density; });
    createEffect(() => { root.style.setProperty('--speed', String(motionScale())); });
    createEffect(() => {
      root.style.setProperty('--accent', settings.accent);
      root.style.setProperty('--on-accent', luminance(settings.accent) > 0.45 ? '#000' : '#fff');
    });
    let timer = 0;
    createEffect(on(() => JSON.stringify(settings), (json) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => { invoke('save_settings', { json }).catch((e) => toastError(e, 'Could not save settings')); }, 400);
    }, { defer: true }));
  });
}

export function folderView(path: string | null): FolderView {
  const v = path ? settings.folderViews[path.toLowerCase()] : undefined;
  return structuredClone(unwrap(v ?? settings.defaultView));
}
export function rememberFolderView(path: string, v: FolderView) {
  const key = path.toLowerCase();
  const keys = Object.keys(settings.folderViews);
  if (keys.length > 400 && !(key in settings.folderViews)) setSettings('folderViews', keys[0], undefined!);
  setSettings('folderViews', key, structuredClone(v));
}
