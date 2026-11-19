// In-memory backend used when the UI runs in a plain browser (`pnpm dev` without Tauri).
import { Flag } from './types';
import type { AppError, DirListing, Drive, FileInfo, Frecent, SearchHit, Sort, Suggestion } from './types';

interface N { name: string; dir: boolean; size: number; mod: number; cre: number; flags: number; kids?: Map<string, N>; deny?: boolean }

let seed = 42;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const NOW = Date.now();
const DAY = 864e5;
const ago = (maxDays: number) => Math.floor(NOW - rnd() * maxDays * DAY);
const fail = (code: AppError['code'], message: string): never => { throw { code, message } satisfies AppError; };

const drives = new Map<string, N>();
function mkDir(parent: N | null, name: string, flags = 0): N {
  const n: N = { name, dir: true, size: 0, mod: ago(200), cre: ago(800), flags: flags | Flag.Dir, kids: new Map() };
  parent?.kids!.set(name.toLowerCase(), n);
  return n;
}
function mkFile(parent: N, name: string, size?: number, flags = 0): N {
  const n: N = { name, dir: false, size: size ?? Math.floor(rnd() * rnd() * 8e6) + 120, mod: ago(400), cre: ago(900), flags };
  parent.kids!.set(name.toLowerCase(), n);
  return n;
}

const USER = 'C:\\Users\\Alex';
(function build() {
  const c = mkDir(null, 'C:'); drives.set('c:', c);
  const d = mkDir(null, 'D:'); drives.set('d:', d);
  const users = mkDir(c, 'Users'); const me = mkDir(users, 'Alex'); mkDir(users, 'Public');
  mkDir(c, 'Program Files'); mkDir(c, 'Windows', Flag.System);
  mkDir(c, 'System Volume Information', Flag.Hidden | Flag.System).deny = true;
  mkFile(c, 'pagefile.sys', 8e9, Flag.Hidden | Flag.System);
  const desk = mkDir(me, 'Desktop');
  ['Notes.txt', 'MyExplorer.lnk', 'Project board.url', 'Todo.md'].forEach((n) => mkFile(desk, n));
  mkFile(desk, 'desktop.ini', 282, Flag.Hidden | Flag.System);
  const docs = mkDir(me, 'Documents');
  ['Quarterly report Q3.docx', 'Budget 2026.xlsx', 'Pitch deck.pptx', 'Contract - signed.pdf', 'Meeting notes.md', 'Ideas.txt', 'Résumé.pdf', 'Tax return 2025.pdf']
    .forEach((n) => mkFile(docs, n));
  const inv = mkDir(docs, 'Invoices');
  for (let i = 1; i <= 36; i++) mkFile(inv, `Invoice ${1000 + i * 7}.pdf`, 40e3 + Math.floor(rnd() * 3e5));
  const proj = mkDir(docs, 'Projects');
  for (const p of ['myexplorer', 'website', 'data-pipeline']) {
    const r = mkDir(proj, p);
    mkDir(r, '.git', Flag.Hidden); mkDir(r, 'node_modules');
    const src = mkDir(r, 'src');
    ['main.ts', 'App.tsx', 'store.ts', 'utils.ts', 'styles.css', 'index.html', 'worker.rs', 'parser.py'].forEach((n) => mkFile(src, n, 800 + Math.floor(rnd() * 3e4)));
    ['package.json', 'README.md', 'tsconfig.json', '.gitignore', 'Cargo.toml', 'LICENSE'].forEach((n) => mkFile(r, n, 300 + Math.floor(rnd() * 5e3)));
  }
  const locked = mkDir(docs, 'Locked'); locked.deny = true;
  mkDir(docs, 'Empty folder');
  const dl = mkDir(me, 'Downloads');
  ['VSCodeUserSetup-x64.exe', 'node-v22.11.0-x64.msi', 'photos-backup.zip', 'dataset.csv', 'Windows11.iso', 'paper-attention.pdf', 'font-inter.ttf', 'wallpaper-4k.jpg', 'podcast-ep42.mp3', 'archive.7z', 'logo.svg', 'statement-october.pdf']
    .forEach((n) => mkFile(dl, n, 1e5 + Math.floor(rnd() * 9e8)));
  const pics = mkDir(me, 'Pictures'); const shots = mkDir(pics, 'Screenshots'); const trips = mkDir(pics, 'Lisbon 2026');
  for (let i = 0; i < 48; i++) mkFile(pics, `IMG_${2040 + i * 3}.jpg`, 1.5e6 + rnd() * 6e6);
  for (let i = 0; i < 24; i++) mkFile(shots, `Screenshot 2026-${String(1 + (i % 11)).padStart(2, '0')}-${String(1 + i).padStart(2, '0')} 0930${i % 10}.png`, 2e5 + rnd() * 2e6);
  for (let i = 0; i < 30; i++) mkFile(trips, `DSC0${4100 + i}.heic`, 2e6 + rnd() * 4e6);
  const music = mkDir(me, 'Music');
  const artists = ['Nils Frahm', 'Bonobo', 'Floating Points', 'Jon Hopkins', 'Ólafur Arnalds'];
  for (let i = 0; i < 26; i++) mkFile(music, `${pick(artists)} - Track ${i + 1}.${pick(['mp3', 'flac', 'm4a'])}`, 4e6 + rnd() * 3e7);
  const vids = mkDir(me, 'Videos');
  ['Product demo.mp4', 'Birthday.mov', 'Screen recording 2026-11-02.mp4', 'Lecture 07.mkv'].forEach((n) => mkFile(vids, n, 5e7 + rnd() * 2e9));
  const od = mkDir(me, 'OneDrive'); const odDocs = mkDir(od, 'Documents'); const odPics = mkDir(od, 'Photos');
  for (let i = 0; i < 20; i++) mkFile(odDocs, `Shared doc ${i + 1}.${pick(['docx', 'xlsx', 'pdf', 'pptx'])}`, undefined, i % 3 ? Flag.Cloud : 0);
  for (let i = 0; i < 30; i++) mkFile(odPics, `Photo ${i + 1}.jpg`, 3e6, Flag.Cloud);
  mkDir(me, 'AppData', Flag.Hidden);
  const logs = mkDir(mkDir(c, 'Archive'), 'Logs (50,000 items)');
  const exts = ['log', 'txt', 'json', 'csv', 'gz', 'png', 'pdf'];
  for (let i = 0; i < 50000; i++) {
    const name = `${pick(['sensor', 'trace', 'event', 'audit', 'metrics'])}-${String(i).padStart(5, '0')}.${exts[i % exts.length]}`;
    logs.kids!.set(name, { name, dir: false, size: Math.floor(rnd() * 2e6), mod: ago(700), cre: ago(900), flags: 0 });
  }
  const proj2 = mkDir(d, 'Projects'); mkDir(d, 'Backups'); const media = mkDir(d, 'Media');
  for (let i = 0; i < 12; i++) mkDir(proj2, `Client ${String.fromCharCode(65 + i)}`);
  for (let i = 0; i < 18; i++) mkFile(media, `Clip ${i + 1}.mp4`, 2e8 + rnd() * 1e9);
})();

