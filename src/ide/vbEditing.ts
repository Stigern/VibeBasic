// Readability helpers of the code window: the matching block keywords under the cursor (If / ElseIf / Else / End If,
// For / Next, Sub / End Sub, ...) in a light box, the other occurrences of the identifier under the cursor, Enter that
// indents after a block opener and adds its missing End line, and Tab to the next 4-column stop (VB6).
import { type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type Command, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { indentMore, insertNewlineKeepIndent } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { KEYWORDS } from '../lang/tokens';
import { blocksOf, classifyLine } from './vbBlocks';
import type { SpanCache } from './vbLanguage';

const continues = (t: string) => /(^|\s)_\s*$/.test(t);

// ---- matching block keywords -----------------------------------------------------------------------------------
/** The keywords that belong with the one under the cursor (absolute ranges), or [] when the cursor is on none. */
export function matchingKeywords(state: EditorState): { from: number; to: number }[] {
  const sel = state.selection.main;
  if (!sel.empty) return [];
  const line = state.doc.lineAt(sel.head), col = sel.head - line.from;
  const hit = blocksOf(state).keysByLine.get(line.number)?.find(k => col >= k.from && col <= k.to);
  if (!hit) return [];
  return hit.block.keys.map(k => { const l = state.doc.line(k.line); return { from: l.from + k.from, to: l.from + k.to }; });
}
const kwMatch = Decoration.mark({ class: 'cm-vb-kwmatch' });
const matchKeywordsExt = EditorView.decorations.compute(['doc', 'selection'], s =>
  Decoration.set(matchingKeywords(s).map(r => kwMatch.range(r.from, r.to)), true));

// ---- other occurrences of the identifier under the cursor --------------------------------------------------------
const WORD = /[A-Za-z0-9_]/;
const occur = Decoration.mark({ class: 'cm-vb-occur' });
const inSpan = (cache: SpanCache, text: string, col: number) =>
  cache.get(text).some(s => (s.cls === 'cm-vb-comment' || s.cls === 'cm-vb-str') && col >= s.from && col < s.to);

/** The identifier around the cursor (not a keyword, not in a comment or string), lower-case; null when none. */
function wordAt(state: EditorState, cache: SpanCache): string | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head), t = line.text;
  let a = sel.head - line.from, b = a;
  while (a > 0 && WORD.test(t[a - 1])) a--;
  while (b < t.length && WORD.test(t[b])) b++;
  const w = t.slice(a, b);
  if (!/^[A-Za-z]/.test(w) || KEYWORDS.has(w.toLowerCase()) || inSpan(cache, t, a)) return null;
  return w.toLowerCase();
}

function occurrenceHighlight(cache: SpanCache): Extension {
  const build = (view: EditorView): DecorationSet => {
    cache.sync();
    const w = wordAt(view.state, cache);
    if (!w) return Decoration.none;
    const rx = new RegExp(`(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_$%&!#])`, 'gi');
    const doc = view.state.doc, out = [];
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const l = doc.lineAt(pos);
        for (const m of l.text.matchAll(rx)) if (!inSpan(cache, l.text, m.index)) out.push(occur.range(l.from + m.index, l.from + m.index + w.length));
        pos = l.to + 1;
      }
    }
    return out.length > 1 ? Decoration.set(out) : Decoration.none;
  };
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view); }
  }, { decorations: v => v.decorations });
}

// ---- Enter and Tab -------------------------------------------------------------------------------------------------
const UNIT = '    ';

/** What a logical line does to the next line's indentation: 'open' (a block opener), 'mid' (Else / Case), or null. */
export function lineOpens(text: string): 'open' | 'mid' | null {
  let depth = 0, mid = false;
  for (const e of classifyLine(text).evs) {
    if (e.op === 'open') depth++;
    else if (e.op === 'close') { depth = Math.max(0, depth - e.n); mid = false; }
    else mid = true;
  }
  return depth > 0 ? 'open' : mid ? 'mid' : null;
}

/**
 * Enter at the end of a block opener (`Sub X()`, `If ... Then`, `For ...`, `Do`, `Select Case`, `With`, ...) indents the
 * new line, and adds the block's End line when it has none (VB6 does that for Sub / Function). Elsewhere it keeps
 * the indentation.
 */
export const vbEnter: Command = view => {
  const st = view.state;
  if (st.readOnly) return false;
  const sel = st.selection.main;
  if (st.selection.ranges.length > 1 || !sel.empty) return insertNewlineKeepIndent(view);
  const line = st.doc.lineAt(sel.head);
  if (st.sliceDoc(sel.head, line.to).trim() || continues(line.text)) return insertNewlineKeepIndent(view);
  let a = line.number;
  while (a > 1 && continues(st.doc.line(a - 1).text)) a--;
  const lines = [];
  for (let i = a; i <= line.number; i++) lines.push(st.doc.line(i).text.replace(/_(\s*)$/, ' $1'));
  const what = lineOpens(lines.join('\n'));
  if (!what) return insertNewlineKeepIndent(view);
  const ind = /^\s*/.exec(st.doc.line(a).text)![0];
  const body = ind + (ind.includes('\t') ? '\t' : UNIT);
  const closer = what === 'open' ? blocksOf(st).unclosed.get(a) : undefined;
  const insert = `\n${body}` + (closer ? `\n${ind}${closer}` : '');
  view.dispatch({
    changes: { from: sel.head, to: line.to, insert },
    selection: { anchor: sel.head + 1 + body.length },
    scrollIntoView: true, userEvent: 'input',
  });
  return true;
};

/** Tab: spaces to the next 4-column stop (VB6); with a selection, indents the selected lines. */
export const vbTab: Command = view => {
  const st = view.state;
  if (st.readOnly) return false;
  const sel = st.selection.main;
  if (st.selection.ranges.length > 1 || !sel.empty) return indentMore(view);
  const line = st.doc.lineAt(sel.head);
  let col = 0;
  for (const ch of line.text.slice(0, sel.head - line.from)) col = ch === '\t' ? (Math.floor(col / 4) + 1) * 4 : col + 1;
  const n = 4 - (col % 4);
  view.dispatch({ changes: { from: sel.head, insert: ' '.repeat(n) }, selection: { anchor: sel.head + n }, scrollIntoView: true, userEvent: 'input' });
  return true;
};

export function editingHelpers(cache: SpanCache): Extension {
  return [indentUnit.of(UNIT), matchKeywordsExt, occurrenceHighlight(cache)];
}
