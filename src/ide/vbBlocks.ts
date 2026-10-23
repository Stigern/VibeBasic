// Block structure of VB source for the code window: foldable blocks (procedures, If, loops, Select Case and its Case
// sections, With, Type / Enum, runs of 3+ comment lines), the keywords that belong together (If / ElseIf / Else /
// End If ...) and the openers that still lack their End line. A line-based scanner that tolerates syntax errors:
// strings and comments are masked, `:` separates statements, ` _` continues a logical line.
//
// Performance: each line's classification is memoised by its text, so a rescan after a keystroke is a cheap pass of
// map lookups and a stack walk; the result is cached per document (CodeMirror Text) and only computed when asked.
import type { EditorState, Text } from '@codemirror/state';

export type BlockKind = 'proc' | 'if' | 'for' | 'do' | 'while' | 'select' | 'case' | 'with' | 'type' | 'enum' | 'comment';
/** A keyword on a line: 1-based line, 0-based columns within the line. */
export interface KwRange { line: number; from: number; to: number }
export interface Block {
  kind: BlockKind;
  /** First line of the opener (1-based). */
  start: number;
  /** Last line of the opener (a continued header spans several lines); the fold starts at its end. */
  headEnd: number;
  /** Last line of the block (the End line; for a Case section the line before the next Case). */
  end: number;
  /** Keywords that belong together: opener, ElseIf / Else / Case, closer. */
  keys: KwRange[];
  /** `End Sub`, `Next`, ... (the line that closes the block). */
  closer: string;
}
export interface BlockScan {
  /** Closed blocks with at least one hidden line, sorted by start. */
  blocks: Block[];
  /** Outermost closed block per opener start line. */
  byStart: Map<number, Block>;
  /** Start lines of openers that have no matching End line (missing End Sub, End If, Next, ...). */
  unclosed: Map<number, string>;
  /** above[L]: blocks with start < L <= end; below[L]: blocks with start <= L < end (outlining margin lines). */
  above: Int32Array;
  below: Int32Array;
  /** Block keywords per line, for the matching-keyword highlight. */
  keysByLine: Map<number, { from: number; to: number; block: Block }[]>;
}

type Ev =
  | { op: 'open'; kind: Exclude<BlockKind, 'case' | 'comment'>; at: number; len: number; closer: string }
  | { op: 'close'; kind: Exclude<BlockKind, 'case' | 'comment'>; at: number; len: number; n: number }
  | { op: 'mid'; at: number; len: number }
  | { op: 'case'; at: number; len: number };
interface LineInfo { evs: Ev[]; commentOnly: boolean; blank: boolean }

const MODS = String.raw`(?:(?:Public|Private|Friend|Static)\s+)*`;
const RX = {
  proc: new RegExp(String.raw`^${MODS}(Sub|Function|Property\s+(?:Get|Let|Set))\s+[A-Za-z_]`, 'i'),
  endProc: /^End\s+(Sub|Function|Property)\b/i,
  typeEnum: /^(?:(?:Public|Private)\s+)?(Type|Enum)\s+[A-Za-z_]/i,
  endTypeEnum: /^End\s+(Type|Enum)\b/i,
  if: /^If\b/i,
  then: /\bThen\b/i,
  elseIf: /^ElseIf\b/i,
  else: /^Else\b/i,
  endIf: /^End\s*If\b/i,
  for: /^For(\s+Each)?\b/i,
  next: /^Next\b/i,
  do: /^Do\b/i,
  loop: /^Loop\b/i,
  while: /^While\b/i,
  wend: /^Wend\b/i,
  select: /^Select\s+Case\b/i,
  case: /^Case\b/i,
  endSelect: /^End\s+Select\b/i,
  with: /^With\b/i,
  endWith: /^End\s+With\b/i,
  rem: /^Rem\b/i,
  lineNo: /^\d+\s+/,
};
const PROC_CLOSER: Record<string, string> = { sub: 'End Sub', function: 'End Function' };

/** Masks string contents and the comment with spaces (offsets are kept); `comment` is true when there was one. */
function mask(text: string): { code: string; comment: boolean } {
  let out = '', comment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      out += ' ';
      for (i++; i < text.length && text[i] !== '\n'; i++) {
        if (text[i] === '"') { if (text[i + 1] === '"') { out += '  '; i++; continue; } break; }
        out += ' ';
      }
      if (i < text.length) out += text[i] === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === "'") {
      comment = true;
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
      if (i < text.length) out += '\n';
      continue;
    }
    out += c;
  }
  return { code: out, comment };
}

