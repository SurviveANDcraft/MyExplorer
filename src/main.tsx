import { render } from 'solid-js/web';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/sidebar.css';
import './styles/view.css';
import './styles/overlays.css';
import './styles/storage.css';
import App from './App';
import { registerCommands } from './commands/defs';
import { invoke, IS_TAURI, listen } from './ipc/invoke';
import type { LaunchReq } from './ipc/types';
import { initSettings, settings } from './state/settings';
import { loadSystem } from './state/system';
import { expectSelection, newTab } from './state/tabs';
import { initUpdater } from './state/updater';

/** Open a launch request (folder double-clicked in Windows, Win+E, …) as a tab. */
function openRequest(r: LaunchReq) {
  if (!r.path) return newTab({ kind: 'home' });
  const t = newTab({ kind: 'dir', path: r.path });
  if (r.select) expectSelection(t, [r.select]);
  return t;
}

async function boot() {
  registerCommands();
  await initSettings();
  loadSystem();
  const launch = IS_TAURI ? await invoke('take_launch').catch(() => null) : null;
  const start = settings.startup;
  if (launch?.path) openRequest(launch);
  else newTab(start && start !== 'home' ? { kind: 'dir', path: start } : { kind: 'home' });
  listen('app:open', (r) => openRequest(r));
  render(() => <App />, document.getElementById('root')!);
  if (IS_TAURI) {
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      getCurrentWindow().show().catch(() => {});
    }));
    // Fire-and-forget: a failed or slow check must never delay startup.
    initUpdater();
  }
}
boot();
