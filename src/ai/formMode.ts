// Form mode: the model answers with JSON ops (add / set / delete / form) and optional event code.
// parseFormOps is tolerant (fences, thinking, trailing commas, comments, type aliases); nothing is applied on failure.
import { setCodeCmd, addControlsCmd, compositeCmd, deleteControlsCmd, setPropertyCmd, type Command } from '../model/commands';
import { addComponentsCmd } from '../model/components';
import { CONTROL_TYPES, getPropDef, newControl, nextDefaultName, validateName } from '../model/controls';
import type { ControlDef, ControlType, FormDef, Project, PropValue } from '../model/types';
import { parsePropertyInput } from '../ide/propertyEditors';
import { applyCodeProposal, extractCode, type CodeApplyResult } from './codeMode';
import { stripThinking } from './clean';

export { setCodeCmd };

export type FormOp =
  | { op: 'add'; type: Exclude<ControlType, 'Form'>; name: string; index: number | null; container: string | null; props: Record<string, PropValue>;
      /** SSTab container: the 0-based tab (default: its current tab). */ tab?: number }
  | { op: 'set'; name: string; index: number | null; props: Record<string, PropValue> }
  | { op: 'delete'; name: string; index: number | null }
  | { op: 'form'; props: Record<string, PropValue> };
export type ParsedFormOps =
  | { ok: true; ops: FormOp[]; code: string | null; warnings: string[]; codeChanges?: CodeApplyResult['changes']; codeText?: string }
  | { ok: false; error: string; raw: string; /** Why the reply was not usable JSON (sent back to the model). */ reason: string };
type Ok = Extract<ParsedFormOps, { ok: true }>;

export const NOT_UNDERSTOOD = 'The AI answer could not be understood. Try again or rephrase.';

const ALIASES: Record<string, Exclude<ControlType, 'Form'>> = {
  button: 'CommandButton', cmd: 'CommandButton', text: 'TextBox', edit: 'TextBox', lbl: 'Label', checkbox: 'CheckBox',
  radiobutton: 'OptionButton', radio: 'OptionButton', option: 'OptionButton', groupbox: 'Frame', list: 'ListBox',
  combo: 'ComboBox', dropdown: 'ComboBox', picture: 'PictureBox', progress: 'ProgressBar',
};
function resolveType(raw: string): Exclude<ControlType, 'Form'> | null {
  const low = raw.trim().toLowerCase();
  for (const t of Object.keys(CONTROL_TYPES) as ControlType[]) if (t !== 'Form' && t.toLowerCase() === low) return t;
  return ALIASES[low] ?? null;
}

/** Removes `//` comments and trailing commas outside strings; escapes raw newlines and tabs inside strings. */
function sanitizeJson(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1).replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
      out += c;
    } else out += c;
  }
  return out;
}

/** The JSON in a reply (fences, thinking and loose syntax tolerated), or why there is none. */
function parseJsonLoose(reply: string): { value: unknown } | { reason: string } {
  const text = stripThinking(reply);
  const o = text.indexOf('{'), q = text.indexOf('[');
  // a bare top-level array of ops is accepted too
  const [open, close] = q >= 0 && (o < 0 || q < o) ? ['[', ']'] : ['{', '}'];
  const a = text.indexOf(open), b = text.lastIndexOf(close);
  if (a < 0 || b <= a) return { reason: 'no JSON object found' };
  try { return { value: JSON.parse(sanitizeJson(text.slice(a, b + 1))) }; }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { reason: msg.length > 100 ? `${msg.slice(0, 97)}...` : msg };
  }
}

/** Op names small models use instead of add / set / delete / form. */
const OP_ALIASES: Record<string, string> = {
  remove: 'delete', update: 'set', modify: 'set', change: 'set', move: 'set', edit: 'set', create: 'add', insert: 'add',
};
const OP_KEYS = new Set(['op', 'type', 'name', 'container', 'index', 'props', 'tab']);
/** The op's props; without a `props` object, loose top-level keys (e.g. {"op":"set","name":"X","Caption":"y"}) count. */
function propsOf(raw: Record<string, unknown>): Record<string, unknown> {
  if (isObj(raw.props)) return raw.props;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !OP_KEYS.has(k.toLowerCase())));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nameKey = (n: string, i: number | null) => `${n.toLowerCase()}#${i ?? ''}`;