/** Events of one logical line (offsets into `text`). */
export function classifyLine(text: string): LineInfo {
  const { code, comment } = mask(text);
  if (!code.trim()) return { evs: [], commentOnly: comment, blank: !comment };
  if (RX.rem.test(code.trimStart())) return { evs: [], commentOnly: true, blank: false };
  const evs: Ev[] = [];
  // statements: split on `:` that is not `:=`
  const stmts: { s: string; at: number }[] = [];
  let st = 0;
  for (let i = 0; i <= code.length; i++) {
    if (i === code.length || (code[i] === ':' && code[i + 1] !== '=')) { stmts.push({ s: code.slice(st, i), at: st }); st = i + 1; }
  }
  for (const { s: raw, at: base } of stmts) {
    let lead = raw.length - raw.trimStart().length;
    let s = raw.trimStart();
    const ln = RX.lineNo.exec(s);
    if (ln) { lead += ln[0].length; s = s.slice(ln[0].length); }
    const at = base + lead;
    let m: RegExpExecArray | null;
    if (!s) continue;
    if (RX.rem.test(s)) break;
    if ((m = RX.endProc.exec(s))) evs.push({ op: 'close', kind: 'proc', at, len: m[0].length, n: 1 });
    else if ((m = RX.proc.exec(s))) {
      const from = m[0].search(/Sub|Function|Property/i);   // after the Public / Private ... modifiers
      const w = m[1].split(/\s/)[0].toLowerCase();
      evs.push({ op: 'open', kind: 'proc', at: at + from, len: m[1].length, closer: PROC_CLOSER[w] ?? 'End Property' });
    } else if ((m = RX.endTypeEnum.exec(s))) evs.push({ op: 'close', kind: m[1].toLowerCase() as 'type' | 'enum', at, len: m[0].length, n: 1 });
    else if ((m = RX.typeEnum.exec(s))) {
      const kind = m[1].toLowerCase() as 'type' | 'enum';
      evs.push({ op: 'open', kind, at: at + m[0].toLowerCase().lastIndexOf(kind), len: kind.length, closer: kind === 'type' ? 'End Type' : 'End Enum' });
    } else if ((m = RX.endIf.exec(s))) evs.push({ op: 'close', kind: 'if', at, len: m[0].length, n: 1 });
    else if (RX.if.test(s)) {
      // multi-line If only when nothing but blanks follows Then on the whole logical line
      const rest = code.slice(at);
      const t = RX.then.exec(rest);
      if (t && !rest.slice(t.index + 4).trim()) evs.push({ op: 'open', kind: 'if', at, len: 2, closer: 'End If' });
      break;   // a single-line If owns the rest of the line
    } else if ((m = RX.elseIf.exec(s))) {
      evs.push({ op: 'mid', at, len: m[0].length });
      break;
    } else if ((m = RX.else.exec(s))) evs.push({ op: 'mid', at, len: m[0].length });
    else if ((m = RX.for.exec(s))) evs.push({ op: 'open', kind: 'for', at, len: m[0].length, closer: 'Next' });
    else if ((m = RX.next.exec(s))) {
      const vars = s.slice(m[0].length).split(',').filter(v => v.trim()).length;
      evs.push({ op: 'close', kind: 'for', at, len: m[0].length, n: Math.max(1, vars) });
    } else if ((m = RX.do.exec(s))) evs.push({ op: 'open', kind: 'do', at, len: 2, closer: 'Loop' });
    else if ((m = RX.loop.exec(s))) evs.push({ op: 'close', kind: 'do', at, len: 4, n: 1 });
    else if ((m = RX.while.exec(s))) evs.push({ op: 'open', kind: 'while', at, len: 5, closer: 'Wend' });
    else if ((m = RX.wend.exec(s))) evs.push({ op: 'close', kind: 'while', at, len: 4, n: 1 });
    else if ((m = RX.select.exec(s))) evs.push({ op: 'open', kind: 'select', at, len: m[0].length, closer: 'End Select' });
    else if ((m = RX.endSelect.exec(s))) evs.push({ op: 'close', kind: 'select', at, len: m[0].length, n: 1 });
    else if ((m = RX.case.exec(s))) evs.push({ op: 'case', at, len: 4 });
    else if ((m = RX.with.exec(s))) evs.push({ op: 'open', kind: 'with', at, len: 4, closer: 'End With' });
    else if ((m = RX.endWith.exec(s))) evs.push({ op: 'close', kind: 'with', at, len: m[0].length, n: 1 });
  }
  return { evs, commentOnly: false, blank: false };
}

const memo = new Map<string, LineInfo>();
function classifyMemo(text: string): LineInfo {
  let r = memo.get(text);
  if (!r) {
    if (memo.size > 50000) memo.clear();
    memo.set(text, r = classifyLine(text));
  }
  return r;
}

const continues = (t: string) => /(^|\s)_\s*$/.test(t);

interface Open { kind: BlockKind; start: number; headEnd: number; keys: KwRange[]; closer: string }

