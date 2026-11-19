import { IS_TAURI } from '../ipc/invoke';
import { baseName, isDir } from '../lib/fs';
import { setSettings, settings } from '../state/settings';
import {
  activate, activeTab, clearSel, closeTab, currentDir, goBack, goForward, goUp, invertSel, previewIndex, refresh, selCount, selectAll, selectedPaths, setSearchQuery, tabs, updateView,
} from '../state/tabs';
import { focusSearch, quickLook, setSearchContent, setSearchEverywhere, setPaletteOpen, setPathEditing, setQuickLook, setSettingsOpen, viewApi } from '../state/ui';
import { openContextMenuForFocus } from '../components/menus';
import * as A from './actions';
import { Command, register } from './registry';

const hasSel = () => selCount(activeTab()) > 0;
const inDir = () => !!currentDir() && !activeTab().search();
const cycleTab = (d: number) => {
  const l = tabs(); const i = l.indexOf(activeTab());
  activate(l[(i + d + l.length) % l.length].id);
};

/** Space: folders have nothing to preview, so step into them; files toggle Quick Look. */
function spaceAction() {
  const t = activeTab();
  const i = previewIndex(t);
  if (i >= 0 && isDir(t.model().flags[i])) { setQuickLook(false); A.openIndex(t, i); return; }
  setQuickLook(!quickLook());
}