const label = (n: string, i: number | null) => (i === null ? n : `${n}(${i})`);

/** Splits "Command1(2)" into name and index. */
function splitName(raw: string): { name: string; index: number | null } {
  const m = /^\s*(.*?)\s*\(\s*(\d+)\s*\)\s*$/.exec(raw);
  return m ? { name: m[1], index: Number(m[2]) } : { name: raw.trim(), index: null };
}

function toValue(def: NonNullable<ReturnType<typeof getPropDef>>, v: unknown): PropValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (def.kind === 'list' && Array.isArray(v)) return v.every(x => typeof x === 'string') ? (v as string[]) : undefined;
  let text: string;
  if (typeof v === 'string') text = v;
  else if (typeof v === 'boolean') text = v ? 'True' : 'False';
  else if (typeof v === 'number') text = String(def.kind === 'int' ? Math.round(v) : v);
  else return undefined;
  const r = parsePropertyInput(def, text);
  return r.ok ? r.value : undefined;
}

function parseProps(type: ControlType, rawProps: unknown, owner: string, warnings: string[]): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  if (!isObj(rawProps)) return out;
  for (const [k, v] of Object.entries(rawProps)) {
    if (k.toLowerCase() === 'name' || k.toLowerCase() === 'index') continue;
    const def = getPropDef(type, k);
    if (!def || !def.designTime) { warnings.push(`Ignored unknown property ${k} on ${type}.`); continue; }
    const val = toValue(def, v);
    if (val === undefined) { warnings.push(`Ignored invalid value for ${def.name} on ${owner}.`); continue; }
    out[def.name] = val;
  }
  return out;
}

const GEO = ['Left', 'Top', 'Width', 'Height'];

