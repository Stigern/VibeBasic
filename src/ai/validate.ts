// Checks the code the AI proposed: cheap automatic fixes plus a list of problems that is fed back to the model once.
// The checks only report; none of them changes the code. A false report costs a slow extra model round, so every
// rule stays silent when it is not sure (a name whose status is uncertain counts as known).
import type { Expr, MissingArg, ModuleAst, Param, PrintItem, ProcDecl, Stmt, VBTypeName } from '../lang/ast';
import { BUILTINS, CANONICAL_NAMES } from '../lang/builtins';
import { compileProblems, type CheckModule } from '../lang/compileCheck';
import { parseModuleLenient } from '../lang/parser';
import { TYPE_KEYWORDS } from '../lang/parseStatements';
import { CONTROL_TYPES } from '../model/controls';
import { listProcedures } from '../model/procedures';
import { moduleKind, type ControlType, type FormDef, type Project } from '../model/types';
import {
  BUILTIN_OBJECTS, controlHasMember, formMembers, isLanguageName, memberNamesOf, moduleNames, projectNames,
} from './knownNames';

export interface ValidateContext {
  moduleName: string;
  form: FormDef | null;
  extraControls?: { name: string; type: ControlType }[];
  /** Without a project only the checks that do not need it run (syntax, events, control members, unsupported calls). */
  project?: Project;
}

const KNOWN_EVENTS = new Set<string>();
for (const td of Object.values(CONTROL_TYPES)) for (const e of td.events) KNOWN_EVENTS.add(e.name.toLowerCase());

// ---------------------------------------------------------------------------------------------------------------
// Event signatures

interface SigParam { text: string; type?: VBTypeName }
const INDEX_PARAM: SigParam = { text: 'Index As Integer', type: 'Integer' };

/** 'KeyCode As Integer, Shift As Integer' (the registry's parameter list) -> the parameters, with the type when it is a plain type. */
function signature(params: string): SigParam[] {
  return params.split(',').map(t => t.trim()).filter(Boolean).map(text => {
    const m = /\bAs\s+(\w+)$/i.exec(text);
    return { text, type: m ? TYPE_KEYWORDS[lc(m[1])] : undefined };
  });
}

/** The last line of a procedure header (a header may continue over lines with ` _`). */
function headerEnd(lines: string[], line: number): number {
  let end = line;
  while (/\s_\s*$/.test(lines[end - 1] ?? '')) end++;
  return end;
}

/**
 * "Form_KeyPress needs (KeyAscii As Integer)." when the declared parameters differ from what the event passes in
 * number, or in a type that is declared; names may differ. `array` is undefined when it is not known whether the
 * control is an array: both forms are then accepted.
 */
function signatureProblem(procName: string, declared: Param[], params: string, array: boolean | undefined): string | null {
  const base = signature(params);
  const fits = (expected: SigParam[]) => declared.length === expected.length && declared.every((p, i) =>
    typeof p.type !== 'string' || expected[i].type === undefined || p.type === expected[i].type);
  const options = array === undefined ? [base, [INDEX_PARAM, ...base]] : [array ? [INDEX_PARAM, ...base] : base];
  if (options.some(fits)) return null;
  return `${procName} needs (${options[options.length - 1].map(p => p.text).join(', ')}).`;
}

const eventsOf = (type: ControlType): Set<string> => new Set(CONTROL_TYPES[type].events.map(e => e.name.toLowerCase()));
const FORM_EVENTS = (): Map<string, string> => new Map(CONTROL_TYPES.Form.events.map(e => [e.name.toLowerCase(), e.name]));

