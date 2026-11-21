// Storage page: drive usage, a live treemap of what fills it, and ranked cleanup suggestions.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { invoke } from '../ipc/invoke';
import type { CleanupItem, CleanupKind } from '../ipc/types';
import { baseName, fmtCount, fmtSize, isInside, parentOf, samePath, segments } from '../lib/fs';
import { Icon } from '../lib/icons';
import { animate } from '../lib/motion';
import { driveLabel, drives } from '../state/system';
import { activeTab, expectSelection, newTab } from '../state/tabs';
import { attempt, MenuItem, openMenu } from '../state/ui';
import {
  CATS, chooseDrive, drive, emptyRecycleBin, Filter, FILTERS, hoverCat, ignore, ignored, isGone, limit, loadMore, minSize, mountStorage,
  phase, recycle, removePaths, setHoverCat, setHoverPath, setMin, SortBy, sugg, summary, tree, unmountStorage, zoom, zoomTo,
} from '../state/storage';
import { indexStatus } from '../state/system';
import { FileIcon } from './FileIcon';
import { Block, Treemap } from './Treemap';

const KIND: Record<CleanupKind, { label: string; safe: boolean }> = {
  rebuildable: { label: 'Rebuildable', safe: true },
  cache: { label: 'Cache', safe: true },
  temp: { label: 'Temporary', safe: true },
  installer: { label: 'Installer', safe: true },
  duplicate: { label: 'Duplicate', safe: true },
  archive: { label: 'Archive', safe: false },
  diskimage: { label: 'Disk image', safe: false },
  media: { label: 'Media', safe: false },
  stale: { label: 'Untouched folder', safe: false },
  download: { label: 'Download', safe: false },
  large: { label: 'Large file', safe: false },
};

const SIZES: [number, string][] = [[10, '≥ 10 MB'], [50, '≥ 50 MB'], [100, '≥ 100 MB'], [500, '≥ 500 MB'], [1024, '≥ 1 GB']];

function ago(ms: number) {
  if (!ms) return '—';
  const d = Math.floor((Date.now() - ms) / 864e5);
  if (d < 1) return 'Today';
  if (d < 2) return 'Yesterday';
  if (d < 45) return `${d} days ago`;
  if (d < 365) return `${Math.round(d / 30)} mo ago`;
  const y = d / 365;
  return y < 2 ? '1 yr ago' : `${Math.floor(y)} yr ago`;
}

function openInTab(path: string, dir: boolean) {
  if (dir) { newTab({ kind: 'dir', path }, { after: activeTab() }); return; }
  const parent = parentOf(path);
  if (!parent) return;
  const t = newTab({ kind: 'dir', path: parent }, { after: activeTab() });
  expectSelection(t, [baseName(path)]);
}
const openItem = (path: string, dir: boolean) => (dir ? openInTab(path, true) : attempt(invoke('open', { path }), `Couldn't open ${baseName(path)}`));

function itemMenu(e: MouseEvent, path: string, dir: boolean, extra: MenuItem[] = []) {
  e.preventDefault();
  openMenu({
    x: e.clientX, y: e.clientY, items: [
      { label: dir ? 'Open in new tab' : 'Open', icon: 'external', run: () => openItem(path, dir) },
      { label: 'Show in folder', icon: 'folder', run: () => openInTab(path, false) },
      ...extra,
      { label: 'Copy as path', icon: 'link', run: () => navigator.clipboard.writeText(`"${path}"`) },
      { label: 'Properties', icon: 'info', run: () => invoke('show_properties', { paths: [path] }).catch(() => {}) },
      { sep: true },
      { label: 'Move to Recycle Bin', icon: 'trash', run: () => removePaths([path], false) },
      { label: 'Delete permanently', icon: 'trash', danger: true, run: () => removePaths([path], true) },
    ],
  });
}

