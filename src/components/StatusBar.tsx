import { createMemo, Show } from 'solid-js';
import { tip } from '../commands/registry';
import { fmtCount, fmtSize, isDir } from '../lib/fs';
import { Icon } from '../lib/icons';
import { indexStatus } from '../state/system';
import { activeTab, isPage, updateView } from '../state/tabs';

export function StatusBar() {
  const t = activeTab;
  const info = createMemo(() => {
    const tab = t();
    const m = tab.model();
    tab.selV();
    let bytes = 0, files = 0, sel = 0;
    for (const i of tab.sel) { if (i >= m.count) continue; sel++; if (!isDir(m.flags[i])) { bytes += m.sizes[i]; files++; } }
    return { count: m.count, sel, bytes, files };
  });
  const home = () => isPage(t().loc()) && !t().search();
  const view = () => t().view().view;
  return (
    <footer class="statusbar">
      <Show when={!home()}>
        <span>{fmtCount(info().count)} {t().search() ? (info().count === 1 ? 'result' : 'results') : info().count === 1 ? 'item' : 'items'}</span>
        <Show when={info().sel}>
          <span class="sb-dot" />
          <span>{fmtCount(info().sel)} selected</span>
          <Show when={info().files}><span class="sb-dot" /><span class="num">{fmtSize(info().bytes)}</span></Show>
        </Show>
      </Show>
      <span class="flex" />
      <Show when={indexStatus()?.state === 'building'}>
        <span class="sb-index"><span class="dot-pulse" />Indexing · {fmtCount(indexStatus()!.entries)} files</span>
      </Show>
      <Show when={!home()}>
        <div class="seg seg-sm">
          <button classList={{ on: view() === 'details' }} data-tip={tip('view.details')} onClick={() => updateView(t(), { view: 'details' })}><Icon name="details" size={14} /></button>
          <button classList={{ on: view() === 'grid' }} data-tip={tip('view.grid')} onClick={() => updateView(t(), { view: 'grid' })}><Icon name="grid" size={14} /></button>
        </div>
      </Show>
    </footer>
  );
}