/** `fixCode` may rewrite the AI's code text (before it is merged into the form's code). */
export function parseFormOps(reply: string, form: FormDef, fixCode?: (code: string) => string): ParsedFormOps {
  const loose = parseJsonLoose(reply);
  if ('reason' in loose) return { ok: false, error: NOT_UNDERSTOOD, raw: reply, reason: loose.reason };
  const parsedJson = loose.value;
  const json: Record<string, unknown> | undefined = Array.isArray(parsedJson) ? { ops: parsedJson } : isObj(parsedJson) ? parsedJson : undefined;
  if (!json) return { ok: false, error: NOT_UNDERSTOOD, raw: reply, reason: 'the JSON is not an object' };
  const fail: ParsedFormOps = { ok: false, error: NOT_UNDERSTOOD, raw: reply, reason: 'it has no usable "ops" and no "code"' };
  const rawOps = Array.isArray(json.ops) ? json.ops : [];
  const warnings: string[] = [];
  const ops: FormOp[] = [];
  // Working picture of the form's controls while the ops are read (names, types, containers).
  const work: FormDef = { ...form, controls: form.controls.map(c => ({ ...c, props: {} })) };
  const taken = (n: string, i: number | null): boolean => work.controls.some(c => c.name.toLowerCase() === n.toLowerCase() && (i === null || c.index === i));
  /** A new control may only join an existing name as a further member of a control array of the same type. */
  const clashes = (n: string, i: number | null, type: ControlType): boolean => {
    const same = work.controls.filter(c => c.name.toLowerCase() === n.toLowerCase());
    return same.length > 0 && (i === null || same.some(c => c.index === null || c.type !== type || c.index === i));
  };
  const find = (n: string, i: number | null) => work.controls.filter(c => c.name.toLowerCase() === n.toLowerCase() && (i === null || c.index === i));

  for (const raw of rawOps) {
    if (!isObj(raw) || typeof raw.op !== 'string') continue;
    const low = raw.op.trim().toLowerCase();
    const kind = OP_ALIASES[low] ?? low;
    if (kind === 'form') {
      const props = parseProps('Form', propsOf(raw), 'Form', warnings);
      if (Object.keys(props).length) ops.push({ op: 'form', props });
    } else if (kind === 'add') {
      const typeName = typeof raw.type === 'string' ? raw.type : '';
      const type = resolveType(typeName);
      if (!type) { warnings.push(`Ignored unknown control type ${typeName}.`); continue; }
      const rawProps = propsOf(raw);
      const given = typeof raw.name === 'string' && raw.name.trim() ? raw.name : typeof rawProps.Name === 'string' ? rawProps.Name : '';
      let { name, index } = splitName(given);
      if (index === null && typeof rawProps.Index === 'number' && rawProps.Index >= 0) index = Math.floor(rawProps.Index);
      if (index === null && typeof raw.index === 'number' && raw.index >= 0) index = Math.floor(raw.index);
      if (!name) name = nextDefaultName(work, type);
      else if (!validateName(name)) {
        const fixed = nextDefaultName(work, type);
        warnings.push(`Renamed ${name} to ${fixed} because the name was not valid.`);
        name = fixed; index = null;
      } else if (clashes(name, index, type)) {
        let n = 1;
        while (taken(`${name}${n}`, null)) n++;
        warnings.push(`Renamed ${name} to ${name}${n} because the name was taken.`);
        name = `${name}${n}`; index = null;
      }
      const props = parseProps(type, rawProps, label(name, index), warnings);
      // a real size under 200 x 60 twips (13 x 4 px) is useless, so small numbers must be pixels
      if (typeof props.Width === 'number' && typeof props.Height === 'number' && props.Width < 200 && props.Height < 60) {
        for (const k of GEO) if (typeof props[k] === 'number') props[k] = (props[k] as number) * 15;
        warnings.push(`Sizes for ${name} looked like pixels and were converted to twips.`);
      }
      let container: string | null = null;
      if (typeof raw.container === 'string' && raw.container.trim()) {
        const parent = find(splitName(raw.container).name, splitName(raw.container).index)[0];
        if (parent && CONTROL_TYPES[parent.type].isContainer) container = label(parent.name, parent.index);
        else warnings.push(`Ignored unknown container ${raw.container} for ${name}.`);
      }
      const parent = container ? find(splitName(container).name, splitName(container).index)[0] : undefined;
      work.controls.push({ id: `w${work.controls.length}`, type, name, index, parentId: parent?.id ?? null, props: {} });
      const tab = parent?.type === 'SSTab' && typeof raw.tab === 'number' && raw.tab >= 0 ? Math.floor(raw.tab) : undefined;
      ops.push({ op: 'add', type, name, index, container, props, ...(tab !== undefined ? { tab } : {}) });
    } else if (kind === 'set' || kind === 'delete') {
      const s = splitName(typeof raw.name === 'string' ? raw.name : '');
      if (s.index === null && typeof raw.index === 'number' && raw.index >= 0) s.index = Math.floor(raw.index);
      const targets = s.name ? find(s.name, s.index) : [];
      if (!targets.length) { warnings.push(`Ignored change to missing control ${label(s.name, s.index)}.`); continue; }
      if (kind === 'delete') {
        const gone = new Set<string>(targets.map(t => t.id));
        for (let grew = true; grew;) {
          grew = false;
          for (const c of work.controls) if (c.parentId && gone.has(c.parentId) && !gone.has(c.id)) { gone.add(c.id); grew = true; }
        }
        work.controls = work.controls.filter(c => !gone.has(c.id));
        ops.push({ op: 'delete', name: targets[0].name, index: s.index });
      } else {
        const props = parseProps(targets[0].type, propsOf(raw), label(targets[0].name, s.index), warnings);
        if (Object.keys(props).length) ops.push({ op: 'set', name: targets[0].name, index: s.index, props });
      }
    } else warnings.push(`Ignored unknown operation ${raw.op}.`);
  }

  let code: string | null = null;
  let codeChanges: CodeApplyResult['changes'] | undefined;
  let text: string | undefined;
  if (typeof json.code === 'string' && json.code.trim()) {
    const extracted = json.code.includes('```') ? extractCode(json.code) ?? json.code : json.code;
    text = fixCode ? fixCode(extracted) : extracted;
    const r = applyCodeProposal(form.code, text, null);
    if (r) { code = r.source; codeChanges = r.changes; } else warnings.push('Ignored code that could not be merged into the form.');
  }
  if (!ops.length && code === null) return warnings.length ? { ...fail, raw: `${reply}\n\nIgnored:\n${warnings.join('\n')}` } : fail;
  return { ok: true, ops, code, warnings, ...(codeChanges ? { codeChanges } : {}), ...(code !== null && text !== undefined ? { codeText: text } : {}) };
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
const fmt = (v: PropValue): string => (typeof v === 'string' ? quote(v) : Array.isArray(v) ? quote(v.join(', ')) : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v));

