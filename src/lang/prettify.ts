// VB6-style line prettifier: keyword / built-in casing and spacing.
//
// The IDE code window calls `prettifyLine` when the cursor leaves a line and
// uses `KEYWORD_CASE` for syntax colouring. The text is rebuilt from the
// lexer's tokens (strings, comments, numbers and dates keep their exact text),
// and the result is checked by re-lexing: if the token sequence would differ
// in any way the line is returned unchanged, so prettifying can never corrupt
// code.
//
// Rules (VB6 behaviour):
// - keywords, built-in functions, constants: canonical casing (KEYWORD_CASE);
//   declared names: the spelling in `known` (see collectIdentifiers);
//   names after `.` / `!` are left alone (plan 02 fixes control properties),
//   except `Debug.Print` and `Debug.Assert`.
// - one space around binary operators, none after a unary +/-; one space
//   after `,` and `;`, none before; none inside parentheses; none around `.`;
//   `:=` unspaced; `:` is written as `: ` (a label `Name:` stays as is).
// - no space between a name and `(` (`a(1)`, `Foo(1, 2)`), except a call
//   statement `Foo (1), 2` where the space changes the meaning; the original
//   spacing is kept there. Keywords before `(` are followed by a space
//   (`If (a)`, `Not (a)`), except the function-like `String(`, `Date(`, `Error(`.
// - a trailing comment keeps the whitespace written before it (at least one
//   space); comment text is untouched apart from trailing whitespace.
// - leading indentation is kept exactly, trailing whitespace is removed,
//   whitespace-only lines become empty.
// - a line ending in a line continuation keeps its ` _`; each physical line is
//   prettified on its own (a continuation line that starts with + or - keeps
//   the original spacing after it, since it cannot be known whether it is unary).
// - lines the lexer rejects (unterminated string, ...) are returned unchanged.

import { tokenize } from './lexer';
import { KEYWORDS, type Token } from './tokens';
import { VBSyntaxError } from './errors';
import { CANONICAL_NAMES } from './builtins';

// ---------------------------------------------------------------- KEYWORD_CASE

const KEYWORD_SPELLING: Record<string, string> = {
  byval: 'ByVal', byref: 'ByRef', elseif: 'ElseIf', goto: 'GoTo', gosub: 'GoSub', typeof: 'TypeOf',
  redim: 'ReDim', withevents: 'WithEvents', paramarray: 'ParamArray', raiseevent: 'RaiseEvent',
};

/** Names that are neither keywords nor registered built-ins but have a fixed VB6 spelling. */
const EXTRA_NAMES = ['Debug', 'Print', 'Tab', 'Spc', 'LSet', 'RSet', 'Collection', 'PSet', 'Line', 'Circle', 'Scale', 'Cls'];

/** Identifiers that are keywords inside a file statement (VB6 colours them): the statement word, and Open's clauses. */
const FILE_STATEMENT_WORDS = new Set(['print', 'write', 'input', 'get', 'put', 'seek']);
const OPEN_WORDS = new Set(['input', 'output', 'append', 'binary', 'random', 'access', 'read', 'write', 'shared', 'lock', 'len']);

/**
 * Indexes of the identifier tokens that act as keywords in a file statement: `Print #`, `Line Input #`, `Get #`, ...,
 * `Name ... As`, and in `Open ... For Input Access Read Lock Write As #1 Len = 8` the mode and clause words; also the
 * `LSet` / `RSet` of `LSet s = value` (identifiers to the lexer too), and the `Get` of `Property Get`.
 */
