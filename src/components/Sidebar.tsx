import { createSignal, For, JSX, Show } from 'solid-js';
import { openPath, togglePin } from '../commands/actions';
import { invoke } from '../ipc/invoke';
import { join, samePath } from '../lib/fs';
import { Icon, IconName } from '../lib/icons';
import { setSettings, settings } from '../state/settings';
import { displayName, driveLabel, drives, frecentDirs, iconForPath, known, knownEntries } from '../state/system';
import { activeTab, currentDir, navigate, openDir } from '../state/tabs';
import { MenuItem, openMenu, toastError } from '../state/ui';

function folderMenu(path: string, pinned: boolean): MenuItem[] {
  return [
    { label: 'Open', icon: 'external', run: () => openDir(path) },
    { label: 'Open in new tab', icon: 'tab', run: () => openPath(path, true, { newTab: true }) },
    { sep: true },
    { label: pinned ? 'Unpin from sidebar' : 'Pin to sidebar', icon: 'pin', run: () => togglePin(path) },
    { label: 'Copy as path', icon: 'link', run: () => navigator.clipboard.writeText(`"${path}"`).catch((e) => toastError(e)) },
    { label: 'Open in Terminal', icon: 'terminal', run: () => invoke('open_terminal', { dir: path }).catch((e) => toastError(e)) },
    { label: 'Properties', icon: 'info', run: () => invoke('show_properties', { paths: [path] }).catch((e) => toastError(e)) },
  ];
}

function Node(p: { path: string; label?: string; icon?: IconName; depth: number; pinned?: boolean; extra?: JSX.Element; onPointerDown?: (e: PointerEvent) => void }) {
  const [open, setOpen] = createSignal(false);
  const [kids, setKids] = createSignal<string[] | null>(null);
  const toggle = async (e: MouseEvent) => {
    e.stopPropagation();
    if (!open() && !kids()) {
      try { setKids(await invoke('list_subdirs', { path: p.path, showHidden: settings.showHidden })); }
      catch (err) { toastError(err, `Couldn't expand ${displayName(p.path)}`); return; }
    }
    setOpen(!open());
  };
  const active = () => samePath(currentDir(), p.path) && !activeTab().search();
  return (
    <div class="sb-node">
      <div class="sb-item" classList={{ active: active() }} data-drop={p.path} style={{ 'padding-left': `${8 + p.depth * 16}px` }} title={p.path}
        role="treeitem" aria-expanded={open()} tabindex="-1"
        onPointerDown={(e) => { if (e.button === 0) p.onPointerDown?.(e); }}
        onClick={(e) => { if (!(e.target as HTMLElement).closest('.sb-chev')) openDir(p.path); }}
        onAuxClick={(e) => { if (e.button === 1) openPath(p.path, true, { newTab: true }); }}
        onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY, items: folderMenu(p.path, !!p.pinned) }); }}>
        <button class="sb-chev" classList={{ open: open(), empty: kids()?.length === 0 }} tabindex="-1" aria-label="Expand" onClick={toggle}>
          <Icon name="chevronRight" size={12} />
        </button>
        <Icon name={p.icon ?? iconForPath(p.path)} />
        <span class="sb-label">{p.label ?? displayName(p.path)}</span>
        {p.extra}
      </div>
      <Show when={open() && kids()}>
        <For each={kids()!}>{(k) => <Node path={join(p.path, k)} label={k} icon="folder" depth={p.depth + 1} />}</For>
      </Show>
    </div>
  );
}

function Section(p: { title: string; children: JSX.Element; collapsible?: boolean }) {
  const [open, setOpen] = createSignal(true);
  return (
    <div class="sb-section">
      <button class="sb-head" onClick={() => setOpen(!open())} aria-expanded={open()}>
        <span>{p.title}</span><Icon name="chevronDown" size={12} class={`ic sb-head-chev ${open() ? '' : 'closed'}`} />
      </button>
      <Show when={open()}><div role="group">{p.children}</div></Show>
    </div>
  );
}

