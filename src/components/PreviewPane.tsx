import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { openIndex } from '../commands/actions';
import { fmtSize, isDir } from '../lib/fs';
import { Icon } from '../lib/icons';
import { animate, popIn } from '../lib/motion';
import { setSettings, settings } from '../state/settings';
import { activeTab, pathAt, previewIndex, selCount, selectedIndices, selectOnly, Tab } from '../state/tabs';
import { quickLook, setQuickLook, viewApi } from '../state/ui';
import { EmptyState } from './EmptyState';
import { Preview, PreviewTarget } from './Preview';

function focusedItem(t: Tab): PreviewTarget | null {
  const i = previewIndex(t);
  if (i < 0) return null;
  const m = t.model();
  return { path: pathAt(m, i), name: m.names[i], flags: m.flags[i], modified: m.modified[i] };
}
/** Debounced so holding an arrow key doesn't hammer the backend. */
function useFocusedItem(delay: number) {
  const [item, setItem] = createSignal<PreviewTarget | null>(focusedItem(activeTab()));
  let timer = 0;
  createEffect(on(() => focusedItem(activeTab()), (it) => {
    clearTimeout(timer);
    const cur = item();
    if (it?.path === cur?.path && it?.modified === cur?.modified) return;
    timer = window.setTimeout(() => setItem(it), it && cur ? delay : 0);
  }));
  onCleanup(() => clearTimeout(timer));
  return item;
}

export function PreviewPane() {
  let el!: HTMLElement;
  const item = useFocusedItem(90);
  onMount(() => animate(el, [{ opacity: 0, transform: 'translateX(12px)' }, { opacity: 1, transform: 'translateX(0)' }], 'pane'));
  const count = () => selCount(activeTab());
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = settings.previewWidth;
    const move = (ev: PointerEvent) => setSettings('previewWidth', Math.max(240, Math.min(720, Math.round(w0 - (ev.clientX - x0)))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.documentElement.classList.remove('col-resizing'); };
    document.documentElement.classList.add('col-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <aside class="previewpane" ref={el} style={{ width: `${settings.previewWidth}px` }}>
      <div class="pp-resizer" onPointerDown={startResize} />
      <Show when={count() > 1} fallback={
        <Show when={item()} keyed fallback={<EmptyState icon="eye" title="Nothing selected" detail="Select a file to preview it here." />}>
          {(it) => <Preview item={it} mode="pane" />}
        </Show>
      }>
        <EmptyState icon="selectAll" title={`${count()} items selected`} detail={selectionSize()} />
      </Show>
    </aside>
  );
}
function selectionSize() {
  const t = activeTab();
  const m = t.model();
  let b = 0;
  for (const i of selectedIndices(t)) if (!isDir(m.flags[i])) b += m.sizes[i];
  return b ? `${fmtSize(b)} in files` : 'Folders only';
}

export function QuickLook() {
  let panel!: HTMLDivElement;
  const item = useFocusedItem(40);
  onMount(() => popIn(panel));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setQuickLook(false); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      const t = activeTab();
      const n = t.model().count;
      const next = Math.max(0, Math.min(n - 1, t.focus() + (e.key === 'ArrowLeft' ? -1 : 1)));
      selectOnly(t, next);
      viewApi.reveal(next);
    } else if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      const t = activeTab();
      setQuickLook(false);
      openIndex(t, t.focus());
    }
  };
  onMount(() => window.addEventListener('keydown', onKey, true));
  onCleanup(() => window.removeEventListener('keydown', onKey, true));
  createEffect(() => { if (quickLook() && !focusedItem(activeTab())) setQuickLook(false); });
  return (
    <div class="ql-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) setQuickLook(false); }}>
      <div class="ql" ref={panel} role="dialog" aria-label="Quick Look">
        <Show when={item()} keyed>
          {(it) => (
            <>
              <div class="ql-head">
                <span class="ql-name">{it.name}</span>
                <span class="ql-hint">←/→ to browse · Enter to open · Space to close</span>
                <button class="btn btn-icon btn-sm" aria-label="Close" onClick={() => setQuickLook(false)}><Icon name="close" size={14} /></button>
              </div>
              <Preview item={it} mode="look" />
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
