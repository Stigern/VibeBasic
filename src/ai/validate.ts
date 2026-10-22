// Checks the code the AI proposed: cheap automatic fixes plus a list of problems that is fed back to the model once.
import { findSyntaxErrors } from '../lang/parser';
import { CONTROL_TYPES } from '../model/controls';
import { listProcedures } from '../model/procedures';
import type { ControlType, FormDef } from '../model/types';

export interface ValidateContext {
  moduleName: string;
  form: FormDef | null;
  extraControls?: { name: string; type: ControlType }[];
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

/** Problems in AI code: syntax errors, and event procedures for controls/events that do not exist. */
export function validateCode(code: string, ctx: ValidateContext): string[] {
  const problems: string[] = [];
  // A bare body (no Sub header) is checked inside a dummy Sub; line numbers stay the same.
  const bare = listProcedures(code).length === 0 && code.split(/\r?\n/).some(l => !DECL_OR_COMMENT.test(l));
  const errors = findSyntaxErrors(bare ? `Sub AiBody__()\n${code}\nEnd Sub` : code, ctx.moduleName);
  const count = code.split(/\r?\n/).length;
  for (const e of errors) {
    const line = bare ? e.line - 1 : e.line;
    if (bare && (line < 1 || line > count)) continue;
    problems.push(`Line ${line}: ${e.message}`);
  }
  if (!ctx.form) return problems;

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
    if (!type) problems.push(`There is no control named ${obj}, so ${p.name} would never run.`);
    else if (!eventsOf(type).has(ev.toLowerCase())) problems.push(`A ${type} has no ${ev} event.`);
  }
  return problems;
}
