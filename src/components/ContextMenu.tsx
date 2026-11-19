import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { getCommand, shortcutLabel } from '../commands/registry';
import { Icon, IconName } from '../lib/icons';
import { animate } from '../lib/motion';
import { menu, MenuItem, noteMenuDismissedBy, setMenu, SubItems, viewApi } from '../state/ui';

interface Resolved { label: string; icon?: IconName; iconSrc?: string; shortcut: string; run?: () => void; disabled: boolean; checked?: boolean; danger?: boolean; submenu?: SubItems; sep?: boolean; loading?: boolean }
const SEP: Resolved = { label: '', shortcut: '', disabled: true, sep: true };
const LOADING: Resolved = { label: 'Loading…', shortcut: '', disabled: true, loading: true };
const subOf = (s?: SubItems) => (typeof s === 'function' ? s() : s);

function resolve(it: MenuItem): Resolved | null {
  if (it.sep) return SEP;
  // A lazy submenu that finished loading empty is dropped entirely.
  if (it.submenu && subOf(it.submenu)?.length === 0) return null;
  const c = it.cmd ? getCommand(it.cmd) : undefined;
  return {
    label: it.label ?? c?.label ?? '',
    icon: it.icon ?? c?.icon,
    shortcut: it.shortcut ?? (it.cmd ? shortcutLabel(it.cmd) : ''),
    run: it.run ?? c?.run,
    disabled: !!it.disabled || (!!c?.enabled && !c.enabled()),
    checked: it.checked, danger: it.danger, submenu: it.submenu, iconSrc: it.iconSrc,
  };
}
function clean(items: (Resolved | null)[]) {
  const out: Resolved[] = [];
  for (const r of items) { if (!r || (r.sep && (!out.length || out[out.length - 1].sep))) continue; out.push(r); }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}

function close() {
  const m = menu();
  setMenu(null);
  m?.onClose?.();
  queueMicrotask(() => { if (!document.activeElement || document.activeElement === document.body) viewApi.focus(); });
}

