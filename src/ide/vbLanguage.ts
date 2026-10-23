// VB syntax colouring for CodeMirror, from the plan-01 lexer, line by line and only for the visible lines (a 3,000-line
// module costs nothing extra per keystroke). Two palettes, chosen in Tools > Options > Editor Format:
// - "Visual Studio" (default): keywords #0000FF (Sub / Function / End ... slightly bolder), comments #008000,
//   strings #A31515, numbers #098658, types #2B91AF, procedure names in their declaration bold, control / form
//   names #795E26, built-in constants #6F008A;
// - "Classic VB6": keywords #000080, comments #008000, everything else black.
// A line the lexer rejects (unterminated string, ...) is left plain.
import { StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { tokenize } from '../lang/lexer';
import { fileStatementWords } from '../lang/prettify';
import { CONSTANTS } from '../lang/builtins';

export type SpanClass = 'cm-vb-kw' | 'cm-vb-kwb' | 'cm-vb-comment' | 'cm-vb-str' | 'cm-vb-num' | 'cm-vb-type' | 'cm-vb-proc' | 'cm-vb-ctl' | 'cm-vb-const';
export interface Span { from: number; to: number; cls: SpanClass }
export type Palette = 'vs' | 'vb6';

const TYPE_NAMES = new Set(['integer', 'long', 'single', 'double', 'string', 'boolean', 'variant', 'date', 'byte', 'currency', 'object']);
/** Structure keywords drawn slightly bolder. */
const STRUCTURE = new Set(['sub', 'function', 'property', 'end', 'type', 'enum']);

/** Colour spans (offsets within `line`); [] when the line cannot be tokenized. `names`: lower-case control / form names. */
export function vbSpans(line: string, names: ReadonlySet<string> = new Set()): Span[] {
  const run = (src: string): Span[] | null => {
    let toks;
    try { toks = tokenize(src); } catch { return null; }
    const fileWords = fileStatementWords(toks);   // Open ... For Output / Print # / Line Input # words are idents to the lexer
    const out: Span[] = [];
    const add = (t: { col: number; text: string }, cls: SpanClass) => out.push({ from: t.col - 1, to: t.col - 1 + t.text.length, cls });
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i], prev = toks[i - 1], low = t.text.toLowerCase();
      const prevKw = prev?.kind === 'keyword' ? prev.text.toLowerCase() : '';
      const afterAs = prevKw === 'as' || (prevKw === 'new' && toks[i - 2]?.kind === 'keyword' && toks[i - 2].text.toLowerCase() === 'as');
      const afterDot = prev?.kind === 'op' && (prev.text === '.' || prev.text === '!');
      if (fileWords.has(i)) { add(t, 'cm-vb-kw'); continue; }
      // `#If`, `#ElseIf`, `#Else`, `#End If`, `#Const`: the `#` is part of the keyword
      if (i === 0 && t.kind === 'op' && t.text === '#' && /^(if|elseif|else|end|const)$/i.test(toks[1]?.text ?? '')) {
        out.push({ from: t.col - 1, to: toks[1].col - 1 + toks[1].text.length, cls: 'cm-vb-kw' });
        i++;
        continue;
      }
      switch (t.kind) {
        case 'keyword':
          // `String(5, "x")` / `Date` as functions keep the keyword colour; `As String` is a type
          if (TYPE_NAMES.has(low) && (afterAs || !(toks[i + 1]?.kind === 'op' && toks[i + 1].text === '('))) add(t, 'cm-vb-type');
          else add(t, STRUCTURE.has(low) ? 'cm-vb-kwb' : 'cm-vb-kw');
          break;
        case 'comment': out.push({ from: t.col - 1, to: line.length, cls: 'cm-vb-comment' }); break;
        case 'string': add(t, 'cm-vb-str'); break;
        case 'number': case 'date': add(t, 'cm-vb-num'); break;
        case 'ident': {
          const base = t.suffix ? low.slice(0, -1) : low;
          const procHead = prevKw === 'sub' || prevKw === 'function'
            || ((prevKw === 'let' || prevKw === 'set' || (prev?.kind === 'ident' && prev.text.toLowerCase() === 'get'))
              && toks[i - 2]?.kind === 'keyword' && toks[i - 2].text.toLowerCase() === 'property');
          if (procHead) add(t, 'cm-vb-proc');
          else if (afterAs) add(t, 'cm-vb-type');
          else if (afterDot) break;
          else if (CONSTANTS.has(base)) add(t, 'cm-vb-const');
          else if (names.has(base)) add(t, 'cm-vb-ctl');
          break;
        }
        default: break;
      }
    }
    return out;
  };
  // a trailing line continuation (` _`) is only valid with a following line: colour the line without it
  return run(line) ?? (/\s_\s*$/.test(line) ? run(line.replace(/\s_\s*$/, '')) : null) ?? [];
}

