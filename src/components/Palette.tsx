import { createEffect, createMemo, createSignal, For, on, onMount, Show } from 'solid-js';
import { openPath } from '../commands/actions';
import { allCommands, runCommand, shortcutLabel } from '../commands/registry';
import { invoke } from '../ipc/invoke';
import { baseName, isDir, parentOf } from '../lib/fs';
import { fuzzy, markParts } from '../lib/fuzzy';
import { Icon, IconName } from '../lib/icons';
import { popIn } from '../lib/motion';
import { settings } from '../state/settings';
import { displayName, frecentDirs, iconForPath, known, recentFiles } from '../state/system';
import { currentDir } from '../state/tabs';
import { setPaletteOpen, viewApi } from '../state/ui';
import { FileIcon } from './FileIcon';

interface Row { key: string; group: string; label: string; sub?: string; icon?: IconName; file?: { path: string; flags: number; extOnly?: boolean }; shortcut?: string; marks?: number[]; run: (newTab?: boolean) => void }

let paletteReq = 0;
export function Palette() {
  let input!: HTMLInputElement;
  let panel!: HTMLDivElement;
  let list!: HTMLDivElement;
  const [q, setQ] = createSignal('');
  const [hi, setHi] = createSignal(0);
  const [suggest, setSuggest] = createSignal<Row[]>([]);
  const [files, setFiles] = createSignal<Row[]>([]);
  const close = () => { setPaletteOpen(false); queueMicrotask(() => viewApi.focus()); };

  onMount(async () => {
    popIn(panel, 'top center');
    input.focus();
    const dir = currentDir() ?? known()?.home;
    if (!dir) return;
    try {
      const s = await invoke('suggest_next', { dir, limit: 6 });
      setSuggest(s.map((x): Row => ({ key: 's' + x.path, group: 'Suggested folders', label: displayName(x.path), sub: x.path, icon: iconForPath(x.path), run: (nt) => openPath(x.path, true, { newTab: nt }) })));
    } catch { /* suggestions are optional */ }
  });

  createEffect(on(q, (text) => {
    const query = text.trim();
    const id = ++paletteReq;
    if (!query || query.startsWith('>')) { setFiles([]); return; }
    invoke('search', { reqId: id, query, options: { scope: null, limit: 12, offset: 0, includeHidden: settings.showHidden } }).then((r) => {
      if (r.reqId !== id || id !== paletteReq) return;
      setFiles(r.hits.map((h): Row => {
        const dir = isDir(h.flags);
        return { key: 'f' + h.path, group: 'Files and folders', label: h.name, sub: parentOf(h.path) ?? '', file: { path: h.path, flags: h.flags }, run: (nt) => openPath(h.path, dir, { newTab: nt }) };
      }));
    }, () => { if (id === paletteReq) setFiles([]); });
  }));

  const rows = createMemo((): Row[] => {
    const raw = q().trim();
    const cmdOnly = raw.startsWith('>');
    const query = cmdOnly ? raw.slice(1).trim() : raw;
    const cmds = allCommands().filter((c) => !c.hidden && (!c.enabled || c.enabled()))
      .map((c) => ({ c, m: fuzzy(query, `${c.label}`) ?? fuzzy(query, `${c.category} ${c.label}`) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .slice(0, cmdOnly ? 50 : query ? 6 : 0)
      .map(({ c, m }): Row => ({ key: c.id, group: 'Commands', label: c.label, sub: c.category, icon: c.icon ?? 'bolt', shortcut: shortcutLabel(c.id), marks: query && fuzzy(query, c.label) ? m!.marks : [], run: () => runCommand(c.id) }));
    if (cmdOnly) return cmds;
    if (!query) {
      const recent = recentFiles().slice(0, 6).map((f): Row => ({ key: 'r' + f.path, group: 'Recent files', label: baseName(f.path), sub: parentOf(f.path) ?? '', file: { path: f.path, flags: 0, extOnly: true }, run: () => openPath(f.path, false) }));
      const sug = suggest().length ? suggest() : frecentDirs().slice(0, 5).map((f): Row => ({ key: 'd' + f.path, group: 'Frequent folders', label: displayName(f.path), sub: f.path, icon: iconForPath(f.path), run: (nt) => openPath(f.path, true, { newTab: nt }) }));
      return [...sug, ...recent];
    }
    const dirs = frecentDirs().map((f) => ({ f, m: fuzzy(query, baseName(f.path)) })).filter((x) => x.m).slice(0, 4)
      .map(({ f, m }): Row => ({ key: 'd' + f.path, group: 'Frequent folders', label: displayName(f.path), sub: f.path, icon: iconForPath(f.path), marks: m!.marks, run: (nt) => openPath(f.path, true, { newTab: nt }) }));
    const seen = new Set(dirs.map((d) => d.key.slice(1).toLowerCase()));
    return [...cmds, ...dirs, ...files().filter((f) => !seen.has(f.key.slice(1).toLowerCase()))];
  });

  createEffect(on(q, () => setHi(0)));
  createEffect(on(hi, (i) => list?.querySelectorAll<HTMLElement>('.pal-row')[i]?.scrollIntoView({ block: 'nearest' })));

  const onKey = (e: KeyboardEvent) => {
    const r = rows();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(r.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const row = r[hi()]; if (row) { close(); row.run(e.ctrlKey); } }
  };

  return (
    <div class="scrim scrim-top" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="palette pop" ref={panel} role="dialog" aria-label="Command palette" data-modal>
        <div class="pal-input">
          <Icon name="search" />
          <input ref={input} placeholder="Search files, folders and commands   ( > for commands only )" value={q()} spellcheck={false} autocomplete="off"
            onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} />
        </div>
        <div class="pal-list" ref={list} role="listbox">
          <For each={rows()}>{(r, i) => (
            <>
              <Show when={i() === 0 || rows()[i() - 1].group !== r.group}><div class="pal-group">{r.group}</div></Show>
              <div class="pal-row" classList={{ hi: hi() === i() }} role="option" aria-selected={hi() === i()}
                onPointerMove={() => setHi(i())} onClick={(e) => { close(); r.run(e.ctrlKey); }}>
                <span class="pal-icon">
                  <Show when={r.file} fallback={<Icon name={r.icon ?? 'bolt'} />}>
                    <FileIcon name={baseName(r.file!.path)} flags={r.file!.flags} path={r.file!.path} size={16} extOnly={r.file!.extOnly} />
                  </Show>
                </span>
                <span class="pal-label"><For each={markParts(r.label, r.marks ?? [])}>{(x) => (x.m ? <mark>{x.s}</mark> : x.s)}</For></span>
                <span class="pal-sub">{r.sub}</span>
                <Show when={r.shortcut}><kbd>{r.shortcut}</kbd></Show>
              </div>
            </>
          )}</For>
          <Show when={!rows().length}><div class="pal-empty">{q().trim() ? 'No matches' : 'Start typing to search'}</div></Show>
        </div>
      </div>
    </div>
  );
}