// ── Usage header ─────────────────────────────────────────────────────────────
function Usage() {
  const d = () => drives().find((x) => samePath(x.path, drive()));
  const segs = createMemo(() => {
    const s = summary(), dv = d();
    if (!dv || !dv.total) return [];
    const used = dv.total - dv.free;
    const out: { label: string; color: string; size: number; cat: number | null }[] = [];
    if (s) {
      CATS.forEach((c, i) => { if (s.cats[i] > 0) out.push({ label: c.label, color: c.color, size: s.cats[i], cat: i }); });
      out.sort((a, b) => b.size - a.size);
      const rest = used - s.size;
      if (rest > dv.total * 0.005) out.push({ label: 'System & unreadable', color: 'var(--text-3)', size: rest, cat: null });
    } else out.push({ label: 'Used', color: 'var(--accent)', size: used, cat: null });
    return out;
  });
  return (
    <Show when={d()}>{(dv) => {
      const used = () => dv().total - dv().free;
      return (
        <div class="st-usage">
          <div class="st-usage-nums">
            <span class="st-big num">{fmtSize(dv().free)}</span><span class="st-dim">free of {fmtSize(dv().total)}</span>
            <span class="flex" />
            <span class="st-dim num">{Math.round((used() / dv().total) * 100)}% used</span>
          </div>
          <div class="st-bar" role="img" aria-label="Drive usage by category">
            <For each={segs()}>{(s) => (
              <span class="st-bar-seg" classList={{ dim: hoverCat() !== null && hoverCat() !== s.cat }}
                style={{ 'flex-grow': s.size, background: s.color }} onMouseEnter={() => setHoverCat(s.cat)} onMouseLeave={() => setHoverCat(null)} />
            )}</For>
            <span class="st-bar-free" style={{ 'flex-grow': dv().free }} />
          </div>
          <div class="st-legend">
            <For each={segs()}>{(s) => (
              <span class="st-leg" classList={{ on: hoverCat() === s.cat && s.cat !== null }} onMouseEnter={() => setHoverCat(s.cat)} onMouseLeave={() => setHoverCat(null)}>
                <span class="st-sw" style={{ background: s.color }} />{s.label}<span class="num st-dim">{fmtSize(s.size)}</span>
              </span>
            )}</For>
          </div>
        </div>
      );
    }}</Show>
  );
}

// ── Map ──────────────────────────────────────────────────────────────────────
function MapSection() {
  const crumbs = () => {
    const segs = segments(zoom());
    const root = segments(drive()).length;
    return segs.slice(root - 1);
  };
  const onMenu = (b: Block, e: MouseEvent) => {
    const extra: MenuItem[] = b.node.t === 1 && b.node.k?.length ? [{ label: 'Zoom in', icon: 'search', run: () => zoomTo(b.path!) }] : [];
    itemMenu(e, b.path!, b.node.t === 1, extra);
  };
  return (
    <section class="st-map">
      <div class="st-map-bar">
        <button class="btn btn-sm btn-icon" title="Up one level" disabled={samePath(zoom(), drive())} onClick={() => { const p = parentOf(zoom()); if (p) zoomTo(p); }}>
          <Icon name="up" size={14} />
        </button>
        <div class="st-crumbs">
          <For each={crumbs()}>{(c, i) => (
            <>
              <Show when={i() > 0}><Icon name="chevronRight" size={12} /></Show>
              <button class="st-crumb" classList={{ last: i() === crumbs().length - 1 }} onClick={() => zoomTo(c.path)}>{i() === 0 ? c.path.slice(0, 2) : c.name}</button>
            </>
          )}</For>
        </div>
        <span class="flex" />
        <Show when={tree()}>{(t) => (
          <span class="st-dim num st-map-meta">
            <Show when={t().pending}><span class="dot-pulse" />Sizing {fmtCount(t().pending)} folders · </Show>
            {fmtSize(t().size)} · {fmtCount(t().files)} files
          </span>
        )}</Show>
      </div>
      <div class="st-map-body">
        <Show when={tree()} fallback={<MapState />}>{(t) => (
          <Treemap tree={t()} onZoom={zoomTo} onOpen={(b) => openItem(b.path!, b.node.t === 1)} onMenu={onMenu} />
        )}</Show>
      </div>
    </section>
  );
}