export function fileStatementWords(tokens: Token[]): Set<number> {
  const out = new Set<number>();
  let start = true;
  let open: '' | 'path' | 'for' | 'as' = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const l = t.text.toLowerCase();
    if (t.kind === 'newline' || t.kind === 'colon' || (t.kind === 'keyword' && (l === 'then' || l === 'else'))) { start = true; open = ''; continue; }
    if (start && t.kind === 'ident' && !t.suffix) {
      const next = tokens[i + 1];
      const hash = (n: Token | undefined) => n?.kind === 'op' && n.text === '#';
      if (FILE_STATEMENT_WORDS.has(l) && hash(next)) out.add(i);
      else if (l === 'line' && next?.kind === 'ident' && next.text.toLowerCase() === 'input' && hash(tokens[i + 2])) { out.add(i); out.add(i + 1); }
      else if (l === 'name' && tokens.slice(i + 1).some(x => x.kind === 'keyword' && x.text.toLowerCase() === 'as')) out.add(i);
      else if ((l === 'lset' || l === 'rset') && next?.kind === 'ident') out.add(i);
    }
    if (t.kind === 'ident' && !t.suffix && l === 'get' && tokens[i - 1]?.kind === 'keyword' && tokens[i - 1].text.toLowerCase() === 'property') out.add(i);
    if (t.kind === 'keyword' && l === 'open' && start) open = 'path';
    else if (open && t.kind === 'keyword' && (l === 'for' || l === 'as')) open = l === 'for' ? 'for' : 'as';
    // the mode and Access / Lock words after `For`, `Len` after `As #n`
    else if (t.kind === 'ident' && !t.suffix && (open === 'for' && OPEN_WORDS.has(l) && l !== 'len' || open === 'as' && l === 'len')) out.add(i);
    start = false;
  }
  return out;
}

/** Built-ins that also exist as `$` string variants (`Left$`). */
const DOLLAR_FUNCTIONS = [
  'Left', 'Right', 'Mid', 'Trim', 'LTrim', 'RTrim', 'UCase', 'LCase', 'Space', 'String', 'Chr', 'ChrW',
  'Hex', 'Oct', 'Format', 'Str', 'Error', 'Command', 'Environ', 'Time', 'Date', 'MonthName', 'WeekdayName',
];

/**
 * Lower-case name -> canonical VB6 spelling, for every keyword, built-in
 * function (also the `$` variants, keyed `left$`) and built-in constant.
 * The spelling of functions and constants is owned by the definitions in
 * builtins/ (CANONICAL_NAMES); keywords are derived from KEYWORDS.
 */
export const KEYWORD_CASE: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const k of KEYWORDS) m.set(k, KEYWORD_SPELLING[k] ?? k.charAt(0).toUpperCase() + k.slice(1));
  for (const n of EXTRA_NAMES) m.set(n.toLowerCase(), n);
  for (const [k, v] of CANONICAL_NAMES) if (!m.has(k)) m.set(k, v);
  for (const f of DOLLAR_FUNCTIONS) m.set(f.toLowerCase() + '$', f + '$');
  return m;
})();

// ---------------------------------------------------------------- prettifyLine

/** Keywords that end an operand: a following +/- is binary. */
const OPERAND_KEYWORDS = new Set(['true', 'false', 'nothing', 'empty', 'null', 'me']);
/** Function-like keywords: `String(5, "x")` has no space before `(`. */
const CALL_KEYWORDS = new Set(['string', 'date', 'error']);
/** After these a new statement starts (single-line If). */
const STATEMENT_STARTERS = new Set(['then', 'else']);

const isOp = (t: Token | undefined, s: string): boolean => !!t && t.kind === 'op' && t.text === s;
const baseOf = (t: Token): string => (t.suffix && t.kind === 'ident' ? t.text.slice(0, -1) : t.text);

/** Comparable form of a token: kind plus text (identifiers/keywords case-insensitively). */
function signature(tokens: Token[]): string[] {
  return tokens.map(t => {
    switch (t.kind) {
      case 'string': case 'date': case 'number': return `${t.kind}\0${t.text}`;
      case 'comment': return `comment\0${t.text.trimEnd().replace(/^rem(?![\p{L}\p{N}_])/iu, 'Rem')}`;
      default: return `${t.kind}\0${t.text.toLowerCase()}`;
    }
  });
}

