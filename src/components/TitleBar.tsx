import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { duplicateTab, newTabHere } from '../commands/actions';
import { tip } from '../commands/registry';
import { IS_TAURI } from '../ipc/invoke';
import { Icon } from '../lib/icons';
import { iconForPath } from '../state/system';
import { activate, activeId, closeTab, currentDir, moveTab, Tab, tabs, tabTitle } from '../state/tabs';
import { openMenu, toastError } from '../state/ui';

async function win() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

function TabItem(p: { tab: Tab; index: number }) {
  let el!: HTMLDivElement;
  const onDown = (e: PointerEvent) => {
    if (e.button === 1) { e.preventDefault(); closeTab(p.tab); return; }
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tab-close')) return;
    activate(p.tab.id);
    const sx = e.clientX;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - sx) < 6) return;
      dragging = true;
      el.classList.add('tab-dragging');
      const items = [...el.parentElement!.querySelectorAll<HTMLElement>('.tab')];
      const to = items.findIndex((t) => { const r = t.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2; });
      const target = to < 0 ? items.length - 1 : to > p.index ? to - 1 : to;
      if (target !== p.index) moveTab(p.index, target);
    };
    const up = () => { el.classList.remove('tab-dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onMenu = (e: MouseEvent) => {
    e.preventDefault();
    openMenu({
      x: e.clientX, y: e.clientY, items: [
        { label: 'New tab', icon: 'plus', cmd: 'tab.new' },
        { label: 'Duplicate tab', icon: 'copy', run: () => duplicateTab(p.tab) },
        { sep: true },
        { label: 'Close tab', icon: 'close', run: () => closeTab(p.tab), shortcut: undefined },
        { label: 'Close other tabs', run: () => tabs().filter((t) => t !== p.tab).forEach(closeTab), disabled: tabs().length < 2 },
        { label: 'Close tabs to the right', run: () => tabs().slice(p.index + 1).forEach(closeTab), disabled: p.index === tabs().length - 1 },
      ],
    });
  };
  const dir = () => currentDir(p.tab);
  return (
    <div ref={el} class="tab" classList={{ active: activeId() === p.tab.id }} data-tab-id={p.tab.id} data-drop={dir() ?? undefined}
      role="tab" aria-selected={activeId() === p.tab.id} title={dir() ?? tabTitle(p.tab)} onPointerDown={onDown} onContextMenu={onMenu}>
      <Icon name={p.tab.search() ? 'search' : dir() ? iconForPath(dir()!) : p.tab.loc().kind === 'storage' ? 'storage' : 'home'} />
      <span class="tab-title">{p.tab.search() ? `Search: ${p.tab.search()!.query || '…'}` : tabTitle(p.tab)}</span>
      <button class="tab-close" title={tip('tab.close', 'Close tab')} onClick={() => closeTab(p.tab)}><Icon name="close" size={12} /></button>
    </div>
  );
}

export function TitleBar() {
  const [maximized, setMaximized] = createSignal(false);
  let unlisten = () => {};
  onCleanup(() => unlisten());
  onMount(async () => {
    if (!IS_TAURI) return;
    try {
      const w = await win();
      setMaximized(await w.isMaximized());
      unlisten = await w.onResized(async () => setMaximized(await w.isMaximized()));
    } catch { /* window API unavailable: keep default icon */ }
  });
  const act = (f: (w: Awaited<ReturnType<typeof win>>) => Promise<void>) => async () => {
    if (IS_TAURI) try { await f(await win()); } catch (e) { toastError(e, 'Window action failed'); }
  };
  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="tabs" role="tablist" data-tauri-drag-region>
        <For each={tabs()}>{(t, i) => <TabItem tab={t} index={i()} />}</For>
        <button class="tab-new" title={tip('tab.new')} onClick={newTabHere}><Icon name="plus" /></button>
      </div>
      <div class="drag-fill" data-tauri-drag-region />
      <Show when={IS_TAURI}>
        <div class="winctl">
          <button title="Minimize" onClick={act((w) => w.minimize())}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5.5h10" stroke="currentColor" /></svg>
          </button>
          <button title={maximized() ? 'Restore down' : 'Maximize'} onClick={act((w) => w.toggleMaximize())}>
            <Show when={maximized()} fallback={<svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" rx="1" fill="none" stroke="currentColor" /></svg>}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><rect x=".5" y="2.5" width="7" height="7" rx="1" /><path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" /></svg>
            </Show>
          </button>
          <button class="winctl-close" title="Close" onClick={act((w) => w.close())}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" /></svg>
          </button>
        </div>
      </Show>
    </header>
  );
}
