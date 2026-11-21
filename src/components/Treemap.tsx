// Squarified, nested treemap of a folder (WizTree-style), drawn on canvas: thousands of
// blocks paint in a few ms. Base layer = blocks; overlay = hover / highlight / dimming.
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import type { DiskNode, DiskTree } from '../ipc/types';
import { fmtCount, fmtDate, fmtSize, join } from '../lib/fs';
import { darkMode } from '../state/settings';
import { CATS, goneV, hoverCat, hoverPath, isGone } from '../state/storage';

export interface Block {
  x: number; y: number; w: number; h: number;
  node: DiskNode;
  /** null for "smaller items" groups. */
  path: string | null;
  depth: number;
  parent: number;
  leaf: boolean;
}

const HEADER = 16;

function squarify(vals: number[], x: number, y: number, w: number, h: number, emit: (i: number, x: number, y: number, w: number, h: number) => void) {
  let total = 0;
  for (const v of vals) total += v;
  if (total <= 0 || w < 1 || h < 1) return;
  const scale = (w * h) / total;
  let i = 0;
  while (i < vals.length) {
    const short = Math.min(w, h);
    let sum = 0, mn = Infinity, mx = 0, best = Infinity, j = i;
    while (j < vals.length) {
      const a = vals[j] * scale;
      const ns = sum + a, nmn = Math.min(mn, a), nmx = Math.max(mx, a);
      const worst = Math.max((short * short * nmx) / (ns * ns), (ns * ns) / (short * short * nmn));
      if (worst > best) break;
      best = worst; sum = ns; mn = nmn; mx = nmx; j++;
    }
    const thick = sum / short;
    if (w >= h) {
      let yy = y;
      for (let k = i; k < j; k++) { const hh = (vals[k] * scale) / thick; emit(k, x, yy, thick, hh); yy += hh; }
      x += thick; w -= thick;
    } else {
      let xx = x;
      for (let k = i; k < j; k++) { const ww = (vals[k] * scale) / thick; emit(k, xx, y, ww, thick); xx += ww; }
      y += thick; h -= thick;
    }
    i = j;
  }
}

function layout(t: DiskTree, W: number, H: number): Block[] {
  const out: Block[] = [];
  const visit = (node: DiskNode, path: string | null, x: number, y: number, w: number, h: number, depth: number, parent: number) => {
    const kids = node.k?.filter((c) => c.t === 2 || !isGone(join(path!, c.n)));
    const idx = out.push({ x, y, w, h, node, path, depth, parent, leaf: !kids?.length }) - 1;
    if (!kids?.length || w < 6 || h < 6) { out[idx].leaf = true; return; }
    const header = depth > 0 && w >= 56 && h >= 40 ? HEADER : 0;
    const pad = depth > 0 ? 2 : 0;
    const ix = x + pad, iy = y + header + (header ? 0 : pad), iw = w - pad * 2, ih = h - header - (header ? pad : pad * 2);
    if (iw < 2 || ih < 2) { out[idx].leaf = true; return; }
    squarify(kids.map((c) => c.s), ix, iy, iw, ih, (i, cx, cy, cw, ch) => {
      const c = kids[i];
      visit(c, c.t === 2 ? null : join(path!, c.n), cx, cy, cw, ch, depth + 1, idx);
    });
  };
  visit(t.root, t.path, 0, 0, W, H, 0, -1);
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (c: [number, number, number], t: [number, number, number], a: number) =>
  `rgb(${c.map((v, i) => Math.round(v + (t[i] - v) * a)).join(',')})`;

function ellipsize(ctx: CanvasRenderingContext2D, s: string, max: number) {
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, m) + '…').width <= max) lo = m; else hi = m - 1; }
  return lo ? s.slice(0, lo) + '…' : '';
}

