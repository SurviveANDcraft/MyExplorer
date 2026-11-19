// Maps file names to highlight.js language ids. Kept separate from the grammars
// so the main bundle only carries this table; grammars load lazily (see highlight.ts).

const BY_EXT: Record<string, string> = {};
const map = (lang: string, exts: string) => exts.split(' ').forEach((e) => (BY_EXT[e] = lang));
map('typescript', 'ts tsx mts cts');
map('javascript', 'js jsx mjs cjs');
map('json', 'json jsonc json5 webmanifest code-workspace');
map('css', 'css');
map('scss', 'scss sass');
map('less', 'less');
map('xml', 'html htm xhtml xml xsd xsl xslt plist csproj vbproj fsproj props targets resx xaml svelte vue astro config manifest');
map('yaml', 'yml yaml');
map('ini', 'toml ini cfg conf editorconfig');
map('properties', 'properties');
map('rust', 'rs');
map('python', 'py pyw pyi');
map('go', 'go');
map('c', 'c h');
map('cpp', 'cpp cc cxx hpp hh hxx inl ino');
map('csharp', 'cs csx');
map('java', 'java');
map('kotlin', 'kt kts');
map('groovy', 'groovy gradle');
map('scala', 'scala sc');
map('swift', 'swift');
map('objectivec', 'mm');
map('dart', 'dart');
map('ruby', 'rb rake gemspec');
map('php', 'php');
map('perl', 'pl pm');
map('lua', 'lua');
map('r', 'r');
map('julia', 'jl');
map('elixir', 'ex exs');
map('erlang', 'erl hrl');
map('haskell', 'hs');
map('ocaml', 'ml mli');
map('fsharp', 'fs fsi fsx');
map('clojure', 'clj cljs cljc edn');
map('nim', 'nim');
map('bash', 'sh bash zsh fish');
map('powershell', 'ps1 psm1 psd1');
map('dos', 'bat cmd');
map('sql', 'sql');
map('graphql', 'graphql gql');
map('protobuf', 'proto');
map('cmake', 'cmake');
map('makefile', 'mk mak');
map('dockerfile', 'dockerfile');
map('nginx', 'nginx');
map('diff', 'diff patch');
map('markdown', 'md markdown mdx');
map('latex', 'tex sty');
map('vbnet', 'vb');
map('glsl', 'glsl vert frag hlsl wgsl');
map('x86asm', 'asm');
map('vim', 'vim');
map('plaintext', 'lock gitignore gitattributes npmrc nvmrc env');

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake', gemfile: 'ruby', rakefile: 'ruby', vagrantfile: 'ruby', podfile: 'ruby',
  '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash', '.bash_profile': 'bash',
  '.gitconfig': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', '.prettierrc': 'json', '.eslintrc': 'json', '.babelrc': 'json',
  '.gitignore': 'plaintext', '.gitattributes': 'plaintext', '.dockerignore': 'plaintext', '.env': 'bash',
  license: 'plaintext', 'cargo.lock': 'ini',
};

export const LANG_LABEL: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', css: 'CSS', scss: 'SCSS', less: 'Less', xml: 'Markup',
  yaml: 'YAML', ini: 'Config', properties: 'Properties', rust: 'Rust', python: 'Python', go: 'Go', c: 'C', cpp: 'C++',
  csharp: 'C#', java: 'Java', kotlin: 'Kotlin', groovy: 'Groovy', scala: 'Scala', swift: 'Swift', objectivec: 'Objective-C',
  dart: 'Dart', ruby: 'Ruby', php: 'PHP', perl: 'Perl', lua: 'Lua', r: 'R', julia: 'Julia', elixir: 'Elixir', erlang: 'Erlang',
  haskell: 'Haskell', ocaml: 'OCaml', fsharp: 'F#', clojure: 'Clojure', nim: 'Nim', bash: 'Shell', powershell: 'PowerShell',
  dos: 'Batch', sql: 'SQL', graphql: 'GraphQL', protobuf: 'Protobuf', cmake: 'CMake', makefile: 'Makefile', dockerfile: 'Dockerfile',
  nginx: 'Nginx', diff: 'Diff', markdown: 'Markdown', latex: 'LaTeX', vbnet: 'VB.NET', glsl: 'Shader', x86asm: 'Assembly', vim: 'Vim',
  plaintext: 'Text',
};

/** highlight.js language id for a file name, or null when it isn't a code/config file. */
export function langFor(name: string): string | null {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  if (lower.startsWith('.env.')) return 'bash';
  if (lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile')) return 'dockerfile';
  const i = lower.lastIndexOf('.');
  const ext = i >= 0 ? lower.slice(i + 1) : '';
  return (ext && BY_EXT[ext]) || null;
}
