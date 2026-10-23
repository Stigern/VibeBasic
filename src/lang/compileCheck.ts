// The compile errors VB6 finds in a whole program before it runs, beyond syntax: a variable of another type passed to a
// typed ByRef parameter, an array or record passed in its own parentheses, New of anything but a Collection, and LSet /
// RSet of a record. The interpreter raises the same errors when the statement runs (exec.ts bindParams, eval.ts bindArgs
// and objectFactory, exec.ts execStringStmt); this pass finds them all at once, before the program starts (Program) and in
// AI code (src/ai/validate.ts).
//
// Every rule stays silent when it is not sure: a name it cannot resolve to a declared variable, a callee that may be
// something else than a procedure, a type it does not know.
import type { Expr, MissingArg, ModuleAst, Param, PrintItem, ProcDecl, Stmt, VarDecl, VBTypeName } from './ast';

export interface CheckModule { name: string; kind: 'form' | 'module'; ast: ModuleAst }

export interface CompileProblem {
  module: string;
  line: number;
  /** VB6's text ("ByRef argument type mismatch"), as the interpreter raises it. */
  message: string;
  /** The message with what to do about it, for the AI ("... pass (total) or declare total As Integer."). */
  hint: string;
}

export interface CompileCheckOptions {
  /** Which procedures to check (default: all of them). */
  only?: (module: CheckModule, proc: ProcDecl) => boolean;
  /** Which module-level declarations to check (default: all of them; none when `only` is given). */
  onlyDecls?: (module: CheckModule, decl: VarDecl) => boolean;
  /** Names whose declaration in the procedure is not known (an AI code body without its Sub): not resolved. */
  unknownLocals?: (module: CheckModule, proc: ProcDecl) => ReadonlySet<string>;
}

const lc = (s: string) => s.toLowerCase();

/** A variable as the rules need it: its resolved type and whether it is an array. */
interface VarInfo { type: VBTypeName; isArray: boolean }
/** What a name resolves to: a variable, a procedure, or something the rules leave alone (a constant, an unknown name). */
type Resolved = { var: VarInfo } | { proc: ProcDecl; module: CheckModule } | null;

const SCALARS = new Set<VBTypeName>(['Integer', 'Long', 'Single', 'Double', 'Currency', 'String', 'Boolean', 'Variant', 'Date', 'Byte']);

const typeText = (t: VBTypeName): string => (typeof t === 'string' ? t : 'userType' in t ? t.userType : t.objectType);

function sameType(a: VBTypeName, b: VBTypeName): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if ('userType' in a && 'userType' in b) return lc(a.userType) === lc(b.userType);
  if ('objectType' in a && 'objectType' in b) return lc(a.objectType) === lc(b.objectType);
  return false;
}

/** The newObject message for `New T`, null when T can be made (a Collection, a form of the project). Matches eval.ts objectFactory. */
function newProblem(t: VBTypeName, forms: ReadonlySet<string>): string | null {
  if (typeof t === 'string' || 'userType' in t) return 'Invalid use of New keyword';
  const n = lc(t.objectType);
  if (n === 'collection' || n === 'vba.collection' || forms.has(n)) return null;
  return `Not supported in VibeBasic: New ${t.objectType} (there are no class modules; New can create a Collection)`;
}

