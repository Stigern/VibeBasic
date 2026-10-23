// The smallest set of changes that turns one text into another, line by line. Used when a whole module is replaced
// (an AI answer applied): only the lines that really differ change, so breakpoints, folds and the cursor on the
// untouched lines stay where they are.

export interface TextChange { from: number; to: number; insert: string }

/** Lines with their line break (the last one may have none). */
const splitLines = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Above this many cells the line comparison is skipped and the middle part changes as one block. */
const MAX_CELLS = 4_000_000;

/** Replacing `doc[from, to)` by `text` without the characters both share at the start and at the end. */
function trimmed(doc: string, from: number, to: number, text: string): TextChange {
  let s = 0;
  while (s < text.length && from + s < to && text[s] === doc[from + s]) s++;
  let e = 0;
  while (e < text.length - s && e < to - from - s && text[text.length - 1 - e] === doc[to - 1 - e]) e++;
  return { from: from + s, to: to - e, insert: text.slice(s, text.length - e) };
}

/** The changes (in `doc` positions, in order, not overlapping) that replace `doc[from, to)` by `text`. */
export function lineChanges(doc: string, from: number, to: number, text: string): TextChange[] {
  const a = splitLines(doc.slice(from, to)), b = splitLines(text);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const offA: number[] = [from];
  for (const l of a) offA.push(offA[offA.length - 1] + l.length);
  const out: TextChange[] = [];
  /** Lines a[i0, i1) become b[j0, j1): edited in place line by line when the counts match, else replaced as a block. */
  const run = (i0: number, i1: number, j0: number, j1: number) => {
    if (i1 - i0 === j1 - j0) {
      for (let k = 0; k < i1 - i0; k++) {
        const c = trimmed(doc, offA[i0 + k], offA[i0 + k + 1], b[j0 + k]);
        if (c.from !== c.to || c.insert) out.push(c);
      }
    } else out.push({ from: offA[i0], to: offA[i1], insert: b.slice(j0, j1).join('') });
  };
  const n = a.length - q, m = b.length - q;
  const w = m - p + 1;
  if ((n - p + 1) * w > MAX_CELLS) { run(p, n, p, m); return out; }
  // lcs[(i - p) * w + (j - p)]: the longest common subsequence of a[i..n) and b[j..m)
  const lcs = new Int32Array((n - p + 1) * w);
  for (let i = n - 1; i >= p; i--) {
    for (let j = m - 1; j >= p; j--) {
      const k = (i - p) * w + (j - p);
      lcs[k] = a[i] === b[j] ? lcs[k + w + 1] + 1 : Math.max(lcs[k + w], lcs[k + 1]);
    }
  }
  let i = p, j = p, i0 = p, j0 = p;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      run(i0, i, j0, j);
      i++; j++; i0 = i; j0 = j;
    } else if (j >= m || (i < n && lcs[(i + 1 - p) * w + (j - p)] >= lcs[(i - p) * w + (j + 1 - p)])) i++;
    else j++;
  }
  run(i0, n, j0, m);
  return out;
}
