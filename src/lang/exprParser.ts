import { VBSyntaxError } from './errors';
import { tokenize } from './lexer';
import type { Token } from './tokens';
import type { BinaryOp, Expr, MissingArg, TypeSuffix } from './ast';

/*
 * Expression parser (precedence climbing over a token array).
 *
 * Precedence, highest to lowest:
 *   ^   unary -   * /   \   Mod   + -   &
 *   = <> < > <= >= Like Is   Not   And   Or   Xor   Eqv   Imp
 * All binary operators are left-associative. `=` is always comparison here;
 * the statement parser decides what an assignment is.
 *
 * Parsing stops at the first token that cannot continue an expression
 * (newline, colon, comment, eof, Then, To, Step, `,`, `)` ...) and leaves it
 * for the caller; use `peek()` / `advance()` to continue.
 */

type Level = { ops: ReadonlySet<string> } | 'not';

// Lowest precedence first.
const LEVELS: Level[] = [
  { ops: new Set(['imp']) },
  { ops: new Set(['eqv']) },
  { ops: new Set(['xor']) },
  { ops: new Set(['or']) },
  { ops: new Set(['and']) },
  'not',
  { ops: new Set(['=', '<>', '<', '>', '<=', '>=', 'like', 'is']) },
  { ops: new Set(['&']) },
  { ops: new Set(['+', '-']) },
  { ops: new Set(['mod']) },
  { ops: new Set(['\\']) },
  { ops: new Set(['*', '/']) },
];
const NOT_LEVEL = LEVELS.indexOf('not');
const COMPARE_LEVEL = NOT_LEVEL + 1;

const WORD_OPS = new Set(['mod', 'like', 'is', 'and', 'or', 'xor', 'eqv', 'imp']);
/** Keywords that are also built-in functions/values and so may start an expression as a name. */
const KEYWORD_NAMES = new Set(['date', 'string', 'error', 'load', 'me', 'empty', 'null']);

export class Parser {
  /** Index of the next unconsumed token. */
  pos = 0;

  constructor(readonly tokens: Token[]) {
    if (tokens.length === 0 || tokens[tokens.length - 1].kind !== 'eof') {
      throw new Error('Parser requires a token stream ending in eof');
    }
  }

  // ---- token cursor ----

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  advance(): Token {
    const t = this.tokens[this.pos];
    if (t.kind !== 'eof') this.pos++;
    return t;
  }

  isOp(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'op' && t.text === text;
  }

  isKeyword(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'keyword' && t.text.toLowerCase() === word;
  }

  expectOp(text: string): Token {
    if (!this.isOp(text)) this.fail(`Expected: ${text}`);
    return this.advance();
  }

  fail(message: string, tok: Token = this.peek()): never {
    throw new VBSyntaxError(message, tok.line, tok.col);
  }

  // ---- expressions ----

  parseExpression(): Expr {
    return this.parseLevel(0);
  }

  /**
   * Parses a parenthesised argument list; the cursor is on `(`. Omitted
   * arguments become MissingArg. Named arguments (`x:=1`) are rejected.
   */
  parseParenArgs(): (Expr | MissingArg)[] {
    this.expectOp('(');
    const args = this.parseArgList(true);
    this.expectOp(')');
    return args;
  }

  /** True at the end of an argument list: `)` when parenthesised, else end of statement (or `Else`). */
  private atArgListEnd(parenthesised: boolean): boolean {
    if (parenthesised) return this.isOp(')');
    const t = this.peek();
    return t.kind === 'newline' || t.kind === 'colon' || t.kind === 'comment' || t.kind === 'eof' || this.isKeyword('else');
  }

  /**
   * Comma-separated arguments with omitted ones allowed (`a, , c`). With
   * `parenthesised` the list ends at `)` (not consumed); otherwise at the end of
   * the statement, for paren-less calls (`MsgBox "x", , "t"`).
   */
  parseArgList(parenthesised: boolean): (Expr | MissingArg)[] {
    const args: (Expr | MissingArg)[] = [];
    if (this.atArgListEnd(parenthesised)) return args;
    for (;;) {
      if (this.isOp(',') || this.atArgListEnd(parenthesised)) {
        args.push({ kind: 'missing', line: this.peek().line });
      } else {
        if (this.isOp('#')) this.advance();   // a file number: Input(5, #1), EOF(#1)
        args.push(this.parseExpression());
        if (this.isOp(':=')) this.fail('Named arguments are not supported');
      }
      if (this.isOp(',')) { this.advance(); continue; }
      return args;
    }
  }

  private binaryOp(t: Token): string | undefined {
    if (t.kind === 'op') return t.text;
    if (t.kind === 'keyword') {
      const w = t.text.toLowerCase();
      if (WORD_OPS.has(w)) return w;
    }
    return undefined;
  }

  private parseLevel(i: number): Expr {
    if (i >= LEVELS.length) return this.parseUnary();
    const level = LEVELS[i];
    if (level === 'not') {
      if (this.isKeyword('not')) {
        const t = this.advance();
        return { kind: 'unary', op: 'not', operand: this.parseLevel(i), line: t.line, st: undefined, chk: 2, lo: -Infinity, hi: Infinity };
      }
      return this.parseLevel(i + 1);
    }
    let left = this.parseLevel(i + 1);
    for (;;) {
      const op = this.binaryOp(this.peek());
      if (op === undefined || !level.ops.has(op)) return left;
      this.advance();
      const right = this.parseLevel(i + 1);
      left = { kind: 'binary', op: op as BinaryOp, left, right, line: left.line, st: undefined, chk: 2, lo: -Infinity, hi: Infinity };
    }
  }