export function describeOps(p: Ok): string[] {
  const lines: string[] = [];
  for (const o of p.ops) {
    if (o.op === 'add') lines.push(`Add ${o.type} ${label(o.name, o.index)}`);
    else if (o.op === 'delete') lines.push(`Delete ${label(o.name, o.index)}`);
    else for (const [k, v] of Object.entries(o.props)) lines.push(`Set ${o.op === 'form' ? 'Form' : label(o.name, o.index)}.${k} = ${fmt(v)}`);
  }
  if (p.code !== null) {
    if (p.codeChanges?.length) for (const c of p.codeChanges) lines.push(`${c.kind === 'added' || c.kind === 'declarations' ? 'Add' : 'Replace'} code: ${c.name}`);
    else lines.push('Change code');
  }
  return lines;
}

/** The commands for the ops, built against `form` (not modified). Controls are addressed by id from a working copy. */
function buildCommands(form: FormDef, p: Ok): Command[] {
  const work: FormDef = structuredClone(form);
  const find = (n: string, i: number | null) => work.controls.filter(c => c.name.toLowerCase() === n.toLowerCase() && (i === null || c.index === i));
  const cmds: Command[] = [];
  for (const o of p.ops) {
    if (o.op === 'form') {
      for (const [k, v] of Object.entries(o.props)) cmds.push(setPropertyCmd(form.id, 'form', k, v));
    } else if (o.op === 'set') {
      for (const c of find(o.name, o.index)) for (const [k, v] of Object.entries(o.props)) cmds.push(setPropertyCmd(form.id, c.id, k, v));
    } else if (o.op === 'delete') {
      const ids = find(o.name, o.index).map(c => c.id);
      if (!ids.length) continue;
      cmds.push(deleteControlsCmd(form.id, ids));
      const gone = new Set(ids);
      for (let grew = true; grew;) {
        grew = false;
        for (const c of work.controls) if (c.parentId && gone.has(c.parentId) && !gone.has(c.id)) { gone.add(c.id); grew = true; }
      }
      work.controls = work.controls.filter(c => !gone.has(c.id));
    } else {
      const parent = o.container ? find(splitContainer(o.container).name, splitContainer(o.container).index)[0] : undefined;
      const def: ControlDef = newControl(work, o.type, { left: 240, top: 240 }, parent?.id ?? null);
      if (parent?.type === 'SSTab') def.tab = o.tab ?? (Number(parent.props.Tab) || 0);
      const generated = def.name;
      def.name = o.name; def.index = o.index;
      // newControl names the caption/text after the generated default name; follow the real name instead
      if (def.props.Caption === generated) def.props.Caption = o.name;
      if (def.props.Text === generated) def.props.Text = o.name;
      Object.assign(def.props, structuredClone(o.props));
      work.controls.push(def);
      cmds.push(addControlsCmd(form.id, [def]));
    }
  }
  if (p.code !== null) cmds.push(setCodeCmd(form.id, p.code));
  return cmds;
}
const splitContainer = splitName;

export function formOpsToCommand(proj: Project, formId: string, parsed: Ok, title: string): Command {
  const form = proj.forms.find(f => f.id === formId);
  if (!form) throw new Error(`Form not found: ${formId}`);
  // a control whose component is not checked yet checks it, in the same undo step
  const comps = addComponentsCmd(proj, parsed.ops.flatMap(o => (o.op === 'add' ? [o.type] : [])));
  return compositeCmd(title, [...(comps ? [comps] : []), ...buildCommands(form, parsed)]);
}

/** A modified copy of the form for the preview. */
export function applyFormOpsToClone(form: FormDef, parsed: Ok): FormDef {
  const clone = structuredClone(form);
  const cmd = compositeCmd('preview', buildCommands(clone, parsed));
  cmd.do({ name: '', title: '', startupForm: '', forms: [clone], modules: [], assets: {}, iconAsset: null, components: [] });
  return clone;
}