export function compileProblems(modules: CheckModule[], opts: CompileCheckOptions = {}): CompileProblem[] {
  const out: CompileProblem[] = [];
  const std = modules.filter(m => m.kind === 'module');

  /** A type as the interpreter resolves it: a name of a Type is a record, of an Enum a Long (program.ts resolveType). */
  const resolveType = (t: VBTypeName | undefined, m: CheckModule): VBTypeName => {
    if (t === undefined) return 'Variant';
    if (typeof t === 'string' || 'userType' in t) return t;
    const k = lc(t.objectType);
    const order = [m, ...std.filter(x => x !== m), ...modules.filter(x => x !== m && x.kind !== 'module')];
    for (const x of order) {
      if (x.ast.types.some(d => lc(d.name) === k)) return { userType: t.objectType };
      if (x.ast.enums.some(d => lc(d.name) === k)) return 'Long';
    }
    return t;
  };
  /** Type and array-ness the rules can compare: scalars and records; null for objects and unknown types. */
  const comparable = (t: VBTypeName): boolean => SCALARS.has(t) || (typeof t === 'object' && 'userType' in t);

  /** Public procedures and variables of the standard modules, by lower-case name; null when two modules have one. */
  const globalProcs = new Map<string, { proc: ProcDecl; module: CheckModule } | null>();
  const globalVars = new Map<string, VarInfo | null>();
  const globalOther = new Set<string>();
  for (const m of std) {
    for (const p of m.ast.procedures) {
      if (p.visibility !== 'public') continue;
      const k = lc(p.name);
      globalProcs.set(k, globalProcs.has(k) ? null : { proc: p, module: m });
    }
    for (const d of m.ast.variables) {
      if (d.scope !== 'public') continue;
      const k = lc(d.name);
      globalVars.set(k, globalVars.has(k) ? null : { type: resolveType(d.type, m), isArray: d.isArray });
    }
    for (const c of m.ast.consts) if (c.scope === 'public') globalOther.add(lc(c.name));
    for (const e of m.ast.enums) for (const x of e.members) globalOther.add(lc(x.name));
    globalOther.add(lc(m.name));
  }
  for (const m of modules) if (m.kind === 'form') globalOther.add(lc(m.name));
  const formNames = new Set(modules.filter(m => m.kind === 'form').map(m => lc(m.name)));

  for (const m of modules) {
    const moduleVars = new Map<string, VarInfo>(m.ast.variables.map(d => [lc(d.name), { type: resolveType(d.type, m), isArray: d.isArray }]));
    const moduleProcs = new Map(m.ast.procedures.map(p => [lc(p.name), p]));
    const moduleOther = new Set([...m.ast.consts.map(c => lc(c.name)), ...m.ast.enums.flatMap(e => e.members.map(x => lc(x.name)))]);
    const report = (line: number, message: string, hint = message) => out.push({ module: m.name, line, message, hint });
    const newDecl = (d: VarDecl) => {
      if (!d.isNew) return;
      const msg = newProblem(resolveType(d.type, m), formNames);
      if (msg) report(d.line, msg);
    };
    const declOk = opts.onlyDecls ?? (() => !opts.only);
    for (const d of m.ast.variables) if (declOk(m, d)) newDecl(d);
    for (const t of m.ast.types) for (const d of t.fields) if (declOk(m, d)) newDecl(d);

    for (const proc of m.ast.procedures) {
      if (opts.only && !opts.only(m, proc)) continue;
      const unknown = opts.unknownLocals?.(m, proc) ?? new Set<string>();
      // the procedure's own names: parameters, Dim / Static / ReDim anywhere in it, constants (VB6 scope is the procedure)
      const locals = new Map<string, VarInfo | null>();
      for (const p of proc.params) locals.set(lc(p.name), { type: resolveType(p.type, m), isArray: p.isArray || !!p.paramArray });
      if (proc.kind === 'function') locals.set(lc(proc.name), null);
      const declare = (body: Stmt[]): void => walkStmts(body, s => {
        if (s.kind === 'dim') for (const d of s.decls) locals.set(lc(d.name), { type: resolveType(d.type, m), isArray: d.isArray });
        else if (s.kind === 'const') for (const d of s.decls) locals.set(lc(d.name), null);
        else if (s.kind === 'redim') for (const d of s.decls) if (!locals.has(lc(d.name)) && !moduleVars.has(lc(d.name)) && !globalVars.has(lc(d.name))) locals.set(lc(d.name), { type: resolveType(d.type, m), isArray: true });
      }, () => {});
      declare(proc.body);

      const resolve = (name: string): Resolved => {
        const k = lc(name);
        if (unknown.has(k)) return null;
        if (locals.has(k)) { const v = locals.get(k); return v ? { var: v } : null; }
        const mv = moduleVars.get(k);
        if (mv) return { var: mv };
        const mp = moduleProcs.get(k);
        if (mp) return { proc: mp, module: m };
        if (moduleOther.has(k)) return null;
        const gp = globalProcs.get(k);
        if (gp !== undefined) return gp && !globalVars.has(k) && !globalOther.has(k) ? gp : null;
        const gv = globalVars.get(k);
        return gv && !globalOther.has(k) ? { var: gv } : null;
      };

      /** One argument for a parameter of a known procedure. */
      const arg = (callee: ProcDecl, calleeModule: CheckModule, p: Param, a: Expr | MissingArg, line: number) => {
        if (a.kind === 'missing' || p.paramArray) return;
        const paren = (a as { paren?: boolean }).paren === true;
        const ptype = resolveType(p.type, calleeModule);
        if (paren && (p.isArray || (typeof ptype === 'object' && 'userType' in ptype))) {
          const msg = 'Type mismatch: array or user-defined type expected';
          report(line, msg, `${msg}: ${callee.name}'s ${p.name} takes the ${p.isArray ? 'array' : 'record'} by reference; pass it without the parentheses.`);
          return;
        }
        if (paren || !p.byRef || p.isArray || ptype === 'Variant' || !comparable(ptype)) return;
        // a plain variable, or an element of an array variable
        let v: VarInfo | null = null, text = '', name = '';
        if (a.kind === 'name') {
          const r = resolve(a.name);
          if (r && 'var' in r && !r.var.isArray) { v = r.var; text = a.name; name = a.name; }
        } else if (a.kind === 'call' && a.target.kind === 'name' && a.args.length > 0) {
          const r = resolve(a.target.name);
          if (r && 'var' in r && r.var.isArray) { v = r.var; text = `${a.target.name}(...)`; name = `${a.target.name}()`; }
        }
        if (!v || !comparable(v.type) || sameType(v.type, ptype)) return;
        const msg = 'ByRef argument type mismatch';
        report(line, msg, `${msg}: ${callee.name}'s ${p.name} is ${typeText(ptype)}, ${text} is ${typeText(v.type)}; pass (${text}) or declare ${name} As ${typeText(ptype)}.`);
      };
      const call = (target: Expr, args: (Expr | MissingArg)[], line: number) => {
        if (target.kind !== 'name') return;
        const r = resolve(target.name);
        if (!r || !('proc' in r)) return;
        r.proc.params.forEach((p, i) => { if (i < args.length) arg(r.proc, r.module, p, args[i], line); });
      };
      const expr = (e: Expr | MissingArg, line: number): void => {
        walkExpr(e, x => {
          if (x.kind === 'call') call(x.target, x.args, line);
          else if (x.kind === 'new') { const msg = newProblem(resolveType({ objectType: x.typeName }, m), formNames); if (msg) report(line, msg); }
        });
      };
      walkStmts(proc.body, s => {
        if (s.kind === 'call') call(s.target, s.args, s.line);
        else if (s.kind === 'dim') for (const d of s.decls) newDecl(d);
        else if ((s.kind === 'lset' || s.kind === 'rset') && s.target.kind === 'name') {
          const r = resolve(s.target.name);
          const t = r && 'var' in r && !r.var.isArray ? r.var.type : null;
          if (t && typeof t === 'object' && 'userType' in t) report(s.line, `Not supported in VibeBasic: ${s.kind === 'lset' ? 'LSet' : 'RSet'} of a user-defined type`);
        }
      }, expr);
    }
  }
  return out;
}

