import { createEffect, createResource, createSignal, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { fileSrc, invoke } from '../ipc/invoke';
import type { AppError } from '../ipc/types';
import { fmtDateLong, fmtSize, isCloud, isDir, previewKind } from '../lib/fs';
import { Icon } from '../lib/icons';
import { LANG_LABEL, langFor } from '../lib/langs';
import { toastError } from '../state/ui';
import { FileIcon } from './FileIcon';

export interface PreviewTarget { path: string; name: string; flags: number; modified: number }

let fontSeq = 0;
function FontSample(p: { src: string }) {
  const [family, setFamily] = createSignal<string | null>(null);
  createEffect(on(() => p.src, (src) => {
    const fam = `mx-preview-${++fontSeq}`;
    const face = new FontFace(fam, `url("${src}")`);
    face.load().then((f) => { document.fonts.add(f); setFamily(fam); }, () => setFamily(null));
    onCleanup(() => document.fonts.delete(face));
  }));
  return (
    <Show when={family()} fallback={<div class="pv-note">Loading font…</div>}>
      <div class="pv-font" style={{ 'font-family': `"${family()}"` }}>
        <div class="pv-font-big">Aa</div>
        <div>The quick brown fox jumps over the lazy dog</div>
        <div class="pv-font-small">ABCDEFGHIJKLMNOPQRSTUVWXYZ · abcdefghijklmnopqrstuvwxyz · 0123456789</div>
      </div>
    </Show>
  );
}

type Highlighter = typeof import('../lib/highlight');
let hl: Promise<Highlighter> | null = null;
const loadHighlighter = () => (hl ??= import('../lib/highlight'));

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Wrap every match of `re` inside `root`'s text in <mark> (DOM-level, so it works on highlighted HTML). */
function markText(root: HTMLElement, re: RegExp, cap = 4000) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { re.lastIndex = 0; if (re.test(n.nodeValue ?? '')) hits.push(n as Text); }
  let count = 0;
  for (const node of hits) {
    const text = node.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m && count < cap; m = re.exec(text)) {
      if (!m[0]) { re.lastIndex++; continue; }
      if (m.index > last) frag.append(text.slice(last, m.index));
      const mk = document.createElement('mark');
      mk.textContent = m[0];
      frag.append(mk);
      last = m.index + m[0].length;
      count++;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
    if (count >= cap) break;
  }
}

export function CodeView(p: { text: string; name: string; mode: 'pane' | 'look'; truncated: boolean; focusLine?: number; mark?: RegExp | null; foot?: boolean }) {
  const lang = () => langFor(p.name) ?? 'plaintext';
  const code = () => p.text.replace(/\r\n?/g, '\n');
  // Plain lines render instantly; the highlighted version swaps in once the grammar chunk is ready.
  const [lines, setLines] = createSignal<string[]>([]);
  createEffect(on([code, lang], ([c, l]) => {
    const plain = c.split('\n');
    if (plain.length > 1 && c.endsWith('\n')) plain.pop();
    setLines(plain.map(escHtml));
    let live = true;
    onCleanup(() => (live = false));
    loadHighlighter().then((m) => { if (live) setLines(m.highlightLines(c, l)); }, () => {});
  }));
  const html = () => lines().map((l) => `<div class="cl">${l || ' '}</div>`).join('');
  const gutter = () => String(lines().length).length;
  let scroller!: HTMLDivElement, body!: HTMLDivElement;
  let lastFocus = -1;
  createEffect(on([html, () => p.focusLine, () => p.mark], () => {
    if (p.mark) markText(body, new RegExp(p.mark.source, p.mark.flags.includes('g') ? p.mark.flags : p.mark.flags + 'g'));
    const f = p.focusLine ?? 0;
    const row = f > 0 ? (body.children[f - 1] as HTMLElement | undefined) : undefined;
    if (!row) return;
    row.classList.add('cl-focus');
    if (f !== lastFocus) {
      lastFocus = f;
      scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight * 0.36);
    }
  }));
  return (
    <div class="pv-code-wrap">
      <div class="pv-code hljs" ref={scroller} style={{ '--gw': `${Math.max(2, gutter())}ch` }}>
        <div class="pv-code-body" ref={body} innerHTML={html()} />
      </div>
      <Show when={p.foot !== false}><div class="pv-code-foot">
        <span class="pv-code-lang">{LANG_LABEL[lang()] ?? lang()}</span>
        <span class="num">{lines().length.toLocaleString()} {lines().length === 1 ? 'line' : 'lines'}</span>
        <Show when={p.truncated}><span class="pv-code-trunc">Showing the start of the file</span></Show>
      </div></Show>
    </div>
  );
}

