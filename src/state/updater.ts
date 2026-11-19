import { createSignal } from 'solid-js';
import type { Update } from '@tauri-apps/plugin-updater';
import { invoke, IS_TAURI } from '../ipc/invoke';
import { toast } from './ui';

/**
 * Auto-update from this repo's GitHub releases (`latest.json`, signed; see tauri.conf.json).
 * One shared state drives the popup and Settings → About, so dismissing the popup never
 * loses the update.
 *
 * Nagging policy:
 *  - on launch: popup, unless the user chose "Later" for this version in the last 12 h;
 *  - while running: re-check every 3 h; if an update is waiting and not snoozed (24 h),
 *    a toast with "Update" (less intrusive than a popup mid-work).
 */

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'uptodate' | 'downloading' | 'installing' | 'error' | 'unsupported';
export interface UpdateState {
  phase: UpdatePhase;
  current: string;
  next?: string;
  notes?: string;
  /** 0–1 while downloading (null = size unknown). */
  progress?: number | null;
  error?: string;
  checkedAt?: number;
}

const [state, setState] = createSignal<UpdateState>({ phase: IS_TAURI && !import.meta.env.DEV ? 'idle' : 'unsupported', current: '' });
export const updateState = state;
export const [updateDialogOpen, setUpdateDialogOpen] = createSignal(false);
const patch = (p: Partial<UpdateState>) => setState((s) => ({ ...s, ...p }));

let pending: Update | null = null;
const STARTUP_DELAY = 4000;
const RECHECK_EVERY = 3 * 3600_000;
const SNOOZE_STARTUP = 12 * 3600_000;
const SNOOZE_RUNNING = 24 * 3600_000;
const SNOOZE_KEY = 'myexplorer.updateSnooze';

function snoozedAt(version: string): number {
  try {
    const s = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? 'null') as { version: string; at: number } | null;
    return s && s.version === version ? s.at : 0;
  } catch { return 0; }
}
function snooze() {
  const v = state().next;
  if (!v) return;
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version: v, at: Date.now() })); } catch { /* private storage */ }
}

/** "Later" in the popup. The update stays available in Settings → About. */
export function dismissUpdate() {
  snooze();
  setUpdateDialogOpen(false);
}

/** Ask GitHub whether a newer release exists. Never throws: offline must not break anything. */
export async function checkForUpdate(): Promise<boolean> {
  const s = state();
  if (s.phase === 'unsupported' || s.phase === 'checking' || s.phase === 'downloading' || s.phase === 'installing') return false;
  patch({ phase: 'checking', error: undefined });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const u = await check({ timeout: 20_000 });
    pending = u;
    if (u) patch({ phase: 'available', next: u.version, notes: u.body?.trim() || undefined, checkedAt: Date.now() });
    else patch({ phase: 'uptodate', next: undefined, notes: undefined, checkedAt: Date.now() });
  } catch (e) {
    pending = null;
    patch({ phase: 'error', error: String(e), checkedAt: Date.now() });
  }
  return state().phase === 'available';
}

/** Download, install (passive installer; the app closes) and relaunch on the new version. */
export async function installUpdate() {
  if (!pending || state().phase === 'downloading' || state().phase === 'installing') return;
  setUpdateDialogOpen(true);
  patch({ phase: 'downloading', progress: null, error: undefined });
  let total = 0;
  let got = 0;
  try {
    await invoke('prepare_update').catch(() => {});
    await pending.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
      else if (ev.event === 'Progress') { got += ev.data.chunkLength; if (total) patch({ progress: Math.min(1, got / total) }); }
      else if (ev.event === 'Finished') patch({ phase: 'installing', progress: 1 });
    });
    // On Windows the installer usually ends this process first and restarts the app itself.
    await invoke('release_single_instance_lock').catch(() => {});
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    patch({ phase: 'error', error: String(e) });
  }
}

let nagToast = false;
async function periodic() {
  if (!(await checkForUpdate())) return;
  const v = state().next!;
  if (updateDialogOpen() || nagToast || Date.now() - snoozedAt(v) < SNOOZE_RUNNING) return;
  nagToast = true;
  snooze(); // one reminder per day at most
  toast({ kind: 'info', text: `MyExplorer ${v} is available`, detail: 'Installs in about a minute and reopens your windows.', action: { label: 'Update', run: () => { void installUpdate(); } } }, 15_000);
  setTimeout(() => { nagToast = false; }, 15_000);
}

/** Start the update cycle (call once at boot). */
export function initUpdater() {
  if (state().phase === 'unsupported') return;
  void import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).then((v) => patch({ current: v })).catch(() => {});
  setTimeout(async () => {
    if ((await checkForUpdate()) && Date.now() - snoozedAt(state().next!) > SNOOZE_STARTUP) setUpdateDialogOpen(true);
  }, STARTUP_DELAY);
  setInterval(() => void periodic(), RECHECK_EVERY);
}