function MapState() {
  return (
    <div class="st-state">
      <Show when={phase() === 'indexing'} fallback={
        <Show when={phase() === 'missing'} fallback={<span class="st-dim"><span class="dot-pulse" />Measuring…</span>}>
          <span class="st-dim">This location isn't in the file index (only fixed drives are indexed).</span>
        </Show>
      }>
        <span class="st-dim"><span class="dot-pulse" />Building the file index · {fmtCount(indexStatus()?.entries ?? 0)} files so far</span>
      </Show>
    </div>
  );
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
function Cleanup() {
  const [filter, setFilter] = createSignal<Filter>('all');
  const [sort, setSort] = createSignal<SortBy>('score');
  const [text, setText] = createSignal('');
  const [here, setHere] = createSignal(true);
  const [shown, setShown] = createSignal(60);
  const [sel, setSel] = createSignal<Set<string>>(new Set());
  const zoomed = () => !samePath(zoom(), drive());

  const base = createMemo(() => {
    const s = sugg();
    if (!s) return [];
    const z = zoom(), inZoom = zoomed() && here();
    return s.items.filter((it) => !ignored(it.path) && !isGone(it.path) && (!inZoom || isInside(it.path, z) || samePath(it.path, z)));
  });
  const counts = createMemo(() => {
    const m = new Map<Filter, number>();
    for (const f of FILTERS) m.set(f.id, 0);
    for (const it of base()) for (const f of FILTERS) if (f.match(it)) m.set(f.id, m.get(f.id)! + 1);
    return m;
  });
  const list = createMemo(() => {
    const f = FILTERS.find((x) => x.id === filter())!;
    const q = text().trim().toLowerCase();
    const l = base().filter((it) => f.match(it) && (!q || it.path.toLowerCase().includes(q) || it.reasons.some((r) => r.toLowerCase().includes(q))));
    const by = sort();
    if (by === 'size') l.sort((a, b) => b.size - a.size);
    else if (by === 'age') l.sort((a, b) => a.lastUsed - b.lastUsed);
    return l;
  });
  const potential = createMemo(() => list().reduce((n, it) => n + (it.nested ? 0 : it.size), 0));
  const selected = createMemo(() => list().filter((it) => sel().has(it.path)));
  const selBytes = createMemo(() => {
    const ps = selected();
    return ps.reduce((n, it) => n + (ps.some((o) => o !== it && isInside(it.path, o.path)) ? 0 : it.size), 0);
  });
  const toggle = (p: string, on?: boolean) => setSel((s) => { const n = new Set(s); (on ?? !n.has(p)) ? n.add(p) : n.delete(p); return n; });
  const clearSel = () => setSel(new Set<string>());
  const del = (permanent: boolean, paths = selected().map((x) => x.path)) => { if (!paths.length) return; clearSel(); removePaths(paths, permanent); };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input')) return;
    if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); del(e.shiftKey); }
    else if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); e.stopPropagation(); setSel(new Set(list().slice(0, shown()).map((x) => x.path))); }
    else if (e.key === 'Escape' && sel().size) { e.stopPropagation(); clearSel(); }
  };
  const rowMenu = (e: MouseEvent, it: CleanupItem) => itemMenu(e, it.path, it.dir, [
    ...(it.dir ? [{ label: 'Show in map', icon: 'search' as const, run: () => zoomTo(it.path) }] : []),
    { label: 'Keep — don’t suggest again', icon: 'check', run: () => ignore(it.path) },
  ]);
  const allShownSelected = () => { const l = list().slice(0, shown()); return l.length > 0 && l.every((x) => sel().has(x.path)); };

  return (
    <section class="st-clean" tabIndex={-1} onKeyDown={onKey}>
      <div class="st-clean-head">
        <h2>Cleanup suggestions</h2>
        <Show when={sugg()}>
          <span class="st-dim">
            <Show when={list().length} fallback="Nothing to suggest with these filters">
              Up to <b class="st-strong num">{fmtSize(potential())}</b> in {fmtCount(list().length)} {list().length === 1 ? 'item' : 'items'}
            </Show>
          </span>
        </Show>
        <span class="flex" />
        <select class="select" value={Math.round(minSize() / 2 ** 20)} onChange={(e) => setMin(Number(e.currentTarget.value) * 2 ** 20)} title="Smallest item to suggest">
          <For each={SIZES}>{([v, l]) => <option value={v}>{l}</option>}</For>
        </select>
        <div class="seg">
          <button classList={{ on: sort() === 'score' }} onClick={() => setSort('score')}>Recommended</button>
          <button classList={{ on: sort() === 'size' }} onClick={() => setSort('size')}>Largest</button>
          <button classList={{ on: sort() === 'age' }} onClick={() => setSort('age')}>Oldest</button>
        </div>
      </div>

      <Show when={recycle().size > 0}>
        <div class="st-bin">
          <Icon name="trash" />
          <span><b class="num">{fmtSize(recycle().size)}</b> is sitting in the Recycle Bin ({fmtCount(recycle().items)} items) — it still takes space until you empty it.</span>
          <span class="flex" />
          <button class="btn btn-outline btn-text" onClick={emptyRecycleBin}>Empty Recycle Bin</button>
        </div>
      </Show>

      <div class="st-filters">
        <For each={FILTERS}>{(f) => (
          <button class="chip" classList={{ on: filter() === f.id }} disabled={f.id !== 'all' && !counts().get(f.id)} onClick={() => { setFilter(f.id); setShown(60); }}>
            {f.label}<span class="num st-chip-n">{counts().get(f.id)}</span>
          </button>
        )}</For>
        <span class="flex" />
        <Show when={zoomed()}>
          <button class="chip" classList={{ on: here() }} onClick={() => setHere(!here())} title="Only suggestions inside the folder shown in the map">
            <Icon name="filter" size={12} />In {baseName(zoom())}
          </button>
        </Show>
        <div class="st-search">
          <Icon name="search" size={14} />
          <input placeholder="Filter" value={text()} onInput={(e) => { setText(e.currentTarget.value); setShown(60); }} spellcheck={false} />
        </div>
      </div>

      <Show when={sugg()} fallback={<div class="st-empty st-dim"><Show when={phase() !== 'missing'}><span class="dot-pulse" />Looking for things you could delete…</Show></div>}>
        <div class="st-list" role="list" onMouseLeave={() => setHoverPath(null)}>
          <div class="st-row st-row-head">
            <span class="st-check" role="checkbox" aria-checked={allShownSelected()} classList={{ on: allShownSelected() }}
              onClick={() => (allShownSelected() ? clearSel() : setSel(new Set(list().slice(0, shown()).map((x) => x.path))))}><Icon name="check" size={12} /></span>
            <span>Item</span><span>Location</span><span class="r">Size</span><span class="r">Last used</span><span />
          </div>
          <For each={list().slice(0, shown())} fallback={<div class="st-empty st-dim">Nothing here. Try a smaller minimum size or another filter.</div>}>{(it) => {
            const k = KIND[it.kind];
            return (
              <div class="st-row" role="listitem" classList={{ sel: sel().has(it.path) }} onMouseEnter={() => setHoverPath(it.path)}
                onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) toggle(it.path); }}
                onDblClick={() => openItem(it.path, it.dir)} onContextMenu={(e) => rowMenu(e, it)}>
                <span class="st-check" classList={{ on: sel().has(it.path) }}><Icon name="check" size={12} /></span>
                <span class="st-item">
                  <FileIcon name={it.name} flags={it.dir ? 1 : 0} path={it.path} size={20} extOnly />
                  <span class="st-item-text">
                    <span class="st-name">{it.name}</span>
                    <span class="st-why">
                      <span class="st-tag" classList={{ safe: k.safe }}>{k.label}</span>
                      <span class="st-reason">{it.reasons[0] ?? (it.dir ? `${fmtCount(it.files)} files` : '')}</span>
                    </span>
                  </span>
                </span>
                <span class="st-loc" title={it.path}>{parentOf(it.path)}</span>
                <span class="r num st-size">{fmtSize(it.size)}</span>
                <span class="r num st-dim" title={it.lastUsed ? new Date(it.lastUsed).toLocaleString() : ''}>{ago(it.lastUsed)}</span>
                <span class="st-acts">
                  <button class="btn btn-sm btn-icon" data-tip="Show in folder" onClick={() => openInTab(it.path, false)}><Icon name="folder" size={14} /></button>
                  <button class="btn btn-sm btn-icon" data-tip="Keep — don’t suggest again" onClick={() => ignore(it.path)}><Icon name="eyeOff" size={14} /></button>
                  <button class="btn btn-sm btn-icon st-del" data-tip="Move to Recycle Bin (Shift: delete permanently)" onClick={(e) => del(e.shiftKey, [it.path])}><Icon name="trash" size={14} /></button>
                </span>
              </div>
            );
          }}</For>
        </div>
        <div class="st-more">
          <Show when={list().length > shown()}>
            <button class="btn btn-outline btn-text" onClick={() => setShown((n) => n + 60)}>Show {Math.min(60, list().length - shown())} more</button>
          </Show>
          <Show when={list().length <= shown() && (sugg()?.total ?? 0) > limit()}>
            <button class="btn btn-outline btn-text" onClick={() => { loadMore(); setShown((n) => n + 60); }}>Find more suggestions</button>
          </Show>
          <Show when={settingsIgnoredCount() > 0}>
            <span class="st-dim">{fmtCount(settingsIgnoredCount())} kept items hidden</span>
          </Show>
        </div>
      </Show>

      <Show when={selected().length}>
        <div class="st-selbar">
          <span><b class="num">{fmtCount(selected().length)}</b> selected · <b class="num">{fmtSize(selBytes())}</b></span>
          <span class="flex" />
          <button class="btn btn-text" onClick={clearSel}>Clear</button>
          <button class="btn btn-outline btn-text" onClick={() => del(false)}><Icon name="trash" size={14} />Move to Recycle Bin</button>
          <button class="btn btn-outline btn-text st-danger" onClick={() => del(true)}>Delete permanently</button>
        </div>
      </Show>
    </section>
  );
}
const settingsIgnoredCount = () => sugg()?.items.filter((it) => ignored(it.path)).length ?? 0;

export function Storage() {
  let el!: HTMLDivElement;
  onMount(() => {
    const fixed = drives().filter((d) => d.kind === 'fixed');
    if (!fixed.some((d) => samePath(d.path, drive())) && fixed.length) chooseDrive(fixed[0].path);
    mountStorage();
    animate(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], 'nav');
  });
  onCleanup(() => { setHoverPath(null); setHoverCat(null); unmountStorage(); });
  const fixed = () => drives().filter((d) => d.kind === 'fixed');
  return (
    <div class="storage" ref={el}>
      <div class="storage-inner">
        <div class="st-head">
          <h1 class="home-title">Storage</h1>
          <Show when={fixed().length > 1}>
            <div class="seg">
              <For each={fixed()}>{(d) => (
                <button classList={{ on: samePath(d.path, drive()) }} onClick={() => chooseDrive(d.path)}><Icon name="drive" size={14} />{driveLabel(d)}</button>
              )}</For>
            </div>
          </Show>
        </div>
        <Usage />
        <MapSection />
        <Cleanup />
      </div>
    </div>
  );
}
