import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { getCommand, shortcutLabel } from '../commands/registry';
import { Icon, IconName } from '../lib/icons';
import { popIn } from '../lib/motion';
import { menu, MenuItem, noteMenuDismissedBy, setMenu, viewApi } from '../state/ui';

interface Resolved { label: string; icon?: IconName; shortcut: string; run?: () => void; disabled: boolean; checked?: boolean; danger?: boolean; submenu?: MenuItem[]; sep?: boolean }
function resolve(it: MenuItem): Resolved {
  if (it.sep) return { label: '', shortcut: '', disabled: true, sep: true };
  const c = it.cmd ? getCommand(it.cmd) : undefined;
  return {
    label: it.label ?? c?.label ?? '',
    icon: it.icon ?? c?.icon,
    shortcut: it.shortcut ?? (it.cmd ? shortcutLabel(it.cmd) : ''),
    run: it.run ?? c?.run,
    disabled: !!it.disabled || (!!c?.enabled && !c.enabled()),
    checked: it.checked, danger: it.danger, submenu: it.submenu,
  };
}
function clean(items: Resolved[]) {
  const out: Resolved[] = [];
  for (const r of items) { if (r.sep && (!out.length || out[out.length - 1].sep)) continue; out.push(r); }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}

function close() {
  const m = menu();
  setMenu(null);
  m?.onClose?.();
  queueMicrotask(() => { if (!document.activeElement || document.activeElement === document.body) viewApi.focus(); });
}

function MenuList(p: { items: MenuItem[]; x: number; y: number; anchor?: DOMRect; sub?: boolean; onBack?: () => void }) {
  let el!: HTMLDivElement;
  const items = clean(p.items.map(resolve));
  const hasChecks = items.some((r) => r.checked !== undefined);
  const [hi, setHi] = createSignal(-1);
  const [sub, setSub] = createSignal<{ i: number; rect: DOMRect } | null>(null);
  const [pos, setPos] = createSignal({ x: p.x, y: p.y });
  let hoverTimer = 0;

  onMount(() => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = p.x, y = p.y, ox = 'left', oy = 'top';
    if (x + r.width > vw - 8) { x = p.sub && p.anchor ? p.anchor.left - r.width + 4 : Math.max(8, vw - r.width - 8); ox = 'right'; }
    if (y + r.height > vh - 8) {
      y = p.anchor && !p.sub ? Math.max(8, p.anchor.top - r.height - 4) : Math.max(8, vh - r.height - 8);
      oy = 'bottom';
    }
    setPos({ x, y });
    popIn(el, `${ox} ${oy}`);
    el.focus({ preventScroll: true });
  });

  const activate = (i: number) => {
    const r = items[i];
    if (!r || r.disabled || r.sep) return;
    if (r.submenu) { openSub(i); return; }
    close();
    r.run?.();
  };
  const openSub = (i: number) => {
    const node = el.querySelectorAll<HTMLElement>('.mi')[i];
    if (node) setSub({ i, rect: node.getBoundingClientRect() });
  };
  const move = (d: number) => {
    let i = hi();
    for (let k = 0; k < items.length; k++) {
      i = (i + d + items.length) % items.length;
      if (!items[i].sep && !items[i].disabled) { setHi(i); return; }
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (sub()) return;
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(hi()); }
    else if (e.key === 'ArrowRight' && items[hi()]?.submenu) { e.preventDefault(); openSub(hi()); }
    else if (e.key === 'Escape' || (e.key === 'ArrowLeft' && p.sub)) { e.preventDefault(); if (p.sub) p.onBack?.(); else close(); }
    else if (e.key === 'Tab') e.preventDefault();
  };

  return (
    <>
      <div ref={el} class="menu pop" classList={{ checks: hasChecks }} role="menu" tabindex="-1" data-modal
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
        <For each={items}>{(r, i) => (
          <Show when={!r.sep} fallback={<div class="msep" role="separator" />}>
            <div class="mi" classList={{ hi: hi() === i(), disabled: r.disabled, danger: r.danger, open: sub()?.i === i() }} role="menuitem" aria-disabled={r.disabled}
              onPointerEnter={() => {
                setHi(i());
                clearTimeout(hoverTimer);
                if (r.submenu && !r.disabled) hoverTimer = window.setTimeout(() => openSub(i()), 120);
                else if (sub()) hoverTimer = window.setTimeout(() => setSub(null), 200);
              }}
              onClick={() => activate(i())}>
              <Show when={hasChecks}><span class="mi-check">{r.checked ? <Icon name="check" size={14} /> : null}</span></Show>
              <span class="mi-icon">{r.icon ? <Icon name={r.icon} /> : null}</span>
              <span class="mi-label">{r.label}</span>
              <Show when={r.shortcut}><span class="mi-key">{r.shortcut}</span></Show>
              <Show when={r.submenu}><Icon name="chevronRight" size={12} class="ic mi-sub" /></Show>
            </div>
          </Show>
        )}</For>
      </div>
      <Show when={sub()} keyed>
        {(s) => <MenuList items={items[s.i].submenu!} x={s.rect.right - 4} y={s.rect.top - 5} anchor={s.rect} sub onBack={() => { setSub(null); el.focus(); }} />}
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
      {(m) => <MenuList items={m.items} x={m.x} y={m.y} anchor={m.anchor} />}
    </Show>
  );
}