const CLASSES: SpanClass[] = ['cm-vb-kw', 'cm-vb-kwb', 'cm-vb-comment', 'cm-vb-str', 'cm-vb-num', 'cm-vb-type', 'cm-vb-proc', 'cm-vb-ctl', 'cm-vb-const'];
const marks = Object.fromEntries(CLASSES.map(c => [c, Decoration.mark({ class: c === 'cm-vb-kwb' ? 'cm-vb-kw cm-vb-kwb' : c })])) as Record<SpanClass, Decoration>;

/** Re-colours the visible lines (after the project's control / form names changed). */
export const refreshHighlight = StateEffect.define<null>();

/** Per-text span cache shared by the highlighter and the occurrence highlight; `sync` clears it when the names change. */
export class SpanCache {
  private map = new Map<string, Span[]>();
  private key = '';
  private ns: ReadonlySet<string> = new Set();
  constructor(private names: () => ReadonlySet<string>) {}
  /** Call once per rebuild: picks up renamed controls / forms. */
  sync(): void {
    const ns = this.names(), k = [...ns].sort().join(',');
    if (k !== this.key) { this.key = k; this.ns = ns; this.map.clear(); }
  }
  get(text: string): Span[] {
    let r = this.map.get(text);
    if (!r) {
      if (this.map.size > 20000) this.map.clear();
      this.map.set(text, r = vbSpans(text, this.ns));
    }
    return r;
  }
}

/** Syntax colouring of the visible lines (only these are tokenized, through `cache`). */
export function vbHighlight(cache: SpanCache): Extension {
  const build = (view: EditorView): DecorationSet => {
    cache.sync();
    const ranges = [];
    const doc = view.state.doc;
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const l = doc.lineAt(pos);
        for (const s of cache.get(l.text)) if (s.to > s.from) ranges.push(marks[s.cls].range(l.from + s.from, l.from + s.to));
        pos = l.to + 1;
      }
    }
    return Decoration.set(ranges, true);
  };
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some(t => t.effects.some(e => e.is(refreshHighlight)))) this.decorations = build(u.view);
    }
  }, { decorations: v => v.decorations });
}

const sizeThemes = new Map<number, Extension>();
/**
 * A palette (an editor class the theme below keys its colours off) and a font size. The size is a theme, not a style
 * attribute: CodeMirror re-measures its line heights when the theme changes (the margins stay aligned).
 */
export const editorLook = (palette: Palette, fontSize: number): Extension => {
  let size = sizeThemes.get(fontSize);
  if (!size) sizeThemes.set(fontSize, size = EditorView.theme({ '&': { fontSize: `${fontSize}px` } }));
  return [EditorView.editorAttributes.of({ class: `cm-vb-pal-${palette}` }), size];
};

