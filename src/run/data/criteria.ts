// The criteria of Recordset.FindFirst / FindNext ... (DAO) and Find (ADO): a small SQL WHERE expression evaluated on the
// records held in memory. Field names (or [bracketed names]), the comparisons = <> < > <= >=, Like (Jet's * ? # and ADO's
// % _), Is [Not] Null, And, Or, Not and parentheses; literals: numbers, 'text' or "text", #dates#, True, False, Null.
// Text compares without regard to case, as in Jet.

import { VBRuntimeError } from '../../lang/errors';
import { likeMatch } from '../../lang/interp/operators';
import { Null, NullT, compare, isDate, parseDate, toStr, type VBValue } from '../../lang/values';
import { parseDateText } from './dbValues';
import { localeDateParser } from '../../lang/builtins/format';

/** Dates in criteria are read as Jet and ADO read them: US m/d/y (as VB's own #...# literals), not in the program's locale. */
const US_DATES = localeDateParser('en-US');

type Node =
  | { k: 'lit'; v: VBValue }
  | { k: 'field'; name: string }
  | { k: 'not'; e: Node }
  | { k: 'and' | 'or'; a: Node; b: Node }
  | { k: 'cmp'; op: string; a: Node; b: Node }
  | { k: 'like'; a: Node; b: Node; neg: boolean }
  | { k: 'isnull'; a: Node; neg: boolean };

interface Tok { t: 'word' | 'num' | 'str' | 'date' | 'op' | 'name'; v: string }

const bad = (): VBRuntimeError => new VBRuntimeError(3077);

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw bad();
        if (src[i] === c) { if (src[i + 1] === c) { s += c; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    if (c === '#') {
      const e = src.indexOf('#', i + 1);
      if (e < 0) throw bad();
      out.push({ t: 'date', v: src.slice(i + 1, e) });
      i = e + 1;
      continue;
    }
    if (c === '[') {
      const e = src.indexOf(']', i + 1);
      if (e < 0) throw bad();
      out.push({ t: 'name', v: src.slice(i + 1, e) });
      i = e + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=' || two === '!=') { out.push({ t: 'op', v: two === '!=' ? '<>' : two }); i += 2; continue; }
    if ('=<>()'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    const num = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num && (c !== '-' || out.length === 0 || out[out.length - 1].t === 'op')) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const w = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(src.slice(i));
    if (w) { out.push({ t: 'word', v: w[0] }); i += w[0].length; continue; }
    throw bad();
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok | undefined { return this.toks[this.i]; }
  private word(w: string): boolean { const t = this.peek(); return t?.t === 'word' && t.v.toLowerCase() === w; }
  private op(o: string): boolean { const t = this.peek(); return t?.t === 'op' && t.v === o; }

  parse(): Node {
    const e = this.or();
    if (this.i < this.toks.length) throw bad();
    return e;
  }
  private or(): Node {
    let a = this.and();
    while (this.word('or')) { this.i++; a = { k: 'or', a, b: this.and() }; }
    return a;
  }
  private and(): Node {
    let a = this.not();
    while (this.word('and')) { this.i++; a = { k: 'and', a, b: this.not() }; }
    return a;
  }
  private not(): Node {
    if (this.word('not')) { this.i++; return { k: 'not', e: this.not() }; }
    return this.cmp();
  }
  private cmp(): Node {
    const a = this.operand();
    const t = this.peek();
    if (t?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) { this.i++; return { k: 'cmp', op: t.v, a, b: this.operand() }; }
    if (this.word('is')) {
      this.i++;
      const neg = this.word('not');
      if (neg) this.i++;
      if (!this.word('null')) throw bad();
      this.i++;
      return { k: 'isnull', a, neg };
    }
    let neg = false;
    if (this.word('not')) { this.i++; neg = true; if (!this.word('like')) throw bad(); }
    if (this.word('like')) { this.i++; return { k: 'like', a, b: this.operand(), neg }; }
    if (neg) throw bad();
    return a;
  }
  private operand(): Node {
    const t = this.toks[this.i++];
    if (!t) throw bad();
    switch (t.t) {
      case 'num': return { k: 'lit', v: Number(t.v) };
      case 'str': return { k: 'lit', v: t.v };
      case 'date': {
        const d = parseDateText(t.v) ?? parseDate(t.v, US_DATES);   // Jet / ADO #...# is m/d/y whatever the locale
        if (!d) throw bad();
        return { k: 'lit', v: d };
      }
      case 'name': return { k: 'field', name: t.v };
      case 'op':
        if (t.v === '(') { const e = this.or(); if (!this.op(')')) throw bad(); this.i++; return e; }
        throw bad();
      case 'word': {
        const l = t.v.toLowerCase();
        if (l === 'true') return { k: 'lit', v: true };
        if (l === 'false') return { k: 'lit', v: false };
        if (l === 'null') return { k: 'lit', v: Null };
        return { k: 'field', name: t.v };
      }
    }
  }
}

/** A text compared with a date is read as a date. */
function cmpValues(a: VBValue, b: VBValue): -1 | 0 | 1 {
  if (isDate(a) && typeof b === 'string') b = parseDateText(b) ?? parseDate(b, US_DATES) ?? b;
  else if (isDate(b) && typeof a === 'string') a = parseDateText(a) ?? parseDate(a, US_DATES) ?? a;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? -1 : 1;
  return compare(a, b, true);
}

function evaluate(n: Node, field: (name: string) => VBValue): VBValue {
  switch (n.k) {
    case 'lit': return n.v;
    case 'field': return field(n.name);
    case 'not': return !truthy(evaluate(n.e, field));
    case 'and': return truthy(evaluate(n.a, field)) && truthy(evaluate(n.b, field));
    case 'or': return truthy(evaluate(n.a, field)) || truthy(evaluate(n.b, field));
    case 'isnull': return (evaluate(n.a, field) instanceof NullT) !== n.neg;
    case 'like': {
      const a = evaluate(n.a, field), b = evaluate(n.b, field);
      if (a instanceof NullT || b instanceof NullT) return false;
      const pattern = toStr(b).toLowerCase().replace(/%/g, '*').replace(/_/g, '?');
      return likeMatch(toStr(a).toLowerCase(), pattern) !== n.neg;
    }
    case 'cmp': {
      const a = evaluate(n.a, field), b = evaluate(n.b, field);
      if (a instanceof NullT || b instanceof NullT) return false;
      const c = cmpValues(a, b);
      switch (n.op) {
        case '=': return c === 0;
        case '<>': return c !== 0;
        case '<': return c < 0;
        case '>': return c > 0;
        case '<=': return c <= 0;
        default: return c >= 0;
      }
    }
  }
}

const truthy = (v: VBValue): boolean => v === true || (typeof v === 'number' && v !== 0);

/** The criteria as a test of one record; `field` gives a field's value by name (and throws for an unknown name).
 *  Error 3077 when the criteria cannot be read. */
export function compileCriteria(criteria: string): (field: (name: string) => VBValue) => boolean {
  const tree = new Parser(lex(criteria)).parse();
  return field => truthy(evaluate(tree, field));
}