/** Scans `count` lines (1-based accessor). */
export function scanBlocks(lineText: (n: number) => string, count: number): BlockScan {
  const blocks: Block[] = [];
  const unclosed = new Map<number, string>();
  const stack: Open[] = [];
  let commentRun = 0;   // start line of the current run of comment-only lines (0: none)
  const endRun = (last: number) => {
    if (commentRun && last - commentRun >= 2) blocks.push({ kind: 'comment', start: commentRun, headEnd: commentRun, end: last, keys: [], closer: '' });
    commentRun = 0;
  };
  const finish = (o: Open, end: number, closeKey: KwRange | null) => {
    if (closeKey) o.keys.push(closeKey);
    if (end > o.headEnd) blocks.push({ kind: o.kind, start: o.start, headEnd: o.headEnd, end, keys: o.keys, closer: o.closer });
  };
  const drop = (o: Open) => { if (o.kind !== 'case') unclosed.set(o.start, o.closer); };
  /** Pops to the innermost open block of `kind`; false when there is none (a stray closer). */
  const closeTo = (kind: BlockKind, end: number, key: KwRange | null): boolean => {
    let i = stack.length - 1;
    while (i >= 0 && stack[i].kind !== kind) i--;
    if (i < 0) return false;
    while (stack.length - 1 > i) {
      const o = stack.pop()!;
      if (o.kind === 'case') finish(o, end - 1, null); else drop(o);
    }
    finish(stack.pop()!, end, key);
    return true;
  };

  for (let n = 1; n <= count; n++) {
    let text = lineText(n);
    const a = n;
    // a logical line: join continued physical lines (the `_` becomes a blank, offsets are kept)
    const starts = [0];
    while (continues(text) && n < count) {
      text = text.replace(/_(\s*)$/, ' $1') + '\n';
      starts.push(text.length);
      text += lineText(++n);
    }
    const b = n;
    const info = a === b ? classifyMemo(text) : classifyLine(text);
    const pos = (off: number): { line: number; col: number } => {
      let i = starts.length - 1;
      while (i > 0 && starts[i] > off) i--;
      return { line: a + i, col: off - starts[i] };
    };
    const key = (at: number, len: number): KwRange => { const p = pos(at); return { line: p.line, from: p.col, to: p.col + len }; };

    if (info.commentOnly && a === b) { if (!commentRun) commentRun = a; continue; }
    endRun(a - 1);
    for (const e of info.evs) {
      if (e.op === 'open') {
        if (e.kind === 'proc') while (stack.length) { const o = stack.pop()!; if (o.kind === 'case') finish(o, a - 1, null); else drop(o); }
        stack.push({ kind: e.kind, start: a, headEnd: b, keys: [key(e.at, e.len)], closer: e.closer });
      } else if (e.op === 'close') {
        for (let k = 0; k < e.n; k++) closeTo(e.kind, b, k === 0 ? key(e.at, e.len) : null);
        // a closer on the opener's own line (`Do: Loop`) leaves no block
      } else if (e.op === 'mid') {
        const top = stack[stack.length - 1];
        if (top?.kind === 'if') top.keys.push(key(e.at, e.len));
      } else {   // Case
        const top = stack[stack.length - 1];
        if (top?.kind === 'case') { finish(stack.pop()!, a - 1, null); }
        const sel = stack[stack.length - 1];
        if (sel?.kind === 'select') {
          sel.keys.push(key(e.at, e.len));
          stack.push({ kind: 'case', start: a, headEnd: b, keys: [], closer: '' });
        }
      }
    }
    // End Select also ends the open Case section (closeTo finishes sections above the Select at end - 1)
  }
  endRun(count);
  while (stack.length) drop(stack.pop()!);

  blocks.sort((x, y) => x.start - y.start || y.end - x.end);
  const byStart = new Map<number, Block>();
  for (const bl of blocks) if (!byStart.has(bl.start)) byStart.set(bl.start, bl);
  const above = new Int32Array(count + 2), below = new Int32Array(count + 2);
  const keysByLine = new Map<number, { from: number; to: number; block: Block }[]>();
  for (const bl of blocks) {
    above[bl.start + 1]++; above[bl.end + 1]--;
    below[bl.start]++; below[bl.end]--;
  }
  for (let i = 1; i <= count + 1; i++) { above[i] += above[i - 1]; below[i] += below[i - 1]; }
  for (const bl of blocks) for (const k of bl.keys) {
    let l = keysByLine.get(k.line);
    if (!l) keysByLine.set(k.line, l = []);
    l.push({ from: k.from, to: k.to, block: bl });
  }
  return { blocks, byStart, unclosed, above, below, keysByLine };
}

const cache = new WeakMap<Text, BlockScan>();
/** The block structure of a state's document (computed once per document version, on demand). */
export function blocksOf(state: EditorState): BlockScan {
  const doc = state.doc;
  let r = cache.get(doc);
  if (!r) {
    const lines: string[] = [];
    for (const it = doc.iterLines(); !it.next().done;) lines.push(it.value);
    cache.set(doc, r = scanBlocks(n => lines[n - 1] ?? '', lines.length));
  }
  return r;
}

/** Innermost closed block whose lines contain `line` (1-based), optionally of the given kinds. */
export function innermostBlock(scan: BlockScan, line: number, skip: ReadonlySet<BlockKind> = new Set()): Block | null {
  let best: Block | null = null;
  for (const b of scan.blocks) {
    if (b.start > line) break;
    if (line <= b.end && !skip.has(b.kind) && (!best || b.start >= best.start)) best = b;
  }
  return best;
}
