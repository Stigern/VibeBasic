// Conditional compilation: `#Const NAME = expr` and `#If expr Then` / `#ElseIf expr Then` / `#Else` / `#End If`,
// evaluated before a module is parsed. Directive lines and the lines of branches not taken become empty lines, so
// line numbers stay the same (VB6 does not compile them at all: they may hold anything).
//
// Conditions and #Const values are constant expressions of literals, operators and conditional constants: the
// module's own #Const (private to the module), the project's (`condComp`, "DEBUG = 1 : BETA = 0", as in VB6's
// Project Properties) and VB6's built-in Win16 (False) and Win32 (True). An undefined name is Empty (False).

import type { Expr } from './ast';
import { VBRuntimeError, VBSyntaxError } from './errors';
import { Parser } from './exprParser';
import { tokenize } from './lexer';
import { binaryOp, truthy, unaryOp } from './interp/operators';
import { Empty, type VBValue } from './values';

/** Conditional compilation constants by lower-case name. */
export type CondConsts = ReadonlyMap<string, VBValue>;

const BUILT_IN: [string, VBValue][] = [['win16', false], ['win32', true]];

const DIRECTIVE = /^[ \t]*#[ \t]*(ElseIf|Else|End[ \t]*If|If|Const)\b(.*)$/i;

/** Evaluates a constant expression of a directive. */
function evaluate(e: Expr, consts: CondConsts, fail: (msg: string) => never): VBValue {
  try {
    switch (e.kind) {
      case 'number': case 'string': case 'bool': return e.value;
      case 'name': return consts.get(e.name.toLowerCase()) ?? Empty;
      case 'unary': return unaryOp(e.op, evaluate(e.operand, consts, fail));
      case 'binary': return binaryOp(e.op, evaluate(e.left, consts, fail), evaluate(e.right, consts, fail));
      default: return fail('Constant expression required');
    }
  } catch (err) {
    if (err instanceof VBRuntimeError) return fail(err.message);
    throw err;
  }
}

/** Parses `text` as an expression followed by `then` (`#If`), `null` (end) or after `name =` (`#Const`). */
function parseDirective(text: string, line: number, what: 'cond' | 'const'): { name?: string; expr: Expr } {
  const fail = (msg: string): never => { throw new VBSyntaxError(msg, line, 1); };
  let p: Parser;
  try {
    p = new Parser(tokenize(text));
  } catch (e) {
    if (e instanceof VBSyntaxError) fail(e.message);
    throw e;
  }
  try {
    let name: string | undefined;
    if (what === 'const') {
      const t = p.advance();
      if (t.kind !== 'ident') fail('Expected: identifier');
      name = t.suffix ? t.text.slice(0, -1) : t.text;
      p.expectOp('=');
    }
    const expr = p.parseExpression();
    if (what === 'cond') {
      if (!p.isKeyword('then')) fail('Expected: Then');
      p.advance();
    }
    const end = p.peek().kind;
    if (end !== 'eof' && end !== 'comment') fail('Expected: end of statement');
    return { name, expr };
  } catch (e) {
    if (e instanceof VBSyntaxError && e.line !== line) fail(e.message);
    throw e;
  }
}

/** The project's conditional compilation arguments, VB6 style: `DEBUG = 1 : BETA = 0` (a syntax error throws). */
export function parseCondConsts(text: string): Map<string, VBValue> {
  const out = new Map<string, VBValue>();
  for (const part of text.split(':')) {
    if (!part.trim()) continue;
    const { name, expr } = parseDirective(part, 1, 'const');
    out.set(name!.toLowerCase(), evaluate(expr, out, msg => { throw new VBSyntaxError(msg, 1, 1); }));
  }
  return out;
}

/**
 * The line check of one directive line (Auto Syntax Check, without block matching): its own syntax error, or null;
 * undefined when `line` is no directive.
 */
export function directiveLineError(line: string): VBSyntaxError | null | undefined {
  const m = DIRECTIVE.exec(line);
  if (!m) return undefined;
  const word = m[1].toLowerCase().replace(/[ \t]+/g, '');
  const rest = m[2].trim();
  try {
    if (word === 'if' || word === 'elseif') parseDirective(m[2], 1, 'cond');
    else if (word === 'const') parseDirective(m[2], 1, 'const');
    else if (rest && !rest.startsWith("'")) return new VBSyntaxError('Expected: end of statement', 1, 1);
    return null;
  } catch (e) {
    if (e instanceof VBSyntaxError) return e;
    throw e;
  }
}

interface Branch { parentActive: boolean; taken: boolean; sawElse: boolean; line: number }

/**
 * The source with conditional compilation applied (the same text when it has no directive). Errors (a `#Else`
 * without `#If`, a bad condition ...) throw, or are added to `errors` with the line left empty.
 */
export function preprocess(source: string, project?: CondConsts, errors?: VBSyntaxError[]): string {
  if (source.indexOf('#') < 0) return source;
  const parts = source.split(/(\r\n|\n|\r)/);   // line, line break, line, ...
  let any = false;
  for (let i = 0; i < parts.length && !any; i += 2) any = DIRECTIVE.test(parts[i]);
  if (!any) return source;
  const consts = new Map<string, VBValue>(BUILT_IN);
  if (project) for (const [k, v] of project) consts.set(k, v);
  const stack: Branch[] = [];
  let active = true;
  const report = (e: VBSyntaxError) => { if (errors) errors.push(e); else throw e; };
  for (let i = 0; i < parts.length; i += 2) {
    const line = i / 2 + 1;
    const m = DIRECTIVE.exec(parts[i]);
    if (!m) {
      if (!active) parts[i] = '';
      continue;
    }
    parts[i] = '';
    const word = m[1].toLowerCase().replace(/[ \t]+/g, '');
    const rest = m[2];
    const fail = (msg: string): never => { throw new VBSyntaxError(msg, line, 1); };
    const cond = (): boolean => truthy(evaluate(parseDirective(rest, line, 'cond').expr, consts, fail));
    try {
      const top = stack[stack.length - 1];
      switch (word) {
        case 'const':
          if (active) {
            const { name, expr } = parseDirective(rest, line, 'const');
            consts.set(name!.toLowerCase(), evaluate(expr, consts, fail));
          }
          break;
        case 'if': {
          const taken: boolean = active && cond();
          stack.push({ parentActive: active, taken, sawElse: false, line });
          active = taken;
          break;
        }
        case 'elseif': {
          if (!top || top.sawElse) fail('#ElseIf without #If');
          active = top.parentActive && !top.taken && cond();
          if (active) top.taken = true;
          break;
        }
        case 'else': {
          if (!top || top.sawElse) fail('#Else without #If');
          if (rest.trim() && !rest.trim().startsWith("'")) fail('Expected: end of statement');
          active = top.parentActive && !top.taken;
          top.taken = top.sawElse = true;
          break;
        }
        default: {   // endif
          if (!top) fail('#End If without #If');
          stack.pop();
          active = top.parentActive;
        }
      }
    } catch (e) {
      if (!(e instanceof VBSyntaxError)) throw e;
      report(e);
    }
  }
  if (stack.length) report(new VBSyntaxError('#If block not terminated by #End If', stack[stack.length - 1].line, 1));
  return parts.join('');
}