/** "Form1_Load" -> "Form_Load": VB6 form events always use the name Form_. Only the Sub header changes. */
export function autoFixEventNames(code: string, formName: string): { code: string; notes: string[] } {
  const notes: string[] = [];
  if (!formName || formName.toLowerCase() === 'form') return { code, notes };
  const formEvents = FORM_EVENTS();
  const re = /^(\s*(?:(?:Public|Private|Friend|Static)\s+)*Sub\s+)([A-Za-z_][A-Za-z0-9_]*)(?=\s*(?:\(|$|'))/i;
  const prefix = `${formName.toLowerCase()}_`;
  const lines = code.split('\n').map(line => {
    const m = re.exec(line.replace(/\r$/, ''));
    if (!m || !m[2].toLowerCase().startsWith(prefix)) return line;
    const ev = formEvents.get(m[2].slice(prefix.length).toLowerCase());
    if (!ev) return line;
    notes.push(`Renamed ${m[2]} to Form_${ev}`);
    return `${m[1]}Form_${ev}${line.slice(m[0].length)}`;
  });
  return { code: lines.join('\n'), notes };
}

const DECL_OR_COMMENT = /^\s*(?:$|'|Rem(?:\s|$)|(?:Dim|Const|Public|Private|Friend|Global|Static|Option|Type|Enum|Declare|Event|Implements|End\s+(?:Type|Enum))\b)/i;
const BARE_PROC = 'AiBody__';

// ---------------------------------------------------------------------------------------------------------------
// Unsupported functions and statements

/** Alternatives offered with "X is not supported in VibeBasic." (keys lower case). */
const ALTERNATIVES: Record<string, string> = {
  shell: 'Programs cannot be started.',
  print: 'Use a Label, a TextBox or Debug.Print instead.',
};
/** Functions that parse fine but do not exist in VibeBasic, with the name as written in VB6. */
const UNSUPPORTED_CALLS: Record<string, string> = {
  createobject: 'CreateObject', getobject: 'GetObject', shell: 'Shell',
};
const unsupported = (name: string): string => {
  const alt = ALTERNATIVES[name.toLowerCase()];
  return `${name} is not supported in VibeBasic.${alt ? ` ${alt}` : ''}`;
};
const PARSER_UNSUPPORTED = /^Not supported in VibeBasic: (.+)$/;

// ---------------------------------------------------------------------------------------------------------------
// Control members

/** Common mix-ups: `${type}.${member}` (lower case) -> what to use instead. */
const MIXUPS: Record<string, string> = {
  'label.text': 'Caption', 'commandbutton.text': 'Caption', 'frame.text': 'Caption', 'checkbox.text': 'Caption',
  'optionbutton.text': 'Caption', 'form.text': 'Caption', 'textbox.caption': 'Text',
  'listbox.items': 'List or AddItem', 'combobox.items': 'List or AddItem',
  'checkbox.checked': 'Value', 'optionbutton.checked': 'Value',
};

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length];
}

/** "Did you mean X?": the mix-up table first, then the closest registry name (at most two letters off). */
function suggestion(type: ControlType, member: string): string {
  const l = member.toLowerCase();
  const mix = MIXUPS[`${type.toLowerCase()}.${l}`];
  if (mix) return ` Did you mean ${mix}?`;
  const font = /^font(name|size|bold|italic|underline)$/i.exec(member);
  if (font) return ` Did you mean Font.${font[1].charAt(0).toUpperCase()}${font[1].slice(1).toLowerCase()}?`;
  let best = '', dist = Infinity;
  for (const n of memberNamesOf(type)) {
    const k = editDistance(l, n.toLowerCase());
    if (k < dist) { best = n; dist = k; }
  }
  return dist <= 2 && dist < l.length / 2 ? ` Did you mean ${best}?` : '';
}

const article = (type: string) => (/^[AEIOU]|^MS/.test(type) ? 'An' : 'A');
const noMember = (type: ControlType, member: string, method: boolean) =>
  `${article(type)} ${type} has no ${member} ${method ? 'method' : 'property'}.${suggestion(type, member)}`;

// ---------------------------------------------------------------------------------------------------------------
// Walking the code

const lc = (s: string) => s.toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// Argument counts

interface Arity { name: string; min: number; max: number }
/** A built-in with this many or more maximum arguments takes any number (Choose, Array). */
const ANY_COUNT = 100;
const procArity = (p: ProcDecl): Arity => ({
  name: p.name, min: p.params.filter(x => !x.optional && !x.paramArray).length,
  max: p.params.some(x => x.paramArray) ? ANY_COUNT : p.params.length,
});

/** "Twice takes 1 argument, not 2." */
function arityMessage(a: Arity, given: number): string {
  const n = a.max >= ANY_COUNT ? `at least ${a.min}` : a.max === 0 ? 'no' : a.min === a.max ? `${a.min}` : `${a.min} to ${a.max}`;
  return `${a.name} takes ${n} argument${a.max === 1 && a.min === 1 ? '' : 's'}, not ${given}.`;
}

/** The arguments a call passes, as the interpreter counts them (trailing omitted ones dropped); null when one in the middle is omitted. */
function argCount(args: (Expr | MissingArg)[]): number | null {
  let n = args.length;
  while (n > 0 && args[n - 1].kind === 'missing') n--;
  return args.slice(0, n).some(a => a.kind === 'missing') ? null : n;
}

/** Names a procedure declares (parameters, Dim, Static, Const, ReDim) and names it may create implicitly. */
function procNames(p: ProcDecl): { declared: Set<string>; implicit: Set<string> } {
  const declared = new Set<string>(p.params.map(x => lc(x.name)));
  const implicit = new Set<string>();
  const argNames = (args: (Expr | MissingArg)[]) => { for (const a of args) if (a.kind === 'name') implicit.add(lc(a.name)); };
  const expr = (e: Expr | MissingArg): void => {
    if (e.kind === 'call') { argNames(e.args); expr(e.target); e.args.forEach(expr); }
    else if (e.kind === 'member') expr(e.object);
    else if (e.kind === 'unary') expr(e.operand);
    else if (e.kind === 'binary') { expr(e.left); expr(e.right); }
    else if (e.kind === 'typeOf') expr(e.object);
  };
  /** A variable the statement writes (Input #, Get #, Mid, LSet...): a bare name may be created implicitly. */
  const target = (t: Expr) => { if (t.kind === 'name') implicit.add(lc(t.name)); expr(t); };
  const items = (list: PrintItem[]) => { for (const it of list) { if (it.expr) expr(it.expr); if (it.fn?.arg) expr(it.fn.arg); } };
  const stmts = (body: Stmt[]): void => {
    for (const s of body) {
      switch (s.kind) {
        case 'dim': for (const d of s.decls) declared.add(lc(d.name)); break;
        case 'const': for (const d of s.decls) declared.add(lc(d.name)); break;
        case 'redim': for (const d of s.decls) declared.add(lc(d.name)); break;
        case 'erase': for (const t of s.targets) implicit.add(lc(t.name)); break;
        case 'assign': target(s.target); expr(s.value); break;
        case 'call': argNames(s.args); s.args.forEach(expr); break;
        case 'raiseEvent': argNames(s.args); s.args.forEach(expr); break;
        case 'for': implicit.add(lc(s.variable.name)); expr(s.from); expr(s.to); if (s.step) expr(s.step); stmts(s.body); break;
        case 'forEach': implicit.add(lc(s.variable.name)); expr(s.collection); stmts(s.body); break;
        case 'if': for (const b of s.branches) { expr(b.cond); stmts(b.body); } if (s.elseBody) stmts(s.elseBody); break;
        case 'select': expr(s.subject); for (const c of s.cases) stmts(c.body); if (s.elseBody) stmts(s.elseBody); break;
        case 'do': if (s.test) expr(s.test.expr); stmts(s.body); break;
        case 'while': expr(s.cond); stmts(s.body); break;
        case 'with': expr(s.object); stmts(s.body); break;
        case 'unload': case 'load': expr(s.target); break;
        case 'debugPrint': items(s.items); break;
        case 'error': expr(s.number); break;
        case 'mid': target(s.target); expr(s.start); if (s.length) expr(s.length); expr(s.value); break;
        case 'lset': case 'rset': target(s.target); expr(s.value); break;
        case 'open': expr(s.path); expr(s.file); if (s.recLen) expr(s.recLen); break;
        case 'close': s.files.forEach(expr); break;
        case 'printFile': case 'writeFile': expr(s.file); items(s.items); break;
        case 'inputFile': case 'lineInput': expr(s.file); s.targets.forEach(target); break;
        case 'getFile': expr(s.file); if (s.rec) expr(s.rec); target(s.target); break;
        case 'putFile': expr(s.file); if (s.rec) expr(s.rec); expr(s.target); break;
        case 'seekFile': expr(s.file); expr(s.pos); break;
        case 'name': expr(s.from); expr(s.to); break;
        case 'onGoto': expr(s.index); break;
        case 'debugAssert': expr(s.cond); break;
        case 'exit': case 'onError': case 'resume': case 'goto': case 'return': case 'label': case 'end': case 'stop': break;
        default: { const never: never = s; void never; }
      }
    }
  };
  stmts(p.body);
  return { declared, implicit };
}

interface Checker {
  report(msg: string): void;
  /** The name rules may run (unknown names, undeclared variables, calls): the project is known and every module parsed. */
  namesKnown: boolean;
  optionExplicit: boolean;
  /** Module-level names of this module (proposal and existing code), lower case. */
  module: Set<string>;
  /** Public names of other modules, module and form names. */
  globals: Set<string>;
  /** Members of the current form (bare names in its procedures resolve to them); null in a standard module. */
  me: Set<string> | null;
  controls: Map<string, { type: ControlType; array: boolean }>;
  forms: Map<string, Set<string> | null>;
  /** Extra names every procedure counts as declared (a bare body: everything the module's procedures declare). */
  bareExtra: Set<string>;
  /** Procedures of this module (the proposal's replace the existing ones), lower case. */
  procs: Map<string, ProcDecl>;
  /** Public procedures of the other standard modules; null when the name is ambiguous. */
  globalProcs: Map<string, ProcDecl | null>;
}

function checkProc(c: Checker, p: ProcDecl): void {
  const { declared, implicit } = procNames(p);
  if (p.name === BARE_PROC) for (const n of c.bareExtra) declared.add(n);
  const shadowed = (k: string) => declared.has(k) || c.module.has(k);
  const known = (k: string) => shadowed(k) || c.globals.has(k) || isLanguageName(k) || BUILTIN_OBJECTS.has(k) || (c.me?.has(k) ?? false);
  const reportedNames = new Set<string>();
  const undefinedName = (name: string) => {
    const k = lc(name);
    if (!c.namesKnown || !c.optionExplicit || known(k) || reportedNames.has(k)) return;
    reportedNames.add(k);
    c.report(`Variable not defined: ${name}`);
  };
  const callName = (name: string) => {
    const k = lc(name);
    if (UNSUPPORTED_CALLS[k] && !shadowed(k) && !c.globals.has(k)) c.report(unsupported(UNSUPPORTED_CALLS[k]));
  };
  const control = (k: string) => (shadowed(k) ? undefined : c.controls.get(k));

  /** What `name(args)` / `name args` calls, in the interpreter's lookup order; null when it is not a known procedure or built-in. */
  const arityOf = (k: string, name: string, withArgs: boolean): Arity | null => {
    if (declared.has(k)) return null;
    const mp = c.procs.get(k);
    if (mp) return procArity(mp);
    if (c.module.has(k)) return null;
    // in a form a control or a property of Me comes first; with arguments a built-in wins over the property
    if (c.controls.has(k) || (c.me?.has(k) && !(withArgs && BUILTINS.has(k)))) return null;
    const gp = c.globalProcs.get(k);
    if (gp !== undefined) return gp && procArity(gp);
    if (c.globals.has(k)) return null;
    const b = BUILTINS.get(k);
    return b ? { name: CANONICAL_NAMES.get(k) ?? name, min: b.minArgs, max: b.maxArgs } : null;
  };
  /** A call by name: Sub or Function not defined, and a wrong argument count (the arity is known for the project's procedures and the built-ins). */
  const callTarget = (name: string, args: (Expr | MissingArg)[], expression: boolean) => {
    callName(name);
    const k = lc(name);
    if (!c.namesKnown || UNSUPPORTED_CALLS[k]) return;
    if (!known(k) && !implicit.has(k)) {
      if (!reportedNames.has(k)) c.report(`Sub or Function not defined: ${name}`);
      reportedNames.add(k);
      return;
    }
    const a = arityOf(k, name, expression || args.length > 0);
    const given = argCount(args);
    if (a && given !== null && (given < a.min || (given > a.max && a.max < ANY_COUNT))) c.report(arityMessage(a, given));
  };

  /** `obj.member`: rules 1 (unknown member of a control or form) and 2 (unknown name before the dot). */
  const member = (obj: Expr, name: string, method: boolean) => {
    if (obj.kind === 'name') {
      const k = lc(obj.name);
      if (k === 'me') {
        if (c.me && !c.me.has(lc(name))) c.report(noMember('Form', name, method));
        return;
      }
      const ctl = control(k);
      if (ctl) {
        if (!ctl.array && !controlHasMember(ctl.type, name, false)) c.report(noMember(ctl.type, name, method));
        return;
      }
      if (!shadowed(k) && c.forms.has(k)) {
        const members = c.forms.get(k);
        if (members && !members.has(lc(name))) c.report(noMember('Form', name, method));
        return;
      }
      if (!c.namesKnown || known(k) || (!c.optionExplicit && implicit.has(k)) || reportedNames.has(k)) return;
      reportedNames.add(k);
      c.report(`${obj.name} is not a control, form, module or variable.`);
      return;
    }
    // Me.Text1.Text
    if (obj.kind === 'member' && obj.object.kind === 'name' && lc(obj.object.name) === 'me' && c.me) {
      const ctl = c.controls.get(lc(obj.name));
      if (ctl && !ctl.array && !controlHasMember(ctl.type, name, false)) c.report(noMember(ctl.type, name, method));
    }
    // Text1(0).Text on a control array
    if (obj.kind === 'call' && obj.args.length === 1 && obj.target.kind === 'name') {
      const ctl = control(lc(obj.target.name));
      if (ctl?.array && !controlHasMember(ctl.type, name, true)) c.report(noMember(ctl.type, name, method));
    }
    expr(obj);
  };

  function expr(e: Expr | MissingArg): void {
    switch (e.kind) {
      case 'name': undefinedName(e.name); callName(e.name); return;
      case 'member': member(e.object, e.name, false); return;
      case 'call':
        if (e.target.kind === 'name') callTarget(e.target.name, e.args, true);
        else if (e.target.kind === 'member') member(e.target.object, e.target.name, false);
        else expr(e.target);
        e.args.forEach(expr);
        return;
      case 'unary': expr(e.operand); return;
      case 'binary': expr(e.left); expr(e.right); return;
      case 'typeOf': expr(e.object); return;
    }
  }

  /** A variable or property a statement writes (`x = `, `Input #1, x`, `Mid(x, 1) = `, `LSet x = `). */
  const target = (t: Expr) => {
    if (t.kind === 'name') undefinedName(t.name);
    else if (t.kind === 'call') {
      if (t.target.kind === 'member') member(t.target.object, t.target.name, false);
      else if (t.target.kind !== 'name') expr(t.target);
      t.args.forEach(expr);
    } else expr(t);
  };
  const items = (list: PrintItem[]) => { for (const it of list) { if (it.expr) expr(it.expr); if (it.fn?.arg) expr(it.fn.arg); } };
  const stmts = (body: Stmt[]): void => {
    for (const s of body) {
      switch (s.kind) {
        case 'dim': for (const d of s.decls) for (const b of d.bounds ?? []) { if (b.lower) expr(b.lower); expr(b.upper); } break;
        case 'const': for (const d of s.decls) expr(d.value); break;
        case 'redim': for (const d of s.decls) for (const b of d.bounds) { if (b.lower) expr(b.lower); expr(b.upper); } break;
        case 'erase': break;
        case 'assign': target(s.target); expr(s.value); break;
        case 'call':
          if (s.target.kind === 'name') callTarget(s.target.name, s.args, false);
          else if (s.target.kind === 'member') member(s.target.object, s.target.name, true);
          s.args.forEach(expr);
          break;
        case 'if': for (const b of s.branches) { expr(b.cond); stmts(b.body); } if (s.elseBody) stmts(s.elseBody); break;
        case 'select':
          expr(s.subject);
          for (const cl of s.cases) {
            for (const t of cl.tests) { if (t.kind === 'range') { expr(t.from); expr(t.to); } else expr(t.value); }
            stmts(cl.body);
          }
          if (s.elseBody) stmts(s.elseBody);
          break;
        case 'for': undefinedName(s.variable.name); expr(s.from); expr(s.to); if (s.step) expr(s.step); stmts(s.body); break;
        case 'forEach': undefinedName(s.variable.name); expr(s.collection); stmts(s.body); break;
        case 'do': if (s.test) expr(s.test.expr); stmts(s.body); break;
        case 'while': expr(s.cond); stmts(s.body); break;
        case 'with': expr(s.object); stmts(s.body); break;
        case 'unload': case 'load': expr(s.target); break;
        case 'debugPrint': items(s.items); break;
        case 'error': expr(s.number); break;
        case 'mid': target(s.target); expr(s.start); if (s.length) expr(s.length); expr(s.value); break;
        case 'lset': case 'rset': target(s.target); expr(s.value); break;
        case 'open': expr(s.path); expr(s.file); if (s.recLen) expr(s.recLen); break;
        case 'close': s.files.forEach(expr); break;
        case 'printFile': case 'writeFile': expr(s.file); items(s.items); break;
        case 'inputFile': case 'lineInput': expr(s.file); s.targets.forEach(target); break;
        case 'getFile': expr(s.file); if (s.rec) expr(s.rec); target(s.target); break;
        case 'putFile': expr(s.file); if (s.rec) expr(s.rec); expr(s.target); break;
        case 'seekFile': expr(s.file); expr(s.pos); break;
        case 'name': expr(s.from); expr(s.to); break;
        case 'raiseEvent': s.args.forEach(expr); break;
        case 'onGoto': expr(s.index); break;
        case 'debugAssert': expr(s.cond); break;
        case 'exit': case 'onError': case 'resume': case 'goto': case 'return': case 'label': case 'end': case 'stop': break;
        default: { const never: never = s; void never; }
      }
    }
  };
  stmts(p.body);
}

/** The name and call rules on a parsed proposal. The module's current code counts too: its declarations are known names. */
function checkNames(ast: ModuleAst, syntaxOk: boolean, ctx: ValidateContext, report: (m: string) => void): void {
  const name = lc(ctx.moduleName);
  const form = ctx.form ?? ctx.project?.forms.find(f => lc(f.name) === name) ?? null;
  const existingCode = form ? form.code : ctx.project?.modules.find(m => lc(m.name) === name)?.code ?? '';
  const existing = parseModuleLenient(existingCode, ctx.moduleName);
  const module = moduleNames(ast);
  if (existing.ast) for (const n of moduleNames(existing.ast)) module.add(n);
  const proj = ctx.project ? projectNames(ctx.project, name) : null;

  const controls = new Map<string, { type: ControlType; array: boolean }>();
  if (form) {
    for (const ctl of form.controls) controls.set(lc(ctl.name), { type: ctl.type, array: ctl.index !== null });
    for (const ctl of ctx.extraControls ?? []) if (!controls.has(lc(ctl.name))) controls.set(lc(ctl.name), { type: ctl.type, array: false });
  }
  const me = form ? formMembers(form, module, ctx.extraControls) : null;
  const forms = new Map(proj?.forms ?? []);
  if (form) forms.set(lc(form.name), me);

  const procs = new Map<string, ProcDecl>();
  // Property procedures share a name (Get and Let): their arity is not checked, the name is a module name
  for (const p of [...existing.ast?.procedures ?? [], ...ast.procedures]) if (p.name !== BARE_PROC && !p.property) procs.set(lc(p.name), p);

  const bareExtra = new Set<string>();
  for (const p of existing.ast?.procedures ?? []) { const n = procNames(p); for (const k of [...n.declared, ...n.implicit]) bareExtra.add(k); }

  const c: Checker = {
    report,
    namesKnown: !!proj && proj.complete && syntaxOk && existing.errors.length === 0,
    optionExplicit: ast.optionExplicit || (existing.ast?.optionExplicit ?? false),
    module, globals: proj?.globals ?? new Set(), me, controls, forms, bareExtra, procs, globalProcs: proj?.procs ?? new Map(),
  };
  for (const p of ast.procedures) checkProc(c, p);
  if (c.namesKnown && ctx.project) compileRules(ast, existing.ast, form !== null, { ...ctx, project: ctx.project }, c.bareExtra, report);
}

/**
 * The compile errors VibeBasic raises when the statement runs (a ByRef type mismatch, an array in parentheses, New of a
 * record, LSet of a record), found in the proposal's procedures with the whole project around them (src/lang/compileCheck.ts).
 */
function compileRules(ast: ModuleAst, existing: ModuleAst | null, isForm: boolean, ctx: ValidateContext & { project: Project },
  bareExtra: Set<string>, report: (m: string) => void): void {
  const name = lc(ctx.moduleName);
  const replaced = new Set(ast.procedures.map(p => lc(p.name)));
  const merged: ModuleAst = {
    ...ast,
    variables: [...existing?.variables ?? [], ...ast.variables], consts: [...existing?.consts ?? [], ...ast.consts],
    types: [...existing?.types ?? [], ...ast.types], enums: [...existing?.enums ?? [], ...ast.enums],
    procedures: [...(existing?.procedures ?? []).filter(p => !replaced.has(lc(p.name))), ...ast.procedures],
    events: [...existing?.events ?? [], ...ast.events ?? []], implements: [...existing?.implements ?? [], ...ast.implements ?? []],
  };
  const self = ctx.project.modules.find(m => lc(m.name) === name);
  const modules: CheckModule[] = [{ name: ctx.moduleName, kind: isForm ? 'form' : self ? moduleKind(self) : 'module', ast: merged }];
  const others = [...ctx.project.forms.map(f => ({ name: f.name, kind: 'form' as const, code: f.code })),
    ...ctx.project.modules.map(m => ({ name: m.name, kind: moduleKind(m), code: m.code }))];
  for (const o of others) {
    if (lc(o.name) === name) continue;
    const r = parseModuleLenient(o.code, o.name);
    if (!r.ast || r.errors.length) return;
    modules.push({ name: o.name, kind: o.kind, ast: r.ast });
  }
  const none = new Set<string>();
  for (const p of compileProblems(modules, {
    only: (m, proc) => m.ast === merged && ast.procedures.includes(proc),
    onlyDecls: (m, d) => m.ast === merged && ast.variables.includes(d),
    unknownLocals: (_m, proc) => (proc.name === BARE_PROC ? bareExtra : none),
  })) report(p.hint);
}

/**
 * Problems in AI code: syntax errors, event procedures for controls/events that do not exist, unknown members of
 * controls and forms, unknown names before a dot, undeclared variables under Option Explicit, functions and
 * statements VibeBasic does not have, event procedures whose parameters do not match the event, calls to procedures
 * that exist nowhere or with the wrong number of arguments, and procedures the proposal defines twice.
 */
export function validateCode(code: string, ctx: ValidateContext): string[] {
  const problems: string[] = [];
  const report = (m: string) => { if (!problems.includes(m)) problems.push(m); };
  // A bare body (no Sub header) is checked inside a dummy Sub; line numbers stay the same.
  const bare = listProcedures(code).length === 0 && code.split(/\r?\n/).some(l => !DECL_OR_COMMENT.test(l));
  const source = bare ? `Sub ${BARE_PROC}()\n${code}\nEnd Sub` : code;
  const parsed = parseModuleLenient(source, ctx.moduleName);
  const sourceLines = source.split(/\r?\n/);
  const count = code.split(/\r?\n/).length;
  for (const e of parsed.errors) {
    const line = bare ? e.line - 1 : e.line;
    if (bare && (line < 1 || line > count)) continue;
    const un = PARSER_UNSUPPORTED.exec(e.message);
    if (un) report(`Line ${line}: ${unsupported(un[1])}`);
    else report(`Line ${line}: ${e.message}`);
  }

  const procs = listProcedures(code);
  const seen = new Set<string>();
  for (const p of procs) {
    const k = `${lc(p.name)} ${p.property ?? ''}`;   // a Property Get, Let and Set of one name belong together
    if (seen.has(k)) report(`${p.name} is defined more than once; keep one.`);
    seen.add(k);
  }

  if (ctx.form) {
    const controls = new Map<string, ControlType>();
    /** Whether a control is an array: known for the form's controls, unknown (undefined) for the ones the proposal adds. */
    const isArray = new Map<string, boolean>();
    for (const c of ctx.form.controls) { controls.set(lc(c.name), c.type); isArray.set(lc(c.name), c.index !== null); }
    for (const c of ctx.extraControls ?? []) controls.set(lc(c.name), c.type);
    const decls = new Map((bare ? [] : parsed.ast?.procedures ?? []).map(d => [lc(d.name), d] as const));
    // `Private WithEvents w As Worker`: w_Event handles the class's events, not a control's
    const eventVars = new Set([...parsed.ast?.variables ?? [], ...parseModuleLenient(ctx.form.code, ctx.moduleName).ast?.variables ?? []]
      .filter(v => v.withEvents).map(v => lc(v.name)));
    for (const p of procs) {
      if (p.kind !== 'sub' || p.property) continue;
      const us = p.name.lastIndexOf('_');
      if (us <= 0 || us === p.name.length - 1) continue;
      const obj = p.name.slice(0, us), ev = p.name.slice(us + 1);
      if (eventVars.has(lc(obj))) continue;
      if (!KNOWN_EVENTS.has(ev.toLowerCase())) continue;   // not event-shaped
      const type: ControlType | undefined = obj.toLowerCase() === 'form' ? 'Form' : controls.get(obj.toLowerCase());
      if (!type) report(`There is no control named ${obj}, so ${p.name} would never run.`);
      else if (!eventsOf(type).has(ev.toLowerCase())) report(`A ${type} has no ${ev} event.`);
      else {
        const decl = decls.get(lc(p.name));
        const headerOk = decl && !parsed.errors.some(e => e.line >= decl.line && e.line <= headerEnd(sourceLines, decl.line));
        const def = CONTROL_TYPES[type].events.find(e => lc(e.name) === lc(ev))!;
        const wrong = headerOk ? signatureProblem(p.name, decl.params, def.params, type === 'Form' ? false : isArray.get(lc(obj))) : null;
        if (wrong) report(wrong);
      }
    }
  }

  if (parsed.ast) checkNames(parsed.ast, parsed.errors.length === 0, ctx, report);
  return problems;
}
