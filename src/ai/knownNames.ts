// Which names exist, for checking AI code: the language's own built-ins and constants, the project's forms,
// modules and Public names, and the members of controls and forms. Mirrors what the interpreter and the run
// session resolve (src/lang/interp/eval.ts `lookup`, src/run/session.ts `resolveName`, the run-time objects'
// `hasMember`), so the checker and F5 agree. Where the answer is uncertain the name counts as known.
import { BUILTINS, CONSTANTS } from '../lang/builtins';
import type { ModuleAst, ProcDecl } from '../lang/ast';
import { parseModuleLenient } from '../lang/parser';
import { CONTROL_TYPES, getPropDef } from '../model/controls';
import type { ControlType, FormDef, Project } from '../model/types';

/** Objects the code may use without declaring them (lower case). */
export const BUILTIN_OBJECTS = new Set(['app', 'screen', 'err', 'debug', 'clipboard', 'forms', 'me', 'printer', 'printers']);

/** Names the language itself knows: built-in functions and constants, and Me/Empty/Null/Nothing/True/False. */
export function isLanguageName(key: string): boolean {
  return BUILTINS.has(key) || CONSTANTS.has(key) || ['me', 'empty', 'null', 'nothing', 'true', 'false'].includes(key);
}

/** Every module-level name of a module: variables, constants, procedures, enums (and members) and types. */
export function moduleNames(ast: ModuleAst, onlyPublic = false): Set<string> {
  const out = new Set<string>();
  const add = (n: string) => out.add(n.toLowerCase());
  for (const v of ast.variables) if (!onlyPublic || v.scope === 'public') add(v.name);
  for (const c of ast.consts) if (!onlyPublic || c.scope === 'public') add(c.name);
  for (const p of ast.procedures) if (!onlyPublic || p.visibility === 'public') add(p.name);
  for (const e of ast.enums) {
    if (onlyPublic && e.visibility !== 'public') continue;
    add(e.name);
    for (const m of e.members) add(m.name);
  }
  for (const t of ast.types) if (!onlyPublic || t.visibility === 'public') add(t.name);
  return out;
}

/** Lenient parse; null when the code has syntax errors (its names are then uncertain). */
export function parseClean(code: string, name: string): ModuleAst | null {
  const r = parseModuleLenient(code, name);
  return r.errors.length ? null : r.ast;
}

/** Members the run-time form object answers besides its registry entries (formInstance.ts FORM_METHODS and FORM_OBJECTS, Load/Unload). */
const FORM_EXTRA = ['show', 'hide', 'refresh', 'move', 'setfocus', 'zorder', 'load', 'unload', 'scalewidth', 'scaleheight', 'name',
  'controls', 'activecontrol', 'count'];

/** Members of a form: its controls, registry properties and methods, and the names declared in its code. */
export function formMembers(form: FormDef, codeNames: Iterable<string>, extraControls: { name: string }[] = []): Set<string> {
  const out = new Set<string>([...FORM_EXTRA, ...codeNames]);
  for (const c of [...form.controls, ...extraControls]) out.add(c.name.toLowerCase());
  for (const p of CONTROL_TYPES.Form.props) if (p.runtime !== 'none') out.add(p.name.toLowerCase());
  for (const m of CONTROL_TYPES.Form.methods) out.add(m.name.toLowerCase());
  return out;
}

/** Whether a control (an element when `element` is set) has the member, as the run-time control object answers it. */
export function controlHasMember(type: ControlType, name: string, element: boolean): boolean {
  const l = name.toLowerCase();
  if (l === 'name') return true;
  if (l === 'index') return element;
  const pd = getPropDef(type, name);
  if (pd) return pd.runtime !== 'none';
  return CONTROL_TYPES[type].methods.some(m => m.name.toLowerCase() === l);
}

/** Property and method names of a type that exist at run time (for "Did you mean"). */
export function memberNamesOf(type: ControlType): string[] {
  return [...CONTROL_TYPES[type].props.filter(p => p.runtime !== 'none').map(p => p.name), ...CONTROL_TYPES[type].methods.map(m => m.name)];
}

/** What the project contributes: names visible from every module, and the members of each form. */
export interface ProjectNames {
  /** Public names of standard modules, module, class module and form names (lower case). */
  globals: Set<string>;
  /** False when another module has syntax errors: its names are then unknown. */
  complete: boolean;
  /** Members of the project's forms by lower-case form name; null when that form's code has syntax errors. */
  forms: Map<string, Set<string> | null>;
  /** Public procedures of the other standard modules by lower-case name; null when two modules define the name. */
  procs: Map<string, ProcDecl | null>;
}

/** `current` (lower case) is the module being checked: its own code is supplied separately, so it is skipped here. */
export function projectNames(project: Project, current: string): ProjectNames {
  const globals = new Set<string>();
  const procs = new Map<string, ProcDecl | null>();
  let complete = true;
  for (const m of project.modules) {
    globals.add(m.name.toLowerCase());
    // a class module's Public members belong to its objects (`x.Member`), not to every module
    if (m.name.toLowerCase() === current || m.kind === 'class') continue;
    const ast = parseClean(m.code, m.name);
    if (!ast) { complete = false; continue; }
    for (const n of moduleNames(ast, true)) globals.add(n);
    for (const p of ast.procedures) {
      if (p.visibility !== 'public' || p.property) continue;
      const k = p.name.toLowerCase();
      procs.set(k, procs.has(k) ? null : p);
    }
  }
  const forms = new Map<string, Set<string> | null>();
  for (const f of project.forms) {
    globals.add(f.name.toLowerCase());
    if (f.name.toLowerCase() === current) continue;
    const ast = parseClean(f.code, f.name);
    forms.set(f.name.toLowerCase(), ast ? formMembers(f, moduleNames(ast)) : null);
  }
  return { globals, complete, forms, procs };
}