export function Treemap(p: {
  tree: DiskTree;
  onZoom: (path: string) => void;
  onOpen: (b: Block) => void;
  onMenu: (b: Block, e: MouseEvent) => void;
}) {
  let wrap!: HTMLDivElement, base!: HTMLCanvasElement, over!: HTMLCanvasElement;
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const [hover, setHover] = createSignal(-1);
  const [tipPos, setTipPos] = createSignal({ x: 0, y: 0 });
  let blocks: Block[] = [];
  let byPath = new Map<string, number>();

  onMount(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(wrap);
    onCleanup(() => ro.disconnect());
  });

  const palette = () => {
    const dark = darkMode();
    const white: [number, number, number] = [255, 255, 255], black: [number, number, number] = [0, 0, 0];
    return {
      dark,
      cats: CATS.map((c) => { const rgb = hexToRgb(c.color); return { hi: mix(rgb, white, dark ? 0.12 : 0.28), lo: mix(rgb, black, dark ? 0.38 : 0.22) }; }),
      frame: dark ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.045)',
      header: dark ? 'rgba(241,242,244,0.72)' : 'rgba(26,27,30,0.7)',
      headerDim: dark ? 'rgba(241,242,244,0.42)' : 'rgba(26,27,30,0.42)',
      group: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)',
      folder: dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.12)',
    };
  };

  const draw = () => {
    const { w, h } = size();
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [base, over]) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = `${w}px`; c.style.height = `${h}px`;
    }
    blocks = layout(p.tree, w, h);
    byPath = new Map();
    blocks.forEach((b, i) => { if (b.path) byPath.set(b.path.toLowerCase(), i); });
    const ctx = base.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pal = palette();
    ctx.textBaseline = 'middle';
    for (const b of blocks) {
      if (b.depth === 0) continue;
      const bw = b.w - 1, bh = b.h - 1;
      if (bw < 0.5 || bh < 0.5) continue;
      if (!b.leaf) {
        ctx.fillStyle = pal.frame;
        ctx.fillRect(b.x, b.y, bw, bh);
        if (b.w >= 56 && b.h >= 40) {
          ctx.font = '600 11px "Segoe UI Variable Text", "Segoe UI", sans-serif';
          const sz = fmtSize(b.node.s);
          const sw = ctx.measureText(sz).width;
          ctx.fillStyle = pal.header;
          const name = ellipsize(ctx, b.node.n, b.w - sw - 18);
          ctx.fillText(name, b.x + 5, b.y + HEADER / 2 + 1);
          if (name) { ctx.font = '11px "Segoe UI Variable Text", "Segoe UI", sans-serif'; ctx.fillStyle = pal.headerDim; ctx.fillText(sz, b.x + b.w - sw - 6, b.y + HEADER / 2 + 1); }
        }
        continue;
      }
      if (b.node.t === 2) { ctx.fillStyle = pal.group; ctx.fillRect(b.x, b.y, bw, bh); continue; }
      if (b.node.t === 1 && b.node.c === 0) { ctx.fillStyle = pal.folder; ctx.fillRect(b.x, b.y, bw, bh); continue; }
      const c = pal.cats[b.node.c] ?? pal.cats[0];
      if (bw > 3 && bh > 3) {
        const g = ctx.createLinearGradient(b.x, b.y, b.x + bw, b.y + bh);
        g.addColorStop(0, c.hi); g.addColorStop(1, c.lo);
        ctx.fillStyle = g;
      } else ctx.fillStyle = c.lo;
      ctx.fillRect(b.x, b.y, bw, bh);
      if (bw > 74 && bh > 34) {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = '600 12px "Segoe UI Variable Text", "Segoe UI", sans-serif';
        const name = ellipsize(ctx, b.node.n, bw - 12);
        ctx.fillText(name, b.x + 6, b.y + 13);
        ctx.font = '11px "Segoe UI Variable Text", "Segoe UI", sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        if (name) ctx.fillText(fmtSize(b.node.s), b.x + 6, b.y + 28);
      }
    }
    drawOverlay();
  };

  const drawOverlay = () => {
    const { w, h } = size();
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = over.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const dark = darkMode();
    const cat = hoverCat();
    if (cat !== null) {
      ctx.fillStyle = dark ? 'rgba(20,21,24,0.72)' : 'rgba(252,252,253,0.78)';
      for (const b of blocks) {
        if (!b.leaf || b.depth === 0) continue;
        const c = b.node.t === 0 || (b.node.t === 1 && b.node.c !== 0) ? b.node.c : -1;
        if (c !== cat) ctx.fillRect(b.x, b.y, b.w - 1, b.h - 1);
      }
    }
    const ring = (i: number, color: string, width: number) => {
      const b = blocks[i];
      if (!b || b.depth === 0) return;
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.strokeRect(b.x + width / 2, b.y + width / 2, Math.max(0, b.w - 1 - width), Math.max(0, b.h - 1 - width));
    };
    const hp = hoverPath();
    if (hp) {
      let k = hp.toLowerCase(), i = byPath.get(k);
      while (i === undefined && k.includes('\\')) { k = k.slice(0, k.lastIndexOf('\\')); i = byPath.get(k); }
      if (i !== undefined) {
        const b = blocks[i];
        ctx.fillStyle = dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.rect(b.x, b.y, b.w - 1, b.h - 1);
        ctx.fill('evenodd');
        ring(i, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f6fea', 2);
      }
    }
    const hv = hover();
    if (hv >= 0) {
      ring(hv, dark ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.8)', 1.5);
      const top = topAncestor(hv);
      if (top >= 0 && top !== hv && !blocks[top].leaf) ring(top, dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)', 1);
    }
  };

  createEffect(on([() => p.tree, size, darkMode, goneV], draw));
  createEffect(on([hover, hoverPath, hoverCat], drawOverlay, { defer: true }));

  const hit = (e: MouseEvent) => {
    const r = over.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    for (let i = blocks.length - 1; i > 0; i--) {
      const b = blocks[i];
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return i;
    }
    return -1;
  };
  /** The depth-1 block containing block i: what a click drills into. */
  const topAncestor = (i: number) => {
    let k = i;
    while (k > 0 && blocks[k].depth > 1) k = blocks[k].parent;
    return k > 0 ? k : -1;
  };
  const onMove = (e: MouseEvent) => {
    const i = hit(e);
    if (i !== hover()) setHover(i);
    const r = wrap.getBoundingClientRect();
    setTipPos({ x: e.clientX - r.left, y: e.clientY - r.top });
    const top = i >= 0 ? topAncestor(i) : -1;
    over.style.cursor = top >= 0 && blocks[top].node.t === 1 && blocks[top].node.k?.length ? 'zoom-in' : 'default';
  };
  const onClick = (e: MouseEvent) => {
    const top = topAncestor(hit(e));
    const b = blocks[top];
    if (b?.path && b.node.t === 1 && b.node.k?.length) p.onZoom(b.path);
  };
  const tipBlock = () => (hover() >= 0 ? blocks[hover()] : null);
  const tipStyle = () => {
    const { x, y } = tipPos(), { w, h } = size();
    const left = x + 16 + 260 > w ? Math.max(4, x - 16 - 260) : x + 16;
    const top = Math.min(Math.max(4, y + 14), Math.max(4, h - 92));
    return { transform: `translate(${left}px, ${top}px)` };
  };

  return (
    <div class="tm" ref={wrap}>
      <canvas ref={base} class="tm-base" />
      <canvas ref={over} class="tm-over" onMouseMove={onMove} onMouseLeave={() => setHover(-1)} onClick={onClick}
        onDblClick={(e) => { const i = hit(e); if (i >= 0 && blocks[i].path) p.onOpen(blocks[i]); }}
        onContextMenu={(e) => { e.preventDefault(); const i = hit(e); if (i >= 0 && blocks[i].path) p.onMenu(blocks[i], e); }} />
      <Show when={tipBlock()}>{(b) => (
        <div class="tm-tip" style={tipStyle()}>
          <div class="tm-tip-name">
            <Show when={b().node.t === 0 || b().node.c}><span class="tm-sw" style={{ background: CATS[b().node.c]?.color }} /></Show>
            {b().node.t === 2 ? `${fmtCount(Number(b().node.n))} smaller items` : b().node.n}
          </div>
          <div class="tm-tip-size num">{fmtSize(b().node.s)}<Show when={b().node.t !== 0}><span> · {fmtCount(b().node.f)} files</span></Show></div>
          <Show when={b().node.m}><div class="tm-tip-sub">Modified {fmtDate(b().node.m)}</div></Show>
          <Show when={b().path}><div class="tm-tip-sub tm-tip-path">{b().path}</div></Show>
        </div>
      )}</Show>
    </div>
  );
}