/** `a (1) = 2`: the `(` at `open` is an array index whose `)` is followed by `=`. */
function assignsElement(tokens: Token[], open: number): boolean {
  let depth = 0;
  for (let j = open; j < tokens.length; j++) {
    if (isOp(tokens[j], '(')) depth++;
    else if (isOp(tokens[j], ')') && --depth === 0) return isOp(tokens[j + 1], '=');
  }
  return false;
}

function prettifyPhysicalLine(line: string, known: Map<string, string>): string {
  const indent = /^[ \t]*/.exec(line)![0];
  const body = line.slice(indent.length).trimEnd();
  if (body === '') return '';

  let tokens: Token[];
  try {
    tokens = tokenize(body);
  } catch (e) {
    if (e instanceof VBSyntaxError) return line;
    throw e;
  }
  tokens.pop(); // eof
  if (tokens.some(t => t.kind === 'newline')) return line;

  const start = (t: Token) => t.col - 1;
  const end = (t: Token) => t.col - 1 + t.text.length;

  // Line continuation: the lexer swallowed a trailing `_`.
  const last = tokens[tokens.length - 1];
  const tail = body.slice(last ? end(last) : 0).trim();
  const continued = tail === '_' && last?.kind !== 'comment';
  if (tail !== '' && !continued) return line;

  const parts: string[] = [];
  let prev: Token | undefined;
  let prevUnary = false;
  let gfx = '';             // in a drawing statement (its word): `Line (x1, y1)-Step(x2, y2)` is written as VB6 does
  let head = true;          // the statement so far is just a leading name (a.b.c)
  let prevHead = false;     // prev is the last name of that leading chain

  const fileWords = fileStatementWords(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const orig = prev ? body.slice(end(prev), start(t)) : '';
    const lower = t.text.toLowerCase();
    let text = t.text;
    let unary = false;

    // ---- casing
    if (t.kind === 'keyword') {
      text = KEYWORD_CASE.get(lower) ?? t.text;
    } else if (fileWords.has(i)) {
      text = KEYWORD_CASE.get(lower) ?? t.text[0].toUpperCase() + lower.slice(1);   // Print #, Line Input #, Output, LSet ...
    } else if (t.kind === 'ident') {
      const afterMember = prev && (isOp(prev, '.') || isOp(prev, '!'));
      if (afterMember) {
        const before = tokens[i - 2];
        if (isOp(prev, '.') && before?.kind === 'ident' && !before.suffix && before.text.toLowerCase() === 'debug' && (lower === 'print' || lower === 'assert')) text = lower === 'print' ? 'Print' : 'Assert';
      } else {
        const key = baseOf(t).toLowerCase();
        const cased = known.get(key) ?? (t.suffix ? KEYWORD_CASE.get(key + t.suffix) : undefined) ?? KEYWORD_CASE.get(key);
        if (cased !== undefined) text = t.suffix && !cased.endsWith(t.suffix) ? cased + t.suffix : cased;
      }
    } else if (t.kind === 'comment' && /^rem(?![\p{L}\p{N}_])/iu.test(t.text)) {
      text = 'Rem' + t.text.slice(3);
    }
    if (t.kind === 'comment') text = text.trimEnd();

    // ---- unary +/-
    const gfxDash = (gfx === 'line' || gfx === 'scale') && isOp(t, '-') && (isOp(prev, ')') || (prev?.kind === 'ident' && prev.text.toLowerCase() === gfx));
    if (gfxDash) unary = true;
    else if (t.kind === 'op' && (t.text === '+' || t.text === '-')) {
      if (!prev) {
        unary = next !== undefined && body.slice(end(t), start(next)) === '';
        // a leading +/- (continuation line) keeps the written spacing
      } else if (prev.kind === 'colon') unary = true;
      else if (prev.kind === 'op') unary = prev.text !== ')';
      else if (prev.kind === 'keyword') unary = !OPERAND_KEYWORDS.has(prev.text.toLowerCase());
      else if (prev.kind === 'ident' && prevHead && orig !== '' && next !== undefined && body.slice(end(t), start(next)) === '') unary = true; // `Foo -1`
    }

    // ---- separator before this token
    let sep = ' ';
    if (!prev) sep = '';
    else if (t.kind === 'comment') sep = prev.kind === 'colon' ? ' ' : orig === '' ? ' ' : orig;
    else if (prev.kind === 'colon') sep = ' ';
    else if (t.kind === 'colon') sep = '';
    else if (gfxDash) sep = isOp(prev, ')') ? '' : ' ';
    else if (prevUnary) sep = '';
    else if (gfx && isOp(t, '(') && kw(prev, 'step')) sep = '';
    else if (prev.kind === 'op' && (prev.text === '(' || prev.text === '.' || prev.text === '!' || prev.text === '#' || prev.text === ':=')) sep = '';
    else if (t.kind === 'op') {
      switch (t.text) {
        case ',': sep = isOp(prev, ',') ? ' ' : ''; break; // `MsgBox "x", , "t"`
        case ')': case ';': case ':=': sep = ''; break;
        case '.': case '!':
          sep = prev.kind === 'op' && prev.text !== ')' ? ' ' : orig === '' ? '' : ' ';
          break;
        case '(':
          // `As Integer()` (a Function returning an array) has no space, like a call
          if (prev.kind === 'keyword') sep = CALL_KEYWORDS.has(prev.text.toLowerCase()) || kw(tokens[i - 2], 'as') ? '' : ' ';
          else if (prev.kind === 'ident') sep = prevHead && !assignsElement(tokens, i) ? (orig === '' ? '' : ' ') : '';
          else if (isOp(prev, ')')) sep = orig === '' ? '' : ' ';
          break;
        default: break;
      }
    }
    parts.push(sep, text);

    // ---- statement bookkeeping
    if (t.kind === 'ident' && head && (lower === 'line' || lower === 'scale' || lower === 'pset' || lower === 'circle')) gfx = lower;
    if (t.kind === 'colon') gfx = '';
    if (t.kind === 'colon' || (t.kind === 'keyword' && STATEMENT_STARTERS.has(lower))) { head = true; prevHead = false; }
    else {
      if (!(t.kind === 'ident' || isOp(t, '.') || (t.kind === 'keyword' && lower === 'me'))) head = false;
      prevHead = head && t.kind === 'ident';
    }
    prev = t;
    prevUnary = unary;
  }

  if (continued) parts.push(tokens.length ? ' _' : '_');
  const result = indent + parts.join('');

  // Safety net: the token sequence must be identical.
  try {
    const a = signature(tokens);
    const again = tokenize(result.slice(indent.length));
    again.pop();
    const b = signature(again);
    if (a.length !== b.length || a.some((s, i) => s !== b[i])) return line;
  } catch (e) {
    if (e instanceof VBSyntaxError) return line;
    throw e;
  }
  return result;
}

