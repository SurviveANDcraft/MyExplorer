import { createEffect, createMemo, createSignal, For, on, onMount, Show } from 'solid-js';
import { transferTo } from '../commands/actions';
import { invoke } from '../ipc/invoke';
import { baseName, join, normPath, parentOf, samePath } from '../lib/fs';
import { fuzzy, markParts } from '../lib/fuzzy';
import { Icon } from '../lib/icons';
import { popIn } from '../lib/motion';
import { settings } from '../state/settings';
import { displayName, drives, frecentDirs, iconForPath, knownEntries } from '../state/system';
import { picker, setPicker, viewApi } from '../state/ui';

interface Dest { path: string; reason: string; marks?: number[] }

export function Picker() {
  const job = picker()!;
  let input!: HTMLInputElement;
  let panel!: HTMLDivElement;
  const [q, setQ] = createSignal('');
  const [hi, setHi] = createSignal(0);
  const [predicted, setPredicted] = createSignal<Dest[]>([]);
  const [typed, setTyped] = createSignal<Dest[]>([]);
  const sources = new Set(job.paths.map((p) => (parentOf(p) ?? '').toLowerCase()));
  const close = () => { setPicker(null); queueMicrotask(() => viewApi.focus()); };

  onMount(async () => {
    popIn(panel, 'top center');
    input.focus();
    try {
      const s = await invoke('suggest_destinations', { paths: job.paths, limit: 8 });
      setPredicted(s.map((x) => ({ path: x.path, reason: x.reason === 'history' ? 'Predicted' : x.reason === 'frecent' ? 'Frequent' : 'Nearby' })));
    } catch { /* fall back to frequent + known */ }
  });

  const pool = createMemo(() => {
    const out: Dest[] = [];
    const add = (path: string, reason: string) => {
      if (job.mode === 'move' && sources.has(path.toLowerCase())) return;
      if (job.paths.some((p) => samePath(p, path))) return;
      if (!out.some((d) => samePath(d.path, path))) out.push({ path, reason });
    };
    predicted().forEach((d) => add(d.path, d.reason));
    frecentDirs().forEach((f) => add(f.path, 'Frequent'));
    settings.pinned.forEach((p) => add(p, 'Pinned'));
    knownEntries().forEach((k) => add(k.path, 'Location'));
    drives().forEach((d) => add(d.path, 'Drive'));
    return out;
  });

  let seq = 0;
  createEffect(on(q, async (text) => {
    const v = text.trim();
    const id = ++seq;
    if (!/^[a-z]:/i.test(v) && !v.includes('\\')) { setTyped([]); return; }
    const p = v.replace(/\//g, '\\');
    const cut = p.lastIndexOf('\\');
    const parent = normPath(p.slice(0, cut + 1) || p);
    const pre = p.slice(cut + 1).toLowerCase();
    const res: Dest[] = [{ path: normPath(p), reason: 'Typed path' }];
    try {
      const names = await invoke('list_subdirs', { path: parent, showHidden: settings.showHidden });
      if (id !== seq) return;
      for (const n of names) if (n.toLowerCase().startsWith(pre)) { const full = join(parent, n); if (!samePath(full, res[0].path)) res.push({ path: full, reason: 'Folder' }); if (res.length > 8) break; }
    } catch { /* parent not valid yet */ }
    if (id === seq) setTyped(res);
  }));

  const rows = createMemo((): Dest[] => {
    const v = q().trim();
    if (typed().length) return typed();
    if (!v) return pool().slice(0, 10);
    return pool().map((d) => ({ ...d, m: fuzzy(v, displayName(d.path)) ?? fuzzy(v, d.path) }))
      .filter((x) => x.m).sort((a, b) => b.m!.score - a.m!.score).slice(0, 10)
      .map((x) => ({ path: x.path, reason: x.reason, marks: fuzzy(v, displayName(x.path))?.marks ?? [] }));
  });
  createEffect(on(rows, () => setHi(0)));

  const confirm = (d?: Dest) => {
    if (!d) return;
    close();
    transferTo(job.paths, d.path, job.mode);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(rows().length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Tab' && rows()[hi()]) { e.preventDefault(); const v = rows()[hi()].path + '\\'; setQ(v); input.value = v; }
    else if (e.key === 'Enter') { e.preventDefault(); confirm(rows()[hi()]); }
  };
  const what = job.paths.length === 1 ? `"${baseName(job.paths[0])}"` : `${job.paths.length} items`;

  return (
    <div class="scrim scrim-top" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="palette picker pop" ref={panel} role="dialog" aria-label={job.mode === 'move' ? 'Move to' : 'Copy to'} data-modal>
        <div class="picker-title">
          <Icon name={job.mode === 'move' ? 'folderMove' : 'folderCopy'} />
          <span>{job.mode === 'move' ? 'Move' : 'Copy'} {what} to…</span>
          <span class="picker-hint">Enter confirms the top guess</span>
        </div>
        <div class="pal-input">
          <Icon name="search" />
          <input ref={input} placeholder="Filter destinations or type a path" value={q()} spellcheck={false} autocomplete="off"
            onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} />
        </div>
        <div class="pal-list" role="listbox">
          <For each={rows()}>{(d, i) => (
            <div class="pal-row" classList={{ hi: hi() === i() }} role="option" onPointerMove={() => setHi(i())} onClick={() => confirm(d)}>
              <span class="pal-icon"><Icon name={iconForPath(d.path)} /></span>
              <span class="pal-label"><For each={markParts(displayName(d.path), d.marks ?? [])}>{(x) => (x.m ? <mark>{x.s}</mark> : x.s)}</For></span>
              <span class="pal-sub">{d.path}</span>
              <span class="pal-tag" classList={{ accent: d.reason === 'Predicted' }}>{d.reason}</span>
            </div>
          )}</For>
          <Show when={!rows().length}><div class="pal-empty">No matching folders. Type a full path, e.g. C:\Projects</div></Show>
        </div>
      </div>
    </div>
  );
}