/** Is p inside triangle (a, b, c)? Used to keep a submenu open while the pointer travels toward it. */
function inTri(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  const s = (p1: typeof a, p2: typeof a, p3: typeof a) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function Bar(p: { items: MenuItem[] }) {
  const list = () => p.items.map(resolve).filter((r): r is Resolved => !!r && !r.sep);
  return (
    <div class="mbar" role="group">
      <For each={list()}>{(r) => (
        <button class="mbar-btn" classList={{ danger: r.danger }} disabled={r.disabled} aria-label={r.label}
          data-tip={r.shortcut ? `${r.label}  ·  ${r.shortcut}` : r.label}
          onClick={() => { close(); r.run?.(); }}>
          {r.icon ? <Icon name={r.icon} size={16} /> : null}
        </button>
      )}</For>
    </div>
  );
}

function MenuList(p: { items: SubItems; bar?: MenuItem[]; x: number; y: number; anchor?: DOMRect; sub?: boolean; onBack?: () => void; onEl?: (el: HTMLDivElement) => void; onEnter?: () => void }) {
  let el!: HTMLDivElement;
  let subEl: HTMLDivElement | undefined;
  const list = createMemo(() => {
    const raw = subOf(p.items);
    return raw === null ? [LOADING] : clean((raw ?? []).map(resolve));
  });
  const hasChecks = () => list().some((r) => r.checked !== undefined);
  const [hi, setHi] = createSignal(-1);
  const [sub, setSub] = createSignal<{ i: number; rect: DOMRect } | null>(null);
  const [pos, setPos] = createSignal({ x: p.x, y: p.y });
  let hoverTimer = 0;
  let last = { x: 0, y: 0 };
  let target = -1; // row whose hover has been handled (pointermove fires continuously)

  const place = () => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = p.x, y = p.y, ox = 'left', oy = 'top';
    if (x + r.width > vw - 8) { x = p.sub && p.anchor ? p.anchor.left - r.width + 4 : Math.max(8, vw - r.width - 8); ox = 'right'; }
    if (y + r.height > vh - 8) {
      y = p.anchor && !p.sub ? Math.max(8, p.anchor.top - r.height - 4) : Math.max(8, vh - r.height - 8);
      oy = 'bottom';
    }
    setPos({ x, y });
    return { ox, oy };
  };
  onMount(() => {
    const { ox, oy } = place();
    el.style.transformOrigin = `${ox} ${oy}`;
    const dx = p.sub ? (ox === 'left' ? -4 : 4) : 0;
    animate(el, [{ opacity: 0, transform: `translateX(${dx}px) scale(${p.sub ? 1 : 0.98})` }, { opacity: 1, transform: 'none' }], p.sub ? 'press' : 'menu');
    p.onEl?.(el);
    el.focus({ preventScroll: true });
  });
  onCleanup(() => clearTimeout(hoverTimer));
  // Lazy entries arrive after opening: re-fit once the menu changes size.
  createEffect(on(() => list().length, () => queueMicrotask(place), { defer: true }));

  const activate = (i: number) => {
    const r = list()[i];
    if (!r || r.disabled || r.sep) return;
    if (r.submenu) { openSub(i, true); return; }
    close();
    r.run?.();
  };
  const openSub = (i: number, focus = false) => {
    clearTimeout(hoverTimer);
    if (sub()?.i === i) { if (focus) subEl?.focus(); return; }
    const node = el.querySelector<HTMLElement>(`:scope > .mi[data-mi="${i}"]`);
    if (node) setSub({ i, rect: node.getBoundingClientRect() });
  };
  const move = (d: number) => {
    let i = hi();
    const items = list();
    for (let k = 0; k < items.length; k++) {
      i = (i + d + items.length) % items.length;
      if (!items[i].sep && !items[i].disabled) { setHi(i); return; }
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (sub() && subEl && subEl.contains(document.activeElement)) return;
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setHi(-1); move(1); }
    else if (e.key === 'End') { e.preventDefault(); setHi(0); move(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(hi()); }
    else if (e.key === 'ArrowRight' && list()[hi()]?.submenu) { e.preventDefault(); openSub(hi(), true); }
    else if (e.key === 'Escape' || (e.key === 'ArrowLeft' && p.sub)) { e.preventDefault(); if (p.sub) p.onBack?.(); else close(); }
    else if (e.key === 'Tab') e.preventDefault();
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // Type-ahead: jump to the next entry starting with that letter.
      const items = list(), k = e.key.toLowerCase();
      for (let n = 1; n <= items.length; n++) {
        const j = (hi() + n) % items.length;
        if (!items[j].sep && !items[j].disabled && items[j].label.toLowerCase().startsWith(k)) { setHi(j); break; }
      }
    }
  };

  /** Pointer over row i: open its submenu, or close another one — unless the pointer is heading into that submenu. */
  const hover = (i: number, e: PointerEvent) => {
    const pt = { x: e.clientX, y: e.clientY };
    const prev = last;
    last = pt;
    if (i === target) return;
    const r = list()[i];
    const s = sub();
    target = i;
    if (s?.i === i) { clearTimeout(hoverTimer); hoverTimer = 0; setHi(i); return; }
    if (s && subEl) {
      const b = subEl.getBoundingClientRect();
      const edge = b.left >= s.rect.left ? b.left : b.right;
      if (inTri(pt, prev, { x: edge, y: b.top - 6 }, { x: edge, y: b.bottom + 6 })) {
        // Travelling diagonally across this row toward the open submenu: wait a beat before switching.
        clearTimeout(hoverTimer);
        hoverTimer = window.setTimeout(() => switchTo(i, r), 220);
        return;
      }
    }
    switchTo(i, r, r?.submenu ? 70 : 0);
  };
  const switchTo = (i: number, r: Resolved | undefined, delay = 0) => {
    clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
      hoverTimer = 0;
      setHi(i);
      if (r?.submenu && !r.disabled) openSub(i);
      else setSub(null);
    }, delay);
    setHi(i);
  };

  return (
    <>
      <div ref={el} class="menu pop" classList={{ checks: hasChecks(), 'menu-sub': p.sub }} role="menu" tabindex="-1" data-modal
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}
        onPointerEnter={() => p.onEnter?.()}
        onPointerLeave={() => { target = -1; if (!sub()) { clearTimeout(hoverTimer); hoverTimer = 0; setHi(-1); } }}>
        <Show when={p.bar?.length}><Bar items={p.bar!} /></Show>
        <For each={list()}>{(r, i) => (
          <Show when={!r.sep} fallback={<div class="msep" role="separator" />}>
            <div class="mi" classList={{ hi: hi() === i(), disabled: r.disabled && !r.loading, loading: r.loading, danger: r.danger, open: sub()?.i === i() }}
              data-mi={i()} role="menuitem" aria-disabled={r.disabled} aria-haspopup={r.submenu ? 'menu' : undefined}
              onPointerMove={(e) => hover(i(), e)}
              onClick={() => activate(i())}>
              <Show when={hasChecks()}><span class="mi-check">{r.checked ? <Icon name="check" size={14} /> : null}</span></Show>
              <span class="mi-icon">{r.loading ? <span class="spinner spinner-xs" /> : r.iconSrc ? <img class="mi-img" src={r.iconSrc} alt="" draggable={false} /> : r.icon ? <Icon name={r.icon} /> : null}</span>
              <span class="mi-label">{r.label}</span>
              <Show when={r.shortcut}><span class="mi-key">{r.shortcut}</span></Show>
              <Show when={r.submenu}><Icon name="chevronRight" size={12} class="ic mi-sub" /></Show>
            </div>
          </Show>
        )}</For>
      </div>
      <Show when={sub()} keyed>
        {(s) => (
          <MenuList items={list()[s.i]?.submenu ?? []} x={s.rect.right - 2} y={s.rect.top - 4} anchor={s.rect} sub
            onEl={(e) => (subEl = e)} onEnter={() => { clearTimeout(hoverTimer); hoverTimer = 0; target = s.i; setHi(s.i); }}
            onBack={() => { setSub(null); subEl = undefined; el.focus(); }} />
        )}
      </Show>
    </>
  );
}

export function ContextMenu() {
  const onDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.menu')) return;
    const m = menu();
    noteMenuDismissedBy(m?.anchorEl?.contains(target) ? m.anchorEl : null);
    if (m) close();
  };
  const onBlur = () => close();
  onMount(() => {
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
  });
  onCleanup(() => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
  });
  return (
    <Show when={menu()} keyed>
      {(m) => <MenuList items={m.items} bar={m.bar} x={m.x} y={m.y} anchor={m.anchor} />}
    </Show>
  );
}