/**
 * Prettifies one line of VB code (see the rules at the top of this file).
 * `known` maps lower-case names to their declared spelling (collectIdentifiers).
 * Text containing line breaks is prettified line by line, the breaks are kept.
 */
export function prettifyLine(line: string, known: Map<string, string>): string {
  if (!/[\r\n]/.test(line)) return prettifyPhysicalLine(line, known);
  return line.split(/(\r\n|\n|\r)/).map((s, i) => (i % 2 ? s : prettifyPhysicalLine(s, known))).join('');
}

// ---------------------------------------------------------- collectIdentifiers

/** Tokens of the whole source; a line the lexer rejects is blanked and lexing resumes. */
function tolerantTokens(source: string): Token[] {
  let src = source;
  for (let attempt = 0; attempt < 1000; attempt++) {
    try {
      return tokenize(src);
    } catch (e) {
      if (!(e instanceof VBSyntaxError)) throw e;
      const lines = src.split('\n');
      const i = e.line - 1;
      if (i < 0 || i >= lines.length || lines[i].replace(/\r$/, '') === '') break;
      lines[i] = lines[i].endsWith('\r') ? '\r' : '';
      src = lines.join('\n');
    }
  }
  return [];
}

const MODIFIERS = new Set(['private', 'public', 'static', 'global', 'friend']);
const kw = (t: Token | undefined, ...words: string[]): boolean => !!t && t.kind === 'keyword' && words.includes(t.text.toLowerCase());