  /** Unary minus/plus bind looser than `^` but tighter than `* /`. */
  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && t.text === '-') {
      this.advance();
      return { kind: 'unary', op: 'neg', operand: this.parseUnary(), line: t.line, st: undefined, chk: 2, lo: -Infinity, hi: Infinity };
    }
    if (t.kind === 'op' && t.text === '+') {
      this.advance();
      return this.parseUnary();
    }
    // `x = Not y`: Not in operand position (VB6 accepts this).
    if (this.isKeyword('not')) {
      this.advance();
      return { kind: 'unary', op: 'not', operand: this.parseLevel(COMPARE_LEVEL), line: t.line, st: undefined, chk: 2, lo: -Infinity, hi: Infinity };
    }
    return this.parsePower();
  }

  private parsePower(): Expr {
    let left = this.parsePostfix();
    while (this.isOp('^')) {
      this.advance();
      const right = this.parsePowerOperand();
      left = { kind: 'binary', op: '^', left, right, line: left.line, st: undefined, chk: 2, lo: -Infinity, hi: Infinity };
    }
    return left;
  }

  /** `2 ^ -2` is legal: the exponent may carry a sign. */
  private parsePowerOperand(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && t.text === '-') {
      this.advance();
      return { kind: 'unary', op: 'neg', operand: this.parsePowerOperand(), line: t.line, st: undefined, chk: 2, lo: -Infinity, hi: Infinity };
    }
    if (t.kind === 'op' && t.text === '+') {
      this.advance();
      return this.parsePowerOperand();
    }
    return this.parsePostfix();
  }

  protected parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp('(')) {
        const args = this.parseParenArgs();
        e = { kind: 'call', target: e, args, line: e.line };
      } else if (this.isOp('.')) {
        this.advance();
        e = { kind: 'member', object: e, name: this.parseMemberName(), line: e.line };
      } else if (this.isOp('!') && (this.peek(1).kind === 'ident' || this.peek(1).kind === 'keyword')) {
        // `rs!Name` is `rs("Name")`: the default member with the name as a string
        const line = this.peek().line;
        this.advance();
        e = { kind: 'call', target: e, args: [{ kind: 'string', value: this.parseMemberName(), line }], line: e.line };
      } else {
        return e;
      }
    }
  }

  private parseMemberName(): string {
    const t = this.peek();
    if (t.kind !== 'ident' && t.kind !== 'keyword') this.fail('Expected: identifier');
    this.advance();
    return stripSuffix(t);
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case 'number':
        this.advance();
        if (t.suffix) return { kind: 'number', value: t.value as number, suffix: t.suffix, line: t.line };
        return t.text[0] !== '&' && /[.eE]/.test(t.text)
          ? { kind: 'number', value: t.value as number, isDouble: true, line: t.line }
          : { kind: 'number', value: t.value as number, line: t.line };
      case 'string':
        this.advance();
        return { kind: 'string', value: t.value as string, line: t.line };
      case 'date':
        this.advance();
        return { kind: 'date', text: t.value as string, line: t.line };
      case 'ident':
        this.advance();
        return this.nameExpr(t);
      case 'op':
        if (t.text === '(') {
          this.advance();
          const inner = this.parseExpression();
          this.expectOp(')');
          return parenthesised(inner);
        }
        if (t.text === '.') {
          this.advance();
          return { kind: 'withMember', name: this.parseMemberName(), line: t.line };
        }
        if (t.text === '!' && (this.peek(1).kind === 'ident' || this.peek(1).kind === 'keyword')) {
          // `!Name` inside `With rs`: `rs("Name")`, the default member of the With object with the name as a string
          this.advance();
          const name: Expr = { kind: 'string', value: this.parseMemberName(), line: t.line };
          return { kind: 'call', target: { kind: 'withObject', line: t.line }, args: [name], line: t.line };
        }
        break;
      case 'keyword': {
        const w = t.text.toLowerCase();
        if (w === 'true' || w === 'false') {
          this.advance();
          return { kind: 'bool', value: w === 'true', line: t.line };
        }
        if (w === 'nothing') {
          this.advance();
          return { kind: 'nothing', line: t.line };
        }
        if (w === 'new') {
          this.advance();
          const n = this.peek();
          if (n.kind !== 'ident') this.fail('Expected: class name');
          this.advance();
          let typeName = stripSuffix(n);
          // `New ADODB.Recordset`: a library-qualified class name
          while (this.isOp('.') && this.peek(1).kind === 'ident') { this.advance(); typeName += '.' + this.advance().text; }
          return { kind: 'new', typeName, line: t.line };
        }
        if (KEYWORD_NAMES.has(w)) {
          this.advance();
          return this.nameExpr(t);
        }
        break;
      }
    }
    return this.fail(t.kind === 'eof' || t.kind === 'newline' ? 'Expected: expression' : 'Syntax error');
  }

  private nameExpr(t: Token): Expr {
    return t.suffix
      ? { kind: 'name', name: stripSuffix(t), suffix: t.suffix as TypeSuffix, line: t.line }
      : { kind: 'name', name: t.text, line: t.line };
  }
}

/** `(e)`: a name, member, call/index or With member in its own parentheses is marked as a value (see `paren` in ast.ts). */
export function parenthesised(e: Expr): Expr {
  switch (e.kind) {
    case 'name': case 'member': case 'call': case 'withMember': return { ...e, paren: true };
    default: return e;
  }
}

function stripSuffix(t: Token): string {
  return t.suffix ? t.text.slice(0, -1) : t.text;
}

/** Parses a complete expression from source text; anything left over is a syntax error. */
export function parseExpression(src: string): Expr {
  const p = new Parser(tokenize(src));
  const e = p.parseExpression();
  if (p.peek().kind !== 'eof') p.fail('Syntax error');
  return e;
}
