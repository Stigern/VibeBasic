// Builds the text the AI sees: control type reference, form descriptions and chat messages.
import { CONTROL_TYPES, type PropDef } from '../model/controls';
import { listProcedures } from '../model/procedures';
import type { ControlDef, ControlType, FormDef, FontValue, ModuleDef, Project, PropValue } from '../model/types';
import type { ChatMessage } from './types';
import { CODE_SYSTEM_PROMPT, FORM_SYSTEM_PROMPT } from './prompts';

const COMMON = new Set(['left', 'top', 'width', 'height', 'visible', 'enabled', 'tabindex', 'tabstop', 'tag', 'tooltiptext']);
const BASE_METHODS = new Set(['move', 'setfocus', 'refresh', 'zorder']);

/** One line per control type, e.g. "CommandButton: Caption, Default, … | events: Click, … | methods: …". */
export function describeControlTypes(): string {
  const lines: string[] = [];
  for (const td of Object.values(CONTROL_TYPES)) {
    const props = td.props.filter(p => !COMMON.has(p.name.toLowerCase()) && (p.designTime || p.runtime !== 'none')).map(p => p.name);
    const methods = td.methods.filter(m => !BASE_METHODS.has(m.name.toLowerCase())).map(m => m.name);
    let line = `${td.type}: ${props.join(', ')} | events: ${td.events.map(e => e.name).join(', ')}`;
    if (methods.length) line += ` | methods: ${methods.join(', ')}`;
    lines.push(line);
  }
  lines.push('All controls also have: Left, Top, Width, Height, Visible, Enabled, TabIndex, Tag and the methods Move, SetFocus, Refresh, ZOrder.'
    + ' Exceptions: Shape has no Enabled, TabIndex or SetFocus; Line has X1, Y1, X2, Y2 (twips) instead of Left, Top, Width, Height, and no Enabled, TabIndex, Move or SetFocus.'
    + ' A StatusBar always sits at the bottom of the form, full width (only its Height matters). Its Panels and a TabStrip\'s Tabs are one item per line,'
    + ' fields separated by | : Panels "Text|Key|Width|Alignment(0 left, 1 center, 2 right)", Tabs "Caption|Key".'
    + ' A ListView\'s ColumnHeaders are lines "Text|Key|Width|Alignment(0 left, 1 right, 2 center)"; Nodes, ListItems and the cells of an MSFlexGrid (TextMatrix) are filled by code at run time.');
  return lines.join('\n');
}

const same = (a: PropValue, b: PropValue): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;

function fmtFont(f: FontValue): string {
  return quote(`${f.name} ${f.size}pt${f.bold ? ' Bold' : ''}${f.italic ? ' Italic' : ''}${f.underline ? ' Underline' : ''}`);
}

function fmtValue(v: PropValue): string {
  if (v === null) return 'None';
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return quote(v.join('|'));
  if ('asset' in v) return '(picture)';
  return fmtFont(v);
}

const nameOf = (c: ControlDef): string => c.index === null ? c.name : `${c.name}(${c.index})`;

function propParts(type: ControlType, props: Record<string, PropValue>, skip: Set<string>): string[] {
  const defs = new Map<string, PropDef>(CONTROL_TYPES[type].props.map(p => [p.name, p]));
  const out: string[] = [];
  for (const pd of CONTROL_TYPES[type].props) {
    if (skip.has(pd.name.toLowerCase()) || !(pd.name in props)) continue;
    const v = props[pd.name];
    // An empty Text is still worth showing: it tells the model the box is blank on purpose.
    if (same(v, pd.default) && pd.name !== 'Text') continue;
    out.push(`${pd.name}=${fmtValue(v)}`);
  }
  for (const [k, v] of Object.entries(props)) if (!defs.has(k) && !skip.has(k.toLowerCase())) out.push(`${k}=${fmtValue(v)}`);
  return out;
}

/** One line for the form, one per control in z-order. Only geometry and non-default properties are listed. */
export function describeForm(form: FormDef): string {
  const lines: string[] = [];
  const formParts = propParts('Form', form.props, new Set(['left', 'top', 'width', 'height', 'tabindex']));
  for (const k of ['Width', 'Height']) if (k in form.props) formParts.push(`${k}=${fmtValue(form.props[k])}`);
  lines.push(['Form', form.name, ...formParts].join(' '));
  const byId = new Map(form.controls.map(c => [c.id, c]));
  for (const c of form.controls) {
    const geo = ['Left', 'Top', 'Width', 'Height', 'X1', 'Y1', 'X2', 'Y2'].filter(k => k in c.props).map(k => `${k}=${fmtValue(c.props[k])}`);
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    const head = [c.type, nameOf(c)];
    if (parent) head.push('in', nameOf(parent));
    lines.push([...head, ...geo, ...propParts(c.type, c.props, new Set(['left', 'top', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'tabindex']))].join(' '));
  }
  return lines.join('\n');
}

/** "Form1: Command1 (CommandButton), Text1 (TextBox)" per form; control arrays are listed once. */
export function describeProjectForms(p: Project): string {
  return p.forms.map(f => {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const c of f.controls) {
      const k = c.name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(`${c.name} (${c.type})`);
    }
    return `${f.name}: ${items.length ? items.join(', ') : '(no controls)'}`;
  }).join('\n');
}

function findItem(p: Project, id: string): { form?: FormDef; module?: ModuleDef } {
  const form = p.forms.find(f => f.id === id);
  if (form) return { form };
  return { module: p.modules.find(m => m.id === id) };
}

export function buildCodeRequest(p: Project, itemId: string, cursorLine: number, userPrompt: string): ChatMessage[] {
  const { form, module } = findItem(p, itemId);
  const code = (form ?? module)?.code ?? '';
  const proc = listProcedures(code).find(pr => cursorLine >= pr.line && cursorLine <= pr.endLine);
  const context = form ? `Form description:\n${describeForm(form)}` : `Forms in the project:\n${describeProjectForms(p)}`;
  const user = `${context}\n\nCode of ${form ? `form ${form.name}` : `module ${module?.name ?? ''}`}:\n${code}\n\nCurrent procedure: ${proc?.name ?? '(none)'}\n\nRequest: ${userPrompt}`;
  return [{ role: 'system', content: `${CODE_SYSTEM_PROMPT}${describeControlTypes()}` }, { role: 'user', content: user }];
}

export function buildFormRequest(p: Project, formId: string, userPrompt: string): ChatMessage[] {
  const form = p.forms.find(f => f.id === formId);
  if (!form) throw new Error(`Unknown form ${formId}`);
  const user = `Form description:\n${describeForm(form)}\n\nForm code:\n${form.code}\n\nRequest: ${userPrompt}`;
  return [{ role: 'system', content: `${FORM_SYSTEM_PROMPT}${describeControlTypes()}` }, { role: 'user', content: user }];
}

export { stripThinking } from './clean';
export { CODE_SYSTEM_PROMPT, FORM_SYSTEM_PROMPT } from './prompts';
