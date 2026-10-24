export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

/** Above this many cells (lines of the changed middle part of `a` times those of `b`) the middle part changes as one block. */
export const MAX_DIFF_CELLS = 4_000_000;

/**
 * Line diff by longest common subsequence; deletions come before additions within a changed run. The lines both share at the
 * start and at the end are left out of the comparison, and the table is one Int32Array of at most MAX_DIFF_CELLS cells (16 MB),
 * so a large module with a small change stays fast and small.
 */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const out: DiffLine[] = a.slice(0, p).map(text => ({ kind: 'same' as const, text }));
  const n = a.length - q, m = b.length - q;
  const del = (i: number) => out.push({ kind: 'del', text: a[i] });
  const add = (j: number) => out.push({ kind: 'add', text: b[j] });
  const w = m - p + 1;
  if ((n - p + 1) * w > MAX_DIFF_CELLS) {
    for (let i = p; i < n; i++) del(i);
    for (let j = p; j < m; j++) add(j);
  } else {
    // the lines as numbers, so the table compares integers
    const ids = new Map<string, number>();
    const id = (s: string) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
    const ai = Int32Array.from(a.slice(p, n), id), bi = Int32Array.from(b.slice(p, m), id);
    // L[i * w + j]: the longest common subsequence of ai[i..] and bi[j..]
    const L = new Int32Array((n - p + 1) * w);
    for (let i = n - p - 1; i >= 0; i--)
      for (let j = m - p - 1; j >= 0; j--) {
        const k = i * w + j;
        L[k] = ai[i] === bi[j] ? L[k + w + 1] + 1 : Math.max(L[k + w], L[k + 1]);
      }
    let i = 0, j = 0;
    while (i < n - p && j < m - p) {
      if (ai[i] === bi[j]) { out.push({ kind: 'same', text: a[p + i] }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) del(p + i++);
      else add(p + j++);
    }
    while (i < n - p) del(p + i++);
    while (j < m - p) add(p + j++);
  }
  for (let k = n; k < a.length; k++) out.push({ kind: 'same', text: a[k] });
  return out;
}
