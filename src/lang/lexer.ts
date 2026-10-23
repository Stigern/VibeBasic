import { VBSyntaxError } from './errors';
import { KEYWORDS, type Token, type TokenKind } from './tokens';

/*
 * Lexer notes:
 * - Newlines: one `newline` token per physical line break; consecutive blank
 *   lines are NOT collapsed (the parser skips empty statements). The last line
 *   has no trailing `newline` unless the source itself ends with a line break.
 * - Line continuation (` _` at end of line) emits no token; following tokens
 *   keep their real physical line/col.
 * - A keyword directly after `.` is a member name and becomes `ident`
 *   (x.Close, Err.Error, .Load). A keyword with a type suffix (String$) is an `ident`.
 * - `Rem` is a comment only at the start of a statement.
 * - Hex/octal literals follow VB6 sign rules: &HFFFF = -1 (Integer, up to 4 hex
 *   digits), &HFFFF& = 65535 (Long), &H80000005 = -2147483643 (Long).
 */

type Suffix = NonNullable<Token['suffix']>;

/** What a date literal has besides digits: a date separator or a colon between digits, or a month name. */
const DATE_SHAPE = /\d\s*[/-]\s*\d|\d\s*:\s*\d|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => /\p{L}/u.test(c);
const isIdentPart = (c: string) => /[\p{L}\p{N}_]/u.test(c);
const isHex = (c: string) => /[0-9a-fA-F]/.test(c);
const isOct = (c: string) => c >= '0' && c <= '7';
const isSuffix = (c: string): c is Suffix => c === '%' || c === '&' || c === '!' || c === '#' || c === '$';

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;

  const colAt = (p: number) => p - lineStart + 1;
  const fail = (msg: string, p: number): never => { throw new VBSyntaxError(msg, line, colAt(p)); };
  const push = (kind: TokenKind, text: string, start: number, extra: Partial<Token> = {}) =>
    out.push({ kind, text, line, col: colAt(start), ...extra });
  const atStatementStart = () => {
    const last = out[out.length - 1];
    return !last || last.kind === 'newline' || last.kind === 'colon';
  };
  const newlineLen = (p: number) => (src[p] === '\r' && src[p + 1] === '\n' ? 2 : src[p] === '\n' || src[p] === '\r' ? 1 : 0);

  while (pos < n) {
    const c = src[pos];
    const start = pos;

    // line breaks
    const nl = newlineLen(pos);
    if (nl) {
      push('newline', src.slice(pos, pos + nl), start);
      pos += nl; line++; lineStart = pos;
      continue;
    }
    // whitespace
    if (c === ' ' || c === '\t' || c === '\f' || c === ' ') { pos++; continue; }

    // line continuation: `_` + optional blanks + line break
    if (c === '_') {
      let p = pos + 1;
      while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
      const l = p < n ? newlineLen(p) : 0;
      if (l) {
        pos = p + l; line++; lineStart = pos;
        continue;
      }
      if (p >= n) { pos = p; continue; } // `_` at end of file
      fail("Invalid character '_'", pos);
    }

    // comments
    if (c === "'") {
      let p = pos;
      while (p < n && !newlineLen(p)) p++;
      push('comment', src.slice(pos, p), start, { value: src.slice(pos + 1, p) });
      pos = p;
      continue;
    }

    // strings
    if (c === '"') {
      let p = pos + 1;
      let val = '';
      for (;;) {
        if (p >= n || newlineLen(p)) fail('Unterminated string', pos);
        if (src[p] === '"') {
          if (src[p + 1] === '"') { val += '"'; p += 2; continue; }
          p++;
          break;
        }
        val += src[p++];
      }
      push('string', src.slice(pos, p), start, { value: val });
      pos = p;
      continue;
    }

    // hex / octal literals
    if (c === '&' && pos + 2 < n && /[hHoO]/.test(src[pos + 1]) && (isHex(src[pos + 2]) && /[hH]/.test(src[pos + 1]) || isOct(src[pos + 2]) && /[oO]/.test(src[pos + 1]))) {
      const hex = /[hH]/.test(src[pos + 1]);
      let p = pos + 2;
      while (p < n && (hex ? isHex(src[p]) : isOct(src[p]))) p++;
      const digits = src.slice(pos + 2, p);
      let suffix: Suffix | undefined;
      if (src[p] === '&' || src[p] === '%') suffix = src[p++] as Suffix;
      let v = parseInt(digits, hex ? 16 : 8);
      if (v > 0xffffffff) fail('Numeric constant too large', pos);
      const isInteger = suffix === '%' || (suffix === undefined && (hex ? digits.length <= 4 : v <= 0xffff));
      if (isInteger) { if (v > 0xffff) fail('Numeric constant too large', pos); if (v >= 0x8000) v -= 0x10000; }
      else if (v >= 0x80000000) v -= 0x100000000;
      push('number', src.slice(pos, p), start, suffix ? { value: v, suffix } : { value: v });
      pos = p;
      continue;
    }

    // decimal numbers (a leading `.` is a number only when not a member access)
    const prev = pos > 0 ? src[pos - 1] : '';
    if (isDigit(c) || (c === '.' && pos + 1 < n && isDigit(src[pos + 1]) && !(isIdentPart(prev) || prev === ')'))) {
      let p = pos;
      while (p < n && isDigit(src[p])) p++;
      if (src[p] === '.') { p++; while (p < n && isDigit(src[p])) p++; }
      if ((src[p] === 'e' || src[p] === 'E') && (isDigit(src[p + 1] ?? '') || ((src[p + 1] === '+' || src[p + 1] === '-') && isDigit(src[p + 2] ?? '')))) {
        p += 2;
        while (p < n && isDigit(src[p])) p++;
      }
      const value = Number(src.slice(pos, p));
      let suffix: Suffix | undefined;
      if (p < n && isSuffix(src[p]) && src[p] !== '$') suffix = src[p++] as Suffix;
      push('number', src.slice(pos, p), start, suffix ? { value, suffix } : { value });
      pos = p;
      continue;
    }

    // date literal #...#, otherwise `#` is an operator
    if (c === '#') {
      let p = pos + 1;
      while (p < n && src[p] !== '#' && !newlineLen(p)) p++;
      const inner = src.slice(pos + 1, p);
      // a date or time (`#1/2/2000#`, `#12:30 PM#`, `#1 Jan 2000#`); `#1, #2` (file numbers) is not one
      if (src[p] === '#' && /\d/.test(inner) && /^[\w/\-:.,\s]+$/.test(inner) && DATE_SHAPE.test(inner)) {
        push('date', src.slice(pos, p + 1), start, { value: inner.trim() });
        pos = p + 1;
        continue;
      }
      push('op', '#', start);
      pos++;
      continue;
    }

    // identifiers and keywords
    if (isIdentStart(c)) {
      let p = pos + 1;
      while (p < n && isIdentPart(src[p])) p++;
      const word = src.slice(pos, p);
      const lower = word.toLowerCase();
      let suffix: Suffix | undefined;
      // `rs!Name` / `rs![Order Date]`: a `!` right before a name is the bang operator, not the Single suffix
      const bang = src[p] === '!' && p + 1 < n && (isIdentStart(src[p + 1]) || src[p + 1] === '[');
      if (p < n && isSuffix(src[p]) && !bang) suffix = src[p++] as Suffix;
      // `Rem` comment at statement start
      if (lower === 'rem' && !suffix && atStatementStart()) {
        let e = p;
        while (e < n && !newlineLen(e)) e++;
        push('comment', src.slice(pos, e), start, { value: src.slice(p, e).replace(/^ /, '') });
        pos = e;
        continue;
      }
      const afterDot = out.length > 0 && out[out.length - 1].kind === 'op' && (out[out.length - 1].text === '.' || out[out.length - 1].text === '!')
        && out[out.length - 1].line === line && out[out.length - 1].col === colAt(pos) - 1;
      const isKeyword = !suffix && !afterDot && KEYWORDS.has(lower);
      push(isKeyword ? 'keyword' : 'ident', src.slice(pos, p), start, suffix ? { suffix } : {});
      pos = p;
      continue;
    }

    // operators
    const two = src.slice(pos, pos + 2);
    if (two === '<>' || two === '<=' || two === '>=' || two === ':=') {
      push('op', two, start);
      pos += 2;
      continue;
    }
    if (c === ':') { push('colon', ':', start); pos++; continue; }
    if (c === '!' && src[pos + 1] === '[') {   // `rs![Order Date]`: the bracketed name is one identifier
      const close = src.indexOf(']', pos + 2);
      if (close < 0 || src.slice(pos + 2, close).includes('\n')) fail("Expected: ']'", pos + 1);
      push('op', '!', start);
      out.push({ kind: 'ident', text: src.slice(pos + 2, close), line, col: colAt(pos + 1) });
      pos = close + 1;
      continue;
    }
    if (c === '[') {   // `[_NewEnum]`, `[My Name]`: a bracketed identifier (any name, a keyword too)
      const close = src.indexOf(']', pos + 1);
      if (close < 0 || close === pos + 1 || /[\r\n]/.test(src.slice(pos + 1, close))) fail("Expected: ']'", pos);
      out.push({ kind: 'ident', text: src.slice(pos + 1, close), line, col: colAt(pos) });
      pos = close + 1;
      continue;
    }
    if ('+-*/\\^&=<>(),;.!'.includes(c)) { push('op', c, start); pos++; continue; }

    fail(`Invalid character '${c}'`, pos);
  }

  out.push({ kind: 'eof', text: '', line, col: colAt(pos) });
  return out;
}
