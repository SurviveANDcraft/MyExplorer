import { createMemo, createResource, createSignal, For, JSX, onCleanup, onMount, Show } from 'solid-js';
import { setShowHidden } from '../commands/actions';
import { allCommands, chordsFor, Command, commandsForChord, defaultChords, eventChord, getCommand, keyCapture, prettyChord } from '../commands/registry';
import { invoke, IS_TAURI } from '../ipc/invoke';
import type { Integration, SortKey } from '../ipc/types';
import { Icon } from '../lib/icons';
import { popIn } from '../lib/motion';
import { ACCENTS, setSettings, settings } from '../state/settings';
import { currentDir } from '../state/tabs';
import { attempt, setSettingsOpen, toast, toastError, viewApi } from '../state/ui';
import { checkForUpdate, installUpdate, updateState } from '../state/updater';

function Seg<T extends string>(p: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="seg" role="radiogroup">
      <For each={p.options}>{([v, label]) => (
        <button role="radio" aria-checked={p.value === v} classList={{ on: p.value === v }} onClick={() => p.onChange(v)}>{label}</button>
      )}</For>
    </div>
  );
}
function Toggle(p: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button class="switch" role="switch" aria-checked={p.value} aria-label={p.label} classList={{ on: p.value }} onClick={() => p.onChange(!p.value)}><span /></button>;
}
function Field(p: { label: JSX.Element; hint?: string; children: JSX.Element }) {
  return (
    <div class="field">
      <div class="field-text"><div class="field-label">{p.label}</div><Show when={p.hint}><div class="field-hint">{p.hint}</div></Show></div>
      <div class="field-ctl">{p.children}</div>
    </div>
  );
}

