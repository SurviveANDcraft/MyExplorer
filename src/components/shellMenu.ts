// Our context menu, extended with every Windows shell entry (7-Zip, Git, "Open with", "Send to", …).
// The backend reads Explorer's menu without showing it; we render the entries and invoke the pick.
import { createSignal } from 'solid-js';
import { diskChanged } from '../commands/actions';
import { invoke, IS_TAURI } from '../ipc/invoke';
import type { ShellItem } from '../ipc/types';
import { parentOf } from '../lib/fs';
import type { Tab } from '../state/tabs';
import { currentDir, refresh, selectedPaths, tabs } from '../state/tabs';
import { MenuItem, openMenu, toastError } from '../state/ui';

// Entries we already offer natively (or that only make sense inside File Explorer).
const HIDE_VERBS = new Set([
  'open', 'opennewwindow', 'opennewprocess', 'opennewtab', 'explore', 'cut', 'copy', 'paste', 'delete', 'rename', 'properties',
  'pintohome', 'pintohomefile', 'unpinfromhome', 'unpinfromhomefile', 'copyaspath', 'refresh', 'undo', 'redo',
]);
const HIDE_LABELS = new Set([
  'open', 'cut', 'copy', 'paste', 'delete', 'rename', 'properties', 'refresh', 'view', 'sort by', 'group by', 'copy as path',
  'open in new window', 'open in new tab', 'pin to quick access', 'unpin from quick access', 'add to favorites',
  'remove from favorites', 'show more options', 'open in terminal', 'open in myexplorer',
]);
const hidden = (it: ShellItem) => {
  const l = it.label.toLowerCase();
  return HIDE_VERBS.has(it.verb) || HIDE_LABELS.has(l) || /^(undo|redo) /.test(l);
};

let warmed = false;
/** Shell extensions load their DLLs on first use (can take seconds); do that once in the background. */
export function prewarmShellMenu(dir: string | null) {
  if (warmed || !IS_TAURI || !dir) return;
  warmed = true;
  invoke('shell_menu_open', { paths: [dir], dir: null, extended: false }).then((m) => invoke('shell_menu_close', { session: m.session })).catch(() => {});
}

const refreshAll = (paths: (string | null)[]) => window.setTimeout(() => {
  diskChanged(...paths);
  for (const t of tabs()) if (!t.search() && currentDir(t)) refresh(t);
}, 400);

/** Lazy views of the Windows entries, for building the menu before they load (null = loading). */
export interface Shell {
  /** Windows' "Open with" app list ([] when it has none). */
  openWith: () => MenuItem[] | null;
  /** Everything else from Windows: "Send to", 7-Zip, Git, OneDrive, … */
  more: () => MenuItem[] | null;
  /** Extra document types from Windows' "New" submenu (background only). */
  newTypes: () => MenuItem[];
}
export interface MenuSpec { bar?: MenuItem[]; items: MenuItem[] }

/** Opens our menu at (x, y); Windows' entries for `target` stream into the lazy parts of `build`. */
export function openWithShell(x: number, y: number, build: (shell: Shell) => MenuSpec, target: { paths: string[]; dir: string | null }, extended = false) {
  type Loaded = { openWith: MenuItem[]; more: MenuItem[]; newTypes: MenuItem[] };
  const [loaded, setLoaded] = createSignal<Loaded | null>(IS_TAURI ? null : { openWith: [], more: [], newTypes: [] });
  let session = 0, closed = false, picked = false;
  const dpr = window.devicePixelRatio || 1;
  const convert = (list: ShellItem[]): MenuItem[] => list.filter((it) => it.separator || !hidden(it)).map((it): MenuItem => {
    if (it.separator) return { sep: true };
    if (it.children.length) return { label: it.label, iconSrc: it.icon ?? undefined, disabled: it.disabled, submenu: convert(it.children) };
    return {
      label: it.label, iconSrc: it.icon ?? undefined, disabled: it.disabled, checked: it.checked || undefined,
      run: () => {
        picked = true;
        invoke('shell_menu_invoke', { session, id: it.id, x: Math.round(x * dpr), y: Math.round(y * dpr) })
          .then(() => refreshAll([...target.paths, target.dir, ...target.paths.map(parentOf)]), (e) => toastError(e, `Couldn't run “${it.label}”`));
      },
    };
  });
  const hasReal = (l: MenuItem[]) => l.some((e) => !e.sep);
  if (IS_TAURI) {
    invoke('shell_menu_open', { paths: target.paths, dir: target.dir, extended }).then((m) => {
      session = m.session;
      if (closed) { invoke('shell_menu_close', { session }).catch(() => {}); return; }
      let rest = m.items;
      const take = (pred: (s: ShellItem) => boolean) => { const i = rest.findIndex(pred); if (i < 0) return null; const it = rest[i]; rest = rest.filter((_, k) => k !== i); return it; };
      const ow = take((s) => s.children.length > 0 && /^open with$/i.test(s.label));
      // A lone "Open with…" (no app list) is the app chooser itself.
      const owSingle = ow ? null : take((s) => s.verb === 'openas' || /^open with/i.test(s.label));
      const nw = target.dir ? take((s) => s.children.length > 0 && /^new$/i.test(s.label)) : null;
      const openWith = ow ? convert(ow.children) : owSingle ? convert([{ ...owSingle, label: 'Choose another app' }]) : [];
      const newTypes = nw ? convert(nw.children.filter((c) => !/^(folder|text document)$/i.test(c.label))) : [];
      const more = convert(rest);
      setLoaded({ openWith: hasReal(openWith) ? openWith : [], more: hasReal(more) ? more : [], newTypes: hasReal(newTypes) ? newTypes : [] });
    }, () => setLoaded({ openWith: [], more: [], newTypes: [] }));
  }
  const spec = build({
    openWith: () => loaded()?.openWith ?? null,
    more: () => loaded()?.more ?? null,
    newTypes: () => loaded()?.newTypes ?? [],
  });
  openMenu({
    x, y, items: spec.items, bar: spec.bar,
    // A pick closes the menu before its run() fires: decide after the current task.
    onClose: () => { closed = true; window.setTimeout(() => { if (session && !picked) invoke('shell_menu_close', { session }).catch(() => {}); }, 0); },
  });
}

/** Selection-aware target used by the file view and the keyboard (Shift+F10 / menu key). */
export function shellTarget(t: Tab, onItem: boolean) {
  return { paths: onItem ? selectedPaths(t) : [], dir: onItem ? null : currentDir(t) };
}
