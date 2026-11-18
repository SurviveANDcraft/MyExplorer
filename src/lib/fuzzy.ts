/** Subsequence fuzzy match. Higher score is better; null if not a match. */
export function fuzzy(query: string, text: string): { score: number; marks: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, marks: [] };
  const t = text.toLowerCase();
  const sub = t.indexOf(q);
  if (sub >= 0) {
    const boundary = sub === 0 || /[\s\-_.\\/]/.test(t[sub - 1]);
    return { score: 100 + (boundary ? 50 : 0) - sub - text.length * 0.1, marks: Array.from({ length: q.length }, (_, k) => sub + k) };
  }
  const marks: number[] = [];
  let score = 0, ti = 0, prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    const boundary = i === 0 || /[\s\-_.\\/]/.test(t[i - 1]) || (text[i] !== t[i] && text[i - 1] === t[i - 1]);
    score += (i === prev + 1 ? 6 : 0) + (boundary ? 8 : 0) - Math.min(4, i - ti);
    marks.push(i);
    prev = i;
    ti = i + 1;
  }
  return { score: score - text.length * 0.1, marks };
}

export function markParts(text: string, marks: number[]) {
  if (!marks.length) return [{ s: text, m: false }];
  const set = new Set(marks);
  const out: { s: string; m: boolean }[] = [];
  let cur = '', on = set.has(0);
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== on && cur) { out.push({ s: cur, m: on }); cur = ''; }
    on = m;
    cur += text[i];
  }
  if (cur) out.push({ s: cur, m: on });
  return out;
}
