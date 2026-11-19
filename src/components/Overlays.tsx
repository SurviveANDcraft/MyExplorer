import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { kindOf } from '../lib/fs';
import { Icon } from '../lib/icons';
import { popIn } from '../lib/motion';
import { drag, dropLabel } from '../state/drag';
import { dismissToast, toasts } from '../state/ui';
import { Glyph } from './FileIcon';

function ToastView(p: { id: number }) {
  const cur = () => toasts().find((x) => x.id === p.id);
  const last = { v: cur()! };
  const t = () => (last.v = cur() ?? last.v);
  let el!: HTMLDivElement;
  onMount(() => popIn(el, 'bottom center'));
  return (
    <div ref={el} class={`toast toast-${t().kind}`} role={t().kind === 'error' ? 'alert' : 'status'}>
      <span class="toast-icon">
        <Show when={t().kind === 'progress'} fallback={<Icon name={t().kind === 'error' ? 'alert' : t().kind === 'success' ? 'check' : 'info'} />}>
          <span class="spinner" />
        </Show>
      </span>
      <div class="toast-text">
        <div class="toast-title">{t().text}</div>
        <Show when={t().detail}><div class="toast-detail">{t().detail}</div></Show>
        <Show when={t().kind === 'progress'}>
          <div class="toast-bar" classList={{ indeterminate: t().progress == null }}><span style={{ width: t().progress == null ? undefined : `${Math.round((t().progress ?? 0) * 100)}%` }} /></div>
        </Show>
      </div>
      <Show when={t().action}>
        <button class="btn btn-text btn-sm btn-accent" onClick={() => { t().action!.run(); dismissToast(t().id); }}>{t().action!.label}</button>
      </Show>
      <button class="btn btn-icon btn-sm" aria-label="Dismiss" onClick={() => dismissToast(t().id)}><Icon name="close" size={12} /></button>
    </div>
  );
}
export function Toasts() {
  return <div class="toasts" aria-live="polite"><For each={toasts().map((t) => t.id)}>{(id) => <ToastView id={id} />}</For></div>;
}

export function DragGhost() {
  return (
    <Show when={drag()}>
      {(d) => (
        <div class="ghost" style={{ transform: `translate(${d().x + 14}px, ${d().y + 14}px)` }} classList={{ external: !!d().external }}>
          <Show when={!d().external}>
            <div class="ghost-card">
              <Glyph kind={kindOf(d().name, d().flags)} size={20} />
              <span class="ghost-name">{d().paths.length > 1 ? `${d().paths.length} items` : d().name}</span>
            </div>
          </Show>
          <Show when={d().target}><div class="ghost-hint"><Icon name={d().copy ? 'plus' : 'forward'} size={12} />{dropLabel(d())}</div></Show>
        </div>
      )}
    </Show>
  );
}

/** One global tooltip for every element with `data-tip`. */
export function Tooltip() {
  const [tip, setTip] = createSignal<{ text: string; x: number; y: number; below: boolean } | null>(null);
  let timer = 0, current: HTMLElement | null = null, warm = false, coolTimer = 0;
  let el: HTMLDivElement | undefined;
  const hide = () => { clearTimeout(timer); if (tip()) { warm = true; clearTimeout(coolTimer); coolTimer = window.setTimeout(() => (warm = false), 600); } setTip(null); current = null; };
  const over = (e: PointerEvent) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (t === current) return;
    hide();
    if (!t || document.documentElement.classList.contains('is-dragging')) return;
    current = t;
    timer = window.setTimeout(() => {
      const text = t.dataset.tip;
      if (!text || !t.isConnected) return;
      const r = t.getBoundingClientRect();
      const below = r.bottom + 40 < window.innerHeight;
      setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
      queueMicrotask(() => {
        if (!el) return;
        const w = el.offsetWidth;
        const x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
        el.style.left = `${x}px`;
        if (!below) el.style.top = `${r.top - 6 - el.offsetHeight}px`;
        popIn(el, below ? 'top center' : 'bottom center');
      });
    }, warm ? 60 : 550);
  };
  onMount(() => {
    window.addEventListener('pointerover', over);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
  });
  onCleanup(() => {
    window.removeEventListener('pointerover', over);
    window.removeEventListener('pointerdown', hide, true);
    window.removeEventListener('keydown', hide, true);
    window.removeEventListener('blur', hide);
  });
  return (
    <Show when={tip()}>
      {(t) => <div ref={el} class="tooltip" classList={{ above: !t().below }} style={{ left: `${t().x}px`, top: `${t().y}px` }}>{t().text}</div>}
    </Show>
  );
}
