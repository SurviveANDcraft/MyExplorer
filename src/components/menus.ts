import { isArchive, isPinned, openSelection, togglePin } from '../commands/actions';
import type { SortKey } from '../ipc/types';
import { baseName, isDir } from '../lib/fs';
import { settings } from '../state/settings';
import { pathAt, selectedIndices, sortBy, sortByRelevance, Tab, updateView } from '../state/tabs';
import type { MenuItem } from '../state/ui';
import { MenuSpec, openWithShell, Shell, shellTarget } from './shellMenu';

export const newMenu = (): MenuItem[] => [
  { cmd: 'file.newFolder' },
  { cmd: 'file.newText' },
];

export function viewMenu(t: Tab): MenuItem[] {
  const v = t.view();
  const grid = (g: 's' | 'm' | 'l' | 'xl', label: string): MenuItem => ({ label, checked: v.view === 'grid' && v.grid === g, run: () => updateView(t, { view: 'grid', grid: g }) });
  return [
    { label: 'Details', icon: 'details', cmd: 'view.details', checked: v.view === 'details' },
    { label: 'List', icon: 'list', cmd: 'view.list', checked: v.view === 'list' },
    { sep: true },
    grid('s', 'Small icons'), grid('m', 'Medium icons'), grid('l', 'Large icons'), grid('xl', 'Extra large icons'),
    { sep: true },
    { label: 'Preview pane', cmd: 'view.previewPane', checked: settings.previewPane },
    { label: 'Hidden items', cmd: 'view.hidden', checked: settings.showHidden },
    { label: 'File name extensions', cmd: 'view.extensions', checked: settings.showExtensions },
  ];
}

export function sortMenu(t: Tab): MenuItem[] {
  const searching = !!t.search();
  const s = searching ? t.searchSort() : t.view().sort;
  const key = (k: SortKey, label: string): MenuItem => ({ label, checked: s?.key === k, run: () => sortBy(t, k) });
  const items: MenuItem[] = [];
  if (searching) items.push({ label: 'Relevance', checked: !s, run: () => sortByRelevance(t) });
  items.push(key('name', 'Name'), key('modified', 'Date modified'), key('type', 'Type'), key('size', 'Size'));
  if (!searching) items.push(key('created', 'Date created'));
  if (s) items.push({ sep: true },
    { label: 'Ascending', checked: !s.desc, run: () => { if (s.desc) sortBy(t, s.key); } },
    { label: 'Descending', checked: s.desc, run: () => { if (!s.desc) sortBy(t, s.key); } });
  if (!searching) {
    const sort = t.view().sort;
    items.push({ sep: true }, { label: 'Folders first', checked: sort.foldersFirst, run: () => updateView(t, { sort: { ...sort, foldersFirst: !sort.foldersFirst } }) });
  }
  return items;
}

/** "Open with ▸": Windows' app list when available, else our app chooser. */
const openWithItem = (shell: Shell): MenuItem => ({
  label: 'Open with', icon: 'external',
  submenu: () => { const l = shell.openWith(); return l === null ? null : l.length ? l : [{ cmd: 'item.openWith', label: 'Choose another app…' }]; },
});
const moreItem = (shell: Shell): MenuItem => ({ label: 'More options', icon: 'more', submenu: shell.more });

export function itemMenu(t: Tab, shell: Shell): MenuSpec {
  const idx = selectedIndices(t);
  const m = t.model();
  const single = idx.length === 1;
  const dirs = idx.filter((i) => isDir(m.flags[i]));
  const allDirs = dirs.length === idx.length;
  const firstDir = dirs.length ? pathAt(m, dirs[0]) : null;
  return {
    bar: [
      { cmd: 'edit.cut' }, { cmd: 'edit.copy' },
      ...(single && allDirs ? [{ label: 'Paste into folder', icon: 'paste', cmd: 'edit.paste' } as MenuItem] : []),
      { cmd: 'edit.copyPath' },
      { cmd: 'edit.rename', disabled: !single },
      { cmd: 'edit.delete', danger: true },
    ],
    items: [
      { label: 'Open', icon: 'external', cmd: 'item.open', run: () => openSelection() },
      ...(dirs.length ? [{ cmd: 'item.openNewTab' } as MenuItem] : []),
      ...(!allDirs && single ? [openWithItem(shell)] : []),
      ...(single && allDirs ? [{ cmd: 'shell.terminal' } as MenuItem] : []),
      // Search results live anywhere: jump to the folder that holds the item.
      ...(single && t.search() ? [{ cmd: 'item.openLocation' } as MenuItem] : []),
      { sep: true },
      { cmd: 'edit.copyPath', label: single ? 'Copy path' : 'Copy paths' },
      { cmd: 'file.moveTo' }, { cmd: 'file.copyTo' },
      ...(idx.some((i) => !isDir(m.flags[i]) && isArchive(baseName(pathAt(m, i)))) ? [{ cmd: 'file.extract' } as MenuItem] : [{ cmd: 'file.compress' } as MenuItem]),
      ...(firstDir ? [{ label: isPinned(firstDir) ? 'Unpin from sidebar' : 'Pin to sidebar', icon: 'pin', run: () => togglePin(firstDir) } as MenuItem] : []),
      { sep: true },
      moreItem(shell),
      { cmd: 'item.properties' },
    ],
  };
}

export function backgroundMenu(t: Tab, shell: Shell): MenuSpec {
  return {
    bar: [{ cmd: 'edit.paste' }, { cmd: 'edit.undo' }, { cmd: 'edit.selectAll' }, { label: 'Refresh', icon: 'refresh', cmd: 'nav.refresh' }],
    items: [
      { label: 'New', icon: 'plus', submenu: () => { const x = shell.newTypes(); return x.length ? [...newMenu(), { sep: true }, ...x] : newMenu(); }, disabled: !!t.search() },
      { label: 'View', icon: 'grid', submenu: viewMenu(t) },
      { label: 'Sort by', icon: 'sort', submenu: sortMenu(t) },
      { sep: true },
      { cmd: 'file.pin' },
      { cmd: 'shell.terminal' },
      { sep: true },
      moreItem(shell),
      { cmd: 'item.properties' },
    ],
  };
}

/** The file view's right-click menu, with the Windows shell entries merged in. */
export function openContextMenu(t: Tab, x: number, y: number, onItem: boolean, extended = false) {
  const target = shellTarget(t, onItem);
  if (!onItem && t.search()) target.dir = null;
  openWithShell(x, y, (shell) => (onItem ? itemMenu(t, shell) : backgroundMenu(t, shell)), target, extended);
}
/** Keyboard (Shift+F10 / menu key): anchor on the focused row, else near the top of the view. */
export function openContextMenuForFocus(t: Tab) {
  const onItem = selectedIndices(t).length > 0;
  const row = document.querySelector<HTMLElement>(`.vscroll .row[data-i="${t.focus()}"], .vscroll .tile[data-i="${t.focus()}"]`);
  const r = row?.getBoundingClientRect();
  const view = document.querySelector<HTMLElement>('.vscroll')?.getBoundingClientRect();
  if (onItem && r) openContextMenu(t, r.left + 40, r.bottom - 2, true);
  else if (view) openContextMenu(t, view.left + 24, view.top + 24, onItem);
}