/** Every statement of `body`, nested ones included (`stmt`), and every expression a statement holds (`expr`, with its line). */
function walkStmts(body: Stmt[], stmt: (s: Stmt) => void, expr: (e: Expr | MissingArg, line: number) => void): void {
  const items = (list: PrintItem[], line: number) => { for (const it of list) { if (it.expr) expr(it.expr, line); if (it.fn?.arg) expr(it.fn.arg, line); } };
  for (const s of body) {
    stmt(s);
    const x = (e: Expr | MissingArg | undefined) => { if (e) expr(e, s.line); };
    switch (s.kind) {
      case 'dim': for (const d of s.decls) for (const b of d.bounds ?? []) { x(b.lower); x(b.upper); } break;
      case 'const': for (const d of s.decls) x(d.value); break;
      case 'redim': for (const d of s.decls) for (const b of d.bounds) { x(b.lower); x(b.upper); } break;
      case 'erase': break;
      case 'assign': x(s.target); x(s.value); break;
      // the call itself is the statement's (stmt); its arguments may hold calls too
      case 'call': if (s.target.kind !== 'name') x(s.target); s.args.forEach(x); break;
      case 'if': for (const b of s.branches) { x(b.cond); walkStmts(b.body, stmt, expr); } if (s.elseBody) walkStmts(s.elseBody, stmt, expr); break;
      case 'select':
        x(s.subject);
        for (const c of s.cases) {
          for (const t of c.tests) { if (t.kind === 'range') { x(t.from); x(t.to); } else x(t.value); }
          walkStmts(c.body, stmt, expr);
        }
        if (s.elseBody) walkStmts(s.elseBody, stmt, expr);
        break;
      case 'for': x(s.variable); x(s.from); x(s.to); x(s.step); walkStmts(s.body, stmt, expr); break;
      case 'forEach': x(s.variable); x(s.collection); walkStmts(s.body, stmt, expr); break;
      case 'do': x(s.test?.expr); walkStmts(s.body, stmt, expr); break;
      case 'while': x(s.cond); walkStmts(s.body, stmt, expr); break;
      case 'with': x(s.object); walkStmts(s.body, stmt, expr); break;
      case 'unload': case 'load': x(s.target); break;
      case 'debugPrint': items(s.items, s.line); break;
      case 'error': x(s.number); break;
      case 'mid': x(s.target); x(s.start); x(s.length); x(s.value); break;
      case 'lset': case 'rset': x(s.target); x(s.value); break;
      case 'open': x(s.path); x(s.file); x(s.recLen); break;
      case 'close': s.files.forEach(x); break;
      case 'printFile': case 'writeFile': x(s.file); items(s.items, s.line); break;
      case 'inputFile': case 'lineInput': x(s.file); s.targets.forEach(x); break;
      case 'getFile': case 'putFile': x(s.file); x(s.rec); x(s.target); break;
      case 'seekFile': x(s.file); x(s.pos); break;
      case 'name': x(s.from); x(s.to); break;
      case 'exit': case 'onError': case 'resume': case 'goto': case 'label': case 'end': case 'stop': break;
      default: { const never: never = s; void never; }
    }
  }
}

/** `e` and every expression inside it. */
function walkExpr(e: Expr | MissingArg, visit: (e: Expr) => void): void {
  if (e.kind === 'missing') return;
  visit(e);
  switch (e.kind) {
    case 'member': walkExpr(e.object, visit); break;
    case 'call': walkExpr(e.target, visit); e.args.forEach(a => walkExpr(a, visit)); break;
    case 'unary': walkExpr(e.operand, visit); break;
    case 'binary': walkExpr(e.left, visit); walkExpr(e.right, visit); break;
  }
}
