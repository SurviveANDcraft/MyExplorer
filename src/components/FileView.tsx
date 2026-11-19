import { batch, createEffect, createMemo, createSignal, For, JSX, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js';
import { commitRename, openIndex } from '../commands/actions';
import { commandsForChord, eventChord } from '../commands/registry';
import { baseName, extOf, fmtDate, fmtSize, isCloud, isDir, isHidden, parentOf, stemLength } from '../lib/fs';
import { Icon } from '../lib/icons';
import { animate } from '../lib/motion';
import { trackDrag } from '../state/drag';
import { endHover, hoverDir, knownSize, sizeError, sizeTip } from '../state/dirsize';
import { ColumnId, rowHeight, setSettings, settings } from '../state/settings';
import { isCut, typeName } from '../state/system';
import {
  clearSel, currentDir, isSel, pathAt, selectedPaths, selectOnly, selectRange, setSelection, sortBy, Tab, toggleSel,
} from '../state/tabs';
import { viewApi } from '../state/ui';
import { FileIcon } from './FileIcon';
import { openContextMenu } from './menus';
import { SearchStrip } from './SearchStrip';
import { EmptyState } from './EmptyState';

const HEADER = 32;
interface Layout { mode: 'details' | 'list' | 'grid'; cols: number; iw: number; ih: number; gx: number; gy: number; px: number; py: number; icon: number; hd: number }
const GRID = { s: [92, 104, 48], m: [124, 140, 80], l: [176, 196, 136], xl: [256, 276, 216] } as const;
const COL_LABEL: Record<ColumnId, string> = { name: 'Name', folder: 'Folder', modified: 'Date modified', type: 'Type', size: 'Size' };
const COL_SORT: Partial<Record<ColumnId, 'name' | 'modified' | 'type' | 'size'>> = { name: 'name', modified: 'modified', type: 'type', size: 'size' };

function Highlight(p: { text: string; terms: string[] }) {
  const parts = createMemo(() => {
    const terms = p.terms.filter((x) => x && !x.includes('\\') && !x.includes('/'));
    if (!terms.length) return null;
    const lower = p.text.toLowerCase();
    const marks = new Uint8Array(p.text.length);
    for (const t of terms) { let i = lower.indexOf(t); while (i >= 0) { marks.fill(1, i, i + t.length); i = lower.indexOf(t, i + t.length); } }
    const out: { s: string; m: boolean }[] = [];
    let start = 0;
    for (let i = 1; i <= p.text.length; i++) if (i === p.text.length || marks[i] !== marks[start]) { out.push({ s: p.text.slice(start, i), m: !!marks[start] }); start = i; }
    return out;
  });
  return <Show when={parts()} fallback={p.text}><For each={parts()}>{(x) => (x.m ? <mark>{x.s}</mark> : x.s)}</For></Show>;
}

function RenameInput(p: { tab: Tab; i: number; name: string; dir: boolean; class?: string }) {
  let el!: HTMLInputElement;
  let done = false;
  const finish = (val: string | null, step: 0 | 1 | -1 = 0) => {
    if (done) return;
    done = true;
    if (val === null) p.tab.setRenaming(-1);
    else commitRename(p.tab, p.i, val, step);
    viewApi.focus();
  };
  onMount(() => { el.focus(); el.setSelectionRange(0, stemLength(p.name, p.dir)); });
  onCleanup(() => finish(el.value));
  return (
    <input ref={el} class={`rename ${p.class ?? ''}`} value={p.name} spellcheck={false}
      onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(el.value); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        else if (e.key === 'Tab') { e.preventDefault(); finish(el.value, e.shiftKey ? -1 : 1); }
      }}
      onBlur={() => finish(el.value)} />
  );
}