function reorderPinned(e: PointerEvent, index: number, list: HTMLElement) {
  const sy = e.clientY;
  let mode: 'none' | 'reorder' = 'none';
  const move = (ev: PointerEvent) => {
    if (mode === 'none' && Math.abs(ev.clientY - sy) > 5 && Math.abs(ev.clientX - e.clientX) < 24) mode = 'reorder';
    if (mode !== 'reorder') return;
    const items = [...list.querySelectorAll<HTMLElement>(':scope > .sb-node')];
    let to = items.findIndex((el) => { const r = el.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if (to < 0) to = items.length;
    items.forEach((el, i) => el.classList.toggle('insert-before', i === to && to !== index && to !== index + 1));
    list.classList.toggle('insert-end', to === items.length && index !== items.length - 1);
    list.dataset.to = String(to);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    list.querySelectorAll('.insert-before').forEach((el) => el.classList.remove('insert-before'));
    list.classList.remove('insert-end');
    if (mode === 'reorder' && list.dataset.to) {
      const to = Number(list.dataset.to);
      setSettings('pinned', (l) => { const c = [...l]; const [x] = c.splice(index, 1); c.splice(to > index ? to - 1 : to, 0, x); return c; });
      const suppress = (ce: MouseEvent) => { ce.stopPropagation(); ce.preventDefault(); };
      window.addEventListener('click', suppress, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', suppress, { capture: true }), 0);
    }
    delete list.dataset.to;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function Sidebar() {
  let pinList!: HTMLDivElement;
  const frequent = () => frecentDirs().filter((f) => !settings.pinned.some((p) => samePath(p, f.path))).slice(0, 5);
  const homeActive = () => activeTab().loc().kind === 'home' && !activeTab().search();
  const storageActive = () => activeTab().loc().kind === 'storage' && !activeTab().search();
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = settings.sidebarWidth;
    const move = (ev: PointerEvent) => setSettings('sidebarWidth', Math.max(180, Math.min(420, Math.round(w0 + ev.clientX - x0))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.documentElement.classList.remove('col-resizing'); };
    document.documentElement.classList.add('col-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <nav class="sidebar" style={{ width: `${settings.sidebarWidth}px` }} role="tree" aria-label="Locations">
      <div class="sb-scroll">
        <div class="sb-item sb-top" classList={{ active: homeActive() }} onClick={() => navigate(activeTab(), { kind: 'home' })}>
          <span class="sb-chev-space" /><Icon name="home" /><span class="sb-label">Home</span>
        </div>
        <div class="sb-item sb-top" classList={{ active: storageActive() }} onClick={() => navigate(activeTab(), { kind: 'storage' })}>
          <span class="sb-chev-space" /><Icon name="storage" /><span class="sb-label">Storage</span>
        </div>
        <Show when={settings.pinned.length}>
          <Section title="Pinned">
            <div ref={pinList} class="sb-pins">
              <For each={settings.pinned}>{(path, i) => (
                <Node path={path} depth={0} pinned onPointerDown={(e) => reorderPinned(e, i(), pinList)} />
              )}</For>
            </div>
          </Section>
        </Show>
        <Show when={frequent().length}>
          <Section title="Frequent">
            <For each={frequent()}>{(f) => <Node path={f.path} depth={0} />}</For>
          </Section>
        </Show>
        <Section title="Locations">
          <For each={knownEntries()}>{(k) => <Node path={k.path} label={k.label} icon={k.icon} depth={0} />}</For>
          <Show when={known()?.onedrive}><Node path={known()!.onedrive!} label="OneDrive" icon="cloud" depth={0} /></Show>
        </Section>
        <Section title="This PC">
          <For each={drives()}>{(d) => {
            const used = () => (d.total ? 1 - d.free / d.total : 0);
            return (
              <Node path={d.path} label={driveLabel(d)} icon="drive" depth={0} extra={
                <span class="sb-usage" title={`${Math.round(used() * 100)}% used`}>
                  <span class="sb-usage-bar" classList={{ warn: used() > 0.9 }} style={{ transform: `scaleX(${used()})` }} />
                </span>
              } />
            );
          }}</For>
        </Section>
      </div>
      <div class="sb-resizer" onPointerDown={startResize} onDblClick={() => setSettings('sidebarWidth', 240)} />
    </nav>
  );
}
