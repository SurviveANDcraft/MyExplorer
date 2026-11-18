import { isPinned, openSelection, togglePin } from '../commands/actions';
import type { SortKey } from '../ipc/types';
import { isDir } from '../lib/fs';
import { settings } from '../state/settings';
import { pathAt, selectedIndices, sortBy, sortByRelevance, Tab, updateView } from '../state/tabs';
import type { MenuItem } from '../state/ui';

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

export function itemMenu(t: Tab): MenuItem[] {
  const idx = selectedIndices(t);
  const m = t.model();
  const single = idx.length === 1;
  const dirs = idx.filter((i) => isDir(m.flags[i]));
  const allDirs = dirs.length === idx.length;
  const firstDir = dirs.length ? pathAt(m, dirs[0]) : null;
  return [
    { label: 'Open', icon: 'external', cmd: 'item.open', run: () => openSelection() },
    ...(dirs.length ? [{ cmd: 'item.openNewTab' } as MenuItem] : []),
    ...(!allDirs && single ? [{ cmd: 'item.openWith' } as MenuItem] : []),
    { sep: true },
    { cmd: 'edit.cut' }, { cmd: 'edit.copy' },
    ...(single && allDirs ? [{ label: 'Paste into folder', icon: 'paste', cmd: 'edit.paste' } as MenuItem] : []),
    { cmd: 'edit.copyPath' },
    { sep: true },
    { cmd: 'edit.rename', disabled: !single },
    { cmd: 'edit.delete', danger: true },
    { sep: true },
    { cmd: 'file.moveTo' }, { cmd: 'file.copyTo' },
    { label: 'New', icon: 'plus', submenu: newMenu(), disabled: !!t.search() },
    ...(firstDir ? [{ label: isPinned(firstDir) ? 'Unpin from sidebar' : 'Pin to sidebar', icon: 'pin', run: () => togglePin(firstDir) } as MenuItem] : []),
    ...(single && allDirs ? [{ cmd: 'shell.terminal' } as MenuItem] : []),
    { sep: true },
    { cmd: 'item.properties' },
  ];
}

export function backgroundMenu(t: Tab): MenuItem[] {
  return [
    { label: 'View', icon: 'grid', submenu: viewMenu(t) },
    { label: 'Sort by', icon: 'sort', submenu: sortMenu(t) },
    { label: 'Refresh', icon: 'refresh', cmd: 'nav.refresh' },
    { sep: true },
    { label: 'New', icon: 'plus', submenu: newMenu(), disabled: !!t.search() },
    { cmd: 'edit.paste' },
    { cmd: 'edit.undo' },
    { sep: true },
    { cmd: 'edit.selectAll' },
    { cmd: 'file.pin' },
    { cmd: 'shell.terminal' },
    { cmd: 'item.properties' },
  ];
}
