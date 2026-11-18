import { createMemo, createSignal, For, JSX, onCleanup, onMount, Show } from 'solid-js';
import { setShowHidden } from '../commands/actions';
import { allCommands, chordsFor, Command, commandsForChord, defaultChords, eventChord, getCommand, keyCapture, prettyChord } from '../commands/registry';
import type { SortKey } from '../ipc/types';
import { Icon } from '../lib/icons';
import { popIn } from '../lib/motion';
import { ACCENTS, setSettings, settings } from '../state/settings';
import { currentDir } from '../state/tabs';
import { setSettingsOpen, viewApi } from '../state/ui';

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
function Field(p: { label: string; hint?: string; children: JSX.Element }) {
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
    </>
  );
}

function Keyboard() {
  const [filter, setFilter] = createSignal('');
  const [recording, setRecording] = createSignal<string | null>(null);
  const [conflict, setConflict] = createSignal<{ id: string; chord: string; others: string[] } | null>(null);
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
    const others = commandsForChord(chord).filter((o) => o !== id);
    if (others.length) setConflict({ id, chord, others });
    else apply(id, chord, false);
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
                <div class="kb-conflict">
                  <Icon name="alert" size={14} />
                  <span><b>{prettyChord(conflict()!.chord)}</b> is used by {conflict()!.others.map((o) => getCommand(o)?.label ?? o).join(', ')}.</span>
                  <button class="btn btn-text btn-sm btn-accent" onClick={() => apply(c.id, conflict()!.chord, true)}>Reassign</button>
                  <button class="btn btn-text btn-sm" onClick={() => apply(c.id, conflict()!.chord, false)}>Keep both</button>
                  <button class="btn btn-text btn-sm" onClick={() => setConflict(null)}>Cancel</button>
                </div>
              </Show>
            </div>
          )}</For>
        </div>
      )}</For>
    </>
  );
}

export function SettingsDialog() {
  let panel!: HTMLDivElement;
  const [section, setSection] = createSignal<'appearance' | 'behavior' | 'keyboard'>('appearance');
  const close = () => { setSettingsOpen(false); queueMicrotask(() => viewApi.focus()); };
  onMount(() => { popIn(panel); panel.focus(); });
  const nav: ['appearance' | 'behavior' | 'keyboard', string, Parameters<typeof Icon>[0]['name']][] = [
    ['appearance', 'Appearance', 'palette'], ['behavior', 'Behavior', 'settings'], ['keyboard', 'Keyboard', 'keyboard'],
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
          </div>
        </section>
      </div>
    </div>
  );
}