/**
 * Names (lower case -> first spelling) declared in `source`: Dim / Private /
 * Public / Static / Const variables, Sub / Function names and parameters, Type
 * and Enum names and members. Works on source with syntax errors (token scan).
 */
export function collectIdentifiers(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const add = (t: Token | undefined) => {
    if (!t || t.kind !== 'ident') return;
    const name = baseOf(t);
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, name);
  };

  // split into statements at newlines and colons
  const statements: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tolerantTokens(source)) {
    if (t.kind === 'newline' || t.kind === 'colon' || t.kind === 'eof') { statements.push(cur); cur = []; }
    else if (t.kind !== 'comment') cur.push(t);
  }
  statements.push(cur);

  /** Declarators `a(1 To 3) As T, b = 1, c$` starting at `from`. */
  const declarators = (toks: Token[], from: number) => {
    let depth = 0;
    let expecting = true;
    for (let i = from; i < toks.length; i++) {
      const t = toks[i];
      if (isOp(t, '(')) depth++;
      else if (isOp(t, ')')) depth--;
      else if (depth === 0 && isOp(t, ',')) expecting = true;
      else if (expecting && depth === 0) {
        if (kw(t, 'withevents', 'preserve', 'optional', 'byval', 'byref', 'paramarray')) continue;
        if (t.kind === 'ident' && !isOp(toks[i - 1], '.')) add(t);
        expecting = false;
      }
    }
  };

  /** `(ByVal a As T, Optional b, c())` parameter list starting at the `(` at `open`. */
  const parameters = (toks: Token[], open: number) => {
    let depth = 0;
    let expecting = true;
    for (let i = open; i < toks.length; i++) {
      const t = toks[i];
      if (isOp(t, '(')) { depth++; if (depth === 1) expecting = true; }
      else if (isOp(t, ')')) { depth--; if (depth <= 0) break; }
      else if (depth === 1 && isOp(t, ',')) expecting = true;
      else if (expecting && depth === 1) {
        if (kw(t, 'optional', 'byval', 'byref', 'paramarray')) continue;
        add(t);
        expecting = false;
      }
    }
  };

  let inBlock: 'type' | 'enum' | null = null;
  for (const toks of statements) {
    if (toks.length === 0) continue;
    let i = 0;
    while (i < toks.length && kw(toks[i], ...MODIFIERS)) i++;
    const first = toks[i];
    if (!first) continue;
    if (kw(first, 'end') && kw(toks[i + 1], 'type', 'enum')) { inBlock = null; continue; }
    if (inBlock) {
      if (first.kind === 'ident') add(first);
      continue;
    }
    if (kw(first, 'dim', 'const')) declarators(toks, i + 1);
    else if (kw(first, 'sub', 'function')) {
      add(toks[i + 1]);
      const open = toks.findIndex((t, j) => j > i + 1 && isOp(t, '('));
      if (open >= 0) parameters(toks, open);
    } else if (kw(first, 'type', 'enum')) {
      add(toks[i + 1]);
      inBlock = first.text.toLowerCase() as 'type' | 'enum';
    } else if (i > 0 && first.kind === 'ident') {
      // `Private x As Long`: modifier directly followed by a name
      declarators(toks, i);
    }
  }
  return found;
}
