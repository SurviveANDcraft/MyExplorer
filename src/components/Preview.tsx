import { createEffect, createResource, createSignal, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { fileSrc, invoke } from '../ipc/invoke';
import type { AppError } from '../ipc/types';
import { fmtDateLong, fmtSize, isCloud, isDir, previewKind } from '../lib/fs';
import { Icon } from '../lib/icons';
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

export function Preview(p: { item: PreviewTarget; mode: 'pane' | 'look' }) {
  const kind = () => previewKind(p.item.name, p.item.flags);
  const cloud = () => isCloud(p.item.flags);
  const src = () => (cloud() || isDir(p.item.flags) ? null : fileSrc(p.item.path));
  const [info] = createResource(() => p.item.path, async (path) => {
    try { return (await invoke('stat', { paths: [path] }))[0] ?? null; }
    catch (e) { toastError(e, "Couldn't read file details"); return null; }
  });
  const [text] = createResource(() => (!cloud() && kind() === 'text' ? p.item.path : null), async (path) => {
    try { return await invoke('read_text', { path, maxBytes: p.mode === 'look' ? 512 * 1024 : 64 * 1024 }); }
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
