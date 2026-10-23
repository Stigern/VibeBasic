// Breakpoints in a code window: line-start positions in a CodeMirror state field, so they move with their line as the
// text is edited. Only lines with an executable statement can have one (not blank lines, comments, Dim / Const,
// labels or Sub / Function headers), as in VB6. They are not saved in the project.
import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { Stmt } from '../lang/ast';
import { parseModule } from '../lang/parser';

export const bpEffect = StateEffect.define<{ toggle: number } | { clear: true }>();

/** Sorted, distinct line-start positions of the breakpoints. */
export const bpField = StateField.define<readonly number[]>({
  create: () => [],
  update(v, tr) {
    if (tr.docChanged && v.length) {
      // A breakpoint goes with its line (VB6): when one change takes all of the line's text together with a line break, or
      // empties it. Otherwise its line-start position is mapped to the right: text inserted at the start of the line pushes it
      // down with its line.
      const start = tr.startState.doc;
      const gone = (p: number): boolean => {
        const e = start.lineAt(p).to;
        let hit = false;
        tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => {
          if (e > p && fromA <= p && toA >= e && (fromA < p || toA > e || ins.length === 0)) hit = true;
        });
        return hit;
      };
      const m = v.filter(p => !gone(p)).map(p => tr.state.doc.lineAt(tr.changes.mapPos(p, 1)).from);
      v = [...new Set(m)].sort((a, b) => a - b);
    }
    for (const e of tr.effects) {
      if (!e.is(bpEffect)) continue;
      if ('clear' in e.value) v = [];
      else {
        const p = e.value.toggle;
        v = v.includes(p) ? v.filter(x => x !== p) : [...v, p].sort((a, b) => a - b);
      }
    }
    return v;
  },
  provide: f => EditorView.decorations.from(f, ps => Decoration.set(ps.map(p => bpDeco.range(p)))),
});
const bpDeco = Decoration.line({ class: 'cm-vb-bp' });

export function bpLines(state: EditorState): number[] {
  return state.field(bpField).map(p => state.doc.lineAt(p).number);
}

const NON_EXEC = /^\s*(?:$|'|rem\b|(?:(?:public|private|friend|global|static)\s+)*(?:dim|const|sub|function|property|declare|type|enum|option)\b|static\b|end\s+(?:sub|function|property|type|enum)\b)/i;

/** Lines (1-based) of a module's source that hold an executable statement. */
export function executableLines(source: string): Set<number> {
  const out = new Set<number>();
  let ast;
  try {
    ast = parseModule(source, 'Module');
  } catch {
    // a syntax error somewhere: fall back to a line-by-line guess
    source.split('\n').forEach((t, i) => { if (!NON_EXEC.test(t)) out.add(i + 1); });
    return out;
  }
  const walk = (body: Stmt[] | undefined): void => {
    if (!body) return;
    for (const s of body) {
      if (s.kind !== 'dim' && s.kind !== 'const' && s.kind !== 'label') out.add(s.line);
      switch (s.kind) {
        case 'if': s.branches.forEach(b => walk(b.body)); walk(s.elseBody); break;
        case 'select': s.cases.forEach(c => walk(c.body)); walk(s.elseBody); break;
        case 'for': case 'forEach': out.add(s.nextLine); walk(s.body); break;   // Next: the loop's back-edge
        case 'do': case 'while': case 'with': walk(s.body); break;
      }
    }
  };
  for (const p of ast.procedures) walk(p.body);
  return out;
}

/** F9 / a gutter click on `line`: toggles its breakpoint; an existing one always goes, a new one only on an executable line. */
export function toggleBreakpointAt(view: EditorView, line: number): boolean {
  const doc = view.state.doc;
  if (line < 1 || line > doc.lines) return false;
  const pos = doc.line(line).from;
  if (!view.state.field(bpField).includes(pos) && !executableLines(doc.toString()).has(line)) return false;
  view.dispatch({ effects: bpEffect.of({ toggle: pos }) });
  return true;
}
