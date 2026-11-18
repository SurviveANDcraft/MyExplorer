import { createSignal, Show } from 'solid-js';
import { iconPathUrl, iconUrl, IconSize, thumbUrl } from '../ipc/invoke';
import { extOf, isCloud, isDir, Kind, kindOf } from '../lib/fs';

const PATH_EXT = new Set(['exe', 'lnk', 'ico', 'url', 'appx', 'msix', 'cur']);
const SIZES: IconSize[] = [16, 32, 48, 96, 256];
const fit = (px: number): IconSize => SIZES.find((s) => s >= px) ?? 256;

const KIND_COLOR: Partial<Record<Kind, string>> = {
  image: '#2e9d6a', video: '#8a5cf0', audio: '#e0538f', pdf: '#e0483e', code: '#3b82f6', archive: '#c58b2a', doc: '#2b6fd6',
  sheet: '#1d8f50', slides: '#d6612a', exe: '#68707d', font: '#7b5cff', link: '#0e9bb5', text: '#8b919b',
};

export function Glyph(p: { kind: Kind; size: number }) {
  return (
    <svg class="glyph" width={p.size} height={p.size} viewBox="0 0 32 32" aria-hidden="true">
      <Show when={p.kind === 'folder'} fallback={
        <>
          <path d="M8.5 3.5h10.8l6.2 6.2V26.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-21a2 2 0 0 1 2-2z" fill="var(--glyph-page)" stroke="var(--glyph-line)" />
          <path d="M19.3 3.5v4.2a2 2 0 0 0 2 2h4.2" fill="none" stroke="var(--glyph-line)" />
          <Show when={KIND_COLOR[p.kind]}>
            <rect x="9.5" y="19" width="9" height="5" rx="1.5" fill={KIND_COLOR[p.kind]} />
          </Show>
        </>
      }>
        <path d="M3 8a2 2 0 0 1 2-2h6.6l2.6 2.6H27a2 2 0 0 1 2 2V24a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="var(--folder-back)" />
        <path d="M3 12.2a2 2 0 0 1 2-2h22a2 2 0 0 1 2 2V24a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="var(--folder-front)" />
      </Show>
    </svg>
  );
}

/** `extOnly`: flags are unknown (may be a cloud placeholder) — never touch the file itself. */
export function FileIcon(p: { name: string; flags: number; path: string; size: number; thumb?: boolean; modified?: number; byPath?: boolean; extOnly?: boolean }) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const src = () => {
    const s = fit(p.size * (window.devicePixelRatio || 1));
    const f = p.flags;
    if (p.byPath) return iconPathUrl(p.path, s);
    if (isDir(f)) return iconUrl(':dir', s);
    if (isCloud(f) || p.extOnly) return iconUrl(extOf(p.name), s);
    if (p.thumb) return thumbUrl(p.path, s, p.modified ?? 0);
    const ext = extOf(p.name);
    return PATH_EXT.has(ext) ? iconPathUrl(p.path, s) : iconUrl(ext, s);
  };
  return (
    <Show when={src() !== null && src() !== failed()} fallback={<Glyph kind={kindOf(p.name, p.flags)} size={p.size} />}>
      <img class="ficon" src={src()!} width={p.size} height={p.size} loading="lazy" decoding="async" draggable={false} alt=""
        onError={() => setFailed(src())} />
    </Show>
  );
}
