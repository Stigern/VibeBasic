// RichTextBox content as runs. The editable element holds only text nodes and flat <span>s that carry their own format
// (data-vb-* attributes + inline style); every format change reads the DOM into runs, edits the runs and writes them back,
// so a span never nests in another and an attribute that is switched off really is off. Text offsets are offsets in
// textContent (line breaks are "\n" characters), which is what Text, SelStart and SelLength count.

export interface RtfFormat { bold: boolean; italic: boolean; underline: boolean; color: number; fontName: string; fontSize: number }
export type RtfPatch = Partial<RtfFormat>;
export interface Run { text: string; fmt: RtfPatch }

export const RTF_KEYS: readonly (keyof RtfFormat)[] = ['bold', 'italic', 'underline', 'color', 'fontName', 'fontSize'];
const DATA: Record<keyof RtfFormat, string> = { bold: 'vbBold', italic: 'vbItalic', underline: 'vbUnderline', color: 'vbColor', fontName: 'vbFontName', fontSize: 'vbFontSize' };

const sameFmt = (a: RtfPatch, b: RtfPatch): boolean => RTF_KEYS.every(k => a[k] === b[k]);
const encode = (v: string | number | boolean): string => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
function decode(k: keyof RtfFormat, v: string): string | number | boolean {
  if (k === 'bold' || k === 'italic' || k === 'underline') return v === '1';
  return k === 'color' || k === 'fontSize' ? Number(v) : v;
}

/** The text nodes of `root` as runs, each with the format of its nearest ancestors (only what is set explicitly). */
export function readRuns(root: HTMLElement): Run[] {
  const runs: Run[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n as Text).data;
    if (text === '') continue;
    const fmt: Record<string, string | number | boolean> = {};
    for (let p = n.parentNode; p && p !== root; p = p.parentNode) {
      const ds = (p as HTMLElement).dataset;
      if (!ds) continue;
      for (const k of RTF_KEYS) if (fmt[k] === undefined && ds[DATA[k]] !== undefined) fmt[k] = decode(k, ds[DATA[k]]!);
    }
    const last = runs[runs.length - 1];
    if (last && sameFmt(last.fmt, fmt as RtfPatch)) last.text += text; else runs.push({ text, fmt: fmt as RtfPatch });
  }
  return runs;
}

/** The runs as text for a window prop; '' when no run has a format (the plain Text says it all). */
export function encodeRuns(runs: Run[]): string {
  const merged = mergeRuns(runs);
  return merged.every(r => RTF_KEYS.every(k => r.fmt[k] === undefined)) ? '' : JSON.stringify(merged.map(r => [r.text, r.fmt]));
}

/** Inverse of encodeRuns; null for '' (no formatting) and for text that is not a run list. */
export function decodeRuns(text: string): Run[] | null {
  if (text === '') return null;
  try {
    const a = JSON.parse(text) as unknown;
    return Array.isArray(a) ? a.map(x => ({ text: String((x as [string, RtfPatch])[0]), fmt: { ...(x as [string, RtfPatch])[1] } })) : null;
  } catch { return null; }
}

/** The text of the runs. */
export const runsText = (runs: Run[]): string => runs.map(r => r.text).join('');

/** Replaces the content of `root` by the runs; `style` sets the inline style of a span from its format. */
export function writeRuns(root: HTMLElement, runs: Run[], style: (el: HTMLElement, fmt: RtfPatch) => void): void {
  const doc = root.ownerDocument;
  const nodes: Node[] = [];
  for (const r of mergeRuns(runs)) {
    if (RTF_KEYS.every(k => r.fmt[k] === undefined)) { nodes.push(doc.createTextNode(r.text)); continue; }
    const span = doc.createElement('span');
    for (const k of RTF_KEYS) if (r.fmt[k] !== undefined) span.dataset[DATA[k]] = encode(r.fmt[k]!);
    style(span, r.fmt);
    span.textContent = r.text;
    nodes.push(span);
  }
  root.replaceChildren(...nodes);
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.text === '') continue;
    const last = out[out.length - 1];
    if (last && sameFmt(last.fmt, r.fmt)) last.text += r.text; else out.push({ text: r.text, fmt: { ...r.fmt } });
  }
  return out;
}

/** A run boundary at character offset `at`. */
function splitAt(runs: Run[], at: number): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (at > pos && at < end) out.push({ text: r.text.slice(0, at - pos), fmt: r.fmt }, { text: r.text.slice(at - pos), fmt: r.fmt });
    else out.push(r);
    pos = end;
  }
  return out;
}

/** The runs between two offsets that are already boundaries. */
function slice(runs: Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const s = pos;
    pos += r.text.length;
    if (s >= from && pos <= to) out.push(r);
  }
  return out;
}

const total = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0);

/** The explicit format of the character at `start` (or, for an insertion point, of the character before it). */
export function formatAt(runs: Run[], start: number, length: number): RtfPatch {
  const at = length > 0 ? start : Math.max(0, start - 1);
  let pos = 0;
  for (const r of runs) {
    pos += r.text.length;
    if (at < pos) return r.fmt;
  }
  return runs.length ? runs[runs.length - 1].fmt : {};
}

/** Sets `patch` on the characters [start, start + length). */
export function formatRange(runs: Run[], start: number, length: number, patch: RtfPatch): Run[] {
  const end = start + length;
  const rs = splitAt(splitAt(runs, start), end);
  let pos = 0;
  return rs.map(r => {
    const s = pos;
    pos += r.text.length;
    return s >= start && pos <= end ? { text: r.text, fmt: { ...r.fmt, ...patch } } : r;
  });
}

/** Replaces [start, start + length) by `text`; with `fmt` null the new text takes the format of the character it follows. */
export function replaceRange(runs: Run[], start: number, length: number, text: string, fmt: RtfPatch | null): Run[] {
  const n = total(runs);
  start = Math.min(Math.max(0, start), n);
  length = Math.min(Math.max(0, length), n - start);
  const f = fmt ?? formatAt(runs, start, length);
  const rs = splitAt(splitAt(runs, start), start + length);
  return [...slice(rs, 0, start), { text, fmt: f }, ...slice(rs, start + length, n)];
}

// ---------------------------------------------------------------------------------------------------------------
// Selection <-> offsets

const pointAt = (root: HTMLElement, offset: number, preferNext: boolean): { node: Node; offset: number } => {
  let pos = 0;
  let last: Text | null = null;
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text, end = pos + t.data.length;
    if (offset < end || (!preferNext && offset === end)) return { node: t, offset: offset - pos };
    pos = end;
    last = t;
  }
  return last ? { node: last, offset: last.data.length } : { node: root, offset: 0 };
};

function offsetOf(root: HTMLElement, node: Node, off: number): number {
  const r = root.ownerDocument.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, off);
  return r.toString().length;
}

/** The document selection as text offsets, null when it is not inside `root`. */
export function selectionOffsets(root: HTMLElement): { start: number; length: number } | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
  const start = offsetOf(root, r.startContainer, r.startOffset), end = offsetOf(root, r.endContainer, r.endOffset);
  return { start, length: Math.max(0, end - start) };
}

export function setSelectionOffsets(root: HTMLElement, start: number, length: number): void {
  const doc = root.ownerDocument, sel = doc.getSelection();
  if (!sel) return;
  const a = pointAt(root, start, true), b = pointAt(root, start + length, false);
  const r = doc.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(r);
}