function Appearance() {
  return (
    <>
      <Field label="Theme"><Seg value={settings.theme} options={[['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]} onChange={(v) => setSettings('theme', v)} /></Field>
      <Field label="Accent color">
        <div class="swatches">
          <For each={ACCENTS}>{(c) => (
            <button class="swatch" classList={{ on: settings.accent.toLowerCase() === c }} style={{ '--sw': c }} aria-label={c} onClick={() => setSettings('accent', c)}>
              <Show when={settings.accent.toLowerCase() === c}><Icon name="check" size={12} /></Show>
            </button>
          )}</For>
          <label class="swatch swatch-custom" title="Custom color" classList={{ on: !ACCENTS.includes(settings.accent.toLowerCase()) }} style={{ '--sw': settings.accent }}>
            <Icon name="palette" size={14} />
            <input type="color" value={settings.accent} onInput={(e) => setSettings('accent', e.currentTarget.value)} />
          </label>
        </div>
      </Field>
      <Field label="Density" hint="Row height in lists"><Seg value={settings.density} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} onChange={(v) => setSettings('density', v)} /></Field>
      <Field label="Animations" hint="Reduced motion in Windows always wins"><Seg value={settings.anim} options={[['off', 'Off'], ['fast', 'Fast'], ['normal', 'Normal']]} onChange={(v) => setSettings('anim', v)} /></Field>
    </>
  );
}

function Behavior() {
  const dv = () => settings.defaultView;
  return (
    <>
      <Field label="Default view" hint="Folders you've customized keep their own view">
        <Seg value={dv().view} options={[['details', 'Details'], ['list', 'List'], ['grid', 'Grid']]} onChange={(v) => setSettings('defaultView', 'view', v)} />
      </Field>
      <Field label="Default sort">
        <div class="row-ctl">
          <select class="select" value={dv().sort.key} onChange={(e) => setSettings('defaultView', 'sort', 'key', e.currentTarget.value as SortKey)}>
            <option value="name">Name</option><option value="modified">Date modified</option><option value="type">Type</option><option value="size">Size</option><option value="created">Date created</option>
          </select>
          <Seg value={dv().sort.desc ? 'desc' : 'asc'} options={[['asc', 'Ascending'], ['desc', 'Descending']]} onChange={(v) => setSettings('defaultView', 'sort', 'desc', v === 'desc')} />
        </div>
      </Field>
      <Field label="Folders first"><Toggle label="Folders first" value={dv().sort.foldersFirst} onChange={(v) => setSettings('defaultView', 'sort', 'foldersFirst', v)} /></Field>
      <Field label="Show hidden items"><Toggle label="Show hidden items" value={settings.showHidden} onChange={setShowHidden} /></Field>
      <Field label="Show file extensions"><Toggle label="Show file extensions" value={settings.showExtensions} onChange={(v) => setSettings('showExtensions', v)} /></Field>
      <Field label="Open items with"><Seg value={settings.clickMode} options={[['double', 'Double click'], ['single', 'Single click']]} onChange={(v) => setSettings('clickMode', v)} /></Field>
      <Field label="New tabs open" hint={settings.startup === 'home' ? 'Home' : settings.startup}>
        <div class="row-ctl">
          <Seg value={settings.startup === 'home' ? 'home' : 'folder'} options={[['home', 'Home'], ['folder', 'A folder']]}
            onChange={(v) => setSettings('startup', v === 'home' ? 'home' : currentDir() ?? 'home')} />
          <Show when={settings.startup !== 'home'}>
            <button class="btn btn-text btn-outline" disabled={!currentDir()} onClick={() => setSettings('startup', currentDir()!)}>Use current folder</button>
          </Show>
        </div>
      </Field>
      <Field label="Remembered folder views" hint={`${Object.keys(settings.folderViews).length} folders`}>
        <button class="btn btn-text btn-outline" onClick={() => setSettings('folderViews', {})}>Reset</button>
      </Field>
      <div class="st-group">Advanced</div>
      <Field label={<>Search in files <span class="beta">Beta</span></>} hint="Searches the text inside your files from the search box (Ctrl+Shift+G). Still in beta: results and ranking may change.">
        <Toggle label="Search in files" value={settings.contentSearch} onChange={(v) => setSettings('contentSearch', v)} />
      </Field>
    </>
  );
}

function Windows() {
  const [st, { mutate }] = createResource(() => invoke('integration_status').catch(() => null));
  const [busy, setBusy] = createSignal(false);
  const apply = async (next: Integration) => {
    setBusy(true);
    try { mutate(await invoke('set_integration', { state: next })); }
    catch (e) { toastError(e, "Couldn't change Windows settings"); }
    finally { setBusy(false); }
  };
  const cur = (): Integration => ({ folders: !!st()?.folders, winE: !!st()?.winE, contextEntry: !!st()?.contextEntry });
  const all = () => cur().folders && cur().winE;
  const set = (patch: Partial<Integration>) => apply({ ...cur(), ...patch });
  return (
    <Show when={IS_TAURI} fallback={<div class="field-hint">Available in the desktop app.</div>}>
      <div class="win-hero" classList={{ on: all() }}>
        <div class="win-hero-icon"><Icon name={all() ? 'check' : 'windows'} size={22} /></div>
        <div class="win-hero-text">
          <div class="win-hero-title">{all() ? 'MyExplorer is your file manager' : 'Make MyExplorer your default file manager'}</div>
          <div class="field-hint">{all() ? 'Folders, drives and Win+E open here. File Explorer is still one click away.' : 'Folders you open anywhere in Windows, and Win+E, open here instead of File Explorer. No admin rights needed.'}</div>
        </div>
        <Show when={all()} fallback={<button class="btn btn-text btn-accent" disabled={busy() || !st()} onClick={() => apply({ folders: true, winE: true, contextEntry: true })}>Make default</button>}>
          <button class="btn btn-text btn-outline" disabled={busy()} onClick={() => apply({ folders: false, winE: false, contextEntry: false })}>Restore File Explorer</button>
        </Show>
      </div>
      <Show when={st()?.stale}>
        <div class="win-note"><Icon name="alert" size={14} /><span>Some entries point to another copy of MyExplorer.</span>
          <button class="btn btn-text btn-sm btn-accent" disabled={busy()} onClick={() => apply(cur())}>Point them here</button></div>
      </Show>
      <Show when={st()?.devBuild}>
        <div class="win-note"><Icon name="info" size={14} /><span>This is a development build. Changes here register this build ({st()?.exe}).</span></div>
      </Show>
      <Field label="Open folders and drives" hint="Double-clicking a folder on the desktop, in Start or in other apps opens it here">
        <Toggle label="Open folders and drives" value={cur().folders} onChange={(v) => set({ folders: v, contextEntry: v || cur().contextEntry })} />
      </Field>
      <Field label="Win+E opens MyExplorer" hint="Also the “This PC” shortcut">
        <Toggle label="Win+E opens MyExplorer" value={cur().winE} onChange={(v) => set({ winE: v })} />
      </Field>
      <Field label="“Open in MyExplorer” in File Explorer" hint={cur().folders ? 'Always on while folders open here' : 'Adds the option to File Explorer’s right-click menu'}>
        <Toggle label="Open in MyExplorer in File Explorer" value={cur().contextEntry || cur().folders} onChange={(v) => { if (!cur().folders) set({ contextEntry: v }); }} />
      </Field>
    </Show>
  );
}

function Agents() {
  const [st, { mutate }] = createResource(() => invoke('agents_status').catch(() => null));
  const [busy, setBusy] = createSignal<string | null>(null);
  const set = async (id: string, on: boolean) => {
    setBusy(id);
    try { mutate(await invoke('set_agent', { id, on })); }
    catch (e) { toastError(e, "Couldn't change agent setup"); }
    finally { setBusy(null); }
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(await invoke('agents_prompt'));
      toast({ kind: 'success', text: 'Prompt copied', detail: 'Paste it into your agent’s instructions (AGENTS.md, Cursor rules, custom instructions).' });
    } catch (e) { toastError(e, "Couldn't copy the prompt"); }
  };
  const anyOn = () => !!st()?.agents.some((a) => a.installed);
  const ready = () => !!st()?.mxPath;
  return (
    <Show when={IS_TAURI} fallback={<div class="field-hint">Available in the desktop app.</div>}>
      <div class="win-hero" classList={{ on: anyOn() }}>
        <div class="win-hero-icon"><Icon name={anyOn() ? 'check' : 'bolt'} size={22} /></div>
        <div class="win-hero-text">
          <div class="win-hero-title">Instant file search for AI agents</div>
          <div class="field-hint">The <code>mx</code> command lets coding agents find any file on this PC by name in milliseconds, from the same index as this app's search. It works even when MyExplorer is closed.</div>
        </div>
      </div>
      <Show when={st() && !ready()}>
        <div class="win-note"><Icon name="alert" size={14} /><span>mx.exe wasn't found next to MyExplorer. Reinstall MyExplorer to get it.</span></div>
      </Show>
      <Show when={st()?.devBuild && ready()}>
        <div class="win-note"><Icon name="info" size={14} /><span>This is a development build. Skills installed here point to {st()?.mxPath}.</span></div>
      </Show>
      <For each={st()?.agents ?? []}>{(a) => (
        <Field label={a.name} hint={a.installed ? (a.current ? `Skill installed: ${a.skillPath}` : 'Skill is from another version. Turn off and on to update it.') : a.detected ? 'Adds the mx skill, so the agent uses mx on its own when it needs to find files' : 'Not detected on this PC'}>
          <Toggle label={a.name} value={a.installed} onChange={(v) => { if (!busy() && ready() && (a.detected || !v)) set(a.id, v); }} />
        </Field>
      )}</For>
      <Field label="Other agents" hint="Cursor, Copilot, ChatGPT and others: paste this into the agent’s instructions or AGENTS.md">
        <button class="btn btn-text btn-outline" disabled={!ready()} onClick={copyPrompt}><Icon name="copy" size={14} />Copy prompt</button>
      </Field>
      <Field label={<><code>mx</code> in terminals</>} hint={st()?.onPath ? 'On your user PATH. Terminals opened before this change need a restart.' : 'Adds MyExplorer’s folder to your user PATH so agents (and you) can type mx anywhere'}>
        <Toggle label="mx in terminals" value={!!st()?.onPath} onChange={(v) => { if (!busy() && ready()) set('path', v); }} />
      </Field>
    </Show>
  );
}

const REPO = 'https://github.com/SurviveANDcraft/MyExplorer';
function About() {
  const s = updateState;
  const openUrl = (url: string) => attempt(invoke('open', { path: url }), "Couldn't open the link");
  const status = () => {
    const x = s();
    switch (x.phase) {
      case 'checking': return 'Checking for updates…';
      case 'available': return `Version ${x.next} is available`;
      case 'uptodate': return 'You’re up to date';
      case 'downloading': return 'Downloading the update…';
      case 'installing': return 'Installing the update…';
      case 'error': return 'Couldn’t check for updates. Are you offline?';
      case 'unsupported': return 'Updates are off in development builds';
      default: return 'Checks automatically at startup and every few hours';
    }
  };
  return (
    <>
      <Field label="MyExplorer" hint={s().current ? `Version ${s().current}` : undefined}>
        <span class="field-hint">MIT License</span>
      </Field>
      <Field label="Updates" hint={status()}>
        <Show when={s().phase === 'available'} fallback={
          <button class="btn btn-text btn-outline" disabled={s().phase === 'unsupported' || s().phase === 'checking' || s().phase === 'downloading' || s().phase === 'installing'}
            onClick={() => void checkForUpdate()}>Check for updates</button>}>
          <button class="btn btn-text btn-outline btn-accent" onClick={() => void installUpdate()}>Update now</button>
        </Show>
      </Field>
      <Field label="Open source" hint="Source code, license, privacy and the licenses of the components MyExplorer uses">
        <div class="about-links">
          <button class="btn btn-text btn-outline" onClick={() => openUrl(REPO)}>Source code</button>
          <button class="btn btn-text btn-outline" onClick={() => openUrl(`${REPO}/blob/main/PRIVACY.md`)}>Privacy</button>
          <button class="btn btn-text btn-outline" disabled={!IS_TAURI} onClick={() => attempt(invoke('open_notices'), "Couldn't open the notices")}>Third-party licenses</button>
        </div>
      </Field>
    </>
  );
}

// ── Shortcut validation ──────────────────────────────────────────────────────
const VK: Record<string, number> = {
  Enter: 13, Space: 32, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, '`': 0xc0, ',': 0xbc, '.': 0xbe, '/': 0xbf, '\\': 0xdc, '-': 0xbd, '=': 0xbb,
  '[': 0xdb, ']': 0xdd, ';': 0xba, "'": 0xde, ContextMenu: 0x5d,
};
function chordToHotkey(chord: string): { mods: number; vk: number } | null {
  const parts = chord.split('+');
  const key = parts.pop()!;
  let mods = 0;
  for (const m of parts) mods |= m === 'Alt' ? 1 : m === 'Ctrl' ? 2 : m === 'Shift' ? 4 : m === 'Win' ? 8 : 0;
  let vk = VK[key] ?? 0;
  if (!vk && /^[A-Z0-9]$/.test(key)) vk = key.charCodeAt(0);
  if (!vk && /^F([1-9]|1[0-9]|2[0-4])$/.test(key)) vk = 111 + Number(key.slice(1));
  return vk ? { mods, vk } : null;
}
const RESERVED = new Set(['Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Tab', 'Alt+Escape', 'Ctrl+Escape', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape', 'Alt+Space', 'PrintScreen', 'Alt+PrintScreen']);
/** Why a chord can't be used, or null if it can. */
async function blockedReason(id: string, chord: string): Promise<string | null> {
  if (chord.split('+').includes('Win')) return 'Windows reserves Win-key shortcuts.';
  if (RESERVED.has(chord) || (chord === 'Alt+F4' && id !== 'app.quit')) return 'Windows uses this shortcut itself.';
  const key = chord.split('+').pop()!;
  const mods = chord.split('+').length - 1;
  if ((mods === 0 || chord.startsWith('Shift+') && mods === 1) && (key.length === 1 || key === 'Space') && id !== 'item.quickLook')
    return 'Single keys type to select files. Add Ctrl or Alt.';
  const hk = IS_TAURI ? chordToHotkey(chord) : null;
  if (hk && (hk.mods & 3) && !(await invoke('hotkey_free', hk).catch(() => true))) return 'Another app has taken this as a global shortcut, so MyExplorer would never receive it.';
  return null;
}

function Keyboard() {
  const [filter, setFilter] = createSignal('');
  const [recording, setRecording] = createSignal<string | null>(null);
  const [conflict, setConflict] = createSignal<{ id: string; chord: string; others: string[]; blocked?: string } | null>(null);
  const cmds = createMemo(() => {
    const f = filter().toLowerCase();
    return allCommands().filter((c) => !f || c.label.toLowerCase().includes(f) || c.category.toLowerCase().includes(f) || chordsFor(c.id).some((k) => k.toLowerCase().includes(f)));
  });
  const groups = createMemo(() => {
    const m = new Map<string, Command[]>();
    for (const c of cmds()) { const l = m.get(c.category) ?? []; l.push(c); m.set(c.category, l); }
    return [...m];
  });
  const setKeys = (id: string, keys: string[]) => {
    const def = defaultChords(id);
    const same = keys.length === def.length && keys.every((k, i) => k === def[i]);
    setSettings('keys', id, same ? undefined! : keys);
  };
  const apply = (id: string, chord: string, replace: boolean) => {
    if (replace) for (const o of commandsForChord(chord)) if (o !== id) setKeys(o, chordsFor(o).filter((k) => k !== chord));
    if (!chordsFor(id).includes(chord)) setKeys(id, [...chordsFor(id), chord]);
    setConflict(null);
  };
  const onKey = (e: KeyboardEvent) => {
    const id = recording();
    if (!id) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stop(); return; }
    const chord = eventChord(e);
    if (!chord) return;
    stop();
    blockedReason(id, chord).then((blocked) => {
      if (blocked) { setConflict({ id, chord, others: [], blocked }); return; }
      const others = commandsForChord(chord).filter((o) => o !== id);
      if (others.length) setConflict({ id, chord, others });
      else apply(id, chord, false);
    });
  };
  const start = (id: string) => { setConflict(null); setRecording(id); keyCapture.active = true; window.addEventListener('keydown', onKey, true); };
  function stop() { setRecording(null); keyCapture.active = false; window.removeEventListener('keydown', onKey, true); }
  onCleanup(stop);
  return (
    <>
      <div class="kb-tools">
        <div class="kb-search"><Icon name="search" size={14} /><input placeholder="Filter commands or shortcuts" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} /></div>
        <button class="btn btn-text btn-outline" disabled={!Object.keys(settings.keys).length} onClick={() => setSettings('keys', {})}>Reset all</button>
      </div>
      <For each={groups()}>{([cat, list]) => (
        <div class="kb-group">
          <div class="kb-cat">{cat}</div>
          <For each={list}>{(c) => (
            <div class="kb-row" classList={{ rec: recording() === c.id }}>
              <span class="kb-label">{c.label}</span>
              <span class="kb-keys">
                <For each={chordsFor(c.id)}>{(k) => (
                  <span class="kbd-chip">{prettyChord(k)}<button aria-label={`Remove ${k}`} onClick={() => setKeys(c.id, chordsFor(c.id).filter((x) => x !== k))}><Icon name="close" size={10} /></button></span>
                )}</For>
                <Show when={recording() === c.id} fallback={<button class="kb-add" onClick={() => start(c.id)} aria-label="Add shortcut"><Icon name="plus" size={12} /></button>}>
                  <span class="kbd-chip recording">Press keys… <span class="dim">Esc to cancel</span></span>
                </Show>
                <Show when={settings.keys[c.id]}>
                  <button class="kb-reset" data-tip="Reset to default" onClick={() => setSettings('keys', c.id, undefined!)}><Icon name="undo" size={12} /></button>
                </Show>
              </span>
              <Show when={conflict()?.id === c.id}>
                <div class="kb-conflict" classList={{ blocked: !!conflict()!.blocked }}>
                  <Icon name="alert" size={14} />
                  <Show when={conflict()!.blocked} fallback={<>
                    <span><b>{prettyChord(conflict()!.chord)}</b> is used by {conflict()!.others.map((o) => getCommand(o)?.label ?? o).join(', ')}.</span>
                    <button class="btn btn-text btn-sm btn-accent" onClick={() => apply(c.id, conflict()!.chord, true)}>Reassign</button>
                    <button class="btn btn-text btn-sm" onClick={() => apply(c.id, conflict()!.chord, false)}>Keep both</button>
                    <button class="btn btn-text btn-sm" onClick={() => setConflict(null)}>Cancel</button>
                  </>}>
                    <span><b>{prettyChord(conflict()!.chord)}</b> can't be used. {conflict()!.blocked}</span>
                    <button class="btn btn-text btn-sm" onClick={() => setConflict(null)}>OK</button>
                  </Show>
                </div>
              </Show>
            </div>
          )}</For>
        </div>
      )}</For>
    </>
  );
}

type Section = 'appearance' | 'behavior' | 'keyboard' | 'windows' | 'agents' | 'about';

export function SettingsDialog() {
  let panel!: HTMLDivElement;
  const [section, setSection] = createSignal<Section>('appearance');
  const close = () => { setSettingsOpen(false); queueMicrotask(() => viewApi.focus()); };
  onMount(() => { popIn(panel); panel.focus(); });
  const nav: [Section, string, Parameters<typeof Icon>[0]['name']][] = [
    ['appearance', 'Appearance', 'palette'], ['behavior', 'Behavior', 'settings'], ['keyboard', 'Keyboard', 'keyboard'], ['windows', 'Windows', 'windows'], ['agents', 'AI agents', 'terminal'], ['about', 'About', 'info'],
  ];
  return (
    <div class="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="settings pop" ref={panel} role="dialog" aria-label="Settings" tabindex="-1" data-modal
        onKeyDown={(e) => { if (e.key === 'Escape' && !keyCapture.active) { e.preventDefault(); close(); } }}>
        <aside class="st-nav">
          <div class="st-title">Settings</div>
          <For each={nav}>{([id, label, icon]) => (
            <button class="st-nav-item" classList={{ on: section() === id }} onClick={() => setSection(id)}><Icon name={icon} />{label}</button>
          )}</For>
        </aside>
        <section class="st-body">
          <div class="st-head">
            <h2>{nav.find((n) => n[0] === section())![1]}</h2>
            <button class="btn btn-icon" aria-label="Close settings" onClick={close}><Icon name="close" /></button>
          </div>
          <div class="st-content">
            <Show when={section() === 'appearance'}><Appearance /></Show>
            <Show when={section() === 'behavior'}><Behavior /></Show>
            <Show when={section() === 'keyboard'}><Keyboard /></Show>
            <Show when={section() === 'windows'}><Windows /></Show>
            <Show when={section() === 'agents'}><Agents /></Show>
            <Show when={section() === 'about'}><About /></Show>
          </div>
        </section>
      </div>
    </div>
  );
}