/** Hover card with a folder's recursive size. Positioned at the pointer, kept on screen. */
function SizeCard(p: { path: string; x: number; y: number }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: p.x + 14, y: p.y + 20 });
  const fit = () => {
    const r = el.getBoundingClientRect();
    let x = p.x + 14, y = p.y + 20;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, p.y - r.height - 10);
    setPos({ x, y });
  };
  onMount(fit);
  createEffect(on(() => knownSize(p.path), () => queueMicrotask(fit), { defer: true }));
  const n = (v: number) => v.toLocaleString();
  return (
    <div ref={el} class="sizecard pop" role="tooltip" style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
      <Show when={knownSize(p.path)} fallback={
        <Show when={sizeError(p.path)} fallback={<div class="sc-calc"><span class="sc-spin" />Calculating size…</div>}>
          <div class="sc-meta">Size unavailable</div>
        </Show>}>
        {(d) => (<>
          <div class="sc-size">{d().partial ? 'At least ' : ''}{fmtSize(d().size)}</div>
          <div class="sc-meta">{n(d().files)} {d().files === 1 ? 'file' : 'files'} · {n(d().folders)} {d().folders === 1 ? 'folder' : 'folders'}</div>
        </>)}
      </Show>
    </div>
  );
}

export function FileView(p: { tab: Tab }) {
  const t = p.tab;
  let scroller!: HTMLDivElement;
  let canvas!: HTMLDivElement;
  const [w, setW] = createSignal(800);
  const [h, setH] = createSignal(600);
  const [st, setSt] = createSignal(t.scroll);
  const [band, setBand] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null);
  const m = () => t.model();
  const searching = () => !!t.search();
  const terms = () => t.searchMeta()?.terms ?? [];

  const columns = createMemo((): ColumnId[] => (searching() ? ['name', 'folder', 'modified', 'type', 'size'] : ['name', 'modified', 'type', 'size']));
  const template = createMemo(() => columns().map((c) => `${settings.columns[c]}px`).join(' '));
  const detailsW = createMemo(() => columns().reduce((s, c) => s + settings.columns[c], 0));

  const L = createMemo((): Layout => {
    const v = t.view();
    const rh = rowHeight();
    if (v.view === 'details') return { mode: 'details', cols: 1, iw: detailsW(), ih: rh, gx: 0, gy: 0, px: 8, py: 4, icon: 16, hd: HEADER };
    if (v.view === 'list') {
      const iw = 264, px = 12, gx = 4;
      return { mode: 'list', cols: Math.max(1, Math.floor((w() - px * 2 + gx) / (iw + gx))), iw, ih: rh, gx, gy: 0, px, py: 8, icon: 16, hd: 0 };
    }
    const [iw, ih, icon] = GRID[v.grid];
    const px = 12, gx = 4;
    return { mode: 'grid', cols: Math.max(1, Math.floor((w() - px * 2 + gx) / (iw + gx))), iw, ih, gx, gy: 4, px, py: 10, icon, hd: 0 };
  });
  const rows = () => Math.ceil(m().count / L().cols);
  const totalH = () => { const l = L(); return l.py * 2 + Math.max(0, rows() * (l.ih + l.gy) - l.gy); };
  const range = createMemo(() => {
    const l = L();
    const step = l.ih + l.gy;
    const top = st() - l.hd - l.py;
    return [Math.max(0, Math.floor(top / step) - 4), Math.floor((top + h()) / step) + 4] as const;
  }, undefined, { equals: (a, b) => a[0] === b[0] && a[1] === b[1] });
  const visible = createMemo(() => {
    const [r0, r1] = range();
    const cols = L().cols;
    const n = m().count;
    const out: number[] = [];
    for (let i = r0 * cols, end = Math.min(n, (r1 + 1) * cols); i < end; i++) out.push(i);
    return out;
  });
  const pos = (i: number) => {
    const l = L();
    const r = Math.floor(i / l.cols), c = i % l.cols;
    return { x: l.px + c * (l.iw + l.gx), y: l.py + r * (l.ih + l.gy) };
  };

  function reveal(i: number) {
    if (i < 0 || !scroller) return;
    const l = L();
    const { y } = pos(i);
    if (y < scroller.scrollTop) scroller.scrollTop = Math.max(0, y - l.py);
    else if (y + l.hd + l.ih > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + l.hd + l.ih - scroller.clientHeight + l.py;
  }
  const jumpTo = (top: number) => { scroller.scrollTop = Math.max(0, top); t.scroll = scroller.scrollTop; setSt(t.scroll); };
  /** Scroll so item `i` sits in the middle of the viewport. */
  const center = (i: number) => {
    if (i < 0 || !scroller) return;
    const l = L();
    jumpTo(pos(i).y + l.hd + l.ih / 2 - (scroller.clientHeight + l.hd) / 2);
  };
  const toTop = () => { if (scroller) jumpTo(0); };

  // ── Scroll + size ──────────────────────────────────────────────────────────
  const onScroll = () => {
    endHover();
    t.scroll = scroller.scrollTop;
    setSt(t.scroll); // cheap: `range` only changes when a row boundary is crossed
  };
  onMount(() => {
    const ro = new ResizeObserver(([e]) => batch(() => { setW(e.contentRect.width); setH(e.contentRect.height); }));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    scroller.scrollTop = t.scroll;
    setSt(scroller.scrollTop);
    viewApi.focus = () => scroller.focus({ preventScroll: true });
    viewApi.reveal = reveal;
    viewApi.center = center;
    viewApi.toTop = toTop;
    if (!document.activeElement || document.activeElement === document.body) scroller.focus({ preventScroll: true });
  });
  onCleanup(endHover);
  onCleanup(() => { viewApi.focus = () => {}; viewApi.reveal = () => {}; viewApi.center = () => {}; viewApi.toTop = () => {}; });
  createEffect(on(t.navSeq, (s) => {
    scroller.scrollTop = t.scroll;
    setSt(scroller.scrollTop);
    const dx = s.dir === 'fwd' ? 6 : s.dir === 'back' ? -6 : 0;
    animate(canvas, [{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'translateX(0)' }], 'nav');
    if (document.activeElement === document.body) scroller.focus({ preventScroll: true });
  }, { defer: true }));

  // ── Pointer: select, drag, rubber band ────────────────────────────────────
  const indexOf = (el: EventTarget | null) => {
    const item = (el as HTMLElement | null)?.closest<HTMLElement>('[data-i]');
    return item ? Number(item.dataset.i) : -1;
  };
  // ── Hover: folder size card ───────────────────────────────────────────────
  const onPointerMove = (e: PointerEvent) => {
    if (e.buttons || t.renaming() >= 0) return;
    const i = indexOf(e.target);
    hoverDir(i >= 0 && isDir(m().flags[i]) ? pathAt(m(), i) : null, e.clientX, e.clientY);
  };
  const onPointerDown = (e: PointerEvent) => {
    endHover();
    const target = e.target as HTMLElement;
    if (target.closest('input, .vhead')) return;
    scroller.classList.remove('kbd');
    scroller.focus({ preventScroll: true });
    const i = indexOf(target);
    if (e.button === 1) { e.preventDefault(); if (i >= 0 && isDir(m().flags[i])) openIndex(t, i, true); return; }
    if (i >= 0) {
      if (e.button === 2) { if (!t.sel.has(i)) selectOnly(t, i); return; }
      if (e.button !== 0) return;
      let deferred = false;
      if (e.shiftKey) selectRange(t, i, e.ctrlKey);
      else if (e.ctrlKey) toggleSel(t, i);
      else if (!t.sel.has(i)) selectOnly(t, i);
      else deferred = true;
      const model = m();
      trackDrag(e, () => ({ paths: t.sel.has(i) ? selectedPaths(t) : [], name: model.names[i], flags: model.flags[i] }), (ev) => {
        if (deferred) selectOnly(t, i);
        if (settings.clickMode === 'single' && !ev.ctrlKey && !ev.shiftKey && t.renaming() < 0) openIndex(t, i);
      });
      return;
    }
    if (e.button === 2) { if (!e.ctrlKey) clearSel(t); return; }
    if (e.button === 0 && e.clientX < scroller.getBoundingClientRect().left + scroller.clientWidth) startBand(e);
  };

  function hits(r: { x: number; y: number; w: number; h: number }) {
    const l = L();
    const out: number[] = [];
    const step = l.ih + l.gy, cstep = l.iw + l.gx;
    const r0 = Math.max(0, Math.floor((r.y - l.py) / step)), r1 = Math.min(rows() - 1, Math.floor((r.y + r.h - l.py) / step));
    const c0 = Math.max(0, Math.floor((r.x - l.px) / cstep)), c1 = Math.min(l.cols - 1, Math.floor((r.x + r.w - l.px) / cstep));
    for (let row = r0; row <= r1; row++) {
      const y = l.py + row * step;
      if (y > r.y + r.h || y + l.ih < r.y) continue;
      for (let c = c0; c <= c1; c++) {
        const x = l.px + c * cstep;
        if (x > r.x + r.w || x + l.iw < r.x) continue;
        const i = row * l.cols + c;
        if (i < m().count) out.push(i);
      }
    }
    return out;
  }
  function startBand(e: PointerEvent) {
    const rect = scroller.getBoundingClientRect();
    const l = L();
    const toCanvas = (cx: number, cy: number) => [cx - rect.left + scroller.scrollLeft, cy - rect.top + scroller.scrollTop - l.hd] as const;
    const [x0, y0] = toCanvas(e.clientX, e.clientY);
    const additive = e.ctrlKey || e.shiftKey;
    const base = additive ? new Set(t.sel) : new Set<number>();
    if (!additive) clearSel(t);
    let lx = e.clientX, ly = e.clientY, started = false, frame = 0;
    const update = () => {
      frame = 0;
      const edge = 28;
      if (ly < rect.top + l.hd + edge) scroller.scrollTop -= Math.min(24, (rect.top + l.hd + edge - ly) / 2);
      else if (ly > rect.bottom - edge) scroller.scrollTop += Math.min(24, (ly - rect.bottom + edge) / 2);
      const [x1, y1] = toCanvas(Math.max(rect.left, Math.min(lx, rect.right)), Math.max(rect.top + l.hd, Math.min(ly, rect.bottom)));
      const r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      setBand(r);
      const s = new Set(base);
      const hit = hits(r);
      for (const i of hit) s.add(i);
      setSelection(t, s);
      if (hit.length) t.setFocus(hit[hit.length - 1]);
      if (ly < rect.top + l.hd + edge || ly > rect.bottom - edge) frame = requestAnimationFrame(update);
    };
    const move = (ev: PointerEvent) => {
      lx = ev.clientX; ly = ev.clientY;
      if (!started && Math.hypot(lx - e.clientX, ly - e.clientY) < 4) return;
      started = true;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const up = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setBand(null);
      if (t.sel.size) t.anchor = Math.min(...t.sel);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const onDblClick = (e: MouseEvent) => {
    const i = indexOf(e.target);
    if (i >= 0 && settings.clickMode === 'double' && !e.ctrlKey && !e.shiftKey) openIndex(t, i);
  };
  const onContextMenu = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('input')) return;
    e.preventDefault();
    // Shift+right-click adds Windows' extended entries, like Explorer.
    openContextMenu(t, e.clientX, e.clientY, indexOf(e.target) >= 0 && t.sel.size > 0, e.shiftKey);
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  let typeBuf = '', typeTimer = 0;
  function typeAhead(ch: string) {
    clearTimeout(typeTimer);
    typeTimer = window.setTimeout(() => (typeBuf = ''), 900);
    typeBuf += ch.toLowerCase();
    const model = m(), n = model.count;
    const same = typeBuf.length > 1 && [...typeBuf].every((c) => c === typeBuf[0]);
    const q = same ? typeBuf[0] : typeBuf;
    const f = Math.max(0, t.focus());
    const start = typeBuf.length === 1 || same ? f + 1 : f;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (model.names[i].toLowerCase().startsWith(q)) { selectOnly(t, i); reveal(i); return; }
    }
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || e.altKey || e.metaKey) return;
    const n = m().count;
    const l = L();
    const f = t.focus();
    const page = Math.max(1, Math.floor((h() - l.hd) / (l.ih + l.gy)) - 1) * l.cols;
    let next: number;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = scroller.getBoundingClientRect();
      const { x, y } = f >= 0 ? pos(f) : { x: 20, y: 20 };
      openContextMenu(t, r.left + x + 24, r.top + y + l.hd - scroller.scrollTop + l.ih, f >= 0 && t.sel.size > 0);
      return;
    }
    switch (e.key) {
      case 'ArrowDown': next = f < 0 ? 0 : Math.min(n - 1, f + l.cols); break;
      case 'ArrowUp': next = f < 0 ? 0 : Math.max(0, f - l.cols); break;
      case 'ArrowRight': if (l.cols === 1) return; next = Math.min(n - 1, f + 1); break;
      case 'ArrowLeft': if (l.cols === 1) return; next = Math.max(0, f - 1); break;
      case 'Home': next = 0; break;
      case 'End': next = n - 1; break;
      case 'PageDown': next = Math.min(n - 1, Math.max(f, 0) + page); break;
      case 'PageUp': next = Math.max(0, f - page); break;
      case 'Escape': if (t.sel.size) { e.preventDefault(); clearSel(t); } return;
      case ' ':
        if (e.ctrlKey && f >= 0) { e.preventDefault(); toggleSel(t, f); return; }
        if (typeBuf) { e.preventDefault(); e.stopPropagation(); typeAhead(' '); }
        return;
      default: {
        if (e.key.length !== 1 || e.ctrlKey) return;
        const chord = eventChord(e);
        if (chord && commandsForChord(chord).length) return;
        e.preventDefault();
        typeAhead(e.key);
        return;
      }
    }
    if (n === 0) return;
    e.preventDefault();
    scroller.classList.add('kbd');
    if (e.shiftKey) selectRange(t, next, e.ctrlKey);
    else if (e.ctrlKey) t.setFocus(next);
    else selectOnly(t, next);
    reveal(next);
  };

  // ── Column header ─────────────────────────────────────────────────────────
  function resizeCol(e: PointerEvent, c: ColumnId) {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = settings.columns[c];
    const move = (ev: PointerEvent) => setSettings('columns', c, Math.max(c === 'name' ? 140 : 64, Math.round(w0 + ev.clientX - x0)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.documentElement.classList.remove('col-resizing'); };
    document.documentElement.classList.add('col-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  const sortState = () => (searching() ? t.searchSort() : t.view().sort);
  const header = () => (
    <div class="vhead" style={{ 'grid-template-columns': template(), width: `${detailsW() + 16}px` }}>
      <For each={columns()}>{(c) => {
        const key = COL_SORT[c];
        return (
          <div class="vh-cell" classList={{ num: c === 'size', sortable: !!key, sorted: !!key && sortState()?.key === key }} onClick={() => key && sortBy(t, key)}>
            <span>{COL_LABEL[c]}</span>
            <Show when={key && sortState()?.key === key}><Icon name={sortState()!.desc ? 'chevronDown' : 'chevronUp'} size={12} /></Show>
            <div class="col-resizer" onPointerDown={(e) => resizeCol(e, c)} onClick={(e) => e.stopPropagation()} />
          </div>
        );
      }}</For>
    </div>
  );

  // ── Items ─────────────────────────────────────────────────────────────────
  const displayNameOf = (name: string, flags: number) => {
    if (settings.showExtensions || isDir(flags)) return name;
    const e = extOf(name);
    return e && name.length > e.length + 1 ? name.slice(0, -(e.length + 1)) : name;
  };
  function Item(ip: { i: number }): JSX.Element {
    const i = ip.i;
    const name = () => m().names[i] ?? '';
    const flags = () => m().flags[i] ?? 0;
    const path = () => pathAt(m(), i);
    const dir = () => isDir(flags());
    const l = L;
    const style = () => { const { x, y } = pos(i); return { transform: `translate(${x}px, ${y}px)`, width: `${l().iw}px`, height: `${l().ih}px` }; };
    const cls = () => ({ sel: isSel(t, i), focus: t.focus() === i, dim: isHidden(flags()) || isCut(path()) });
    const nameEl = (c?: string) => (
      <Show when={t.renaming() === i} fallback={<span class={`nm ${c ?? ''}`}><Highlight text={displayNameOf(name(), flags())} terms={terms()} /></span>}>
        <RenameInput tab={t} i={i} name={name()} dir={dir()} class={c} />
      </Show>
    );
    const cloud = () => isCloud(flags()) && <Icon name="cloud" size={14} class="ic badge-cloud" />;
    return (
      <Switch>
        <Match when={l().mode === 'details'}>
          <div class="row" data-i={i} data-drop={dir() ? path() : undefined} classList={cls()} style={{ ...style(), 'grid-template-columns': template() }}>
            <div class="cell c-name"><FileIcon name={name()} flags={flags()} path={path()} size={16} />{nameEl()}{cloud()}</div>
            <Show when={searching()}><div class="cell c-sub" title={parentOf(path()) ?? ''}>{parentOf(path())}</div></Show>
            <div class="cell c-sub num">{fmtDate(m().modified[i])}</div>
            <div class="cell c-sub">{typeName(name(), flags())}</div>
            <div class="cell c-sub num right" classList={{ 'dir-size': dir() }}>{dir() ? (knownSize(path()) ? fmtSize(knownSize(path())!.size) : '') : fmtSize(m().sizes[i])}</div>
          </div>
        </Match>
        <Match when={l().mode === 'list'}>
          <div class="row list" data-i={i} data-drop={dir() ? path() : undefined} classList={cls()} style={style()} title={searching() ? path() : undefined}>
            <div class="cell c-name"><FileIcon name={name()} flags={flags()} path={path()} size={16} />{nameEl()}{cloud()}</div>
          </div>
        </Match>
        <Match when={l().mode === 'grid'}>
          <div class="tile" data-i={i} data-drop={dir() ? path() : undefined} classList={cls()} style={style()}
            title={dir() ? undefined : `${name()}\n${typeName(name(), flags())} · ${fmtSize(m().sizes[i])}\n${fmtDate(m().modified[i])}`}>
            <div class="tile-icon" style={{ height: `${l().icon}px` }}>
              <FileIcon name={name()} flags={flags()} path={path()} size={l().icon} thumb={l().icon >= 80} modified={m().modified[i]} />
              {cloud()}
            </div>
            {nameEl('tile-name')}
          </div>
        </Match>
      </Switch>
    );
  }

  const empty = () => m().count === 0 && (t.status() === 'ready' || t.status() === 'error');
  return (
    <div class="fileview">
      <Show when={searching()}><SearchStrip tab={t} /></Show>
      <Show when={sizeTip()} keyed>{(s) => <SizeCard path={s.path} x={s.x} y={s.y} />}</Show>
      <div ref={scroller} class="vscroll" classList={{ details: L().mode === 'details' }} tabindex="0" data-drop={currentDir(t) ?? undefined}
        onScroll={onScroll} onPointerMove={onPointerMove} onPointerLeave={endHover} onWheel={endHover} onPointerDown={onPointerDown} onDblClick={onDblClick} onContextMenu={onContextMenu} onKeyDown={onKeyDown}
        aria-label="Items" role="listbox" aria-multiselectable="true">
        <Show when={L().mode === 'details' && !(empty() && t.status() === 'error')}>{header()}</Show>
        <div ref={canvas} class="canvas" classList={{ hidden: t.status() === 'loading' }} style={{ height: `${totalH()}px`, width: L().mode === 'details' ? `${detailsW() + 16}px` : '100%' }}>
          <For each={visible()}>{(i) => <Item i={i} />}</For>
          <Show when={band()}>{(b) => <div class="band" style={{ transform: `translate(${b().x}px, ${b().y}px)`, width: `${b().w}px`, height: `${b().h}px` }} />}</Show>
        </div>
        <Show when={t.status() === 'loading'}>
          <div class="skeleton" style={{ top: `${L().hd}px` }}>
            <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>{(k) => <div class="sk-row" style={{ 'animation-delay': `${k * 60}ms`, width: `${70 - (k % 3) * 12}%` }} />}</For>
          </div>
        </Show>
        <Show when={empty()}>
          <Switch>
            <Match when={t.status() === 'error' && t.error()?.code === 'access_denied'}>
              <EmptyState icon="lock" title="You don't have permission to open this folder" detail={t.error()?.message} />
            </Match>
            <Match when={t.status() === 'error'}>
              <EmptyState icon="alert" title={t.error()?.code === 'not_found' ? "This folder doesn't exist anymore" : "Couldn't open this folder"} detail={t.error()?.message} />
            </Match>
            <Match when={searching() && !t.searchMeta()?.pending}>
              <EmptyState icon="search" title="No results" detail={t.search()?.everywhere ? 'Try fewer words or remove a filter.' : `Nothing matches in ${baseName(currentDir(t) ?? '')}. Try searching everywhere.`} />
            </Match>
            <Match when={!searching()}>
              <EmptyState icon="folder" title="This folder is empty" detail="Drop files here or create something new." />
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  );
}
