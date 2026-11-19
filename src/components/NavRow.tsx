import { createEffect, on, Show } from 'solid-js';
import { getCommand, runCommand, tip } from '../commands/registry';
import { Icon, IconName } from '../lib/icons';
import { settings } from '../state/settings';
import { displayName } from '../state/system';
import { activeTab, currentDir, exitSearch, setSearchQuery } from '../state/tabs';
import { searchContent, searchEverywhere, searchFocusTick, setSearchContent, setSearchEverywhere, viewApi } from '../state/ui';
import { PathBar } from './PathBar';

export function CmdButton(p: { cmd: string; icon?: IconName; label?: string; text?: boolean; class?: string }) {
  const c = () => getCommand(p.cmd);
  const enabled = () => { const x = c(); return !x?.enabled || x.enabled(); };
  return (
    <button class={`btn ${p.text ? 'btn-text' : 'btn-icon'} ${p.class ?? ''}`} disabled={!enabled()} data-tip={tip(p.cmd, p.label)} aria-label={p.label ?? c()?.label}
      onClick={() => runCommand(p.cmd)}>
      <Icon name={p.icon ?? c()?.icon ?? 'more'} />
      <Show when={p.text}><span>{p.label ?? c()?.label}</span></Show>
    </button>
  );
}

function SearchBox() {
  let input!: HTMLInputElement;
  const t = activeTab;
  const s = () => t().search();
  const everywhere = () => s()?.everywhere ?? (searchEverywhere() || !currentDir());
  createEffect(on(searchFocusTick, (n) => { if (n) { input.focus(); input.select(); } }, { defer: true }));
  const content = () => settings.contentSearch && (s()?.content ?? searchContent());
  const placeholder = () => (content()
    ? (everywhere() ? 'Search inside files everywhere' : `Search inside files in ${displayName(currentDir()!)}`)
    : (everywhere() ? 'Search everywhere' : `Search ${displayName(currentDir()!)}`));
  return (
    <div class="searchbox" classList={{ active: !!s(), content: content() }}>
      <Icon name={content() ? 'fileSearch' : 'search'} />
      <input ref={input} placeholder={placeholder()} value={s()?.query ?? ''} spellcheck={false} autocomplete="off"
        onInput={(e) => setSearchQuery(t(), { query: e.currentTarget.value, everywhere: everywhere(), content: content() })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); if (s()) exitSearch(t()); input.blur(); viewApi.focus(); }
          else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); viewApi.focus(); }
        }} />
      <Show when={s()?.query}>
        <button class="btn btn-icon btn-sm" aria-label="Clear search" onClick={() => { exitSearch(t()); input.focus(); }}><Icon name="close" size={14} /></button>
      </Show>
      <Show when={settings.contentSearch}><button class="btn btn-icon btn-sm scope" classList={{ on: content() }}
        data-tip={tip('search.contents', content() ? 'Searching inside files: switch to names' : 'Search inside files')}
        onClick={() => { const v = !content(); setSearchContent(v); if (s()) setSearchQuery(t(), { content: v }); input.focus(); }}>
        <Icon name="fileText" size={14} />
      </button></Show>
      <button class="btn btn-icon btn-sm scope" classList={{ on: everywhere() }} disabled={!currentDir()}
        data-tip={tip('search.everywhere', everywhere() ? 'Searching everywhere — switch to this folder' : 'Searching this folder — switch to everywhere')}
        onClick={() => { const v = !everywhere(); setSearchEverywhere(v); if (s()) setSearchQuery(t(), { everywhere: v }); input.focus(); }}>
        <Icon name={everywhere() ? 'globe' : 'folder'} size={14} />
      </button>
    </div>
  );
}

export function NavRow() {
  return (
    <div class="navrow">
      <div class="navbtns">
        <CmdButton cmd="nav.back" />
        <CmdButton cmd="nav.forward" />
        <CmdButton cmd="nav.up" />
        <CmdButton cmd="nav.refresh" />
      </div>
      <PathBar />
      <SearchBox />
    </div>
  );
}
