import { onMount, Show } from 'solid-js';
import { Icon } from '../lib/icons';
import { popIn } from '../lib/motion';
import { dismissUpdate, installUpdate, updateState } from '../state/updater';

/** "Update available" popup. Can't be dismissed while the update is downloading/installing. */
export function UpdateDialog() {
  let panel!: HTMLDivElement;
  const s = updateState;
  const busy = () => s().phase === 'downloading' || s().phase === 'installing';
  const later = () => { if (!busy()) dismissUpdate(); };
  onMount(() => { popIn(panel); panel.focus(); });
  return (
    <div class="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) later(); }}>
      <div class="upd pop" ref={panel} role="dialog" aria-label="Update available" tabindex="-1" data-modal
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); later(); } }}>
        <div class="upd-head">
          <div class="win-hero-icon"><Icon name={busy() ? 'download' : 'bolt'} size={20} /></div>
          <div>
            <div class="upd-title">{busy() ? 'Updating MyExplorer' : s().phase === 'error' ? 'Update failed' : 'Update available'}</div>
            <div class="field-hint">
              {s().phase === 'downloading' ? 'Downloading… MyExplorer restarts when it’s done.'
                : s().phase === 'installing' ? 'Installing. MyExplorer will reopen in a moment.'
                : s().phase === 'error' ? s().error
                : `MyExplorer ${s().next} is ready to install. You have ${s().current}.`}
            </div>
          </div>
        </div>
        <Show when={s().notes && !busy() && s().phase !== 'error'}><div class="upd-notes">{s().notes}</div></Show>
        <Show when={busy()}>
          <div class="upd-bar" classList={{ indeterminate: s().progress == null }}>
            <div style={{ width: s().progress != null ? `${Math.round(s().progress! * 100)}%` : '35%' }} />
          </div>
        </Show>
        <div class="upd-actions">
          <button class="btn btn-text" disabled={busy()} onClick={later}>Later</button>
          <button class="btn btn-text btn-outline btn-accent" disabled={busy()} onClick={() => void installUpdate()}>
            {busy() ? 'Updating…' : s().phase === 'error' ? 'Try again' : 'Update now'}
          </button>
        </div>
      </div>
    </div>
  );
}