export function Preview(p: { item: PreviewTarget; mode: 'pane' | 'look' }) {
  const kind = () => previewKind(p.item.name, p.item.flags);
  const cloud = () => isCloud(p.item.flags);
  const src = () => (cloud() || isDir(p.item.flags) ? null : fileSrc(p.item.path));
  const [info] = createResource(() => p.item.path, async (path) => {
    try { return (await invoke('stat', { paths: [path] }))[0] ?? null; }
    catch (e) { toastError(e, "Couldn't read file details"); return null; }
  });
  const maxBytes = () => (p.mode === 'look' ? 512 * 1024 : 64 * 1024);
  const [text] = createResource(() => (!cloud() && (kind() === 'text' || kind() === 'code') ? p.item.path : null), async (path) => {
    try { return await invoke('read_text', { path, maxBytes: maxBytes() }); }
    catch (e) { if ((e as AppError).code !== 'unsupported') toastError(e, "Couldn't read the file"); return null; }
  });
  const [mediaFailed, setMediaFailed] = createSignal<string | null>(null);
  const media = () => { const s = src(); return s && s !== mediaFailed() ? s : null; };

  const Fallback = () => (
    <div class="pv-icon">
      <FileIcon name={p.item.name} flags={p.item.flags} path={p.item.path} size={p.mode === 'look' ? 192 : 128} thumb={!cloud() && !isDir(p.item.flags)} modified={p.item.modified} />
      <Show when={cloud()}><div class="pv-note"><Icon name="cloud" size={14} />Online-only file. Preview is off so nothing gets downloaded.</div></Show>
    </div>
  );

  return (
    <div class={`preview preview-${p.mode}`}>
      <div class="pv-stage">
        <Switch fallback={<Fallback />}>
          <Match when={kind() === 'image' && media()}>
            <img class="pv-img" src={media()!} decoding="async" alt="" draggable={false} onError={() => setMediaFailed(media())} />
          </Match>
          <Match when={kind() === 'video' && media()}>
            <video class="pv-media" src={media()!} controls autoplay onError={() => setMediaFailed(media())} />
          </Match>
          <Match when={kind() === 'audio' && media()}>
            <div class="pv-audio"><Fallback /><audio src={media()!} controls autoplay onError={() => setMediaFailed(media())} /></div>
          </Match>
          <Match when={kind() === 'pdf' && media()}>
            <iframe class="pv-pdf" src={media()!} title={p.item.name} />
          </Match>
          <Match when={kind() === 'font' && media()}>
            <FontSample src={media()!} />
          </Match>
          <Match when={kind() === 'code' && text() != null}>
            <CodeView text={text()!} name={p.item.name} mode={p.mode} truncated={(info()?.size ?? 0) > maxBytes()} />
          </Match>
          <Match when={kind() === 'text' && text()}>
            <pre class="pv-text">{text()}</pre>
          </Match>
        </Switch>
      </div>
      <Show when={p.mode === 'pane'}>
        <div class="pv-meta">
          <div class="pv-name" title={p.item.name}>{p.item.name}</div>
          <Show when={info()}>{(i) => (
            <dl>
              <dt>Type</dt><dd>{i().typeName}</dd>
              <Show when={!isDir(i().flags)}><dt>Size</dt><dd class="num">{fmtSize(i().size)}</dd></Show>
              <dt>Modified</dt><dd class="num">{fmtDateLong(i().modified)}</dd>
              <dt>Created</dt><dd class="num">{fmtDateLong(i().created)}</dd>
              <Show when={i().target}><dt>Target</dt><dd class="pv-path">{i().target}</dd></Show>
              <dt>Location</dt><dd class="pv-path">{i().path}</dd>
            </dl>
          )}</Show>
        </div>
      </Show>
    </div>
  );
}
