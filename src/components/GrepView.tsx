import { createEffect, createMemo, createResource, createSignal, For, JSX, on, onCleanup, onMount, Show } from 'solid-js';
import { openPath, revealPath } from '../commands/actions';
import { invoke } from '../ipc/invoke';
import type { FileHit, LineHit } from '../ipc/types';
import { fmtCount, fmtDate, fmtSize, isInside, parentOf } from '../lib/fs';
import { Icon } from '../lib/icons';
import { trackDrag } from '../state/drag';
import { grepState } from '../state/grep';
import { settings, setSettings } from '../state/settings';
import { displayName } from '../state/system';
import { currentDir, Tab } from '../state/tabs';
import { focusSearch, viewApi } from '../state/ui';
import { openWithShell } from './shellMenu';
import { EmptyState } from './EmptyState';
import { FileIcon } from './FileIcon';
import { CodeView } from './Preview';

type Row =
  | { kind: 'file'; f: FileHit; key: string }
  | { kind: 'line'; f: FileHit; l: LineHit; key: string }
  | { kind: 'more'; f: FileHit; key: string };
const H = { file: 38, line: 26, more: 24 } as const;

function Snippet(p: { l: LineHit }) {
  const parts = () => {
    const out: JSX.Element[] = [];
    let at = 0;
    const t = p.l.text;
    for (const [a, b] of p.l.ranges) {
      if (a < at) continue;
      if (a > at) out.push(t.slice(at, a));
      out.push(<mark>{t.slice(a, b)}</mark>);
      at = b;
    }
    if (at < t.length) out.push(t.slice(at));
    return out;
  };
  return <span class="gr-snip">{parts()}</span>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function GrepView(p: { tab: Tab }) {
  const t = p.tab;
  const st = () => grepState(t);
  const s = () => t.search()!;
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [selKey, setSelKey] = createSignal<string | null>(null);
  let list!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);

  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const c = collapsed();
    for (const f of st().files) {
      out.push({ kind: 'file', f, key: f.path });
      if (c.has(f.path)) continue;
      for (const l of f.lines) out.push({ kind: 'line', f, l, key: `${f.path}\n${l.line}` });
      if (f.matches > f.lines.length) out.push({ kind: 'more', f, key: `${f.path}\n+` });
    }
    return out;
  });
  const offsets = createMemo(() => {
    const r = rows();
    const o = new Float64Array(r.length + 1);
    for (let i = 0; i < r.length; i++) o[i + 1] = o[i] + H[r[i].kind];
    return o;
  });
  const indexAt = (y: number) => {
    const o = offsets();
    let lo = 0, hi = o.length - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (o[m] <= y) lo = m; else hi = m - 1; }
    return Math.max(0, lo);
  };
  const visible = createMemo(() => {
    const r = rows();
    if (!r.length) return [];
    const a = indexAt(Math.max(0, scrollTop() - 200));
    const b = indexAt(scrollTop() + viewH() + 200);
    const out: number[] = [];
    for (let i = a; i <= b && i < r.length; i++) out.push(i);
    return out;
  });
  const selIndex = createMemo(() => { const k = selKey(); return k ? rows().findIndex((r) => r.key === k) : -1; });
  const selRow = () => rows()[selIndex()] as Row | undefined;

  // Keep a sensible selection as results stream in: the best match's first line.
  createEffect(() => {
    const r = rows();
    if (selIndex() < 0 && r.length) setSelKey((r.find((x) => x.kind === 'line') ?? r[0]).key);
  });
  createEffect(on(() => st().query, () => { setSelKey(null); setCollapsed(new Set<string>()); list.scrollTop = 0; }, { defer: true }));

  onMount(() => {
    const ro = new ResizeObserver(() => setViewH(list.clientHeight));
    ro.observe(list);
    onCleanup(() => ro.disconnect());
    viewApi.focus = () => list.focus();
    list.focus();
  });

  const reveal = (i: number) => {
    const o = offsets();
    const top = o[i], bot = o[i + 1];
    if (top < list.scrollTop) list.scrollTop = top - 4;
    else if (bot > list.scrollTop + list.clientHeight) list.scrollTop = bot - list.clientHeight + 4;
  };
  const select = (i: number) => {
    const r = rows();
    i = Math.max(0, Math.min(r.length - 1, i));
    if (r[i]?.kind === 'more') i += i > selIndex() ? 1 : -1;
    if (!r[i]) return;
    setSelKey(r[i].key);
    reveal(i);
  };
  const toggle = (path: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  const open = (r: Row | undefined) => { if (r) openPath(r.f.path, false); };

  const onKey = (e: KeyboardEvent) => {
    const i = selIndex();
    const r = selRow();
    const page = Math.max(1, Math.floor(list.clientHeight / H.line) - 1);
    const k = e.key;
    let handled = true;
    if (k === 'ArrowDown') select(i + 1);
    else if (k === 'ArrowUp') select(i - 1);
    else if (k === 'PageDown') select(i + page);
    else if (k === 'PageUp') select(i - page);
    else if (k === 'Home') select(0);
    else if (k === 'End') select(rows().length - 1);
    else if (k === 'ArrowLeft' && r) { if (!collapsed().has(r.f.path)) toggle(r.f.path); setSelKey(r.f.path); }
    else if (k === 'ArrowRight' && r?.kind === 'file' && collapsed().has(r.f.path)) toggle(r.f.path);
    else if (k === 'Enter' && (e.ctrlKey || e.altKey)) { if (r) revealPath(r.f.path, t); }
    else if (k === 'Enter') open(r);
    else if (k === 'Escape') focusSearch();
    else if (k === ' ') { /* the preview is already showing */ }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const rowMenu = (e: MouseEvent, r: Row) => {
    e.preventDefault();
    e.stopPropagation();
    setSelKey(r.kind === 'more' ? r.f.path : r.key);
    openWithShell(e.clientX, e.clientY, (shell) => ({
      items: [
        { label: 'Open', icon: 'external', shortcut: 'Enter', run: () => open(r) },
        { label: 'Open with', icon: 'external', submenu: shell.openWith },
        { label: 'Show in folder', icon: 'folder', shortcut: 'Ctrl+Enter', run: () => revealPath(r.f.path, t) },
        { label: 'Copy path', icon: 'link', run: () => navigator.clipboard.writeText(r.f.path).catch(() => {}) },
        { sep: true },
        { label: 'More options', icon: 'more', submenu: shell.more },
      ],
    }), { paths: [r.f.path], dir: null }, e.shiftKey);
  };

  const relDir = (path: string) => {
    const d = parentOf(path) ?? '';
    const scope = s().everywhere ? null : currentDir(t);
    if (scope && isInside(path, scope)) { const rest = d.slice(scope.length).replace(/^\\/, ''); return rest || displayName(scope); }
    return d;
  };

  const markRe = createMemo(() => {
    const q = s().query.trim();
    if (!q) return null;
    try {
      const src = s().regex ? q : [q, ...q.split(/\s+/).filter((w) => w.length > 1 && w !== q)].map(escapeRe).join('|');
      return new RegExp(s().wholeWord ? `\\b(?:${src})\\b` : src, s().caseSensitive ? 'g' : 'gi');
    } catch { return null; }
  });

  const RowView = (rp: { i: number }) => {
    const r = () => rows()[rp.i];
    const style = () => ({ transform: `translateY(${offsets()[rp.i]}px)`, height: `${H[r().kind]}px` });
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const row = r();
      trackDrag(e, () => ({ paths: [row.f.path], name: row.f.name, flags: 0 }), () => {
        if (row.kind === 'more') { setSelKey(row.f.path); return; }
        setSelKey(row.key);
      });
    };
    return (
      <Show when={r()}>
        {(row) => (
          <div class={`gr-row gr-${row().kind}`} classList={{ sel: selKey() === row().key }} style={style()}
            onPointerDown={down} onDblClick={() => open(row())} onContextMenu={(e) => rowMenu(e, row())}>
            <Show when={row().kind === 'file'}>
              <button class="gr-chev" classList={{ shut: collapsed().has(row().f.path) }} aria-label="Collapse" onPointerDown={(e) => e.stopPropagation()} onClick={() => toggle(row().f.path)}>
                <Icon name="chevronDown" size={12} />
              </button>
              <FileIcon name={row().f.name} flags={0} path={row().f.path} size={16} />
              <span class="gr-name">{row().f.name}</span>
              <span class="gr-dir" title={row().f.path}>{relDir(row().f.path)}</span>
              <span class="gr-count num">{row().f.matches >= 5000 ? '5000+' : fmtCount(row().f.matches)}</span>
            </Show>
            <Show when={row().kind === 'line'}>
              <span class="gr-ln num">{(row() as Extract<Row, { kind: 'line' }>).l.line}</span>
              <Snippet l={(row() as Extract<Row, { kind: 'line' }>).l} />
            </Show>
            <Show when={row().kind === 'more'}>
              <span class="gr-more">{fmtCount(row().f.matches - row().f.lines.length)} more in this file</span>
            </Show>
          </div>
        )}
      </Show>
    );
  };

  // ── preview ──
  const target = createMemo(() => { const r = selRow(); return r ? { path: r.f.path, name: r.f.name, line: r.kind === 'line' ? r.l.line : r.f.lines[0]?.line ?? 0, f: r.f } : null; });
  const MAX = 4 << 20;
  const [text] = createResource(() => target()?.path, async (path) => {
    try { return await invoke('read_text', { path, maxBytes: MAX }); } catch { return null; }
  });
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = settings.grepPreviewWidth;
    const move = (ev: PointerEvent) => setSettings('grepPreviewWidth', Math.max(300, Math.min(window.innerWidth - 420, Math.round(w0 - (ev.clientX - x0)))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.documentElement.classList.remove('col-resizing'); };
    document.documentElement.classList.add('col-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const empty = () => st().done && !st().files.length;
  return (
    <div class="grep">
      <div class="gr-list" ref={list} tabindex="0" onKeyDown={onKey} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <Show when={!empty()} fallback={
          <Show when={st().error} fallback={
            <Show when={st().query.length >= 2 || (s().regex && st().query)} fallback={<EmptyState icon="fileSearch" title="Search inside your files" detail="Type at least two characters. Matches are ranked by how likely they're what you mean." />}>
              <EmptyState icon="fileSearch" title="No matches" detail={`Nothing in ${fmtCount(st().scanned)} files contains “${st().query}”.${s().everywhere ? '' : ' Try searching everywhere.'}`} />
            </Show>
          }>
            <EmptyState icon="alert" title="Can't search for that" detail={st().error!} />
          </Show>
        }>
          <div class="gr-canvas" style={{ height: `${offsets()[rows().length]}px` }}>
            <For each={visible()}>{(i) => <RowView i={i} />}</For>
          </div>
        </Show>
      </div>
      <Show when={target()}>
        {(tg) => (
          <aside class="gr-preview" style={{ width: `${settings.grepPreviewWidth}px` }}>
            <div class="pp-resizer" onPointerDown={startResize} />
            <div class="gr-pv-head">
              <FileIcon name={tg().name} flags={0} path={tg().path} size={20} />
              <div class="gr-pv-title">
                <div class="gr-pv-name">{tg().name}</div>
                <div class="gr-pv-sub">{fmtSize(tg().f.size)} · {fmtDate(tg().f.modified)}{tg().line ? ` · line ${tg().line}` : ''}</div>
              </div>
              <button class="btn btn-icon btn-sm" data-tip="Show in folder  (Ctrl+Enter)" aria-label="Show in folder" onClick={() => revealPath(tg().path, t)}><Icon name="folder" size={14} /></button>
              <button class="btn btn-text btn-sm btn-outline" onClick={() => openPath(tg().path, false)}><Icon name="external" size={14} />Open</button>
            </div>
            <div class="gr-pv-body">
              <Show when={text() != null} fallback={<div class="pv-note">{text.loading ? 'Loading…' : "Can't preview this file"}</div>}>
                <CodeView text={text()!} name={tg().name} mode="look" truncated={tg().f.size > MAX} focusLine={tg().line} mark={markRe()} />
              </Show>
            </div>
          </aside>
        )}
      </Show>
    </div>
  );
}
