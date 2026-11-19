import { JSX, splitProps } from 'solid-js';

const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="1.3" fill="currentColor" stroke="none"/>`;
const folder = 'M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z';
const file = 'M6.5 3.5h7l4 4v11a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM13.5 3.5v4h4';
const p = (d: string) => `<path d="${d}"/>`;

const ICONS = {
  back: p('M19 12H5M11 6l-6 6 6 6'),
  forward: p('M5 12h14M13 6l6 6-6 6'),
  up: p('M12 19V5M6 11l6-6 6 6'),
  refresh: p('M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4'),
  search: '<circle cx="11" cy="11" r="6.5"/>' + p('M20 20l-4.2-4.2'),
  globe: '<circle cx="12" cy="12" r="8.5"/>' + p('M3.5 12h17M12 3.5c2.3 2.5 3.4 5.3 3.4 8.5s-1.1 6-3.4 8.5c-2.3-2.5-3.4-5.3-3.4-8.5s1.1-6 3.4-8.5z'),
  folder: p(folder),
  folderPlus: p(folder) + p('M12 10.5v5M9.5 13h5'),
  folderMove: p(folder) + p('M8.5 13h6.5M12.5 10.5L15 13l-2.5 2.5'),
  folderCopy: p(folder) + p('M12 10.5v5M9.5 13h5'),
  file: p(file),
  filePlus: p(file) + p('M12 11v6M9 14h6'),
  fileText: p(file) + p('M9 12.5h6M9 16h4'),
  fileSearch: p('M10.5 20.5h-4a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h7l4 4v3.5M13.5 3.5v4h4') + '<circle cx="15.5" cy="15.5" r="3"/>' + p('M20 20l-2.3-2.3'),
  archive: '<rect x="3.5" y="4.5" width="17" height="4" rx="1.2"/>' + p('M5 8.5v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12h4'),
  unarchive: '<rect x="3.5" y="4.5" width="17" height="4" rx="1.2"/>' + p('M5 8.5v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M12 17.5v-6M9.5 14l2.5-2.5 2.5 2.5'),
  windows: p('M4 5.5l7-1v7H4zM13 4.2l7-1v8.3h-7zM4 12.5h7v7l-7-1zM13 12.5h7v8.3l-7-1z'),
  caseSensitive: p('M3.5 17l3.5-10 3.5 10M4.8 13.5h4.4') + '<circle cx="16.5" cy="14.5" r="2.7"/>' + p('M19.2 11.5v5.5'),
  wholeWord: p('M3.5 16v2.5h17V16') + p('M6.5 14l2-7 2 7M7.1 12h2.8M13.5 7v7M13.5 11.5a2.3 2.3 0 1 1 0 .1'),
  regex: p('M16.5 4v7M13.5 5.8l6 3.4M19.5 5.8l-6 3.4') + '<rect x="4.5" y="14.5" width="5" height="5" rx="1"/>',
  cut: '<circle cx="6.5" cy="17" r="2.5"/><circle cx="17.5" cy="17" r="2.5"/>' + p('M8.3 15.2L18 4.5M15.7 15.2L6 4.5'),
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/>' + p('M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2'),
  paste: p('M8.5 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1.5') + '<rect x="8.5" y="3.5" width="7" height="3.5" rx="1"/>',
  rename: p('M4.5 19.5h4l10.3-10.3a2.8 2.8 0 0 0-4-4L4.5 15.5zM13.5 6.5l4 4'),
  trash: p('M4.5 6.5h15M9.5 6.5v-2h5v2M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12M10 10.5v6M14 10.5v6'),
  sort: p('M7.5 4.5v15M4 16l3.5 3.5L11 16M16.5 19.5v-15M13 8l3.5-3.5L20 8'),
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  details: p('M9 6.5h11M9 12h11M9 17.5h11') + dot(4.8, 6.5) + dot(4.8, 12) + dot(4.8, 17.5),
  list: '<rect x="3.5" y="4.5" width="7" height="6" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="6" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="6" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="6" rx="1.5"/>',
  more: dot(5.5, 12) + dot(12, 12) + dot(18.5, 12),
  preview: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/>' + p('M14.5 4.5v15'),
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/>' + p('M9.5 4.5v15'),
  close: p('M6.5 6.5l11 11M17.5 6.5l-11 11'),
  plus: p('M12 5v14M5 12h14'),
  chevronRight: p('M10 6.5l5.5 5.5-5.5 5.5'),
  chevronDown: p('M6.5 10l5.5 5.5 5.5-5.5'),
  chevronUp: p('M6.5 14.5L12 9l5.5 5.5'),
  home: p('M4.5 10.5L12 4.5l7.5 6V18.5a1.5 1.5 0 0 1-1.5 1.5H15v-5.5H9V20H6a1.5 1.5 0 0 1-1.5-1.5z'),
  pin: p('M9 4.5h6l-1 5.5 3.5 3.5h-11L10 10zM12 13.5v6'),
  clock: '<circle cx="12" cy="12" r="8.5"/>' + p('M12 7.5V12l3 2'),
  drive: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/>' + p('M3.5 13h17') + dot(7.2, 15.3),
  pc: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/>' + p('M9 20h6M12 16v4'),
  download: p('M12 4.5v11M7 10.5l5 5 5-5M5 19.5h14'),
  documents: p(file) + p('M9 12.5h6M9 16h6'),
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="9.5" r="1.6"/>' + p('M20.5 15.5L16 11l-8.5 8.5'),
  music: p('M9 17.5v-11l10-2v11') + '<circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/>' + p('M16 10.5l5-3v9l-5-3'),
  cloud: p('M7.5 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.7 3.7 3.7 0 0 1-.9 7.3z'),
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/>' + p('M7 9.5l3 2.5-3 2.5M12.5 15h4.5'),
  settings: p('M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9') + '<circle cx="15" cy="7.5" r="2"/><circle cx="9" cy="16.5" r="2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/>' + p('M12 11v5.5') + dot(12, 8),
  check: p('M5 12.5l4.5 4.5L19 7.5'),
  undo: p('M9 14L4.5 9.5 9 5M4.5 9.5H15a5 5 0 0 1 0 10h-3.5'),
  redo: p('M15 14l4.5-4.5L15 5M19.5 9.5H9a5 5 0 0 0 0 10h3.5'),
  bolt: p('M13 3.5L5.5 13.5h6l-1 7 8-10.5h-6z'),
  eye: p('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z') + '<circle cx="12" cy="12" r="2.8"/>',
  eyeOff: p('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z') + '<circle cx="12" cy="12" r="2.8"/>' + p('M4 4l16 16'),
  external: p('M14 4.5h5.5V10M19.5 4.5L11 13M17 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4'),
  tab: '<rect x="3.5" y="5" width="17" height="14" rx="2"/>' + p('M3.5 9.5h17M12 12v5M9.5 14.5h5'),
  link: p('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'),
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/>' + p('M8 14.5h8') + dot(6.5, 10) + dot(10, 10) + dot(14, 10) + dot(17.5, 10),
  alert: p('M10.3 4.8a2 2 0 0 1 3.4 0l7.2 12.5a2 2 0 0 1-1.7 3H4.8a2 2 0 0 1-1.7-3zM12 10v4') + dot(12, 17),
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/>' + p('M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5'),
  filter: p('M4 5.5h16l-6 7.5v5l-4 2v-7z'),
  star: p('M12 4.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2L12 16.3l-4.6 2.5.9-5.2-3.8-3.6 5.2-.7z'),
  selectAll: '<rect x="4" y="4" width="16" height="16" rx="3"/>' + p('M8 12.3l2.8 2.7L16 9.5'),
  palette: p('M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.5-1-2.6 0-1 .8-1.7 1.8-1.7h2.2a3.7 3.7 0 0 0 3.7-3.7C20.5 6.9 16.7 3.5 12 3.5z') + dot(7.8, 11.5) + dot(10, 7.6) + dot(14.5, 7.6),
  minus: p('M5 12h14'),
} as const;
export type IconName = keyof typeof ICONS;

export function Icon(props: { name: IconName; size?: number } & JSX.SvgSVGAttributes<SVGSVGElement>) {
  const [own, rest] = splitProps(props, ['name', 'size']);
  return (
    <svg class="ic" width={own.size ?? 16} height={own.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" innerHTML={ICONS[own.name]} {...rest} />
  );
}
