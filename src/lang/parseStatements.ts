import { VBSyntaxError } from './errors';
import { tokenize } from './lexer';
import { Parser, parenthesised } from './exprParser';
import { directiveLineError, preprocess, type CondConsts } from './condComp';
import type { Token } from './tokens';
import type {
  ArgList, ArrayBound, CaseTest, CompareOp, ConstDecl, DebugPrintStmt, EnumDecl, EventDecl, Expr, GfxPoint, GfxStmt, IfBranch, MissingArg,
  ModuleAst, NameExpr, OpenMode, OpenStmt, Param, PrintItem, ProcDecl, ReDimDecl, Stmt, TypeDecl, TypeSuffix, VarDecl, VBTypeName,
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
  | 'end if' | 'end select' | 'end with' | 'end sub' | 'end function' | 'end property' | 'end type' | 'end enum'
  | 'next' | 'loop' | 'wend' | 'else' | 'elseif' | 'case';

export const TYPE_KEYWORDS: Record<string, VBTypeName> = {
  integer: 'Integer', long: 'Long', single: 'Single', double: 'Double', currency: 'Currency',
  string: 'String', boolean: 'Boolean', variant: 'Variant', date: 'Date', byte: 'Byte', object: 'Object',
};
const SUFFIX_TYPES: Record<TypeSuffix, VBTypeName> = { '%': 'Integer', '&': 'Long', '!': 'Single', '#': 'Double', '$': 'String', '@': 'Currency' };

/** Unsupported VB6 keywords (see KEYWORDS in tokens.ts), with the name shown in the error. */
export const UNSUPPORTED_KEYWORDS: Record<string, string> = {
  declare: 'Declare', lib: 'Lib', alias: 'Alias',
};
/** The drawing statements with their own syntax (`[obj.]Line (x1, y1)-(x2, y2), , B`): plain identifiers, statements only when
 *  they start one (or end its object part) and are not assigned to or member-accessed. */
export const GFX_STATEMENTS: Record<string, string> = { print: 'Print', pset: 'PSet', line: 'Line', circle: 'Circle', scale: 'Scale' };
/** File I/O statements that are an identifier followed by `#` (also `Line Input #`, and `Open`/`Close` as keywords). */
export const HASH_STATEMENTS: Record<string, string> = { print: 'Print', write: 'Write', input: 'Input', get: 'Get', put: 'Put', seek: 'Seek' };

const STRAY_MESSAGES: Record<Closer, string> = {
  'end if': 'End If without block If',
  'end select': 'End Select without Select Case',
  'end with': 'End With without With',
  'end sub': 'Invalid outside procedure',
  'end function': 'Invalid outside procedure',
  'end property': 'Invalid outside procedure',
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
  if: 'end if', select: 'end select', with: 'end with', sub: 'end sub', function: 'end function', property: 'end property',
  type: 'end type', enum: 'end enum',
};
/** Keywords that can start an argument of a paren-less call. */
const ARG_START_KEYWORDS = new Set(['true', 'false', 'nothing', 'new', 'not', 'me', 'date', 'string', 'error', 'empty', 'null']);
const COMPARE_OPS = new Set(['=', '<>', '<', '>', '<=', '>=']);
const OPEN_MODES = new Set<string>(['input', 'output', 'append', 'binary', 'random']);

const lower = (t: Token) => t.text.toLowerCase();
const baseName = (t: Token) => (t.suffix ? t.text.slice(0, -1) : t.text);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
type ProcKind = 'sub' | 'function' | 'property';
const END_NAMES: Record<ProcKind, string> = { sub: 'End Sub', function: 'End Function', property: 'End Property' };
const END_CLOSERS: Record<ProcKind, Closer> = { sub: 'end sub', function: 'end function', property: 'end property' };
const isProcCloser = (c: Closer) => c === 'end sub' || c === 'end function' || c === 'end property';

export class StatementParser extends Parser {
  /** When set, errors are recorded here and parsing continues. */
  collect: VBSyntaxError[] | null = null;
  /** Check a single line without block matching (checkLineSyntax). */
  lineMode = false;

  private singleLine = 0;
  private nextQueue: string[] = [];
  /** `Attribute Name.VB_UserMemId = n` lines seen: the member by id (0 default member, -4 NewEnum). */
  private memberIds = new Map<number, string>();
  private nextTokLine = 0;   // line of the last `Next` keyword (shared by the loops `Next j, i` closes)
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

  /** The token after the cursor ends the statement. */
  private atEnd1(): boolean {
    const k = this.peek(1).kind;
    return k === 'newline' || k === 'colon' || k === 'comment' || k === 'eof';
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
  private procKind: ProcKind = 'sub';
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
      if (this.attributeLine()) continue;
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
    // `.Method`, `.Prop = x` and `!Field = x` inside a With block
    if (t.kind === 'op' && (t.text === '.' || t.text === '!')) return this.assignOrCall();
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
      if (w === 'debug' && this.isOp('.', 1) && this.peek(2).kind === 'ident' && lower(this.peek(2)) === 'assert') {
        this.advance(); this.advance(); this.advance();
        return { kind: 'debugAssert', cond: this.parseExpression(), line: t.line };
      }
      if (HASH_STATEMENTS[w] && this.isOp('#', 1)) return this.fileStatement(w);
      // `Seek 1, 100`, `Get 1, , x`: the # is optional
      if ((w === 'seek' || w === 'get' || w === 'put') && !(n.kind === 'op' && (n.text === '=' || n.text === '.')) && !this.atEnd1()) {
        return this.fileStatement(w);
      }
      if (w === 'line' && n.kind === 'ident' && lower(n) === 'input' && !n.suffix && this.isOp('#', 2)) {
        this.advance();
        return this.fileStatement('line input');
      }
      if (w === 'name' && !(n.kind === 'op' && (n.text === '=' || n.text === '.'))) {
        const s = this.nameStatement();
        if (s) return s;
      }
      if ((w === 'lset' || w === 'rset') && (n.kind === 'ident' || n.kind === 'keyword' || (n.kind === 'op' && n.text === '.'))) {
        // `LSet s = "ab"`, `RSet .Name = x`
        this.advance();
        const target = this.target();
        this.expectOp('=');
        return { kind: w, target, value: this.parseExpression(), line: t.line };
      }
      if (GFX_STATEMENTS[w] && !(n.kind === 'op' && (n.text === '=' || n.text === '.'))) {
        if (w === 'line' && n.kind === 'ident' && n.text.toLowerCase() === 'input') this.unsupported('Line Input');
        return this.gfxStatement(undefined);
      }
    }
    return this.assignOrCall();
  }

  // ---- file I/O ----

  /** `[#]n`: a file number. */
  private fileNumber(): Expr {
    if (this.isOp('#')) this.advance();
    return this.parseExpression();
  }

  /** The variable a statement reads into (`Input #1, a`, `Get #1, , rec`). */
  private target(): Expr {
    const start = this.peek();
    const e = this.parsePostfix();
    if (!this.isLvalue(e)) this.fail('Expected: variable', start);
    return e;
  }

  /** Print # / Write # / Input # / Line Input # / Get # / Put # / Seek #; the cursor is on the statement word. */
  private fileStatement(w: string): Stmt {
    const t = this.advance();
    const line = t.line;
    const file = this.fileNumber();
    switch (w) {
      case 'print': case 'write': {
        let items: PrintItem[] = [];
        if (this.isOp(',')) { this.advance(); items = this.printItems(); }
        else if (!this.atEnd()) this.fail('Expected: ,');
        return { kind: w === 'print' ? 'printFile' : 'writeFile', file, items, line };
      }
      case 'input': case 'line input': {
        const targets: Expr[] = [];
        do { this.expectOp(','); targets.push(this.target()); } while (w === 'input' && this.isOp(','));
        return { kind: w === 'input' ? 'inputFile' : 'lineInput', file, targets, line };
      }
      case 'get': case 'put': {
        this.expectOp(',');
        const rec = this.isOp(',') ? undefined : this.parseExpression();
        this.expectOp(',');
        const target = w === 'get' ? this.target() : this.parseExpression();
        return rec ? { kind: w === 'get' ? 'getFile' : 'putFile', file, rec, target, line } : { kind: w === 'get' ? 'getFile' : 'putFile', file, target, line };
      }
      default: {   // seek
        this.expectOp(',');
        return { kind: 'seekFile', file, pos: this.parseExpression(), line };
      }
    }
  }

  /** `Open path For mode [Access ...] [Shared | Lock ...] As [#]n [Len = reclen]`. */
  private openStatement(): Stmt {
    const t = this.advance();
    const path = this.parseExpression();
    const word = (offset = 0) => (this.peek(offset).kind === 'ident' ? lower(this.peek(offset)) : '');
    let mode: OpenMode = 'random';
    if (this.isKeyword('for')) {
      this.advance();
      if (!OPEN_MODES.has(word())) this.fail('Expected: Input, Output, Append, Binary or Random');
      mode = word() as OpenMode;
      this.advance();
    }
    let access: OpenStmt['access'] = '';
    if (word() === 'access') {
      this.advance();
      if (word() === 'read') { this.advance(); access = 'read'; if (word() === 'write') { this.advance(); access = 'readwrite'; } }
      else if (word() === 'write') { this.advance(); access = 'write'; }
      else this.fail('Expected: Read or Write');
    }
    if (word() === 'shared') this.advance();
    else if (word() === 'lock') {
      this.advance();
      if (word() === 'read') { this.advance(); if (word() === 'write') this.advance(); }
      else if (word() === 'write') this.advance();
      else this.fail('Expected: Read or Write');
    }
    this.expectKeyword('as');
    const file = this.fileNumber();
    const s: OpenStmt = { kind: 'open', path, mode, access, file, line: t.line };
    if (word() === 'len') {
      this.advance();
      this.expectOp('=');
      s.recLen = this.parseExpression();
    }
    return s;
  }

  /** `Close` or `Close #1, #2`. */
  private closeStatement(): Stmt {
    const t = this.advance();
    const files: Expr[] = [];
    if (!this.atEnd()) {
      files.push(this.fileNumber());
      while (this.isOp(',')) { this.advance(); files.push(this.fileNumber()); }
    }
    return { kind: 'close', files, line: t.line };
  }

  /** `Name old As new`; null (cursor unchanged) when the statement is something else (`Name x` as a call). */
  private nameStatement(): Stmt | null {
    const start = this.pos;
    const t = this.advance();
    try {
      const from = this.parseExpression();
      if (this.isKeyword('as')) {
        this.advance();
        return { kind: 'name', from, to: this.parseExpression(), line: t.line };
      }
    } catch (e) {
      if (!(e instanceof VBSyntaxError)) throw e;
    }
    this.pos = start;
    return null;
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
      case 'on': return this.onStatement();
      case 'resume': return this.resumeStatement();
      case 'goto': return this.gotoStatement();
      case 'gosub': this.advance(); return { kind: 'goto', label: this.labelTarget(), gosub: true, line: t.line };
      case 'return': this.advance(); return { kind: 'return', line: t.line };
      case 'call': return this.callStatement();
      case 'let': case 'set': return this.explicitAssign(w === 'set');
      case 'end': this.advance(); return { kind: 'end', line: t.line };
      case 'open': return this.openStatement();
      case 'close': return this.closeStatement();
      case 'stop': this.advance(); return { kind: 'stop', line: t.line };
      case 'raiseevent': return this.raiseEventStatement();
      case 'unload': case 'load': {
        this.advance();
        const target = this.parseExpression();
        return w === 'unload' ? { kind: 'unload', target, line: t.line } : { kind: 'load', target, line: t.line };
      }
      case 'option':
        if (this.lineMode) { this.parseOption(); return { kind: 'end', line: t.line }; }
        return this.fail('Invalid inside procedure');
      case 'private': case 'public': case 'friend': case 'global': case 'sub': case 'function': case 'property': case 'type': case 'enum':
      case 'event': case 'implements':
        if (this.lineMode) { this.moduleItem(null); return { kind: 'end', line: t.line }; }
        // a procedure header inside a procedure: the open one is missing its End
        if (w === 'sub' || w === 'function' || w === 'property'
          || ((w === 'private' || w === 'public' || w === 'friend' || w === 'global') && (this.isKeyword('sub', 1) || this.isKeyword('function', 1) || this.isKeyword('property', 1)))) {
          return this.fail(`Expected: ${END_NAMES[this.procKind]}`);
        }
        return this.fail('Invalid inside procedure');
      case 'error':
        // `Error 7`: raises error 7 (the Error statement); `Error(7)` as an expression is the function
        if (!this.isOp('=', 1) && !this.atEnd1()) {
          this.advance();
          return { kind: 'error', number: this.parseExpression(), line: t.line };
        }
        return this.assignOrCall();
      case 'me': case 'date': case 'string': case 'empty': case 'null':
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
    const dot = this.gfxDot();
    if (dot >= 0) {
      // `Picture1.Line (0, 0)-(9, 9)`, `.Circle ...` inside With: the object part, then the statement's own syntax
      const object: Expr = dot === this.pos ? { kind: 'withObject', line: start.line }
        : new StatementParser([...this.tokens.slice(this.pos, dot), { ...this.tokens[dot], kind: 'eof', text: '' }]).objectPart();
      this.pos = dot + 1;
      return this.gfxStatement(object);
    }
    const head = this.parsePostfix();
    if (this.isOp('=')) {
      if (!this.isLvalue(head)) this.fail('Syntax error', start);
      this.advance();
      if (head.kind === 'call' && head.target.kind === 'name' && /^midb?$/i.test(head.target.name)) {
        // the Mid statement: `Mid(s, 3, 2) = "xy"`
        const [target, from, length] = head.args;
        if (head.args.length < 2 || head.args.length > 3 || target.kind === 'missing' || from.kind === 'missing' || length?.kind === 'missing'
          || !this.isLvalue(target)) {
          this.fail('Syntax error', start);
        }
        const s: Stmt = { kind: 'mid', target, start: from, value: this.parseExpression(), line: start.line };
        if (length) s.length = length;
        return s;
      }
      return { kind: 'assign', target: head, value: this.parseExpression(), isSet: false, line: start.line };
    }
    if (!this.isLvalue(head)) this.fail('Syntax error', start);
    return this.callFrom(head, start, false);
  }

  // ---- drawing statements ----

  /** The object part of `obj.Line ...` (a sub-parser over just those tokens). */
  objectPart(): Expr {
    const e = this.parsePostfix();
    if (this.peek().kind !== 'eof') this.fail('Syntax error');
    return e;
  }

  /**
   * The index of the `.` before a drawing statement word that ends the head of this statement (`Picture1(i).Line`, `Me.Print`,
   * `.Circle` in a With block), when the word is not assigned to or followed by a member; -1 otherwise.
   */
  private gfxDot(): number {
    const tk = this.tokens;
    const isGfx = (j: number): boolean => {
      const t = tk[j], n = tk[j + 1];
      return t?.kind === 'ident' && !t.suffix && GFX_STATEMENTS[lower(t)] !== undefined
        && !(n?.kind === 'op' && (n.text === '=' || n.text === '.' || n.text === '!'));
    };
    let i = this.pos;
    const t0 = tk[i];
    if (t0.kind === 'op' && t0.text === '.') {
      if (isGfx(i + 1)) return i;
      if (tk[i + 1]?.kind !== 'ident') return -1;
      i += 2;
    } else if (t0.kind === 'ident' || (t0.kind === 'keyword' && lower(t0) === 'me')) i++;
    else return -1;
    for (;;) {
      const t = tk[i];
      if (t.kind === 'op' && t.text === '(') {
        let depth = 0;
        for (; i < tk.length; i++) {
          const u = tk[i];
          if (u.kind === 'newline' || u.kind === 'eof') return -1;
          if (u.kind === 'op' && u.text === '(') depth++;
          else if (u.kind === 'op' && u.text === ')' && --depth === 0) break;
        }
        i++;
      } else if (t.kind === 'op' && (t.text === '.' || t.text === '!') && (tk[i + 1]?.kind === 'ident' || tk[i + 1]?.kind === 'keyword')) {
        if (t.text === '.' && isGfx(i + 1)) return i;
        i += 2;
      } else return -1;
    }
  }

  /** `[Step] (x, y)`. */
  private gfxPoint(allowStep: boolean): GfxPoint {
    let step = false;
    if (allowStep && this.isKeyword('step')) { this.advance(); step = true; }
    this.expectOp('(');
    const x = this.parseExpression();
    this.expectOp(',');
    const y = this.parseExpression();
    this.expectOp(')');
    return { step, x, y };
  }

  /** Print / PSet / Line / Circle / Scale; the cursor is on the word. */
  private gfxStatement(object: Expr | undefined): GfxStmt {
    const t = this.advance();
    const line = t.line;
    const base = object ? { kind: 'gfx' as const, object, line } : { kind: 'gfx' as const, line };
    const comma = (): boolean => { if (!this.isOp(',')) return false; this.advance(); return true; };
    const optional = (): Expr | undefined => (this.isOp(',') || this.atEnd() ? undefined : this.parseExpression());
    switch (lower(t)) {
      case 'print': return { ...base, method: 'print', items: this.printItems() };
      case 'pset': {
        const at = this.gfxPoint(true);
        return { ...base, method: 'pset', at, color: comma() ? this.parseExpression() : undefined };
      }
      case 'line': {
        const from = this.isOp('-') ? undefined : this.gfxPoint(true);
        this.expectOp('-');
        const to = this.gfxPoint(true);
        let color: Expr | undefined, box: '' | 'b' | 'bf' = '';
        if (comma()) {
          color = optional();
          if (comma()) {
            const b = this.peek();
            if (b.kind !== 'ident' || b.suffix || !/^bf?$/i.test(b.text)) this.fail('Syntax error');
            this.advance();
            box = lower(b) as 'b' | 'bf';
          }
        }
        return { ...base, method: 'line', from, to, color, box };
      }
      case 'circle': {
        const at = this.gfxPoint(true);
        this.expectOp(',');
        const radius = this.parseExpression();
        const rest: (Expr | undefined)[] = [];
        while (rest.length < 4 && comma()) rest.push(optional());
        const [color, start, end, aspect] = rest;
        return { ...base, method: 'circle', at, radius, color, start, end, aspect };
      }
      default: {   // scale
        if (!this.isOp('(')) return { ...base, method: 'scale' };
        const from = this.gfxPoint(false);
        this.expectOp('-');
        return { ...base, method: 'scale', from, to: this.gfxPoint(false) };
      }
    }
  }

  /** Turns a parsed head expression plus optional paren-less arguments into a CallStmt. */
  private callFrom(head: Expr, start: Token, explicitCall: boolean): Stmt {
    let target: Expr = head;
    let args: (Expr | MissingArg)[] = [];
    if (head.kind === 'call') {
      target = head.target;
      args = head.args;
      // `Foo (x)` / `Foo (x), y` without Call: the parentheses are the first argument's own, so it is a value (a ByRef
      // parameter gets a copy, as in VB6)
      if ((args as ArgList).names) return { kind: 'call', target, args, explicitCall, line: start.line };   // `Foo(a:=1)`
      if (!explicitCall && args.length === 1 && args[0].kind !== 'missing') args = [parenthesised(args[0])];
      if (this.isOp(',') && args.length === 1 && args[0].kind !== 'missing') {
        this.advance();
        const rest = this.parseArgList(false);
        const names = (rest as ArgList).names;
        args = [...args, ...rest];
        if (names) (args as ArgList).names = [undefined, ...names];   // `Foo (x), b:=2`
      }
    } else if (!explicitCall && this.canStartArg()) {
      args = this.parseArgList(false);
    }
    return { kind: 'call', target, args, explicitCall, line: start.line };
  }

  /**
   * Whether a paren-less argument list starts here (after a call target at
   * statement level). A sign starts one too: `List1.AddItem -5`,
   * `Picture1.Move -100, 0` (an assignment `x = y - 1` was recognised before).
   */
  private canStartArg(): boolean {
    const t = this.peek();
    switch (t.kind) {
      case 'number': case 'string': case 'date': case 'ident': return true;
      case 'keyword': return ARG_START_KEYWORDS.has(lower(t));
      case 'op': return t.text === '(' || t.text === '.' || t.text === '-' || t.text === '+' || t.text === ',';   // ',': an omitted first argument (Panels.Add , "key", "text")
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
    return { kind: 'debugPrint', items: this.printItems(), line: start.line };
  }

  /**
   * The items of Debug.Print / Print # / Write #: expressions, `Spc(n)`, `Tab(n)` and `Tab`, each followed by an
   * optional `;` or `,`.
   */
  private printItems(): PrintItem[] {
    const items: PrintItem[] = [];
    while (!this.atEnd()) {
      const item: PrintItem = {};
      if (!(this.isOp(';') || this.isOp(','))) {
        const t = this.peek();
        const w = t.kind === 'ident' && !t.suffix ? lower(t) : '';
        if (w === 'spc' && this.isOp('(', 1) || w === 'tab') {
          this.advance();
          item.fn = { kind: w };
          if (this.isOp('(')) { this.advance(); item.fn.arg = this.parseExpression(); this.expectOp(')'); }
        } else item.expr = this.parseExpression();
      }
      if (this.isOp(';') || this.isOp(',')) item.sep = this.advance().text as ';' | ',';
      else if (item.expr === undefined && item.fn === undefined) break;
      items.push(item);
      if (item.sep === undefined) break;
    }
    return items;
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
    const withEvents = this.isKeyword('withevents');
    if (withEvents) {
      if (!this.inModuleDecls) this.fail('Only valid in object module');
      this.advance();
    }
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
    if (withEvents) {
      // VB6: `WithEvents x As Class1`, a single object variable with a class type, no New
      if (isArray || isNew || type === undefined || typeof type !== 'object' || !('objectType' in type)) this.fail('Expected: identifier', nameTok);
      d.withEvents = true;
    }
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
      const s: Stmt = { kind: 'forEach', variable, collection, body: [], line: forTok.line, nextLine: forTok.line };
      if (!this.lineMode) this.forBody(s, forTok, variable.name);
      return s;
    }
    const varTok = this.expectIdent();
    const variable = this.nameOf(varTok);
    this.expectOp('=');
    const from = this.parseExpression();
    this.expectKeyword('to', 'To');
    const to = this.parseExpression();
    const s: Stmt = { kind: 'for', variable, from, to, body: [], line: forTok.line, nextLine: forTok.line };
    if (this.isKeyword('step')) { this.advance(); s.step = this.parseExpression(); }
    this.expectEnd();
    if (!this.lineMode) this.forBody(s, forTok, variable.name);
    return s;
  }

  private forBody(s: Stmt & { body: Stmt[]; nextLine: number }, forTok: Token, varName: string): void {
    this.forDepth++;
    let result: { body: Stmt[]; closer: Closer | null };
    try { result = this.block(); } finally { this.forDepth--; }
    const { body, closer } = result;
    s.body = body;
    if (closer === 'next') s.nextLine = this.consumeNext(varName);
    else this.unclosedBlock('For without Next', forTok);
  }

  /** Consumes `Next [i[, j ...]]` (or the next queued name of `Next j, i`), checking the loop variable; returns the Next's line. */
  private consumeNext(varName: string | undefined): number {
    let name: string | undefined;
    let tok: Token;
    if (this.nextQueue.length > 0) {
      tok = this.peek();
      name = this.nextQueue.shift();
    } else {
      tok = this.advance(); // Next
      this.nextTokLine = tok.line;
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
    return this.nextTokLine;
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
      if (w === 'for' || w === 'do' || w === 'sub' || w === 'function' || w === 'property') {
        this.advance();
        return { kind: 'exit', what: w, line: t.line };
      }
    }
    return this.fail('Expected: For, Do, Sub, Function or Property');
  }

  /** `RaiseEvent Name[(args)]`. */
  private raiseEventStatement(): Stmt {
    const t = this.advance();
    const name = this.expectIdent();
    const args = this.isOp('(') ? this.parseParenArgs() : [];
    return { kind: 'raiseEvent', name: baseName(name), args, line: t.line };
  }

  private labelTarget(): string {
    const t = this.peek();
    if (t.kind === 'ident' && !t.suffix) { this.advance(); return t.text; }
    if (t.kind === 'number' && !t.suffix && Number.isInteger(t.value as number)) { this.advance(); return String(t.value); }
    return this.fail('Expected: identifier');
  }

  /** `On Error ...`, or `On n GoTo l1, l2` / `On n GoSub l1, l2`. */
  private onStatement(): Stmt {
    if (!this.isKeyword('error', 1)) {
      const t = this.advance();
      const index = this.parseExpression();
      const gosub = this.isKeyword('gosub');
      if (!gosub && !this.isKeyword('goto')) this.fail('Expected: GoTo or GoSub');
      this.advance();
      const labels = [this.labelTarget()];
      while (this.isOp(',')) { this.advance(); labels.push(this.labelTarget()); }
      return { kind: 'onGoto', index, labels, gosub, line: t.line };
    }
    return this.onErrorStatement();
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
      if (this.attributeLine()) continue;
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

  /** `Option Explicit`, `Option Base 0|1`, `Option Compare Binary|Text`, `Option Private Module` (accepted, no effect). */
  private parseOption(ast: ModuleAst | null = null): void {
    this.advance(); // Option
    if (this.isKeyword('explicit')) { this.advance(); if (ast) ast.optionExplicit = true; return; }
    const t = this.peek();
    const w = t.kind === 'ident' || t.kind === 'keyword' ? lower(t) : '';
    const n = this.peek(1);
    const next = n.kind === 'ident' ? lower(n) : '';
    if (w === 'base') {
      this.advance();
      if (n.kind !== 'number' || (n.value !== 0 && n.value !== 1) || n.suffix) this.fail('Expected: 0 or 1');
      this.advance();
      if (ast) ast.optionBase = n.value as number;
      return;
    }
    if (w === 'compare') {
      this.advance();
      if (next !== 'binary' && next !== 'text') this.fail('Expected: Binary or Text');
      this.advance();
      if (ast) ast.optionCompareText = next === 'text';
      this.textCompare = next === 'text';
      return;
    }
    if (w === 'private' && next === 'module') { this.advance(); this.advance(); return; }
    if (w) this.unsupported(`Option ${cap(t.text)}`);
    this.fail('Syntax error');
  }

  parseModuleAst(name: string): ModuleAst {
    const ast: ModuleAst = { name, optionExplicit: false, variables: [], consts: [], types: [], enums: [], procedures: [], events: [], implements: [] };
    for (;;) {
      this.skipSeparators();
      if (this.peek().kind === 'eof') {
        const def = this.memberIds.get(0), en = this.memberIds.get(-4);
        if (def !== undefined) ast.defaultMember = def;
        if (en !== undefined) ast.newEnum = en;
        return ast;
      }
      if (this.attributeLine()) continue;
      this.recovering(() => { this.moduleItem(ast); this.expectEnd(); });
    }
  }

  /**
   * A member attribute of a VB6 class file (`Attribute Value.VB_UserMemId = 0`, `Attribute NewEnum.VB_MemberFlags = "40"`),
   * at module level or inside the procedure it belongs to: consumed whole. VB_UserMemId 0 makes the default member, -4
   * the member For Each enumerates; the others change nothing. False (nothing consumed) for anything else.
   */
  private attributeLine(): boolean {
    const t = this.peek();
    if (t.kind !== 'ident' || t.suffix || lower(t) !== 'attribute' || this.peek(1).kind !== 'ident' || !this.isOp('.', 2)
      || this.peek(3).kind !== 'ident' || !this.isOp('=', 4)) return false;
    const member = baseName(this.peek(1));
    const attr = this.peek(3).text.toLowerCase();
    for (let i = 0; i < 5; i++) this.advance();
    let sign = 1;
    if (this.isOp('-')) { this.advance(); sign = -1; }
    const v = this.peek();
    if (attr === 'vb_usermemid' && v.kind === 'number') this.memberIds.set(sign * (v.value as number), member);
    this.skipLine();
    return true;
  }

  /** One module-level item. With `ast` null (line mode) only headers are parsed. */
  private moduleItem(ast: ModuleAst | null): void {
    const first = this.peek();
    const w = first.kind === 'keyword' ? lower(first) : '';
    if (w === 'option') {
      if (ast && ast.procedures.length > 0) this.fail('Option Explicit must precede any procedure');
      this.parseOption(ast);
      return;
    }
    let visibility: 'public' | 'private' | undefined;
    let isStatic = false;
    const procNext = (o: number) => this.isKeyword('sub', o) || this.isKeyword('function', o) || this.isKeyword('property', o);
    if (w === 'private' || w === 'public' || w === 'friend' || w === 'global') {
      // `Friend` (visible to the project, not to other programs): Public in VibeBasic; `Global` is the old word for Public
      visibility = w === 'friend' || w === 'global' ? 'public' : w;
      this.advance();
      if (this.isKeyword('static') && procNext(1)) { isStatic = true; this.advance(); }
    } else if (w === 'static' && procNext(1)) {
      isStatic = true;
      this.advance();
    }
    const t = this.peek();
    const k = t.kind === 'keyword' ? lower(t) : '';
    if (UNSUPPORTED_KEYWORDS[k]) this.unsupported(UNSUPPORTED_KEYWORDS[k]);
    switch (k) {
      case 'sub': case 'function': case 'property': {
        const p = this.procedure(visibility ?? 'public', isStatic, first);
        if (ast) ast.procedures.push(p);
        return;
      }
      case 'event': {
        this.advance();
        const nameTok = this.expectIdent();
        const d: EventDecl = { name: baseName(nameTok), params: this.params(), line: nameTok.line };
        if (ast) ast.events!.push(d);
        return;
      }
      case 'implements': {
        if (visibility) break;
        this.advance();
        const nameTok = this.expectIdent();
        let name = nameTok.text;
        while (this.isOp('.') && this.peek(1).kind === 'ident') { this.advance(); name += '.' + this.advance().text; }
        if (ast) ast.implements!.push(name);
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
        const decls = this.moduleVarDecls('dim');
        if (ast) ast.variables.push(...decls);
        return;
      }
    }
    if (visibility && (t.kind === 'ident' || k === 'withevents')) {
      const decls = this.moduleVarDecls(visibility);
      if (ast) ast.variables.push(...decls);
      return;
    }
    if (visibility) this.fail('Expected: identifier');
    this.fail('Invalid outside procedure');
  }

  /** Set while module-level variables are declared: `WithEvents` is allowed there only. */
  private inModuleDecls = false;

  private moduleVarDecls(scope: VarDecl['scope']): VarDecl[] {
    this.inModuleDecls = true;
    try { return this.varDecls(scope); } finally { this.inModuleDecls = false; }
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
      const paramArray = this.isKeyword('paramarray');
      if (paramArray) { this.advance(); byRef = false; }
      const nameTok = this.expectIdent();
      let isArray = false;
      if (this.isOp('(')) { this.advance(); this.expectOp(')'); isArray = true; }
      let type: VBTypeName | undefined = nameTok.suffix ? SUFFIX_TYPES[nameTok.suffix] : undefined;
      if (this.isKeyword('as')) type = this.parseAsClause().type;
      const p: Param = { name: baseName(nameTok), byRef, optional, isArray };
      if (paramArray) {
        if (!isArray) this.fail('ParamArray must be an array: ParamArray args() As Variant', nameTok);
        p.paramArray = true;
        p.type ??= 'Variant';
      }
      if (type !== undefined) p.type = type;
      if (this.isOp('=')) { this.advance(); p.defaultValue = this.parseExpression(); }
      params.push(p);
      if (paramArray && !this.isOp(')')) this.fail('ParamArray must be the last parameter', this.peek());
      if (this.isOp(',')) { this.advance(); continue; }
      this.expectOp(')');
      return params;
    }
  }

  private procedure(visibility: 'public' | 'private', isStatic: boolean, first: Token): ProcDecl {
    const kwTok = this.advance();
    const word = lower(kwTok) as ProcKind;
    let property: ProcDecl['property'];
    if (word === 'property') {
      // `Property Get|Let|Set Name(...)`: Get and Let/Set are a word and keywords
      const g = this.peek();
      const gw = g.kind === 'ident' || g.kind === 'keyword' ? lower(g) : '';
      if (gw !== 'get' && gw !== 'let' && gw !== 'set') this.fail('Expected: Get or Let or Set');
      this.advance();
      property = gw;
    }
    const kind: 'sub' | 'function' = word === 'property' ? (property === 'get' ? 'function' : 'sub') : word;
    const p: ProcDecl = { kind, name: '?', visibility, isStatic, params: [], body: [], line: first.line, endLine: first.line };
    if (property) p.property = property;
    try {
      const nameTok = this.expectIdent();
      p.name = baseName(nameTok);
      if (kind === 'function' && nameTok.suffix) p.returnType = SUFFIX_TYPES[nameTok.suffix];
      p.params = this.params();
      if ((property === 'let' || property === 'set') && (p.params.length === 0 || p.params[p.params.length - 1].optional || p.params.some(x => x.paramArray))) {
        this.fail('Definitions of property procedures for the same property are inconsistent, or property procedure has an optional parameter, a ParamArray, or an invalid Set final parameter', nameTok);
      }
      if (kind === 'function' && this.isKeyword('as')) {
        p.returnType = this.parseAsClause().type;
        // `Function Nums() As Integer()`: returns an array
        if (this.isOp('(') && this.isOp(')', 1)) { this.advance(); this.advance(); p.returnsArray = true; }
      }
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
    this.procKind = word;
    this.forDepth = 0;
    this.nextQueue = [];
    const endCloser = END_CLOSERS[word];
    const endName = END_NAMES[word];
    for (;;) {
      const { body, closer } = this.block();
      p.body.push(...body);
      if (closer === null) { this.soft(`Expected: ${endName}`, this.peek()); break; }
      if (closer === endCloser) {
        p.endLine = this.peek().line;
        this.advance(); this.advance();
        break;
      }
      const bad = isProcCloser(closer)
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

/**
 * Parses a module; throws the first VBSyntaxError (with `moduleName` set). `consts`: the project's conditional
 * compilation constants for `#If` (see condComp.ts).
 */
export function parseModule(source: string, moduleName: string, consts?: CondConsts): ModuleAst {
  try {
    return new StatementParser(tokenize(preprocess(source, consts))).parseModuleAst(moduleName);
  } catch (e) {
    if (e instanceof VBSyntaxError) e.moduleName = moduleName;
    throw e;
  }
}

/** Checks one logical line without requiring blocks to match (VB6 "Auto Syntax Check"). */
export function checkLineSyntax(line: string): VBSyntaxError | null {
  const directive = directiveLineError(line);
  if (directive !== undefined) return directive;
  try {
    new StatementParser(tokenize(preprocess(line))).parseLine();
    return null;
  } catch (e) {
    if (e instanceof VBSyntaxError) return e;
    throw e;
  }
}

/**
 * Parses a module without stopping at errors: every syntax error (each with `moduleName` set) plus the AST of
 * everything that did parse (a failing statement is skipped to the end of its line). `ast` is null only when
 * the lexer never got through the source.
 */
export function parseModuleLenient(source: string, moduleName: string, consts?: CondConsts): { ast: ModuleAst | null; errors: VBSyntaxError[] } {
  const errors: VBSyntaxError[] = [];
  let src = preprocess(source, consts, errors);
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
  let ast: ModuleAst | null = null;
  if (tokens) {
    const p = new StatementParser(tokens);
    p.collect = errors;
    ast = p.parseModuleAst(moduleName);
  }
  const seen = new Set<string>();
  for (const e of errors) e.moduleName = moduleName;
  const sorted = errors
    .sort((a, b) => a.line - b.line || a.col - b.col)
    .filter(e => { const k = `${e.line}:${e.col}:${e.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ast, errors: sorted };
}

/** All syntax errors of a module (each with `moduleName` set); after an error parsing resumes on the next line. */
export function findSyntaxErrors(source: string, moduleName: string, consts?: CondConsts): VBSyntaxError[] {
  return parseModuleLenient(source, moduleName, consts).errors;
}
