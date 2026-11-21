import { onCleanup, onMount, Show } from 'solid-js';
import { handleGlobalKey, runCommand } from './commands/registry';
import { IS_TAURI, listen } from './ipc/invoke';
import { samePath } from './lib/fs';
import { diskChanged } from './commands/actions';
import { initExternalDrop } from './state/drag';
import { startLiveDrives } from './state/system';
import { settings } from './state/settings';
import { activeTab, currentDir, refresh, tabs } from './state/tabs';
import { prewarmShellMenu } from './components/shellMenu';
import { paletteOpen, picker, quickLook, settingsOpen } from './state/ui';
import { CommandBar } from './components/CommandBar';
import { ContextMenu } from './components/ContextMenu';
import { FileView } from './components/FileView';
import { GrepView } from './components/GrepView';
import { SearchStrip } from './components/SearchStrip';
import { Home } from './components/Home';
import { Storage } from './components/Storage';
import { NavRow } from './components/NavRow';
import { DragGhost, Toasts, Tooltip } from './components/Overlays';
import { Palette } from './components/Palette';
import { Picker } from './components/Picker';
import { PreviewPane, QuickLook } from './components/PreviewPane';
import { SettingsDialog } from './components/Settings';
import { UpdateDialog } from './components/UpdateDialog';
import { updateDialogOpen } from './state/updater';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';

export default function App() {
  onMount(() => {
    window.addEventListener('keydown', handleGlobalKey);
    // Mouse back/forward buttons.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        runCommand(e.button === 3 ? 'nav.back' : 'nav.forward');
      }
    };
    window.addEventListener('mouseup', onMouse);
    const noDefaultMenu = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault(); };
    window.addEventListener('contextmenu', noDefaultMenu);
    let unFs = () => {};
    onCleanup(() => {
      unFs();
      window.removeEventListener('keydown', handleGlobalKey);
      window.removeEventListener('mouseup', onMouse);
      window.removeEventListener('contextmenu', noDefaultMenu);
    });

    const timers = new Map<number, number>();
    listen('fs:changed', ({ path }) => {
      diskChanged(path);
      for (const t of tabs()) {
        if (!samePath(t.watched, path) || t.search()) continue;
        clearTimeout(timers.get(t.id));
        timers.set(t.id, window.setTimeout(() => refresh(t), 30));
      }
    }).then((un) => (unFs = un), () => {});
    initExternalDrop();
    startLiveDrives();
    window.setTimeout(() => prewarmShellMenu(currentDir() ?? 'C:\\'), 2500);
  });

  const page = () => (activeTab()?.search() ? null : activeTab()?.loc().kind ?? null);
  return (
    <div class="app" classList={{ 'no-mica': !IS_TAURI }}>
      <TitleBar />
      <NavRow />
      <CommandBar />
      <div class="body">
        <Show when={!settings.sidebarCollapsed}><Sidebar /></Show>
        <main class="surface">
          <div class="surface-main">
            <div class="viewwrap">
              <Show when={activeTab()} keyed>
                {(t) => (
                  <Show when={page() !== 'home'} fallback={<Home />}>
                    <Show when={page() !== 'storage'} fallback={<Storage />}>
                      <Show when={t.search()?.content} fallback={<FileView tab={t} />}>
                        <div class="grep-wrap"><SearchStrip tab={t} /><GrepView tab={t} /></div>
                      </Show>
                    </Show>
                  </Show>
                )}
              </Show>
            </div>
            <Show when={settings.previewPane && !activeTab()?.search()?.content && page() !== 'storage'}><PreviewPane /></Show>
          </div>
          <StatusBar />
        </main>
      </div>
      <Show when={quickLook()}><QuickLook /></Show>
      <Show when={paletteOpen()}><Palette /></Show>
      <Show when={picker()}><Picker /></Show>
      <Show when={settingsOpen()}><SettingsDialog /></Show>
      <Show when={updateDialogOpen()}><UpdateDialog /></Show>
      <ContextMenu />
      <Tooltip />
      <DragGhost />
      <Toasts />
    </div>
  );
}
