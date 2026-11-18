import { createMemo, createRoot, createSignal } from 'solid-js';
import type { IconName } from '../lib/icons';
import { settings } from '../state/settings';

export interface Command {
  id: string;
  label: string;
  category: string;
  keys?: string[];          // default chords, e.g. "Ctrl+Shift+N"
  icon?: IconName;
  run: () => void;
  enabled?: () => boolean;
  /** Fire even while focus is in a text input. */
  inInput?: boolean;
  /** Hide from the command palette. */
  hidden?: boolean;
}

const commands = new Map<string, Command>();
const [regV, setRegV] = createSignal(0);
export const register = (list: Command[]) => { list.forEach((c) => commands.set(c.id, c)); setRegV((v) => v + 1); };
export const getCommand = (id: string) => commands.get(id);
export const allCommands = () => [...commands.values()];

export const chordsFor = (id: string): string[] => settings.keys[id] ?? commands.get(id)?.keys ?? [];
export const defaultChords = (id: string): string[] => commands.get(id)?.keys ?? [];

const keymap = createRoot(() => createMemo(() => {
  const m = new Map<string, string[]>();
  regV();
  void JSON.stringify(settings.keys);
  for (const c of commands.values()) for (const k of chordsFor(c.id)) {
    const arr = m.get(k) ?? [];
    arr.push(c.id);
    m.set(k, arr);
  }
  return m;
}));
export const commandsForChord = (chord: string) => keymap().get(chord) ?? [];

export function runCommand(id: string) {
  const c = commands.get(id);
  if (!c || (c.enabled && !c.enabled())) return false;
  c.run();
  return true;
}

// ── Chords ───────────────────────────────────────────────────────────────────
const CODE_KEYS: Record<string, string> = {
  Backquote: '`', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Space: 'Space',
};
export function eventChord(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta' || k === 'AltGraph' || k === 'Dead' || k === 'Unidentified') return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^(Digit|Numpad)[0-9]$/.test(e.code)) key = e.code.slice(-1);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = k.length === 1 ? k.toUpperCase() : k;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean);
  return [...mods, key].join('+');
}
const PRETTY: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Delete: 'Del', Escape: 'Esc', Backspace: 'Backspace', PageUp: 'PgUp', PageDown: 'PgDn' };
export const prettyChord = (c: string) => c.split('+').map((p) => PRETTY[p] ?? p).join('+');
export const shortcutLabel = (id: string) => { const c = chordsFor(id)[0]; return c ? prettyChord(c) : ''; };
export const tip = (id: string, label?: string) => {
  const s = shortcutLabel(id);
  return `${label ?? commands.get(id)?.label ?? id}${s ? `  (${s})` : ''}`;
};

function inEditable(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
/** True while a modal key recorder owns the keyboard. */
export const keyCapture = { active: false };

export function handleGlobalKey(e: KeyboardEvent) {
  if (e.defaultPrevented || keyCapture.active || e.isComposing) return;
  const chord = eventChord(e);
  if (!chord) return;
  const el = e.target as HTMLElement | null;
  const editable = inEditable(el) || !!el?.closest?.('[data-modal]') || (el?.tagName === 'BUTTON' && (chord === 'Enter' || chord === 'Space'));
  for (const id of commandsForChord(chord)) {
    const c = commands.get(id)!;
    if (editable && !c.inInput) continue;
    if (c.enabled && !c.enabled()) continue;
    e.preventDefault();
    e.stopPropagation();
    c.run();
    return;
  }
  // Block WebView defaults that would break the app shell.
  if (/^(Ctrl\+(P|R|F|G|J|U|S|O|N|Shift\+I)|F5|F7|Ctrl\+F5|F12)$/.test(chord) && !editable) e.preventDefault();
}
