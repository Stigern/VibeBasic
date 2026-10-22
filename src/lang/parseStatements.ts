import { VBSyntaxError } from './errors';
import { tokenize } from './lexer';
import { Parser } from './exprParser';
import type { Token } from './tokens';
import type {
  ArrayBound, CaseTest, CompareOp, ConstDecl, DebugPrintStmt, EnumDecl, Expr, IfBranch, MissingArg,
  ModuleAst, NameExpr, Param, PrintItem, ProcDecl, ReDimDecl, Stmt, TypeDecl, TypeSuffix, VarDecl, VBTypeName,
} from './ast';

/*
 * Statement and module parser. Extends the expression Parser.
 *
 * Block handling: `block()` parses statements until it meets a *closer*
 * (End If, Next, Loop, Else, Case, End Sub, ...) or eof, and returns which one
 * without consuming it. The opener (If, For, ...) then checks that the closer
 * is its own; if not it reports "<Opener> without <Closer>". At procedure level
 * a closer that belongs to no open block is reported as a stray ("Next without For").
 *
 * Error modes: by default the first VBSyntaxError is thrown. With `collect` set,
 * errors are recorded instead; a failing statement is skipped to the end of its
 * line and parsing continues (used by findSyntaxErrors).
 *
 * `lineMode` (checkLineSyntax) parses one line without requiring blocks to
 * match: block openers stop after their header and closers are accepted alone.
 */

type Closer =
  | 'end if' | 'end select' | 'end with' | 'end sub' | 'end function' | 'end type' | 'end enum'
  | 'next' | 'loop' | 'wend' | 'else' | 'elseif' | 'case';

const TYPE_KEYWORDS: Record<string, VBTypeName> = {
  integer: 'Integer', long: 'Long', single: 'Single', double: 'Double', currency: 'Currency',
  string: 'String', boolean: 'Boolean', variant: 'Variant', date: 'Date', byte: 'Byte', object: 'Object',
};
const SUFFIX_TYPES: Record<TypeSuffix, VBTypeName> = { '%': 'Integer', '&': 'Long', '!': 'Single', '#': 'Double', '$': 'String' };

/** Unsupported VB6 keywords (see KEYWORDS in tokens.ts), with the name shown in the error. */
const UNSUPPORTED_KEYWORDS: Record<string, string> = {
  declare: 'Declare', open: 'Open', close: 'Close', property: 'Property', implements: 'Implements',
  event: 'Event', raiseevent: 'RaiseEvent', withevents: 'WithEvents', friend: 'Friend', global: 'Global',
  lib: 'Lib', alias: 'Alias', paramarray: 'ParamArray', gosub: 'GoSub', return: 'Return',
};
/** Unsupported statements that are plain identifiers; only unsupported when they start a statement and are not assigned to / member-accessed. */
const UNSUPPORTED_IDENTS: Record<string, string> = { print: 'Print', line: 'Line', circle: 'Circle', pset: 'PSet' };
/** File I/O statements: an identifier followed by `#`. */
const HASH_STATEMENTS: Record<string, string> = { print: 'Print', write: 'Write', input: 'Input', get: 'Get', put: 'Put', seek: 'Seek' };

const STRAY_MESSAGES: Record<Closer, string> = {
  'end if': 'End If without block If',
  'end select': 'End Select without Select Case',
  'end with': 'End With without With',
  'end sub': 'Invalid outside procedure',
  'end function': 'Invalid outside procedure',
  'end type': 'Invalid outside procedure',
  'end enum': 'Invalid outside procedure',
  next: 'Next without For',
  loop: 'Loop without Do',
  wend: 'Wend without While',
  else: 'Else without If',
  elseif: 'ElseIf without block If',
  case: 'Case without Select Case',
};
const END_WORDS: Record<string, Closer> = {
  if: 'end if', select: 'end select', with: 'end with', sub: 'end sub', function: 'end function', type: 'end type', enum: 'end enum',
};
/** Keywords that can start an argument of a paren-less call. */
const ARG_START_KEYWORDS = new Set(['true', 'false', 'nothing', 'new', 'not', 'me', 'date', 'string', 'error', 'empty', 'null']);
const COMPARE_OPS = new Set(['=', '<>', '<', '>', '<=', '>=']);

