// Checks the code the AI proposed: cheap automatic fixes plus a list of problems that is fed back to the model once.
// The checks only report; none of them changes the code. A false report costs a slow extra model round, so every
// rule stays silent when it is not sure (a name whose status is uncertain counts as known).
import type { Expr, MissingArg, ModuleAst, ProcDecl, Stmt } from '../lang/ast';
import { parseModuleLenient } from '../lang/parser';
import { CONTROL_TYPES } from '../model/controls';
import { listProcedures } from '../model/procedures';
import type { ControlType, FormDef, Project } from '../model/types';
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

const DECL_OR_COMMENT = /^\s*(?:$|'|Rem(?:\s|$)|(?:Dim|Const|Public|Private|Global|Static|Option|Type|Enum|Declare|End\s+(?:Type|Enum))\b)/i;
const BARE_PROC = 'AiBody__';

// ---------------------------------------------------------------------------------------------------------------
// Unsupported functions and statements

/** Alternatives offered with "X is not supported in VibeBasic." (keys lower case). */
const ALTERNATIVES: Record<string, string> = {
  print: 'Use a Label, a TextBox or Debug.Print instead.',
};
/** Functions that parse fine but do not exist in VibeBasic, with the name as written in VB6. */
const UNSUPPORTED_CALLS: Record<string, string> = {
  createobject: 'CreateObject', getobject: 'GetObject',
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
  };
  const stmts = (body: Stmt[]): void => {
    for (const s of body) {
      switch (s.kind) {
        case 'dim': for (const d of s.decls) declared.add(lc(d.name)); break;
        case 'const': for (const d of s.decls) declared.add(lc(d.name)); break;
        case 'redim': for (const d of s.decls) declared.add(lc(d.name)); break;
        case 'erase': for (const t of s.targets) implicit.add(lc(t.name)); break;
        case 'assign': if (s.target.kind === 'name') implicit.add(lc(s.target.name)); expr(s.target); expr(s.value); break;
        case 'call': argNames(s.args); s.args.forEach(expr); break;
        case 'for': implicit.add(lc(s.variable.name)); expr(s.from); expr(s.to); stmts(s.body); break;
        case 'forEach': implicit.add(lc(s.variable.name)); expr(s.collection); stmts(s.body); break;
        case 'if': for (const b of s.branches) { expr(b.cond); stmts(b.body); } if (s.elseBody) stmts(s.elseBody); break;
        case 'select': expr(s.subject); for (const c of s.cases) stmts(c.body); if (s.elseBody) stmts(s.elseBody); break;
        case 'do': if (s.test) expr(s.test.expr); stmts(s.body); break;
        case 'while': expr(s.cond); stmts(s.body); break;
        case 'with': expr(s.object); stmts(s.body); break;
      }
    }
  };
  stmts(p.body);
  return { declared, implicit };
}

interface Checker {
  report(msg: string): void;
  /** Rule 2/3 may run: the project is known and every module parsed. */
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
        if (e.target.kind === 'name') callName(e.target.name);
        else if (e.target.kind === 'member') member(e.target.object, e.target.name, false);
        else expr(e.target);
        e.args.forEach(expr);
        return;
      case 'unary': expr(e.operand); return;
      case 'binary': expr(e.left); expr(e.right); return;
    }
  }

  const stmts = (body: Stmt[]): void => {
    for (const s of body) {
      switch (s.kind) {
        case 'dim': for (const d of s.decls) for (const b of d.bounds ?? []) { if (b.lower) expr(b.lower); expr(b.upper); } break;
        case 'const': for (const d of s.decls) expr(d.value); break;
        case 'redim': for (const d of s.decls) for (const b of d.bounds) { if (b.lower) expr(b.lower); expr(b.upper); } break;
        case 'assign':
          if (s.target.kind === 'name') undefinedName(s.target.name);
          else if (s.target.kind === 'call') {
            if (s.target.target.kind === 'member') member(s.target.target.object, s.target.target.name, false);
            else if (s.target.target.kind !== 'name') expr(s.target.target);
            s.target.args.forEach(expr);
          } else expr(s.target);
          expr(s.value);
          break;
        case 'call':
          if (s.target.kind === 'name') callName(s.target.name);
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
        case 'debugPrint': for (const it of s.items) if (it.expr) expr(it.expr); break;
      }
    }
  };
  stmts(p.body);
}

/** Rules 1-4 on a parsed proposal. The module's current code counts too: its declarations are known names. */
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

  const bareExtra = new Set<string>();
  for (const p of existing.ast?.procedures ?? []) { const n = procNames(p); for (const k of [...n.declared, ...n.implicit]) bareExtra.add(k); }

  const c: Checker = {
    report,
    namesKnown: !!proj && proj.complete && syntaxOk && existing.errors.length === 0,
    optionExplicit: ast.optionExplicit || (existing.ast?.optionExplicit ?? false),
    module, globals: proj?.globals ?? new Set(), me, controls, forms, bareExtra,
  };
  for (const p of ast.procedures) checkProc(c, p);
}

/**
 * Problems in AI code: syntax errors, event procedures for controls/events that do not exist, unknown members of
 * controls and forms, unknown names before a dot, undeclared variables under Option Explicit, and functions and
 * statements VibeBasic does not have.
 */
export function validateCode(code: string, ctx: ValidateContext): string[] {
  const problems: string[] = [];
  const report = (m: string) => { if (!problems.includes(m)) problems.push(m); };
  // A bare body (no Sub header) is checked inside a dummy Sub; line numbers stay the same.
  const bare = listProcedures(code).length === 0 && code.split(/\r?\n/).some(l => !DECL_OR_COMMENT.test(l));
  const source = bare ? `Sub ${BARE_PROC}()\n${code}\nEnd Sub` : code;
  const parsed = parseModuleLenient(source, ctx.moduleName);
  const count = code.split(/\r?\n/).length;
  for (const e of parsed.errors) {
    const line = bare ? e.line - 1 : e.line;
    if (bare && (line < 1 || line > count)) continue;
    const un = PARSER_UNSUPPORTED.exec(e.message);
    if (un) report(`Line ${line}: ${unsupported(un[1])}`);
    else report(`Line ${line}: ${e.message}`);
  }

  if (ctx.form) {
    const controls = new Map<string, ControlType>();
    for (const c of ctx.form.controls) controls.set(c.name.toLowerCase(), c.type);
    for (const c of ctx.extraControls ?? []) controls.set(c.name.toLowerCase(), c.type);
    for (const p of listProcedures(code)) {
      if (p.kind !== 'sub') continue;
      const us = p.name.lastIndexOf('_');
      if (us <= 0 || us === p.name.length - 1) continue;
      const obj = p.name.slice(0, us), ev = p.name.slice(us + 1);
      if (!KNOWN_EVENTS.has(ev.toLowerCase())) continue;   // not event-shaped
      const type: ControlType | undefined = obj.toLowerCase() === 'form' ? 'Form' : controls.get(obj.toLowerCase());
      if (!type) report(`There is no control named ${obj}, so ${p.name} would never run.`);
      else if (!eventsOf(type).has(ev.toLowerCase())) report(`A ${type} has no ${ev} event.`);
    }
  }

  if (parsed.ast) checkNames(parsed.ast, parsed.errors.length === 0, ctx, report);
  return problems;
}
