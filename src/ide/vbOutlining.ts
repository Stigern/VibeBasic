// Code folding ("outlining", as Visual Studio calls it), the VB6 procedure separator and indentation guides.
// Folding is view state only: CodeMirror's fold state, never saved in the project and never part of undo.
// Foldable: see vbBlocks.ts. A folded block shows its first line and a boxed "..." whose tooltip is the hidden code.
import type { EditorState, Extension, StateEffect } from '@codemirror/state';
import { codeFolding, foldEffect, foldService, foldedRanges, unfoldEffect } from '@codemirror/language';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { blocksOf, innermostBlock, type Block } from './vbBlocks';

/** The folded range of a block: from the end of its opener to the end of its last line. */
export function foldRangeOf(state: EditorState, b: Block): { from: number; to: number } {
  return { from: state.doc.line(b.headEnd).to, to: state.doc.line(b.end).to };
}
const isFolded = (state: EditorState, r: { from: number; to: number }): boolean => {
  let hit = false;
  foldedRanges(state).between(r.from, r.from, (a, b) => { if (a === r.from && b === r.to) hit = true; });
  return hit;
};
const allFolds = (state: EditorState): { from: number; to: number }[] => {
  const out: { from: number; to: number }[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => { out.push({ from, to }); });
  return out;
};

/** Unfold effects for the folds that hide `pos` (jumping to a line shows it). */
export function revealEffects(state: EditorState, pos: number): StateEffect<unknown>[] {
  const out: StateEffect<unknown>[] = [];
  foldedRanges(state).between(pos, pos, (a, b) => { if (a < pos && b >= pos) out.push(unfoldEffect.of({ from: a, to: b })); });
  return out;
}

const PREVIEW_LINES = 30;
const folding = codeFolding({
  preparePlaceholder: (state, range) => {
    const lines = state.sliceDoc(range.from, range.to).replace(/^\r?\n/, '').split('\n');
    return lines.length > PREVIEW_LINES ? [...lines.slice(0, PREVIEW_LINES), '...'].join('\n') : lines.join('\n');
  },
  placeholderDOM: (_view, onclick, prepared: string) => {
    const s = document.createElement('span');
    s.className = 'cm-vb-foldph';
    s.textContent = '...';
    s.title = prepared;
    s.setAttribute('aria-label', 'folded code');
    s.addEventListener('click', onclick);
    return s;
  },
});

const vbFoldService = foldService.of((state, lineStart) => {
  const b = blocksOf(state).byStart.get(state.doc.lineAt(lineStart).number);
  return b ? foldRangeOf(state, b) : null;
});

// ---- outlining margin ------------------------------------------------------------------------------------------
class OutlineMarker extends GutterMarker {
  constructor(readonly top: boolean, readonly bot: boolean, readonly box: 'minus' | 'plus' | null, readonly tick: boolean) { super(); }
  override eq(o: OutlineMarker) { return o.top === this.top && o.bot === this.bot && o.box === this.box && o.tick === this.tick; }
  override toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-vb-ol';
    const part = (cls: string) => { el.appendChild(document.createElement('div')).className = cls; };
    if (this.top) part('cm-vb-ol-top');
    if (this.bot) part('cm-vb-ol-bot');
    if (this.tick) part('cm-vb-ol-tick');
    if (this.box) part(`cm-vb-ol-box cm-vb-ol-${this.box}`);
    return el;
  }
}
const markers = new Map<string, OutlineMarker>();
const markerOf = (top: boolean, bot: boolean, box: 'minus' | 'plus' | null, tick: boolean): OutlineMarker | null => {
  if (!top && !bot && !box && !tick) return null;
  const k = `${+top}${+bot}${box}${+tick}`;
  let m = markers.get(k);
  if (!m) markers.set(k, m = new OutlineMarker(top, bot, box, tick));
  return m;
};
const ends = new WeakMap<object, Set<number>>();
const endLines = (scan: ReturnType<typeof blocksOf>): Set<number> => {
  let s = ends.get(scan);
  if (!s) ends.set(scan, s = new Set(scan.blocks.map(b => b.end)));
  return s;
};

/** Folds or unfolds the block that starts on line `n`; false when none starts there. */
function toggleBlockAt(view: EditorView, n: number): boolean {
  const b = blocksOf(view.state).byStart.get(n);
  if (!b) return false;
  const r = foldRangeOf(view.state, b);
  view.dispatch({ effects: (isFolded(view.state, r) ? unfoldEffect : foldEffect).of(r) });
  return true;
}

const outlineGutter = gutter({
  class: 'cm-vb-fold',
  lineMarker(view, line) {
    const st = view.state, scan = blocksOf(st);
    const first = st.doc.lineAt(line.from).number, last = st.doc.lineAt(line.to).number;
    const b = scan.byStart.get(first);
    const box = b ? (isFolded(st, foldRangeOf(st, b)) ? 'plus' : 'minus') : null;
    return markerOf(scan.above[first] > 0, scan.below[last] > 0, box, !box && endLines(scan).has(last));
  },
  lineMarkerChange: u => u.docChanged || foldedRanges(u.startState) !== foldedRanges(u.state),
  initialSpacer: () => new OutlineMarker(false, false, null, false),
  domEventHandlers: {
    mousedown: (view, line) => toggleBlockAt(view, view.state.doc.lineAt(line.from).number),
  },
});