const splitPath = (p: string) => p.replace(/\//g, '\\').split('\\').filter(Boolean);
function resolve(path: string): N | null {
  const parts = splitPath(path);
  let n = drives.get((parts[0] ?? '').toLowerCase()) ?? null;
  for (let i = 1; n && i < parts.length; i++) n = n.kids?.get(parts[i].toLowerCase()) ?? null;
  return n;
}
function must(path: string): N {
  const n = resolve(path);
  if (!n) fail('not_found', `"${path}" could not be found.`);
  return n!;
}
const joinP = (d: string, n: string) => (d.endsWith('\\') ? d + n : d + '\\' + n);
const parentP = (p: string) => { const i = p.lastIndexOf('\\'); return i <= 2 ? p.slice(0, 3) : p.slice(0, i); };
const extOf = (n: string) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const listeners = new Map<string, Set<(p: unknown) => void>>();
export function on(ev: string, cb: (p: unknown) => void) {
  let s = listeners.get(ev); if (!s) listeners.set(ev, (s = new Set()));
  s.add(cb);
  return () => s!.delete(cb);
}
const changed = (...dirs: string[]) => setTimeout(() => dirs.forEach((path) => listeners.get('fs:changed')?.forEach((cb) => cb({ path }))), 100);

function sortKids(kids: N[], s: Sort) {
  const dir = s.desc ? -1 : 1;
  const by: (a: N, b: N) => number =
    s.key === 'size' ? (a, b) => a.size - b.size :
    s.key === 'modified' ? (a, b) => a.mod - b.mod :
    s.key === 'created' ? (a, b) => a.cre - b.cre :
    s.key === 'type' ? (a, b) => coll.compare(extOf(a.name), extOf(b.name)) : () => 0;
  kids.sort((a, b) => {
    if (s.foldersFirst && a.dir !== b.dir) return a.dir ? -1 : 1;
    return (by(a, b) || coll.compare(a.name, b.name)) * dir;
  });
}

const TYPES: Record<string, string> = {
  '': 'File', txt: 'Text Document', md: 'Markdown File', pdf: 'PDF Document', docx: 'Microsoft Word Document', xlsx: 'Microsoft Excel Worksheet',
  pptx: 'Microsoft PowerPoint Presentation', jpg: 'JPG File', png: 'PNG File', heic: 'HEIC File', svg: 'SVG Document', mp3: 'MP3 File', flac: 'FLAC File',
  m4a: 'M4A File', mp4: 'MP4 Video', mov: 'MOV File', mkv: 'MKV File', zip: 'Compressed (zipped) Folder', '7z': '7Z File', exe: 'Application',
  msi: 'Windows Installer Package', lnk: 'Shortcut', url: 'Internet Shortcut', ts: 'TypeScript File', tsx: 'TSX File', json: 'JSON Source File',
  css: 'CSS Source File', html: 'Microsoft Edge HTML Document', rs: 'Rust Source File', py: 'Python File', csv: 'Microsoft Excel CSV File',
  iso: 'Disc Image File', ttf: 'TrueType font file', log: 'Text Document', gz: 'GZ File', toml: 'TOML File', ini: 'Configuration settings', sys: 'System file',
};
const typeName = (ext: string) => TYPES[ext] ?? `${ext.toUpperCase()} File`;
const BINARY = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'jpg', 'png', 'heic', 'mp3', 'flac', 'm4a', 'mp4', 'mov', 'mkv', 'zip', '7z', 'exe', 'msi', 'iso', 'ttf', 'gz', 'sys']);
const KINDS: Record<string, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'svg', 'webp', 'bmp'], video: ['mp4', 'mov', 'mkv', 'avi', 'webm'], audio: ['mp3', 'flac', 'm4a', 'wav', 'ogg'],
  doc: ['pdf', 'docx', 'doc', 'xlsx', 'pptx', 'txt', 'md', 'csv'], code: ['ts', 'tsx', 'js', 'json', 'css', 'html', 'rs', 'py', 'toml'], archive: ['zip', '7z', 'gz', 'rar', 'iso'],
};

