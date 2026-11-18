import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { openPath } from '../commands/actions';
import { invoke } from '../ipc/invoke';
import { baseName, join, normPath, segments } from '../lib/fs';
import { Icon } from '../lib/icons';
import { settings } from '../state/settings';
import { displayName, drives, driveLabel, frecentDirs, iconForPath } from '../state/system';
import { activeTab, currentDir, navigate, openDir } from '../state/tabs';
import { MenuItem, menuToggledOff, openMenuAt, pathEditing, setPathEditing, toast, toastError, viewApi } from '../state/ui';

const subdirCache = new Map<string, Promise<string[]>>();
function subdirs(path: string) {
  let p = subdirCache.get(path.toLowerCase());
  if (!p) {
    p = invoke('list_subdirs', { path, showHidden: settings.showHidden });
    subdirCache.set(path.toLowerCase(), p);
    setTimeout(() => subdirCache.delete(path.toLowerCase()), 5000);
    p.catch(() => subdirCache.delete(path.toLowerCase()));
  }
  return p;
}

async function chevronMenu(el: HTMLElement, path: string | null) {
  if (menuToggledOff(el)) { el.classList.remove('open'); return; }
  el.classList.add('open');
  const close = () => el.classList.remove('open');
  try {
    let items: MenuItem[];
    if (path === null) {
      items = [{ label: 'Home', icon: 'home', run: () => navigate(activeTab(), { kind: 'home' }) }, { sep: true },
        ...drives().map((d): MenuItem => ({ label: driveLabel(d), icon: 'drive', run: () => openDir(d.path) }))];
    } else {
      const names = await subdirs(path);
      items = names.length ? names.slice(0, 400).map((n): MenuItem => ({ label: n, icon: 'folder', run: () => openDir(join(path, n)) }))
        : [{ label: 'No subfolders', disabled: true }];
    }
    openMenuAt(el, items, close);
  } catch (e) { close(); toastError(e, `Couldn't list ${displayName(path ?? '')}`); }
}

export function PathBar() {
  let input!: HTMLInputElement;
  let crumbs!: HTMLDivElement;
  const [text, setText] = createSignal('');
  const [sugg, setSugg] = createSignal<string[]>([]);
  const [hi, setHi] = createSignal(-1);
  const dir = () => currentDir();

  createEffect(on(pathEditing, (ed) => {
    if (!ed) return;
    setText(dir() ?? '');
    setSugg([]); setHi(-1);
    queueMicrotask(() => { input?.focus(); input?.select(); });
  }));
  createEffect(on(() => [dir(), activeTab().search()], () => queueMicrotask(() => { if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth; })));

  let seq = 0;
  async function suggest(v: string) {
    const id = ++seq;
    const q = v.replace(/\//g, '\\');
    const cut = q.lastIndexOf('\\');
    const out: string[] = [];
    if (cut >= 2) {
      const parent = normPath(q.slice(0, cut + 1));
      const pre = q.slice(cut + 1).toLowerCase();
      try {
        const names = await subdirs(parent);
        if (id !== seq) return;
        for (const n of names) if (n.toLowerCase().startsWith(pre)) { out.push(join(parent, n)); if (out.length >= 8) break; }
      } catch { /* not a folder yet */ }
    }
    const lq = q.toLowerCase();
    if (lq) for (const f of frecentDirs()) {
      if (out.length >= 12) break;
      if (f.path.toLowerCase().includes(lq) && !out.some((o) => o.toLowerCase() === f.path.toLowerCase())) out.push(f.path);
    }
    if (id === seq) { setSugg(out); setHi(-1); }
  }

  async function go(raw: string) {
    const v = raw.trim();
    if (!v) { setPathEditing(false); return; }
    if (/^home$/i.test(v)) { navigate(activeTab(), { kind: 'home' }); setPathEditing(false); return; }
    const p = normPath(v);
    try {
      await invoke('list_subdirs', { path: p, showHidden: false });
      openDir(p);
      setPathEditing(false);
      viewApi.focus();
    } catch (e) {
      const err = e as { code: string };
      if (err.code === 'not_found') toast({ kind: 'error', text: `Can't find "${v}"`, detail: 'Check the spelling and try again.' });
      else { openDir(p); setPathEditing(false); }
    }
  }

  const onKey = (e: KeyboardEvent) => {
    const list = sugg();
    if (e.key === 'Escape') { e.preventDefault(); setPathEditing(false); viewApi.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(hi() >= 0 ? list[hi()] : text()); }
    else if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setHi((h) => (h + 1) % list.length); }
    else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); setHi((h) => (h <= 0 ? list.length - 1 : h - 1)); }
    else if (e.key === 'Tab' && list.length) {
      e.preventDefault();
      const v = list[hi() >= 0 ? hi() : 0] + '\\';
      setText(v); suggest(v);
    }
  };
  const blurTimer = { id: 0 };
  onCleanup(() => clearTimeout(blurTimer.id));

  return (
    <div class="pathbar" classList={{ editing: pathEditing() }}
      onMouseDown={(e) => { if (!pathEditing() && (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('crumbs'))) { e.preventDefault(); setPathEditing(true); } }}>
      <Show when={pathEditing()} fallback={
        <>
          <span class="pathbar-icon"><Icon name={activeTab().search() ? 'search' : dir() ? iconForPath(dir()!) : 'home'} /></span>
          <div class="crumbs" ref={crumbs}>
            <button class="crumb-chev" title="Locations" onClick={(e) => chevronMenu(e.currentTarget, null)}><Icon name="chevronRight" size={12} /></button>
            <Show when={dir()} fallback={<button class="crumb" onClick={() => navigate(activeTab(), { kind: 'home' })}>Home</button>}>
              <For each={segments(dir()!)}>{(s, i) => (
                <>
                  <button class="crumb" data-drop={s.path} classList={{ last: i() === segments(dir()!).length - 1 && !activeTab().search() }} onClick={() => openDir(s.path)}
                    onAuxClick={(e) => { if (e.button === 1) openPath(s.path, true, { newTab: true }); }}>
                    {i() === 0 ? displayName(s.path) : s.name}
                  </button>
                  <button class="crumb-chev" title={`Folders in ${i() === 0 ? displayName(s.path) : baseName(s.path)}`} onClick={(e) => chevronMenu(e.currentTarget, s.path)}><Icon name="chevronRight" size={12} /></button>
                </>
              )}</For>
            </Show>
            <Show when={activeTab().search()}>
              <span class="crumb last search-crumb">Search results</span>
            </Show>
          </div>
        </>
      }>
        <input ref={input} class="pathbar-input" value={text()} spellcheck={false} autocomplete="off"
          onInput={(e) => { setText(e.currentTarget.value); suggest(e.currentTarget.value); }}
          onKeyDown={onKey} onBlur={() => { blurTimer.id = window.setTimeout(() => setPathEditing(false), 120); }} />
        <Show when={sugg().length}>
          <div class="pop suggest" role="listbox">
            <For each={sugg()}>{(s, i) => (
              <div class="suggest-item" classList={{ hi: hi() === i() }} role="option" onMouseDown={(e) => { e.preventDefault(); go(s); }} onMouseEnter={() => setHi(i())}>
                <Icon name={iconForPath(s)} /><span class="suggest-name">{displayName(s)}</span><span class="suggest-path">{s}</span>
              </div>
            )}</For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
