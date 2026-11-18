import { For, onMount, Show } from 'solid-js';
import { openPath } from '../commands/actions';
import { baseName, fmtDate, fmtSize, parentOf, samePath } from '../lib/fs';
import { Icon } from '../lib/icons';
import { animate } from '../lib/motion';
import { settings } from '../state/settings';
import { displayName, driveLabel, drives, frecentDirs, iconForPath, knownEntries, recentFiles, refreshFrecent } from '../state/system';
import { MenuItem, openMenu } from '../state/ui';
import { FileIcon } from './FileIcon';

function FolderTile(p: { path: string; label?: string; sub?: string }) {
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: 'Open', icon: 'external', run: () => openPath(p.path, true) },
      { label: 'Open in new tab', icon: 'tab', run: () => openPath(p.path, true, { newTab: true }) },
    ];
    openMenu({ x: e.clientX, y: e.clientY, items });
  };
  return (
    <button class="h-tile" data-drop={p.path} title={p.path} onClick={() => openPath(p.path, true)} onContextMenu={menu}
      onAuxClick={(e) => { if (e.button === 1) openPath(p.path, true, { newTab: true }); }}>
      <span class="h-tile-icon"><Icon name={iconForPath(p.path)} size={20} /></span>
      <span class="h-tile-text">
        <span class="h-tile-name">{p.label ?? displayName(p.path)}</span>
        <span class="h-tile-sub">{p.sub ?? parentOf(p.path) ?? ''}</span>
      </span>
    </button>
  );
}

export function Home() {
  let el!: HTMLDivElement;
  onMount(() => {
    refreshFrecent();
    animate(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], 'nav');
  });
  const frequent = () => frecentDirs().filter((f) => !settings.pinned.some((p) => samePath(p, f.path))).slice(0, 8);
  return (
    <div class="home" ref={el}>
      <div class="home-inner">
        <h1 class="home-title">Home</h1>
        <Show when={settings.pinned.length || knownEntries().length}>
          <section>
            <h2>{settings.pinned.length ? 'Pinned' : 'Quick access'}</h2>
            <div class="h-grid">
              <For each={settings.pinned.length ? settings.pinned : knownEntries().map((k) => k.path)}>{(p) => <FolderTile path={p} />}</For>
            </div>
          </section>
        </Show>
        <Show when={frequent().length}>
          <section>
            <h2>Frequent folders</h2>
            <div class="h-grid">
              <For each={frequent()}>{(f) => <FolderTile path={f.path} />}</For>
            </div>
          </section>
        </Show>
        <section>
          <h2>Recent files</h2>
          <Show when={recentFiles().length} fallback={<div class="h-empty">Files you open will show up here.</div>}>
            <div class="h-recent" role="list">
              <For each={recentFiles()}>{(f) => (
                <button class="h-rec" role="listitem" title={f.path} onClick={() => openPath(f.path, false)}
                  onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY, items: [
                    { label: 'Open', icon: 'external', run: () => openPath(f.path, false) },
                    { label: 'Open file location', icon: 'folder', run: () => openPath(parentOf(f.path)!, true) },
                    { label: 'Copy as path', icon: 'link', run: () => navigator.clipboard.writeText(`"${f.path}"`) },
                  ] }); }}>
                  <FileIcon name={baseName(f.path)} flags={0} path={f.path} size={20} extOnly />
                  <span class="h-rec-name">{baseName(f.path)}</span>
                  <span class="h-rec-dir">{parentOf(f.path)}</span>
                  <span class="h-rec-time num">{fmtDate(f.lastVisit)}</span>
                </button>
              )}</For>
            </div>
          </Show>
        </section>
        <section>
          <h2>Drives</h2>
          <div class="h-grid">
            <For each={drives()}>{(d) => {
              const used = d.total ? 1 - d.free / d.total : 0;
              return (
                <button class="h-tile h-drive" data-drop={d.path} onClick={() => openPath(d.path, true)}>
                  <span class="h-tile-icon"><Icon name="drive" size={20} /></span>
                  <span class="h-tile-text">
                    <span class="h-tile-name">{driveLabel(d)}</span>
                    <span class="h-bar"><span classList={{ warn: used > 0.9 }} style={{ transform: `scaleX(${used})` }} /></span>
                    <span class="h-tile-sub num">{fmtSize(d.free)} free of {fmtSize(d.total)}</span>
                  </span>
                </button>
              );
            }}</For>
          </div>
        </section>
      </div>
    </div>
  );
}