const FONT = '"Courier New", Courier, monospace';
export const vbTheme: Extension = EditorView.baseTheme({
  '&': { fontFamily: FONT, fontSize: '13px', backgroundColor: '#fff', color: '#000', height: '100%' },
  '.cm-scroller': { fontFamily: FONT, overflow: 'auto', lineHeight: '1.45' },
  '.cm-content': { fontFamily: FONT, WebkitFontSmoothing: 'auto', textRendering: 'optimizeLegibility' },
  '&.cm-focused': { outline: 'none' },
  // the code is black on white in both palettes; Courier New is thin on a Mac screen, a hair of stroke makes it crisp
  '&.cm-vb-pal-vs .cm-content': { WebkitTextStroke: '0.2px currentColor' },
  '.cm-vb-comment': { color: '#008000' },
  '&.cm-vb-pal-vb6 .cm-vb-kw': { color: '#000080' },
  '&.cm-vb-pal-vs .cm-vb-kw': { color: '#0000FF' },
  '&.cm-vb-pal-vs .cm-vb-kwb': { WebkitTextStroke: '0.55px currentColor' },
  '&.cm-vb-pal-vs .cm-vb-str': { color: '#A31515' },
  '&.cm-vb-pal-vs .cm-vb-num': { color: '#098658' },
  '&.cm-vb-pal-vs .cm-vb-type': { color: '#2B91AF' },
  '&.cm-vb-pal-vs .cm-vb-proc': { color: '#000000', fontWeight: 'bold' },
  '&.cm-vb-pal-vs .cm-vb-ctl': { color: '#795E26' },
  '&.cm-vb-pal-vs .cm-vb-const': { color: '#6F008A' },
  '.cm-line.cm-vb-error, .cm-line.cm-vb-error span': { color: '#FF0000' },
  '.cm-line.cm-vb-error': { textDecoration: 'underline wavy #FF0000', textDecorationSkipInk: 'none', textUnderlineOffset: '2px' },
  '.cm-line.cm-vb-bp': { backgroundColor: '#800000', color: '#fff' },
  '.cm-line.cm-vb-bp span': { color: '#fff' },
  '.cm-line.cm-vb-break, .cm-line.cm-vb-bp.cm-vb-break': { backgroundColor: '#FFFF00', color: '#000' },
  '.cm-line.cm-vb-bp.cm-vb-break span': { color: '#000' },
  '.cm-line.cm-vb-procsep': { borderTop: '1px solid #b0b0b0' },
  '.cm-vb-margin': { width: '16px', backgroundColor: '#c0c0c0' },
  '.cm-vb-arrow': { color: '#000', textAlign: 'center' },
  '.cm-vb-mark': { position: 'relative', display: 'inline-block', width: '14px', textAlign: 'center' },
  '.cm-vb-bpdot': { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#800000', verticalAlign: 'middle' },
  '.cm-vb-bpdot + .cm-vb-arrow': { position: 'absolute', left: '0', right: '0', top: '0', color: '#FFFF00' },
  // outlining margin: VS-style boxed [+] / [-] and thin lines down each block
  '.cm-vb-fold': { width: '13px', backgroundColor: '#fff' },
  '.cm-vb-fold .cm-gutterElement': { position: 'relative', padding: '0' },
  '.cm-vb-ol': { position: 'absolute', inset: '0', cursor: 'default' },
  '.cm-vb-ol-top, .cm-vb-ol-bot': { position: 'absolute', left: '6px', width: '0', borderLeft: '1px solid #a5a5a5' },
  '.cm-vb-ol-top': { top: '0', height: '50%' },
  '.cm-vb-ol-bot': { top: '50%', bottom: '0' },
  '.cm-vb-ol-tick': { position: 'absolute', left: '6px', top: '50%', width: '5px', borderTop: '1px solid #a5a5a5' },
  '.cm-vb-ol-box': {
    position: 'absolute', left: '2px', top: 'calc(50% - 4.5px)', width: '9px', height: '9px', boxSizing: 'border-box',
    border: '1px solid #919191', backgroundColor: '#fff', cursor: 'pointer', zIndex: '1',
  },
  '.cm-vb-ol-box::before, .cm-vb-ol-box.cm-vb-ol-plus::after': { content: '""', position: 'absolute', backgroundColor: '#222' },
  '.cm-vb-ol-box::before': { left: '1px', right: '1px', top: '3px', height: '1px' },
  '.cm-vb-ol-box.cm-vb-ol-plus::after': { top: '1px', bottom: '1px', left: '3px', width: '1px' },
  '.cm-vb-foldph': {
    display: 'inline-block', border: '1px solid #a5a5a5', color: '#808080', padding: '0 3px', margin: '0 4px',
    lineHeight: '1.1', fontSize: '0.9em', cursor: 'pointer', WebkitTextStroke: '0', verticalAlign: 'baseline',
  },
  '.cm-vb-foldph:hover': { backgroundColor: '#e8e8e8' },
  '.cm-gutters': { borderRight: 'none', backgroundColor: '#fff' },
  // matching block keyword under the cursor, and the other occurrences of the identifier under it
  '.cm-vb-kwmatch': { outline: '1px solid #9e9e9e', backgroundColor: '#ececec', borderRadius: '1px' },
  '.cm-vb-occur': { backgroundColor: '#e2e2e2' },
});
