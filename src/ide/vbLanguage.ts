// VB syntax colouring for CodeMirror: keywords (#000080) and comments (#008000) from the plan-01 lexer, line by line.
// A line the lexer rejects (unterminated string, ...) is left plain.
import { RangeSetBuilder, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { tokenize } from '../lang/lexer';

export interface Span { from: number; to: number; cls: 'cm-vb-kw' | 'cm-vb-comment' }

/** Colour spans (offsets within `line`); [] when the line cannot be tokenized. */
export function vbSpans(line: string): Span[] {
  const run = (src: string): Span[] | null => {
    try {
      const out: Span[] = [];
      for (const t of tokenize(src)) {
        if (t.kind === 'keyword') out.push({ from: t.col - 1, to: t.col - 1 + t.text.length, cls: 'cm-vb-kw' });
        else if (t.kind === 'comment') out.push({ from: t.col - 1, to: line.length, cls: 'cm-vb-comment' });
      }
      return out;
    } catch { return null; }
  };
  // a trailing line continuation (` _`) is only valid with a following line: colour the line without it
  return run(line) ?? (/\s_\s*$/.test(line) ? run(line.replace(/\s_\s*$/, '')) : null) ?? [];
}

const marks = { 'cm-vb-kw': Decoration.mark({ class: 'cm-vb-kw' }), 'cm-vb-comment': Decoration.mark({ class: 'cm-vb-comment' }) };

function build(doc: { lines: number; line(n: number): { from: number; text: string } }): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n);
    for (const s of vbSpans(l.text)) if (s.to > s.from) b.add(l.from + s.from, l.from + s.to, marks[s.cls]);
  }
  return b.finish();
}

export const vbHighlight: Extension = StateField.define<DecorationSet>({
  create: s => build(s.doc),
  update: (v, tr) => (tr.docChanged ? build(tr.state.doc) : v),
  provide: f => EditorView.decorations.from(f),
});

export const vbTheme: Extension = EditorView.baseTheme({
  '&': { fontFamily: '"Courier New", monospace', fontSize: '13px', backgroundColor: '#fff', color: '#000', height: '100%' },
  '.cm-scroller': { fontFamily: '"Courier New", monospace', overflow: 'auto' },
  '.cm-content': { fontFamily: '"Courier New", monospace' },
  '&.cm-focused': { outline: 'none' },
  '.cm-vb-kw': { color: '#000080' },
  '.cm-vb-comment': { color: '#008000' },
  '.cm-line.cm-vb-error, .cm-line.cm-vb-error span': { color: '#FF0000' },
  '.cm-line.cm-vb-bp': { backgroundColor: '#800000', color: '#fff' },
  '.cm-line.cm-vb-bp span': { color: '#fff' },
  '.cm-line.cm-vb-break, .cm-line.cm-vb-bp.cm-vb-break': { backgroundColor: '#FFFF00', color: '#000' },
  '.cm-line.cm-vb-bp.cm-vb-break span': { color: '#000' },
  '.cm-line.cm-vb-procend': { borderBottom: '1px solid #c0c0c0' },
  '.cm-vb-margin': { width: '16px', backgroundColor: '#c0c0c0' },
  '.cm-vb-arrow': { color: '#000', textAlign: 'center' },
  '.cm-vb-mark': { position: 'relative', display: 'inline-block', width: '14px', textAlign: 'center' },
  '.cm-vb-bpdot': { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#800000', verticalAlign: 'middle' },
  '.cm-vb-bpdot + .cm-vb-arrow': { position: 'absolute', left: '0', right: '0', top: '0', color: '#FFFF00' },
});