function walkAll(cb: (n: N, path: string) => void) {
  const rec = (n: N, path: string) => { for (const k of n.kids!.values()) { const p = joinP(path, k.name); cb(k, p); if (k.dir && !k.deny) rec(k, p); } };
  for (const d of drives.values()) rec(d, d.name + '\\');
}

function search(reqId: number, query: string, o: { scope: string | null; limit: number; offset: number; includeHidden: boolean }) {
  const t0 = performance.now();
  const terms: string[] = []; const filters: [string, string][] = [];
  for (const m of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const tok = (m[1] ?? m[2]).toLowerCase();
    const f = /^(ext|kind|size|modified):(.+)$/.exec(tok);
    if (f && m[2]) filters.push([f[1], f[2]]); else if (tok) terms.push(tok);
  }
  const scope = o.scope?.toLowerCase();
  const scored: SearchHit[] = [];
  walkAll((n, path) => {
    if (!o.includeHidden && n.flags & Flag.Hidden) return;
    const lp = path.toLowerCase(); const ln = n.name.toLowerCase();
    if (scope && !(lp.startsWith(scope.endsWith('\\') ? scope : scope + '\\'))) return;
    let score = 0;
    for (const t of terms) {
      const hay = t.includes('\\') || t.includes('/') ? lp : ln;
      const i = hay.indexOf(t.replace(/\//g, '\\'));
      if (i < 0) return;
      score += ln === t ? 100 : i === 0 ? 60 : /[\s._\-]/.test(hay[i - 1]) ? 40 : 20;
    }
    const ext = extOf(n.name);
    for (const [k, v] of filters) {
      if (k === 'ext' && !v.split(',').includes(ext)) return;
      if (k === 'kind' && !(v === 'folder' ? n.dir : v === 'file' ? !n.dir : KINDS[v]?.includes(ext))) return;
      if (k === 'modified') { const days = { today: 1, week: 7, month: 31, year: 365 }[v] ?? 1e9; if (NOW - n.mod > days * DAY) return; }
      if (k === 'size') { const m = /^([<>])(\d+(?:\.\d+)?)(kb|mb|gb)?$/.exec(v); if (m) { const b = +m[2] * ({ kb: 1e3, mb: 1e6, gb: 1e9 }[m[3] ?? ''] ?? 1); if (m[1] === '>' ? n.size <= b : n.size >= b) return; } }
    }
    if (!terms.length && !filters.length) return;
    score += 30 / (1 + ln.length / 8) + (n.dir ? 4 : 0) - (lp.includes('node_modules') || lp.includes('\\.git') ? 30 : 0);
    scored.push({ path, name: n.name, flags: n.flags, size: n.size, modified: n.mod, score });
  });
  scored.sort((a, b) => b.score - a.score || coll.compare(a.name, b.name));
  return { reqId, hits: scored.slice(o.offset, o.offset + o.limit), total: scored.length, terms, tookMs: Math.round(performance.now() - t0), partial: false };
}

function unique(parent: N, name: string) {
  if (!parent.kids!.has(name.toLowerCase())) return name;
  const e = extOf(name); const stem = e ? name.slice(0, -(e.length + 1)) : name;
  for (let i = 2; ; i++) { const c = `${stem} (${i})${e ? '.' + e : ''}`; if (!parent.kids!.has(c.toLowerCase())) return c; }
}
const clone = (n: N, name = n.name): N => ({ ...n, name, kids: n.kids && new Map([...n.kids].map(([k, v]) => [k, clone(v)])) });
const validName = (s: string) => { if (!s.trim() || /[\\/:*?"<>|]/.test(s)) fail('invalid_name', `"${s}" is not a valid file name.`); };

const undoStack: { desc: string; undo: () => void; redo: () => void }[] = [];
const redoStack: typeof undoStack = [];
const pushUndo = (desc: string, undo: () => void, redo: () => void) => { undoStack.push({ desc, undo, redo }); redoStack.length = 0; };

const frec = new Map<string, { isDir: boolean; count: number; last: number }>();
[[USER + '\\Documents', 9], [USER + '\\Downloads', 7], [USER + '\\Documents\\Projects\\myexplorer', 6], [USER + '\\Pictures\\Screenshots', 4], ['D:\\Projects', 3]]
  .forEach(([p, c], i) => frec.set(p as string, { isDir: true, count: c as number, last: NOW - i * 3600e3 }));
[[USER + '\\Documents\\Quarterly report Q3.docx', 5], [USER + '\\Documents\\Budget 2026.xlsx', 4], [USER + '\\Downloads\\paper-attention.pdf', 3], [USER + '\\Documents\\Meeting notes.md', 3], [USER + '\\Desktop\\Notes.txt', 2], [USER + '\\Pictures\\IMG_2043.jpg', 1]]
  .forEach(([p, c], i) => frec.set(p as string, { isDir: false, count: c as number, last: NOW - i * 5400e3 }));
const frecScore = (v: { count: number; last: number }) => v.count * Math.exp(-(NOW - v.last) / (14 * DAY));

let clipboard: { paths: string[]; cut: boolean } | null = null;
const delay = <T,>(v: T, ms = 4) => new Promise<T>((r) => setTimeout(() => r(v), ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handle(cmd: string, a: any): Promise<unknown> {
  switch (cmd) {
    case 'list_dir': {
      const n = must(a.path);
      if (!n.dir) fail('not_found', `"${a.path}" is not a folder.`);
      if (n.deny) fail('access_denied', `Access to "${a.path}" is denied.`);
      const kids = [...n.kids!.values()].filter((k) => a.showHidden || !(k.flags & Flag.Hidden));
      sortKids(kids, a.sort);
      const l: DirListing = { path: a.path, names: kids.map((k) => k.name), sizes: kids.map((k) => (k.dir ? 0 : k.size)), modified: kids.map((k) => k.mod), created: kids.map((k) => k.cre), flags: kids.map((k) => k.flags) };
      return delay(l, kids.length > 1000 ? 30 : 6);
    }
    case 'get_drives': return [
      { path: 'C:\\', label: 'Windows', fs: 'NTFS', kind: 'fixed', total: 1024e9, free: 312e9 },
      { path: 'D:\\', label: 'Data', fs: 'NTFS', kind: 'fixed', total: 2000e9, free: 1460e9 },
    ] satisfies Drive[];
    case 'get_known_folders': return { home: USER, desktop: USER + '\\Desktop', documents: USER + '\\Documents', downloads: USER + '\\Downloads', pictures: USER + '\\Pictures', music: USER + '\\Music', videos: USER + '\\Videos', onedrive: USER + '\\OneDrive' };
    case 'stat': return (a.paths as string[]).map((p): FileInfo => {
      const n = must(p);
      return { path: p, name: n.name, flags: n.flags, size: n.size, modified: n.mod, created: n.cre, accessed: n.mod, typeName: n.dir ? 'File folder' : typeName(extOf(n.name)), target: extOf(n.name) === 'lnk' ? 'C:\\Program Files\\MyExplorer\\MyExplorer.exe' : null };
    });
    case 'type_names': return (a.exts as string[]).map(typeName);
    case 'list_subdirs': {
      const n = must(a.path);
      if (n.deny) fail('access_denied', `Access to "${a.path}" is denied.`);
      return [...n.kids!.values()].filter((k) => k.dir && (a.showHidden || !(k.flags & Flag.Hidden))).map((k) => k.name).sort(coll.compare);
    }
    case 'dir_size': {
      const walk = (n: ReturnType<typeof must>): { size: number; files: number; folders: number; partial: boolean } => {
        let size = 0, files = 0, folders = 0;
        for (const c of n.kids?.values() ?? []) {
          if (c.dir) { folders++; const r = walk(c); size += r.size; files += r.files; folders += r.folders; } else { files++; size += c.size; }
        }
        return { size, files, folders, partial: false };
      };
      return walk(must(a.path));
    }
    case 'cancel_dir_size': return undefined;
    case 'take_launch': return null;
    case 'read_text': {
      const n = must(a.path); const e = extOf(n.name);
      if (n.flags & Flag.Cloud || BINARY.has(e)) fail('unsupported', 'No text preview for this file.');
      const body = e === 'json' ? '{\n  "name": "myexplorer",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": { "dev": "vite", "build": "tsc && vite build" }\n}\n'
        : ['ts', 'tsx', 'rs', 'py', 'css'].includes(e) ? `// ${n.name}\nexport function main(args: string[]): number {\n  const started = performance.now();\n  for (const a of args) console.log(a);\n  return Math.round(performance.now() - started);\n}\n`
        : `# ${n.name}\n\nThis is mock content for the in-browser preview.\n\n- Fast\n- Quiet\n- Precise\n`;
      return body.repeat(e === 'log' ? 30 : 1).slice(0, a.maxBytes);
    }
    case 'watch_dir': case 'unwatch_dir': case 'open': case 'open_with': case 'show_properties': case 'open_terminal': return null;
    case 'create_folder': case 'create_file': {
      const p = must(a.parent); validName(a.name);
      const name = unique(p, a.name);
      const n = cmd === 'create_folder' ? mkDir(p, name) : mkFile(p, name, 0);
      n.mod = n.cre = Date.now();
      pushUndo(`New ${n.dir ? 'folder' : 'file'} '${name}'`, () => p.kids!.delete(name.toLowerCase()), () => p.kids!.set(name.toLowerCase(), n));
      changed(a.parent);
      return joinP(a.parent, name);
    }
    case 'rename': {
      validName(a.newName);
      const dir = parentP(a.path); const p = must(dir); const n = must(a.path); const old = n.name;
      if (a.newName.toLowerCase() !== old.toLowerCase() && p.kids!.has(a.newName.toLowerCase())) fail('exists', `"${a.newName}" already exists.`);
      const ren = (from: string, to: string) => { p.kids!.delete(from.toLowerCase()); n.name = to; p.kids!.set(to.toLowerCase(), n); changed(dir); };
      ren(old, a.newName);
      pushUndo(`Rename '${old}'`, () => ren(a.newName, old), () => ren(old, a.newName));
      return joinP(dir, a.newName);
    }
    case 'delete': {
      const removed: [N, N][] = [];
      for (const path of a.paths as string[]) { const p = must(parentP(path)); const n = must(path); p.kids!.delete(n.name.toLowerCase()); removed.push([p, n]); }
      const dirs = [...new Set((a.paths as string[]).map(parentP))];
      changed(...dirs);
      if (!a.permanent) pushUndo(`Delete ${removed.length} item(s)`, () => { removed.forEach(([p, n]) => p.kids!.set(n.name.toLowerCase(), n)); changed(...dirs); }, () => { removed.forEach(([p, n]) => p.kids!.delete(n.name.toLowerCase())); changed(...dirs); });
      return null;
    }
    case 'transfer': {
      const dest = must(a.destDir); const out: string[] = []; const added: N[] = []; const moved: [N, N][] = [];
      for (const path of a.paths as string[]) {
        const n = must(path); const src = must(parentP(path));
        if (a.mode === 'move' && src === dest) continue;
        if ((a.destDir + '\\').toLowerCase().startsWith(path.toLowerCase() + '\\')) fail('invalid_name', `Can't put "${n.name}" inside itself.`);
        const name = unique(dest, n.name);
        if (a.mode === 'move') { src.kids!.delete(n.name.toLowerCase()); n.name = name; dest.kids!.set(name.toLowerCase(), n); moved.push([src, n]); }
        else { const c = clone(n, name); dest.kids!.set(name.toLowerCase(), c); added.push(c); }
        out.push(joinP(a.destDir, name));
      }
      const dirs = [a.destDir, ...new Set((a.paths as string[]).map(parentP))];
      changed(...dirs);
      pushUndo(`${a.mode === 'move' ? 'Move' : 'Copy'} ${out.length} item(s)`,
        () => { added.forEach((n) => dest.kids!.delete(n.name.toLowerCase())); moved.forEach(([s, n]) => { dest.kids!.delete(n.name.toLowerCase()); s.kids!.set(n.name.toLowerCase(), n); }); changed(...dirs); },
        () => { added.forEach((n) => dest.kids!.set(n.name.toLowerCase(), n)); moved.forEach(([s, n]) => { s.kids!.delete(n.name.toLowerCase()); dest.kids!.set(n.name.toLowerCase(), n); }); changed(...dirs); });
      return { destPaths: out };
    }
    case 'undo': case 'redo': {
      const from = cmd === 'undo' ? undoStack : redoStack; const to = cmd === 'undo' ? redoStack : undoStack;
      const e = from.pop(); if (!e) return null;
      (cmd === 'undo' ? e.undo : e.redo)(); to.push(e);
      return { description: e.desc };
    }
    case 'clipboard_write_files': clipboard = { paths: a.paths, cut: a.cut }; return null;
    case 'clipboard_read_files': return clipboard;
    case 'search': return search(a.reqId, a.query, a.options);
    case 'index_status': return { state: 'ready', entries: 50612, source: 'cache', roots: ['C:\\', 'D:\\'] };
    case 'record_visit': { const v = frec.get(a.path) ?? { isDir: a.isDir, count: 0, last: 0 }; v.count++; v.last = Date.now(); frec.set(a.path, v); return null; }
    case 'get_frecent': return [...frec].filter(([p, v]) => (a.kind === 'any' || v.isDir === (a.kind === 'dir')) && resolve(p))
      .map(([path, v]): Frecent => ({ path, isDir: v.isDir, score: frecScore(v), lastVisit: v.last })).sort((x, y) => y.score - x.score).slice(0, a.limit);
    case 'suggest_next': case 'suggest_destinations': {
      const skip = new Set<string>([a.dir, ...(a.paths ?? []).map(parentP)].filter(Boolean));
      return [...frec].filter(([p, v]) => v.isDir && !skip.has(p) && resolve(p)).sort((x, y) => frecScore(y[1]) - frecScore(x[1]))
        .slice(0, a.limit).map(([path], i): Suggestion => ({ path, reason: i < 2 ? 'history' : 'frecent' }));
    }
    case 'load_settings': try { return localStorage.getItem('myexplorer.settings'); } catch { return null; }
    case 'save_settings': try { localStorage.setItem('myexplorer.settings', a.json); } catch { /* ignore */ } return null;
    case 'shell_menu_open': return { session: 0, items: [] };
    case 'shell_menu_invoke': case 'shell_menu_close': return null;
    case 'drag_out': return 'none';
    case 'cancel_archive': case 'cancel_grep': return null;
    case 'compress': case 'extract': return fail('unsupported', 'Archives need the desktop app.');
    case 'grep': return fail('unsupported', 'Search in files needs the desktop app.');
    case 'integration_status': return { folders: false, winE: false, contextEntry: false, exe: '', stale: false, devBuild: true };
    case 'set_integration': return { ...a.state, exe: '', stale: false, devBuild: true };
    case 'hotkey_free': return true;
    case 'agents_status': case 'set_agent': return { mxPath: null, onPath: false, agents: [], devBuild: true };
    case 'agents_prompt': return '';
    case 'prepare_update': case 'release_single_instance_lock': case 'open_notices': return null;
    case 'invalidate_dir_sizes': return null;
  }
  return fail('unsupported', `Mock: unknown command ${cmd}`);
}