const lower = (t: Token) => t.text.toLowerCase();
const baseName = (t: Token) => (t.suffix ? t.text.slice(0, -1) : t.text);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export class StatementParser extends Parser {
  /** When set, errors are recorded here and parsing continues. */
  collect: VBSyntaxError[] | null = null;
  /** Check a single line without block matching (checkLineSyntax). */
  lineMode = false;

  private singleLine = 0;
  private nextQueue: string[] = [];
  /** Set when a block opener reported a missing closer without throwing (collect mode). */
  private unclosed = false;
  private readonly userTypes = new Set<string>();
  private readonly enumTypes = new Set<string>();

  constructor(tokens: Token[]) {
    super(tokens);
    for (let i = 0; i + 1 < tokens.length; i++) {
      const t = tokens[i];
      const n = tokens[i + 1];
      if (t.kind !== 'keyword' || n.kind !== 'ident') continue;
      if (lower(t) === 'type') this.userTypes.add(n.text.toLowerCase());
      else if (lower(t) === 'enum') this.enumTypes.add(n.text.toLowerCase());
    }
  }

  // ---- error helpers ----

  /** Reports an error without unwinding (collect mode) or throws (default). */
  private soft(message: string, tok: Token): void {
    const e = new VBSyntaxError(message, tok.line, tok.col);
    if (this.collect) this.collect.push(e);
    else throw e;
  }

  /** An opener's closer was missing: report at the opener, and skip the end-of-statement check. */
  private unclosedBlock(message: string, opener: Token): void {
    this.soft(message, opener);
    this.unclosed = true;
  }

  private skipLine(): void {
    while (this.peek().kind !== 'newline' && this.peek().kind !== 'eof') this.advance();
  }

  private unsupported(name: string, tok: Token = this.peek()): never {
    return this.fail(`Not supported in VibeBasic: ${name}`, tok);
  }

  // ---- token helpers ----

  private skipSeparators(): void {
    for (;;) {
      const k = this.peek().kind;
      if (k === 'newline' || k === 'colon' || k === 'comment') this.advance();
      else return;
    }
  }

  private atEnd(): boolean {
    const t = this.peek();
    return t.kind === 'newline' || t.kind === 'colon' || t.kind === 'comment' || t.kind === 'eof'
      || (this.singleLine > 0 && this.isKeyword('else'));
  }

  private atLineEnd(): boolean {
    const k = this.peek().kind;
    return k === 'newline' || k === 'comment' || k === 'eof';
  }

  private expectEnd(): void {
    if (!this.atEnd()) this.fail('Expected: end of statement');
  }

  private expectKeyword(word: string, display = cap(word)): Token {
    if (!this.isKeyword(word)) this.fail(`Expected: ${display}`);
    return this.advance();
  }

  private expectIdent(): Token {
    if (this.peek().kind !== 'ident') this.fail('Expected: identifier');
    return this.advance();
  }

  private nameOf(t: Token): NameExpr {
    return t.suffix
      ? { kind: 'name', name: baseName(t), suffix: t.suffix as TypeSuffix, line: t.line }
      : { kind: 'name', name: t.text, line: t.line };
  }

  /** The closer keyword at the cursor (a statement start), or null. */
  private closerAt(): Closer | null {
    if (this.nextQueue.length > 0 && (this.lineMode || this.forDepth > 0)) return 'next';
    const t = this.peek();
    if (t.kind !== 'keyword') return null;
    const w = lower(t);
    switch (w) {
      case 'next': case 'loop': case 'wend': case 'else': case 'elseif': case 'case':
        return w;
      case 'end': {
        const n = this.peek(1);
        return n.kind === 'keyword' ? END_WORDS[lower(n)] ?? null : null;
      }
    }
    return null;
  }

  private stray(c: Closer): never {
    return this.fail(this.inProc || this.lineMode ? STRAY_MESSAGES[c] : 'Invalid outside procedure');
  }

  // ---- blocks and statements ----

  private inProc = false;
  private procKind: 'sub' | 'function' = 'sub';
  /** Number of `For` loops whose body is being parsed; queued `Next j, i` names are only drained while one is open. */
  private forDepth = 0;

  /** Parses statements until a closer or eof; the closer is not consumed. */
  private block(): { body: Stmt[]; closer: Closer | null } {
    const body: Stmt[] = [];
    for (;;) {
      // `Next j, i`: the remaining names close the enclosing loops, before any line break is skipped
      if (this.nextQueue.length > 0 && this.forDepth > 0) return { body, closer: 'next' };
      this.skipSeparators();
      if (this.peek().kind === 'eof') return { body, closer: null };
      const closer = this.closerAt();
      if (closer) return { body, closer };
      const s = this.recovering(() => this.statementChecked());
      if (s) body.push(s);
    }
  }

  /** In collect mode: records an error, skips the rest of the line and returns null. */
  private recovering<T>(fn: () => T): T | null {
    if (!this.collect) return fn();
    const start = this.pos;
    const savedSingle = this.singleLine;
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof VBSyntaxError)) throw e;
      this.collect.push(e);
      this.singleLine = savedSingle;
      this.skipLine();
      if (this.pos === start) this.advance();
      return null;
    }
  }

  private statementChecked(): Stmt {
    this.unclosed = false;
    const s = this.statement();
    const skipCheck = this.unclosed;
    this.unclosed = false;
    // A label may be followed by a statement on the same line.
    if (s.kind !== 'label' && !skipCheck) this.expectEnd();
    return s;
  }

  private statement(): Stmt {
    const t = this.peek();
    const closer = this.closerAt();
    if (closer) return this.stray(closer);

    if (t.kind === 'number') {
      if (t.suffix || !Number.isInteger(t.value as number)) this.fail('Syntax error');
      this.advance();
      return { kind: 'label', name: String(t.value), line: t.line };
    }
    if (t.kind === 'op' && t.text === '.') return this.assignOrCall();
    if (t.kind === 'ident') return this.identStatement(t);
    if (t.kind === 'keyword') return this.keywordStatement(t);
    return this.fail(t.kind === 'eof' || t.kind === 'newline' ? 'Expected: expression' : 'Syntax error');
  }

  private identStatement(t: Token): Stmt {
    if (!t.suffix) {
      const w = lower(t);
      const n = this.peek(1);
      // label: `Retry:` alone on its line, or starting in column 1
      if (n.kind === 'colon' && this.singleLine === 0) {
        const after = this.peek(2);
        if (t.col === 1 || after.kind === 'newline' || after.kind === 'comment' || after.kind === 'eof') {
          this.advance(); this.advance();
          return { kind: 'label', name: t.text, line: t.line };
        }
      }
      if (w === 'debug' && this.isOp('.', 1) && this.peek(2).kind === 'ident' && lower(this.peek(2)) === 'print') {
        return this.debugPrint();
      }
      if (HASH_STATEMENTS[w] && this.isOp('#', 1)) this.unsupported(HASH_STATEMENTS[w]);
      if (UNSUPPORTED_IDENTS[w] && !(n.kind === 'op' && (n.text === '=' || n.text === '.'))) {
        if (w === 'line' && n.kind === 'ident' && n.text.toLowerCase() === 'input') this.unsupported('Line Input');
        this.unsupported(UNSUPPORTED_IDENTS[w]);
      }
    }
    return this.assignOrCall();
  }

  private keywordStatement(t: Token): Stmt {
    const w = lower(t);
    if (UNSUPPORTED_KEYWORDS[w]) this.unsupported(UNSUPPORTED_KEYWORDS[w]);
    switch (w) {
      case 'static':
        if (this.lineMode && (this.isKeyword('sub', 1) || this.isKeyword('function', 1))) { this.moduleItem(null); return { kind: 'end', line: t.line }; }
        return this.dimStatement();
      case 'dim': return this.dimStatement();
      case 'const': return this.constStatement('private');
      case 'redim': return this.redimStatement();
      case 'erase': return this.eraseStatement();
      case 'if': return this.ifStatement();
      case 'select': return this.selectStatement();
      case 'for': return this.forStatement();
      case 'do': return this.doStatement();
      case 'while': return this.whileStatement();
      case 'with': return this.withStatement();
      case 'exit': return this.exitStatement();
      case 'on': return this.onErrorStatement();
      case 'resume': return this.resumeStatement();
      case 'goto': return this.gotoStatement();
      case 'call': return this.callStatement();
      case 'let': case 'set': return this.explicitAssign(w === 'set');
      case 'end': this.advance(); return { kind: 'end', line: t.line };
      case 'stop': this.advance(); return { kind: 'stop', line: t.line };
      case 'unload': case 'load': {
        this.advance();
        const target = this.parseExpression();
        return w === 'unload' ? { kind: 'unload', target, line: t.line } : { kind: 'load', target, line: t.line };
      }
      case 'option':
        if (this.lineMode) { this.parseOption(); return { kind: 'end', line: t.line }; }
        return this.fail('Invalid inside procedure');
      case 'private': case 'public': case 'sub': case 'function': case 'type': case 'enum':
        if (this.lineMode) { this.moduleItem(null); return { kind: 'end', line: t.line }; }
        // a procedure header inside a procedure: the open one is missing its End
        if (w === 'sub' || w === 'function' || ((w === 'private' || w === 'public') && (this.isKeyword('sub', 1) || this.isKeyword('function', 1)))) {
          return this.fail(this.procKind === 'sub' ? 'Expected: End Sub' : 'Expected: End Function');
        }
        return this.fail('Invalid inside procedure');
      case 'me': case 'date': case 'string': case 'error': case 'empty': case 'null':
        return this.assignOrCall();
    }
    return this.fail('Syntax error');
  }

  // ---- assignment and calls ----

  private isLvalue(e: Expr): boolean {
    return e.kind === 'name' || e.kind === 'member' || e.kind === 'call' || e.kind === 'withMember';
  }

  private assignOrCall(): Stmt {
    const start = this.peek();
    const head = this.parsePostfix();
    if (this.isOp('=')) {
      if (!this.isLvalue(head)) this.fail('Syntax error', start);
      this.advance();
      return { kind: 'assign', target: head, value: this.parseExpression(), isSet: false, line: start.line };
    }
    if (!this.isLvalue(head)) this.fail('Syntax error', start);
    return this.callFrom(head, start, false);
  }

  /** Turns a parsed head expression plus optional paren-less arguments into a CallStmt. */
  private callFrom(head: Expr, start: Token, explicitCall: boolean): Stmt {
    let target: Expr = head;
    let args: (Expr | MissingArg)[] = [];
    if (head.kind === 'call') {
      target = head.target;
      args = head.args;
      // `Foo (x), y`: the parenthesis was only the first argument's
      if (this.isOp(',') && args.length === 1 && args[0].kind !== 'missing') {
        this.advance();
        args = [...args, ...this.parseArgList(false)];
      }
    } else if (!explicitCall && this.canStartArg()) {
      args = this.parseArgList(false);
    }
    return { kind: 'call', target, args, explicitCall, line: start.line };
  }

  private canStartArg(): boolean {
    const t = this.peek();
    switch (t.kind) {
      case 'number': case 'string': case 'date': case 'ident': return true;
      case 'keyword': return ARG_START_KEYWORDS.has(lower(t));
      case 'op': return t.text === '(' || t.text === '.';
      default: return false;
    }
  }

  private callStatement(): Stmt {
    const start = this.advance();
    const head = this.parsePostfix();
    if (!this.isLvalue(head)) this.fail('Syntax error', start);
    return this.callFrom(head, start, true);
  }

  private explicitAssign(isSet: boolean): Stmt {
    const start = this.advance();
    const target = this.parsePostfix();
    if (!this.isLvalue(target)) this.fail('Syntax error', start);
    this.expectOp('=');
    return { kind: 'assign', target, value: this.parseExpression(), isSet, line: start.line };
  }

  private debugPrint(): DebugPrintStmt {
    const start = this.advance(); // Debug
    this.advance(); this.advance(); // . Print
    const items: PrintItem[] = [];
    while (!this.atEnd()) {
      const item: PrintItem = {};
      if (!(this.isOp(';') || this.isOp(','))) item.expr = this.parseExpression();
      if (this.isOp(';') || this.isOp(',')) item.sep = this.advance().text as ';' | ',';
      else if (item.expr === undefined) break;
      items.push(item);
      if (item.sep === undefined) break;
    }
    return { kind: 'debugPrint', items, line: start.line };
  }

  // ---- declarations ----

  /** `As [New] Type [* n]`; the cursor is on `As`. */
  private parseAsClause(): { type: VBTypeName; isNew: boolean; fixedLength?: number } {
    this.expectKeyword('as');
    let isNew = false;
    if (this.isKeyword('new')) { this.advance(); isNew = true; }
    const type = this.parseTypeName();
    let fixedLength: number | undefined;
    if (this.isOp('*')) {
      this.advance();
      const n = this.peek();
      if (n.kind !== 'number') this.fail('Expected: number');
      this.advance();
      fixedLength = n.value as number;
    }
    return fixedLength === undefined ? { type, isNew } : { type, isNew, fixedLength };
  }

  private parseTypeName(): VBTypeName {
    const t = this.peek();
    if (t.kind === 'keyword') {
      const ty = TYPE_KEYWORDS[lower(t)];
      if (ty) { this.advance(); return ty; }
      if (UNSUPPORTED_KEYWORDS[lower(t)]) this.unsupported(UNSUPPORTED_KEYWORDS[lower(t)]);
    }
    if (t.kind !== 'ident') this.fail('Expected: identifier');
    this.advance();
    let name = t.text;
    while (this.isOp('.') && this.peek(1).kind === 'ident') { this.advance(); name += '.' + this.advance().text; }
    const key = name.toLowerCase();
    if (this.userTypes.has(key)) return { userType: name };
    if (this.enumTypes.has(key)) return 'Long';
    return { objectType: name };
  }

  /** `(` bounds `)`; the cursor is on `(`. An empty `()` gives undefined (dynamic array). */
  private parseBounds(): ArrayBound[] | undefined {
    this.expectOp('(');
    if (this.isOp(')')) { this.advance(); return undefined; }
    const bounds: ArrayBound[] = [];
    for (;;) {
      const a = this.parseExpression();
      if (this.isKeyword('to')) {
        this.advance();
        bounds.push({ lower: a, upper: this.parseExpression() });
      } else {
        bounds.push({ upper: a });
      }
      if (this.isOp(',')) { this.advance(); continue; }
      break;
    }
    this.expectOp(')');
    return bounds;
  }

  private varDecl(scope: VarDecl['scope'], requireAs: boolean): VarDecl {
    if (this.isKeyword('withevents')) this.unsupported('WithEvents');
    const nameTok = this.expectIdent();
    let isArray = false;
    let bounds: ArrayBound[] | undefined;
    if (this.isOp('(')) { isArray = true; bounds = this.parseBounds(); }
    let type: VBTypeName | undefined = nameTok.suffix ? SUFFIX_TYPES[nameTok.suffix] : undefined;
    let isNew = false;
    let fixedLength: number | undefined;
    if (this.isKeyword('as')) {
      const as = this.parseAsClause();
      type = as.type; isNew = as.isNew; fixedLength = as.fixedLength;
    } else if (requireAs) {
      this.fail('Expected: As');
    }
    const d: VarDecl = { name: baseName(nameTok), scope, isArray, isNew, line: nameTok.line };
    if (type !== undefined) d.type = type;
    if (bounds !== undefined) d.bounds = bounds;
    if (fixedLength !== undefined) d.fixedLength = fixedLength;
    return d;
  }

  private varDecls(scope: VarDecl['scope']): VarDecl[] {
    const decls = [this.varDecl(scope, false)];
    while (this.isOp(',')) { this.advance(); decls.push(this.varDecl(scope, false)); }
    return decls;
  }

  private dimStatement(): Stmt {
    const t = this.advance();
    const decls = this.varDecls(lower(t) === 'static' ? 'static' : 'dim');
    return { kind: 'dim', decls, line: t.line };
  }

  private constDecls(scope: 'private' | 'public'): ConstDecl[] {
    const decls: ConstDecl[] = [];
    for (;;) {
      const nameTok = this.expectIdent();
      let type: VBTypeName | undefined = nameTok.suffix ? SUFFIX_TYPES[nameTok.suffix] : undefined;
      if (this.isKeyword('as')) type = this.parseAsClause().type;
      this.expectOp('=');
      const value = this.parseExpression();
      const d: ConstDecl = { name: baseName(nameTok), scope, value, line: nameTok.line };
      if (type !== undefined) d.type = type;
      decls.push(d);
      if (this.isOp(',')) { this.advance(); continue; }
      return decls;
    }
  }

  private constStatement(scope: 'private' | 'public'): Stmt {
    const t = this.advance();
    return { kind: 'const', decls: this.constDecls(scope), line: t.line };
  }

  private redimStatement(): Stmt {
    const t = this.advance();
    let preserve = false;
    if (this.isKeyword('preserve')) { this.advance(); preserve = true; }
    const decls: ReDimDecl[] = [];
    for (;;) {
      const nameTok = this.expectIdent();
      if (!this.isOp('(')) this.fail('Expected: (');
      const bounds = this.parseBounds();
      if (!bounds) this.fail('Expected: expression');
      let type: VBTypeName | undefined = nameTok.suffix ? SUFFIX_TYPES[nameTok.suffix] : undefined;
      if (this.isKeyword('as')) type = this.parseAsClause().type;
      const d: ReDimDecl = { name: baseName(nameTok), bounds, line: nameTok.line };
      if (type !== undefined) d.type = type;
      decls.push(d);
      if (this.isOp(',')) { this.advance(); continue; }
      break;
    }
    return { kind: 'redim', preserve, decls, line: t.line };
  }

  private eraseStatement(): Stmt {
    const t = this.advance();
    const targets: NameExpr[] = [this.nameOf(this.expectIdent())];
    while (this.isOp(',')) { this.advance(); targets.push(this.nameOf(this.expectIdent())); }
    return { kind: 'erase', targets, line: t.line };
  }

  // ---- control flow ----

  private ifStatement(): Stmt {
    const ifTok = this.advance();
    const cond = this.parseExpression();
    this.expectKeyword('then');
    if (!this.atLineEnd()) return this.singleLineIf(ifTok, cond);

    const branches: IfBranch[] = [{ cond, body: [], line: ifTok.line }];
    let elseBody: Stmt[] | undefined;
    if (this.lineMode) return { kind: 'if', branches, singleLine: false, line: ifTok.line };
    let cur = branches[0];
    for (;;) {
      const { body, closer } = this.block();
      if (elseBody) elseBody = body; else cur.body = body;
      if (closer === 'elseif' && !elseBody) {
        const tok = this.advance();
        const c = this.parseExpression();
        this.expectKeyword('then');
        this.expectEnd();
        cur = { cond: c, body: [], line: tok.line };
        branches.push(cur);
        continue;
      }
      if (closer === 'else' && !elseBody) {
        this.advance();
        this.expectEnd();
        elseBody = [];
        continue;
      }
      if (closer === 'end if') { this.advance(); this.advance(); break; }
      this.unclosedBlock('Block If without End If', ifTok);
      break;
    }
    const s: Stmt = { kind: 'if', branches, singleLine: false, line: ifTok.line };
    if (elseBody) s.elseBody = elseBody;
    return s;
  }

  private singleLineIf(ifTok: Token, cond: Expr): Stmt {
    const branches: IfBranch[] = [{ cond, body: [], line: ifTok.line }];
    let elseBody: Stmt[] | undefined;
    this.singleLine++;
    try {
      branches[0].body = this.singleLineBody();
      if (this.isKeyword('else')) {
        this.advance();
        elseBody = this.singleLineBody();
      }
    } finally {
      this.singleLine--;
    }
    const s: Stmt = { kind: 'if', branches, singleLine: true, line: ifTok.line };
    if (elseBody) s.elseBody = elseBody;
    return s;
  }

  /** Statements of a single-line If branch: colon-separated, ends at `Else` or the end of the line. */
  private singleLineBody(): Stmt[] {
    const body: Stmt[] = [];
    const first = this.peek();
    if (first.kind === 'number') { // `If x Then 100`
      this.advance();
      return [{ kind: 'goto', label: String(first.value), line: first.line }];
    }
    for (;;) {
      while (this.peek().kind === 'colon') this.advance();
      if (this.atLineEnd() || this.isKeyword('else')) return body;
      body.push(this.statement());
      if (this.peek().kind === 'colon' || this.atLineEnd() || this.isKeyword('else')) continue;
      this.fail('Expected: end of statement');
    }
  }

  private selectStatement(): Stmt {
    const selTok = this.advance();
    this.expectKeyword('case');
    const subject = this.parseExpression();
    this.expectEnd();
    const s: Stmt = { kind: 'select', subject, cases: [], line: selTok.line };
    if (this.lineMode) return s;
    this.skipSeparators();
    let closer: Closer | null = this.closerAt();
    if (!closer && this.peek().kind !== 'eof') this.fail('Expected: Case');
    while (closer === 'case') {
      const caseTok = this.advance();
      let result: { body: Stmt[]; closer: Closer | null };
      if (this.isKeyword('else')) {
        this.advance();
        this.expectEnd();
        result = this.block();
        s.elseBody = result.body;
      } else {
        const tests = this.parseCaseTests();
        this.expectEnd();
        result = this.block();
        s.cases.push({ tests, body: result.body, line: caseTok.line });
      }
      closer = result.closer;
    }
    if (closer === 'end select') { this.advance(); this.advance(); }
    else this.unclosedBlock('Select Case without End Select', selTok);
    return s;
  }

  private parseCaseTests(): CaseTest[] {
    const tests: CaseTest[] = [];
    for (;;) {
      if (this.isKeyword('is') && this.peek(1).kind === 'op' && COMPARE_OPS.has(this.peek(1).text)) {
        this.advance();
        const op = this.advance().text as CompareOp;
        tests.push({ kind: 'is', op, value: this.parseExpression() });
      } else {
        const a = this.parseExpression();
        if (this.isKeyword('to')) {
          this.advance();
          tests.push({ kind: 'range', from: a, to: this.parseExpression() });
        } else {
          tests.push({ kind: 'value', value: a });
        }
      }
      if (this.isOp(',')) { this.advance(); continue; }
      return tests;
    }
  }

  private forStatement(): Stmt {
    const forTok = this.advance();
    if (this.isKeyword('each')) {
      this.advance();
      const variable = this.nameOf(this.expectIdent());
      this.expectKeyword('in');
      const collection = this.parseExpression();
      this.expectEnd();
      const s: Stmt = { kind: 'forEach', variable, collection, body: [], line: forTok.line };
      if (!this.lineMode) this.forBody(s, forTok, variable.name);
      return s;
    }
    const varTok = this.expectIdent();
    const variable = this.nameOf(varTok);
    this.expectOp('=');
    const from = this.parseExpression();
    this.expectKeyword('to', 'To');
    const to = this.parseExpression();
    const s: Stmt = { kind: 'for', variable, from, to, body: [], line: forTok.line };
    if (this.isKeyword('step')) { this.advance(); s.step = this.parseExpression(); }
    this.expectEnd();
    if (!this.lineMode) this.forBody(s, forTok, variable.name);
    return s;
  }

  private forBody(s: Stmt & { body: Stmt[] }, forTok: Token, varName: string): void {
    this.forDepth++;
    let result: { body: Stmt[]; closer: Closer | null };
    try { result = this.block(); } finally { this.forDepth--; }
    const { body, closer } = result;
    s.body = body;
    if (closer === 'next') this.consumeNext(varName);
    else this.unclosedBlock('For without Next', forTok);
  }

  /** Consumes `Next [i[, j ...]]` (or the next queued name of `Next j, i`), checking the loop variable. */
  private consumeNext(varName: string | undefined): void {
    let name: string | undefined;
    let tok: Token;
    if (this.nextQueue.length > 0) {
      tok = this.peek();
      name = this.nextQueue.shift();
    } else {
      tok = this.advance(); // Next
      const names: string[] = [];
      if (this.peek().kind === 'ident') {
        names.push(this.advance().text);
        while (this.isOp(',')) { this.advance(); names.push(this.expectIdent().text); }
      }
      name = names.shift();
      this.nextQueue = names;
      // more names than open loops (`Next j, i` with one For): the extra ones close nothing
      if (!this.lineMode && names.length > this.forDepth) { this.nextQueue = []; this.fail('Next without For', tok); }
    }
    if (varName !== undefined && name !== undefined && stripSuffix(name) !== stripSuffix(varName)) {
      this.nextQueue = [];
      this.fail('Next without For', tok);
    }
  }

  private loopCondition(): { mode: 'while' | 'until'; expr: Expr } | undefined {
    if (this.isKeyword('while') || this.isKeyword('until')) {
      const mode = lower(this.advance()) as 'while' | 'until';
      return { mode, expr: this.parseExpression() };
    }
    return undefined;
  }

  private doStatement(): Stmt {
    const doTok = this.advance();
    const s: Stmt = { kind: 'do', body: [], line: doTok.line };
    const pre = this.loopCondition();
    if (pre) s.test = { ...pre, atEnd: false };
    this.expectEnd();
    if (this.lineMode) return s;
    const { body, closer } = this.block();
    s.body = body;
    if (closer === 'loop') {
      this.advance();
      const post = this.loopCondition();
      if (post) {
        if (pre) this.fail('Syntax error');
        s.test = { ...post, atEnd: true };
      }
    } else {
      this.unclosedBlock('Do without Loop', doTok);
    }
    return s;
  }

  private whileStatement(): Stmt {
    const t = this.advance();
    const s: Stmt = { kind: 'while', cond: this.parseExpression(), body: [], line: t.line };
    this.expectEnd();
    if (this.lineMode) return s;
    const { body, closer } = this.block();
    s.body = body;
    if (closer === 'wend') this.advance();
    else this.unclosedBlock('While without Wend', t);
    return s;
  }

  private withStatement(): Stmt {
    const t = this.advance();
    const s: Stmt = { kind: 'with', object: this.parseExpression(), body: [], line: t.line };
    this.expectEnd();
    if (this.lineMode) return s;
    const { body, closer } = this.block();
    s.body = body;
    if (closer === 'end with') { this.advance(); this.advance(); }
    else this.unclosedBlock('With without End With', t);
    return s;
  }

  private exitStatement(): Stmt {
    const t = this.advance();
    const n = this.peek();
    if (n.kind === 'keyword') {
      const w = lower(n);
      if (w === 'for' || w === 'do' || w === 'sub' || w === 'function') {
        this.advance();
        return { kind: 'exit', what: w, line: t.line };
      }
      if (w === 'property') this.unsupported('Property');
    }
    return this.fail('Expected: For, Do, Sub or Function');
  }

  private labelTarget(): string {
    const t = this.peek();
    if (t.kind === 'ident' && !t.suffix) { this.advance(); return t.text; }
    if (t.kind === 'number' && !t.suffix && Number.isInteger(t.value as number)) { this.advance(); return String(t.value); }
    return this.fail('Expected: identifier');
  }

  private onErrorStatement(): Stmt {
    const t = this.advance();
    this.expectKeyword('error', 'Error');
    if (this.isKeyword('resume')) {
      this.advance();
      this.expectKeyword('next');
      return { kind: 'onError', mode: 'resumeNext', line: t.line };
    }
    if (this.isKeyword('goto')) {
      this.advance();
      const label = this.labelTarget();
      if (label === '0') return { kind: 'onError', mode: 'goto0', line: t.line };
      return { kind: 'onError', mode: 'goto', label, line: t.line };
    }
    return this.fail('Syntax error');
  }

  private resumeStatement(): Stmt {
    const t = this.advance();
    if (this.isKeyword('next')) { this.advance(); return { kind: 'resume', mode: 'next', line: t.line }; }
    if (this.atEnd()) return { kind: 'resume', mode: 'resume', line: t.line };
    return { kind: 'resume', mode: 'label', label: this.labelTarget(), line: t.line };
  }

  private gotoStatement(): Stmt {
    const t = this.advance();
    return { kind: 'goto', label: this.labelTarget(), line: t.line };
  }

  // ---- line mode ----

  /** checkLineSyntax: parses all statements on the line(s); throws the first error. */
  parseLine(): void {
    this.lineMode = true;
    this.nextQueue = [];
    for (;;) {
      this.skipSeparators();
      if (this.peek().kind === 'eof') return;
      const closer = this.closerAt();
      if (closer) { this.lineCloser(closer); continue; }
      const t = this.peek();
      // `X As Integer` / `V(1 To 3) As Integer`: a line inside a Type block
      if (t.kind === 'ident' && !t.suffix && (this.isKeyword('as', 1) || (this.isOp('(', 1) && this.fieldAhead()))) {
        this.varDecl('dim', true);
        this.expectEnd();
        continue;
      }
      this.statementChecked();
    }
  }

  /** Looks ahead for `ident ( ... ) As`: an array field declaration. */
  private fieldAhead(): boolean {
    let depth = 0;
    for (let i = 1; ; i++) {
      const t = this.peek(i);
      if (t.kind === 'eof' || t.kind === 'newline') return false;
      if (t.kind === 'op' && t.text === '(') depth++;
      else if (t.kind === 'op' && t.text === ')' && --depth === 0) return this.isKeyword('as', i + 1);
    }
  }

  private lineCloser(c: Closer): void {
    switch (c) {
      case 'next': this.consumeNext(undefined); break;
      case 'loop': this.advance(); this.loopCondition(); break;
      case 'wend': this.advance(); break;
      case 'else': this.advance(); return; // statements may follow on the same line
      case 'elseif': this.advance(); this.parseExpression(); this.expectKeyword('then'); return;
      case 'case':
        this.advance();
        if (this.isKeyword('else')) this.advance(); else this.parseCaseTests();
        break;
      default: this.advance(); this.advance(); // End If, End Select, ...
    }
    this.expectEnd();
  }

  // ---- module level ----

  private parseOption(): void {
    this.advance(); // Option
    if (this.isKeyword('explicit')) { this.advance(); return; }
    const t = this.peek();
    if (t.kind === 'ident' || t.kind === 'keyword') this.unsupported(`Option ${cap(t.text)}`);
    this.fail('Syntax error');
  }

  parseModuleAst(name: string): ModuleAst {
    const ast: ModuleAst = { name, optionExplicit: false, variables: [], consts: [], types: [], enums: [], procedures: [] };
    for (;;) {
      this.skipSeparators();
      if (this.peek().kind === 'eof') return ast;
      this.recovering(() => { this.moduleItem(ast); this.expectEnd(); });
    }
  }

  /** One module-level item. With `ast` null (line mode) only headers are parsed. */
  private moduleItem(ast: ModuleAst | null): void {
    const first = this.peek();
    const w = first.kind === 'keyword' ? lower(first) : '';
    if (w === 'option') {
      if (ast && ast.procedures.length > 0) this.fail('Option Explicit must precede any procedure');
      this.parseOption();
      if (ast) ast.optionExplicit = true;
      return;
    }
    let visibility: 'public' | 'private' | undefined;
    let isStatic = false;
    if (w === 'private' || w === 'public') {
      visibility = w;
      this.advance();
    } else if (w === 'static' && (this.isKeyword('sub', 1) || this.isKeyword('function', 1))) {
      isStatic = true;
      this.advance();
    }
    const t = this.peek();
    const k = t.kind === 'keyword' ? lower(t) : '';
    if (UNSUPPORTED_KEYWORDS[k] && k !== 'withevents') this.unsupported(UNSUPPORTED_KEYWORDS[k]);
    switch (k) {
      case 'sub': case 'function': {
        const p = this.procedure(visibility ?? 'public', isStatic, first);
        if (ast) ast.procedures.push(p);
        return;
      }
      case 'type': { const d = this.typeDecl(visibility ?? 'public'); if (ast) ast.types.push(d); return; }
      case 'enum': { const d = this.enumDecl(visibility ?? 'public'); if (ast) ast.enums.push(d); return; }
      case 'const': {
        this.advance();
        const decls = this.constDecls(visibility ?? 'private');
        if (ast) ast.consts.push(...decls);
        return;
      }
      case 'dim': {
        if (visibility) break;
        this.advance();
        const decls = this.varDecls('dim');
        if (ast) ast.variables.push(...decls);
        return;
      }
      case 'withevents': this.unsupported('WithEvents');
    }
    if (visibility && t.kind === 'ident') {
      const decls = this.varDecls(visibility);
      if (ast) ast.variables.push(...decls);
      return;
    }
    if (visibility) this.fail('Expected: identifier');
    if (first.kind === 'ident' && UNSUPPORTED_IDENTS[lower(first)] && !this.isOp('=', 1) && !this.isOp('.', 1)) {
      this.unsupported(UNSUPPORTED_IDENTS[lower(first)]);
    }
    this.fail('Invalid outside procedure');
  }

  private params(): Param[] {
    const params: Param[] = [];
    if (!this.isOp('(')) return params;
    this.advance();
    if (this.isOp(')')) { this.advance(); return params; }
    for (;;) {
      let optional = false;
      let byRef = true;
      if (this.isKeyword('optional')) { this.advance(); optional = true; }
      if (this.isKeyword('byval')) { this.advance(); byRef = false; }
      else if (this.isKeyword('byref')) this.advance();
      if (this.isKeyword('optional')) { this.advance(); optional = true; }
      if (this.isKeyword('paramarray')) this.unsupported('ParamArray');
      const nameTok = this.expectIdent();
      let isArray = false;
      if (this.isOp('(')) { this.advance(); this.expectOp(')'); isArray = true; }
      let type: VBTypeName | undefined = nameTok.suffix ? SUFFIX_TYPES[nameTok.suffix] : undefined;
      if (this.isKeyword('as')) type = this.parseAsClause().type;
      const p: Param = { name: baseName(nameTok), byRef, optional, isArray };
      if (type !== undefined) p.type = type;
      if (this.isOp('=')) { this.advance(); p.defaultValue = this.parseExpression(); }
      params.push(p);
      if (this.isOp(',')) { this.advance(); continue; }
      this.expectOp(')');
      return params;
    }
  }

  private procedure(visibility: 'public' | 'private', isStatic: boolean, first: Token): ProcDecl {
    const kwTok = this.advance();
    const kind = lower(kwTok) as 'sub' | 'function';
    const p: ProcDecl = { kind, name: '?', visibility, isStatic, params: [], body: [], line: first.line, endLine: first.line };
    try {
      const nameTok = this.expectIdent();
      p.name = baseName(nameTok);
      if (kind === 'function' && nameTok.suffix) p.returnType = SUFFIX_TYPES[nameTok.suffix];
      p.params = this.params();
      if (kind === 'function' && this.isKeyword('as')) p.returnType = this.parseAsClause().type;
      this.expectEnd();
    } catch (e) {
      // collect mode: keep going so the body is still checked
      if (!this.collect || !(e instanceof VBSyntaxError)) throw e;
      this.collect.push(e);
      this.skipLine();
    }
    if (this.lineMode) return p;

    const savedInProc = this.inProc;
    this.inProc = true;
    this.procKind = kind;
    this.forDepth = 0;
    this.nextQueue = [];
    const endCloser: Closer = kind === 'sub' ? 'end sub' : 'end function';
    const endName = kind === 'sub' ? 'End Sub' : 'End Function';
    for (;;) {
      const { body, closer } = this.block();
      p.body.push(...body);
      if (closer === null) { this.soft(`Expected: ${endName}`, this.peek()); break; }
      if (closer === endCloser) {
        p.endLine = this.peek().line;
        this.advance(); this.advance();
        break;
      }
      const bad = closer === 'end sub' || closer === 'end function'
        ? new VBSyntaxError(`Expected: ${endName}`, this.peek().line, this.peek().col)
        : new VBSyntaxError(STRAY_MESSAGES[closer], this.peek().line, this.peek().col);
      if (!this.collect) throw bad;
      this.collect.push(bad);
      this.skipLine();
    }
    this.inProc = savedInProc;
    return p;
  }

  private typeDecl(visibility: 'public' | 'private'): TypeDecl {
    const t = this.advance(); // Type
    const nameTok = this.expectIdent();
    this.expectEnd();
    const d: TypeDecl = { name: nameTok.text, visibility, fields: [], line: t.line };
    if (this.lineMode) return d;
    for (;;) {
      this.skipSeparators();
      if (this.peek().kind === 'eof') { this.soft('Expected: End Type', this.peek()); return d; }
      const closer = this.closerAt();
      if (closer === 'end type') { this.advance(); this.advance(); return d; }
      this.recovering(() => {
        if (closer) this.fail('Expected: End Type');
        d.fields.push(this.varDecl('dim', true));
        this.expectEnd();
      });
    }
  }

  private enumDecl(visibility: 'public' | 'private'): EnumDecl {
    const t = this.advance(); // Enum
    const nameTok = this.expectIdent();
    this.expectEnd();
    const d: EnumDecl = { name: nameTok.text, visibility, members: [], line: t.line };
    if (this.lineMode) return d;
    const known = new Map<string, number>();
    let next = 0;
    for (;;) {
      this.skipSeparators();
      if (this.peek().kind === 'eof') { this.soft('Expected: End Enum', this.peek()); return d; }
      const closer = this.closerAt();
      if (closer === 'end enum') { this.advance(); this.advance(); return d; }
      this.recovering(() => {
        if (closer) this.fail('Expected: End Enum');
        const m = this.expectIdent();
        let value = next;
        if (this.isOp('=')) {
          this.advance();
          const at = this.peek();
          value = evalConst(this.parseExpression(), known, () => this.fail('Constant expression required', at));
        }
        this.expectEnd();
        d.members.push({ name: m.text, value });
        known.set(m.text.toLowerCase(), value);
        next = value + 1;
      });
    }
  }
}