// ---- commands (Edit > Outlining) -------------------------------------------------------------------------------
/** Toggle Outlining Expansion (Ctrl+M, Ctrl+M): the fold on the cursor line, else the innermost block around it. */
export function toggleOutliningExpansion(view: EditorView): boolean {
  const st = view.state, head = st.selection.main.head, line = st.doc.lineAt(head);
  const here = allFolds(st).find(f => f.from >= line.from && f.from <= line.to);
  if (here) { view.dispatch({ effects: unfoldEffect.of(here) }); return true; }
  const b = innermostBlock(blocksOf(st), line.number);
  if (!b) return false;
  const r = foldRangeOf(st, b);
  view.dispatch({ effects: foldEffect.of(r), selection: head > r.from ? { anchor: r.from } : undefined });
  return true;
}

function foldBlocks(view: EditorView, blocks: Block[]): void {
  const st = view.state, head = st.selection.main.head;
  const ranges = blocks.map(b => foldRangeOf(st, b));
  const effects: StateEffect<unknown>[] = allFolds(st).map(f => unfoldEffect.of(f));
  effects.push(...ranges.map(r => foldEffect.of(r)));
  // the cursor goes to the start of the outermost fold that would hide it
  const hiding = ranges.filter(r => r.from < head && r.to >= head).sort((a, b) => a.from - b.from)[0];
  view.dispatch({ effects, selection: hiding ? { anchor: hiding.from } : undefined });
}

/** Toggle All Outlining (Ctrl+M, Ctrl+L): unfolds everything when something is folded, else folds every block. */
export function toggleAllOutlining(view: EditorView): boolean {
  const folds = allFolds(view.state);
  if (folds.length) view.dispatch({ effects: folds.map(f => unfoldEffect.of(f)) });
  else foldBlocks(view, blocksOf(view.state).blocks);
  return true;
}

/** Collapse to Definitions (Ctrl+M, Ctrl+O): every procedure folded, everything else open. */
export function collapseToDefinitions(view: EditorView): boolean {
  foldBlocks(view, blocksOf(view.state).blocks.filter(b => b.kind === 'proc'));
  return true;
}

export const outlining: Extension = [folding, vbFoldService, outlineGutter];

// ---- VB6 procedure separator -----------------------------------------------------------------------------------
const sepDeco = Decoration.line({ class: 'cm-vb-procsep' });
const COMMENT_LINE = /^\s*('|rem\b)/i;
/** A thin grey line above every procedure (and the comment lines just above it), not above the first line. */
export const procedureSeparator: Extension = EditorView.decorations.compute(['doc'], s => {
  const scan = blocksOf(s);
  const starts = new Set<number>();
  for (const b of scan.blocks) if (b.kind === 'proc') starts.add(b.start);
  for (const [line, closer] of scan.unclosed) if (/^End (Sub|Function|Property)$/.test(closer)) starts.add(line);
  const tops: number[] = [];
  for (const start of starts) {
    let top = start;
    while (top > 1 && COMMENT_LINE.test(s.doc.line(top - 1).text)) top--;
    if (top > 1) tops.push(top);
  }
  return Decoration.set([...new Set(tops)].sort((a, b) => a - b).map(n => sepDeco.range(s.doc.line(n).from)));
});

// ---- indentation guides ------------------------------------------------------------------------------------------
const TAB = 4;
const indentOf = (text: string): number | null => {
  let c = 0;
  for (const ch of text) {
    if (ch === ' ') c++;
    else if (ch === '\t') c = (Math.floor(c / TAB) + 1) * TAB;
    else return c;
  }
  return null;   // blank
};
const guideDecos = new Map<number, Decoration>();
const guideDeco = (levels: number): Decoration => {
  let d = guideDecos.get(levels);
  if (!d) {
    const cols = Array.from({ length: levels }, (_, i) => i * TAB);
    d = Decoration.line({ attributes: {
      class: 'cm-vb-guides',
      style: `background-image: ${cols.map(() => 'linear-gradient(#c8c8c8 50%, transparent 50%)').join(', ')}; `
        + `background-size: ${cols.map(() => '1px 2px').join(', ')}; background-repeat: repeat-y; `
        + `background-position: ${cols.map(c => `calc(6px + ${c}ch) 0`).join(', ')}`,
    } });
    guideDecos.set(levels, d);
  }
  return d;
};
/** Faint dotted vertical lines at each indent level (blank lines take the smaller indent of their neighbours). */
export const indentGuides: Extension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view: EditorView): DecorationSet {
    const doc = view.state.doc, out = [];
    const near = (n: number, step: number): number => {
      for (let i = n + step, k = 0; i >= 1 && i <= doc.lines && k < 200; i += step, k++) {
        const c = indentOf(doc.line(i).text);
        if (c !== null) return c;
      }
      return 0;
    };
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const l = doc.lineAt(pos);
        let c = indentOf(l.text);
        if (c === null) c = Math.min(near(l.number, -1), near(l.number, 1));
        const levels = Math.ceil(c / TAB);
        if (levels > 0) out.push(guideDeco(levels).range(l.from));
        pos = l.to + 1;
      }
    }
    return Decoration.set(out);
  }
}, { decorations: v => v.decorations });
