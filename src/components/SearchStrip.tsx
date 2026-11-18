import { For, Show } from 'solid-js';
import { fmtCount } from '../lib/fs';
import { Icon, IconName } from '../lib/icons';
import { displayName } from '../state/system';
import { currentDir, SearchState, setSearchQuery, Tab } from '../state/tabs';
import { MenuItem, openMenuAt } from '../state/ui';

type ChipKey = 'kind' | 'date' | 'size';
const CHIPS: { key: ChipKey; label: string; icon: IconName; options: [string, string][] }[] = [
  { key: 'kind', label: 'Kind', icon: 'filter', options: [['folder', 'Folders'], ['file', 'Files'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Music'], ['doc', 'Documents'], ['code', 'Code'], ['archive', 'Archives']] },
  { key: 'date', label: 'Date modified', icon: 'clock', options: [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year']] },
  { key: 'size', label: 'Size', icon: 'drive', options: [['<100kb', 'Under 100 KB'], ['>1mb', 'Over 1 MB'], ['>100mb', 'Over 100 MB'], ['>1gb', 'Over 1 GB']] },
];

export function SearchStrip(p: { tab: Tab }) {
  const s = () => p.tab.search()!;
  const meta = () => p.tab.searchMeta();
  const choose = (el: HTMLElement, c: (typeof CHIPS)[number]) => {
    const cur = s()[c.key];
    const items: MenuItem[] = c.options.map(([v, label]) => ({ label, checked: cur === v, run: () => setSearchQuery(p.tab, { [c.key]: cur === v ? '' : v } as Partial<SearchState>) }));
    if (cur) items.push({ sep: true }, { label: 'Clear', icon: 'close', run: () => setSearchQuery(p.tab, { [c.key]: '' } as Partial<SearchState>) });
    openMenuAt(el, items);
  };
  return (
    <div class="searchstrip">
      <div class="ss-scope">
        <button class="chip" classList={{ on: !s().everywhere }} disabled={!currentDir(p.tab)} onClick={() => setSearchQuery(p.tab, { everywhere: false })}>
          <Icon name="folder" size={14} />{currentDir(p.tab) ? displayName(currentDir(p.tab)!) : 'This folder'}
        </button>
        <button class="chip" classList={{ on: s().everywhere }} onClick={() => setSearchQuery(p.tab, { everywhere: true })}>
          <Icon name="globe" size={14} />Everywhere
        </button>
      </div>
      <span class="ss-sep" />
      <For each={CHIPS}>{(c) => {
        const val = () => s()[c.key];
        return (
          <button class="chip" classList={{ on: !!val() }} onClick={(e) => choose(e.currentTarget, c)}>
            <Icon name={c.icon} size={14} />{val() ? c.options.find((o) => o[0] === val())?.[1] : c.label}<Icon name="chevronDown" size={12} />
          </button>
        );
      }}</For>
      <span class="ss-meta">
        <Show when={meta()}>
          {(m) => <>
            <Show when={m().pending}><span class="dot-pulse" /></Show>
            {fmtCount(m().total)} result{m().total === 1 ? '' : 's'}
            <span class="ss-dim"> · {m().tookMs} ms</span>
            <Show when={m().partial}><span class="ss-warn"> · index building, results may be incomplete</span></Show>
          </>}
        </Show>
      </span>
    </div>
  );
}