export function registerCommands() {
  const C: Command[] = [
    // Navigation
    { id: 'nav.back', label: 'Back', category: 'Navigate', keys: ['Alt+ArrowLeft', 'BrowserBack'], icon: 'back', inInput: true, run: () => goBack(activeTab()), enabled: () => (activeTab().hist(), activeTab().back.length > 0) },
    { id: 'nav.forward', label: 'Forward', category: 'Navigate', keys: ['Alt+ArrowRight', 'BrowserForward'], icon: 'forward', inInput: true, run: () => goForward(activeTab()), enabled: () => (activeTab().hist(), activeTab().fwd.length > 0) },
    { id: 'nav.up', label: 'Up one level', category: 'Navigate', keys: ['Alt+ArrowUp', 'Backspace'], icon: 'up', run: () => goUp(activeTab()), enabled: () => !!currentDir() || !!activeTab().search() },
    { id: 'nav.refresh', label: 'Refresh', category: 'Navigate', keys: ['F5', 'Ctrl+R'], icon: 'refresh', inInput: true, run: () => refresh(activeTab()) },
    { id: 'nav.home', label: 'Go to Home', category: 'Navigate', keys: ['Alt+Home'], icon: 'home', run: () => A.goHome() },
    { id: 'path.edit', label: 'Edit path', category: 'Navigate', keys: ['Ctrl+L', 'Alt+D', 'F4'], icon: 'link', inInput: true, run: () => setPathEditing(true) },
    // Open
    { id: 'item.open', label: 'Open', category: 'File', keys: ['Enter'], icon: 'external', run: () => A.openSelection(), enabled: () => hasSel() || activeTab().focus() >= 0 },
    { id: 'item.openNewTab', label: 'Open in new tab', category: 'File', keys: ['Ctrl+Enter'], icon: 'tab', run: () => A.openSelection(true), enabled: hasSel },
    { id: 'item.openLocation', label: 'Open file location', category: 'File', keys: ['Ctrl+Shift+O'], icon: 'folder', run: A.openLocation, enabled: hasSel },
    { id: 'item.openWith', label: 'Open with…', category: 'File', icon: 'external', run: A.openWith, enabled: hasSel },
    { id: 'item.quickLook', label: 'Quick Look', category: 'View', keys: ['Space'], icon: 'eye', run: spaceAction, enabled: () => quickLook() || hasSel() || activeTab().focus() >= 0 },
    { id: 'item.properties', label: 'Properties', category: 'File', keys: ['Alt+Enter'], icon: 'info', run: A.properties },
    { id: 'shell.terminal', label: 'Open in Terminal', category: 'File', keys: ['Ctrl+`'], icon: 'terminal', inInput: true, run: A.terminalHere, enabled: () => !!currentDir() || hasSel() },
    // Edit
    { id: 'edit.cut', label: 'Cut', category: 'Edit', keys: ['Ctrl+X'], icon: 'cut', run: () => A.clipboardWrite(true), enabled: hasSel },
    { id: 'edit.copy', label: 'Copy', category: 'Edit', keys: ['Ctrl+C'], icon: 'copy', run: () => A.clipboardWrite(false), enabled: hasSel },
    { id: 'edit.paste', label: 'Paste', category: 'Edit', keys: ['Ctrl+V'], icon: 'paste', run: A.paste, enabled: inDir },
    { id: 'edit.rename', label: 'Rename', category: 'Edit', keys: ['F2'], icon: 'rename', run: A.startRename, enabled: hasSel },
    { id: 'edit.delete', label: 'Delete', category: 'Edit', keys: ['Delete'], icon: 'trash', run: () => A.deleteSelection(false), enabled: hasSel },
    { id: 'edit.deletePermanent', label: 'Delete permanently', category: 'Edit', keys: ['Shift+Delete'], icon: 'trash', run: () => A.deleteSelection(true), enabled: hasSel },
    { id: 'edit.undo', label: 'Undo', category: 'Edit', keys: ['Ctrl+Z'], icon: 'undo', run: A.undo },
    { id: 'edit.redo', label: 'Redo', category: 'Edit', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], icon: 'redo', run: A.redo },
    { id: 'edit.selectAll', label: 'Select all', category: 'Edit', keys: ['Ctrl+A'], icon: 'selectAll', run: () => selectAll(activeTab()) },
    { id: 'edit.selectNone', label: 'Select none', category: 'Edit', icon: 'close', run: () => clearSel(activeTab()) },
    { id: 'edit.invert', label: 'Invert selection', category: 'Edit', icon: 'selectAll', run: () => invertSel(activeTab()) },
    { id: 'edit.copyPath', label: 'Copy as path', category: 'Edit', keys: ['Ctrl+Shift+C'], icon: 'link', run: A.copyPaths },
    { id: 'file.newFolder', label: 'New folder', category: 'File', keys: ['Ctrl+Shift+N'], icon: 'folderPlus', run: () => A.createNew('folder'), enabled: inDir },
    { id: 'file.newText', label: 'New text document', category: 'File', icon: 'fileText', run: () => A.createNew('text'), enabled: inDir },
    { id: 'file.moveTo', label: 'Move to…', category: 'File', keys: ['Ctrl+Shift+M'], icon: 'folderMove', run: () => A.openPicker('move'), enabled: hasSel },
    { id: 'file.copyTo', label: 'Copy to…', category: 'File', keys: ['Ctrl+Alt+Shift+C'], icon: 'folderCopy', run: () => A.openPicker('copy'), enabled: hasSel },
    { id: 'file.compress', label: 'Compress to ZIP', category: 'File', icon: 'archive', run: A.compressSelection, enabled: hasSel },
    { id: 'file.extract', label: 'Extract here', category: 'File', icon: 'unarchive', run: A.extractSelection, enabled: () => selectedPaths(activeTab()).some((p) => A.isArchive(baseName(p))) },
    { id: 'shell.contextMenu', label: 'Open context menu', category: 'File', keys: ['Shift+F10', 'ContextMenu'], icon: 'more', run: () => openContextMenuForFocus(activeTab()), enabled: () => hasSel() || !!currentDir() },
    { id: 'file.pin', label: 'Pin / unpin in sidebar', category: 'File', icon: 'pin', run: () => A.togglePin(), enabled: () => !!currentDir() || hasSel() },
    // Search
    { id: 'search.focus', label: 'Search this folder', category: 'Search', keys: ['Ctrl+F', 'Ctrl+E', 'F3'], icon: 'search', inInput: true, run: () => { const t = activeTab(); setSearchEverywhere(false); if (t.search()?.everywhere && currentDir(t)) setSearchQuery(t, { everywhere: false }); focusSearch(); } },
    { id: 'search.everywhere', label: 'Search everywhere', category: 'Search', keys: ['Ctrl+Shift+F'], icon: 'globe', inInput: true, run: () => { const t = activeTab(); const v = t.search() ? !t.search()!.everywhere || !currentDir(t) : true; setSearchEverywhere(v); if (t.search()) setSearchQuery(t, { everywhere: v }); focusSearch(); } },
    { id: 'search.contents', label: 'Search in files', category: 'Search', keys: ['Ctrl+Shift+G'], icon: 'fileSearch', inInput: true, enabled: () => settings.contentSearch, run: () => { const t = activeTab(); const v = !t.search()?.content; setSearchContent(v); if (t.search()) setSearchQuery(t, { content: v }); focusSearch(); } },
    { id: 'palette.open', label: 'Command palette', category: 'App', keys: ['Ctrl+K', 'Ctrl+Shift+P'], icon: 'bolt', inInput: true, run: () => setPaletteOpen(true), hidden: true },
    // View
    { id: 'view.details', label: 'Details view', category: 'View', keys: ['Ctrl+Shift+1'], icon: 'details', run: () => updateView(activeTab(), { view: 'details' }) },
    { id: 'view.list', label: 'List view', category: 'View', keys: ['Ctrl+Shift+2'], icon: 'list', run: () => updateView(activeTab(), { view: 'list' }) },
    { id: 'view.grid', label: 'Grid view', category: 'View', keys: ['Ctrl+Shift+3'], icon: 'grid', run: () => updateView(activeTab(), { view: 'grid' }) },
    { id: 'view.gridLarger', label: 'Larger icons', category: 'View', keys: ['Ctrl+='], icon: 'grid', run: () => zoom(1) },
    { id: 'view.gridSmaller', label: 'Smaller icons', category: 'View', keys: ['Ctrl+-'], icon: 'grid', run: () => zoom(-1) },
    { id: 'view.previewPane', label: 'Preview pane', category: 'View', keys: ['Alt+P'], icon: 'preview', inInput: true, run: () => setSettings('previewPane', (v) => !v) },
    { id: 'view.sidebar', label: 'Toggle sidebar', category: 'View', keys: ['Ctrl+B'], icon: 'sidebar', inInput: true, run: () => setSettings('sidebarCollapsed', (v) => !v) },
    { id: 'view.hidden', label: 'Show hidden items', category: 'View', keys: ['Ctrl+H'], icon: 'eyeOff', run: () => A.setShowHidden(!settings.showHidden) },
    { id: 'view.extensions', label: 'Show file extensions', category: 'View', icon: 'fileText', run: () => setSettings('showExtensions', (v) => !v) },
    // Tabs
    { id: 'tab.new', label: 'New tab', category: 'Tabs', keys: ['Ctrl+T'], icon: 'plus', inInput: true, run: A.newTabHere },
    { id: 'tab.close', label: 'Close tab', category: 'Tabs', keys: ['Ctrl+W', 'Ctrl+F4'], icon: 'close', inInput: true, run: () => closeTab(activeTab()) },
    { id: 'tab.duplicate', label: 'Duplicate tab', category: 'Tabs', icon: 'copy', run: () => A.duplicateTab() },
    { id: 'tab.next', label: 'Next tab', category: 'Tabs', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], inInput: true, run: () => cycleTab(1) },
    { id: 'tab.prev', label: 'Previous tab', category: 'Tabs', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], inInput: true, run: () => cycleTab(-1) },
    ...Array.from({ length: 9 }, (_, i): Command => ({
      id: `tab.go${i + 1}`, label: i === 8 ? 'Go to last tab' : `Go to tab ${i + 1}`, category: 'Tabs', keys: [`Ctrl+${i + 1}`], inInput: true, hidden: true,
      run: () => { const l = tabs(); const t = i === 8 ? l[l.length - 1] : l[i]; if (t) activate(t.id); },
    })),
    // App
    { id: 'app.settings', label: 'Settings', category: 'App', keys: ['Ctrl+,'], icon: 'settings', inInput: true, run: () => setSettingsOpen(true) },
    { id: 'app.focusView', label: 'Focus file list', category: 'App', keys: [], hidden: true, run: () => viewApi.focus() },
  ];
  if (IS_TAURI) C.push({ id: 'app.quit', label: 'Close window', category: 'App', keys: ['Alt+F4'], inInput: true, run: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().close() });
  register(C);
}

const GRID = ['s', 'm', 'l', 'xl'] as const;
function zoom(d: number) {
  const t = activeTab();
  const v = t.view();
  if (v.view !== 'grid') { if (d > 0) updateView(t, { view: 'grid' }); return; }
  const i = Math.max(0, Math.min(3, GRID.indexOf(v.grid) + d));
  updateView(t, { grid: GRID[i] });
}
