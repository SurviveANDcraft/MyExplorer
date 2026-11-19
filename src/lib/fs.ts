import { Flag } from '../ipc/types';
import { langFor } from './langs';

export const isDir = (f: number) => (f & Flag.Dir) !== 0;
export const isCloud = (f: number) => (f & Flag.Cloud) !== 0;
export const isHidden = (f: number) => (f & (Flag.Hidden | Flag.System)) !== 0;

export function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
export function stemLength(name: string, dir: boolean) {
  if (dir) return name.length;
  const i = name.lastIndexOf('.');
  return i > 0 ? i : name.length;
}

const ROOT = /^[A-Za-z]:\\?$/;
export const isRoot = (p: string) => ROOT.test(p);
export const join = (dir: string, name: string) => (dir.endsWith('\\') ? dir + name : dir + '\\' + name);
export function parentOf(p: string): string | null {
  if (isRoot(p)) return null;
  const i = p.lastIndexOf('\\');
  if (i < 0) return null;
  return i === 2 ? p.slice(0, 3) : p.slice(0, i);
}
export function baseName(p: string) {
  if (isRoot(p)) return p.slice(0, 2);
  return p.slice(p.lastIndexOf('\\') + 1);
}
export function normPath(input: string): string {
  let p = input.trim().replace(/^"|"$/g, '').replace(/\//g, '\\');
  if (/^[A-Za-z]:$/.test(p)) p += '\\';
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  while (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1);
  return p;
}
export const samePath = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const isInside = (child: string, dir: string) => (child.toLowerCase() + '\\').startsWith(join(dir, '').toLowerCase());

export function segments(p: string): { name: string; path: string }[] {
  const parts = p.split('\\').filter(Boolean);
  const out: { name: string; path: string }[] = [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? join(acc, part) : part + '\\';
    out.push({ name: part, path: acc });
  }
  return out;
}

const num = new Intl.NumberFormat();
export const fmtCount = (n: number) => num.format(n);
export function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
export function fmtDate(ms: number) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = today.getTime();
  if (ms >= t) return `Today, ${timeFmt.format(d)}`;
  if (ms >= t - 864e5) return `Yesterday, ${timeFmt.format(d)}`;
  return `${dateFmt.format(d)}, ${timeFmt.format(d)}`;
}
const longFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });
export const fmtDateLong = (ms: number) => (ms ? longFmt.format(new Date(ms)) : '—');

export type Kind = 'folder' | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'code' | 'archive' | 'doc' | 'sheet' | 'slides' | 'exe' | 'font' | 'link' | 'file';
const KIND: Record<string, Kind> = {};
const reg = (k: Kind, exts: string) => exts.split(' ').forEach((e) => (KIND[e] = k));
reg('image', 'jpg jpeg png gif webp bmp svg ico heic avif tif tiff');
reg('video', 'mp4 mov mkv avi webm wmv m4v');
reg('audio', 'mp3 flac m4a wav ogg aac wma opus');
reg('pdf', 'pdf');
reg('text', 'txt md log ini cfg csv tsv nfo rtf');
reg('code', 'ts tsx js jsx mjs json css scss html htm xml yml yaml toml rs py go c h cpp hpp cs java kt rb php sh ps1 bat sql lua vue svelte gitignore');
reg('archive', 'zip 7z rar gz tar xz iso cab');
reg('doc', 'doc docx odt pages');
reg('sheet', 'xls xlsx ods numbers');
reg('slides', 'ppt pptx odp key');
reg('exe', 'exe msi bat cmd com appx msix');
reg('font', 'ttf otf woff woff2');
reg('link', 'lnk url');
export const kindOf = (name: string, flags: number): Kind => (isDir(flags) ? 'folder' : KIND[extOf(name)] ?? 'file');
export const previewKind = (name: string, flags: number) => {
  const k = kindOf(name, flags);
  if (k === 'folder' || k === 'image') return k;
  if (langFor(name)) return 'code';
  return k === 'text' || k === 'code' ? 'text' : k;
};