function stripSuffix(s: string): string {
  return s.toLowerCase().replace(/[%&!#$]$/, '');
}

/** Evaluates an Enum member's constant expression; `bad()` throws when it is not constant. */
function evalConst(e: Expr, known: Map<string, number>, bad: () => never): number {
  switch (e.kind) {
    case 'number': return e.value;
    case 'name': {
      const v = known.get(e.name.toLowerCase());
      return v === undefined ? bad() : v;
    }
    case 'unary': {
      if (e.op !== 'neg') return bad();
      return -evalConst(e.operand, known, bad);
    }
    case 'binary': {
      const a = evalConst(e.left, known, bad);
      const b = evalConst(e.right, known, bad);
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '\\': return Math.trunc(a / b);
        case 'mod': return a % b;
        case '^': return a ** b;
        default: return bad();
      }
    }
    default: return bad();
  }
}

// ---- public API ----

/** Parses a module; throws the first VBSyntaxError. */
export function parseModule(source: string, moduleName: string): ModuleAst {
  return new StatementParser(tokenize(source)).parseModuleAst(moduleName);
}

/** Checks one logical line without requiring blocks to match (VB6 "Auto Syntax Check"). */
export function checkLineSyntax(line: string): VBSyntaxError | null {
  try {
    new StatementParser(tokenize(line)).parseLine();
    return null;
  } catch (e) {
    if (e instanceof VBSyntaxError) return e;
    throw e;
  }
}

/** All syntax errors of a module; after an error parsing resumes on the next line. */
export function findSyntaxErrors(source: string, moduleName: string): VBSyntaxError[] {
  const errors: VBSyntaxError[] = [];
  let src = source;
  let tokens: Token[] | null = null;
  // The lexer stops at its first error; blank that line out and try again.
  for (let attempt = 0; attempt < 1000 && !tokens; attempt++) {
    try {
      tokens = tokenize(src);
    } catch (e) {
      if (!(e instanceof VBSyntaxError)) throw e;
      errors.push(e);
      const lines = src.split('\n');
      const i = e.line - 1;
      if (i < 0 || i >= lines.length) break;
      lines[i] = lines[i].endsWith('\r') ? '\r' : '';
      src = lines.join('\n');
    }
  }
  if (tokens) {
    const p = new StatementParser(tokens);
    p.collect = errors;
    p.parseModuleAst(moduleName);
  }
  const seen = new Set<string>();
  return errors
    .sort((a, b) => a.line - b.line || a.col - b.col)
    .filter(e => { const k = `${e.line}:${e.col}:${e.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
