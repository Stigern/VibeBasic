// Form mode: the model answers with JSON ops (add / set / delete / form, and the placement ops arrange / autosize) and optional event code.
// parseFormOps is tolerant (fences, thinking, trailing commas, comments, type aliases); nothing is applied on failure.
// Relative placement ("place" on add and set, "arrange", "autosize") is resolved to absolute Left/Top/Width/Height while parsing, in op order.
import { setCodeCmd, addControlsCmd, compositeCmd, deleteControlsCmd, setPropertyCmd, type Command } from '../model/commands';
import { addComponentsCmd } from '../model/components';
import { CONTROL_TYPES, getPropDef, newControl, nextDefaultName, validateName } from '../model/controls';
import type { ControlDef, ControlType, FormDef, Project, PropValue } from '../model/types';
import { absoluteRect, sizeOf } from '../ide/designerLogic';
import { isDocked, isLine } from '../model/geometry';
import { SHORTCUT_LABELS, isMenu, shortcutValue } from '../model/menus';
import { formHasProp, formObjectName, mdiAllows } from '../model/mdi';
import { parsePropertyInput } from '../ide/propertyEditors';
import { applyCodeProposal, extractCode, type CodeApplyResult } from './codeMode';
import { stripThinking } from './clean';
import { CAPTION_PAD, captionText, textWidthPx } from './layoutCheck';

export { setCodeCmd };

export type FormOp =
  | { op: 'add'; type: Exclude<ControlType, 'Form'>; name: string; index: number | null; container: string | null; props: Record<string, PropValue>;
      /** SSTab container: the 0-based tab (default: its current tab). */ tab?: number }
  | { op: 'set'; name: string; index: number | null; props: Record<string, PropValue> }
  | { op: 'delete'; name: string; index: number | null }
  | { op: 'form'; props: Record<string, PropValue> };
export type ParsedFormOps =
  | { ok: true; ops: FormOp[]; code: string | null; warnings: string[]; codeChanges?: CodeApplyResult['changes']; codeText?: string; codeSkipped?: string[];
      /** Added controls renamed because their name was taken: `from` (what the answer asked for, still the existing control) to `to`. */
      renamed?: { from: string; to: string }[] }
  | { ok: false; error: string; raw: string; /** Why the reply was not usable JSON (sent back to the model). */ reason: string };
type Ok = Extract<ParsedFormOps, { ok: true }>;

/** A property value as parseProps reads it: text, a number, True/False, or a List's items. */
const PROP_VALUE = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }] };
const PROPS = { type: 'object', additionalProperties: PROP_VALUE };
const opSchema = (op: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', properties: { op: { type: 'string', enum: [op] }, ...properties }, required: ['op', ...required], additionalProperties: false });
const NAME = { type: 'string' }, INDEX = { type: 'integer', minimum: 0 }, INT = { type: 'integer' }, NAMES = { type: 'array', items: NAME }, BOOL = { type: 'boolean' };
/** "place": next to another control, `gap` twips away (default 120). */
const PLACE = {
  type: 'object',
  properties: { below: NAME, above: NAME, rightOf: NAME, leftOf: NAME, gap: INT, align: { type: 'string', enum: ['left', 'top', 'center'] } },
  additionalProperties: false,
};

/** The most ops one answer may have (the schema's maxItems). */
export const MAX_OPS = 300;

/**
 * The JSON schema of a form-mode answer, `{ops:[...], code?}`, sent as `response_format` (json_schema "form_ops").
 * It matches what parseFormOps reads; the parser stays tolerant for servers that ignore it. Extend the op list here.
 */
export const FORM_OPS_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      // a loop inside the grammar (the same op over and over) cannot go on forever
      maxItems: MAX_OPS,
      items: {
        anyOf: [
          opSchema('add', { type: { type: 'string' }, name: NAME, index: INDEX, container: { anyOf: [{ type: 'string' }, { type: 'null' }] }, tab: INDEX, props: PROPS, place: PLACE }, ['type', 'name']),
          opSchema('set', { name: NAME, index: INDEX, props: PROPS, place: PLACE }, ['name']),
          opSchema('delete', { name: NAME, index: INDEX }, ['name']),
          opSchema('form', { props: PROPS }, ['props']),
          opSchema('arrange', { names: NAMES, as: { type: 'string', enum: ['row', 'column', 'grid'] }, columns: { type: 'integer', minimum: 1 }, gap: INT, left: INT, top: INT }, ['names', 'as']),
          opSchema('autosize', { names: NAMES }, ['names']),
          opSchema('menu', { name: NAME, caption: { type: 'string' }, parent: { anyOf: [{ type: 'string' }, { type: 'null' }] }, index: INDEX,
            shortcut: { type: 'string' }, checked: BOOL, enabled: BOOL, visible: BOOL, windowList: BOOL }, ['name']),
        ],
      },
    },
    code: { type: 'string' },
  },
  required: ['ops'],
  additionalProperties: false,
} as const;

/** `response_format` for a form-mode request (OpenAI-style servers). */
export const FORM_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'form_ops', schema: FORM_OPS_SCHEMA } } as const;
/**
 * vLLM's `structured_outputs` for a form-mode request. With `response_format` json_schema, vLLM (xgrammar) emits `{"ops"` and then
 * whitespace until max_tokens on this anyOf schema; `disable_any_whitespace` avoids that (measured on vLLM 0.28).
 */
export const FORM_STRUCTURED_OUTPUTS = { json: FORM_OPS_SCHEMA, disable_any_whitespace: true } as const;

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
const OP_KEYS = new Set(['op', 'type', 'name', 'container', 'index', 'props', 'tab', 'place']);
/** The keys of a "menu" op and the Menu properties they set. */
const MENU_KEYS: Record<string, string> = { caption: 'Caption', checked: 'Checked', enabled: 'Enabled', visible: 'Visible', windowlist: 'WindowList' };
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
  const work: FormDef = { ...form, controls: form.controls.map(c => ({ ...c, props: { ...c.props } })) };
  /** The props of the add op of a control added in this reply (by working id): later placement goes into them. */
  const addedProps = new Map<string, Record<string, PropValue>>();
  /** New geometry for `c`: into its add op when it was added in this reply, else a further set op. */
  const setGeometry = (c: ControlDef, geo: Record<string, number>) => {
    Object.assign(c.props, geo);
    const own = addedProps.get(c.id);
    if (own) Object.assign(own, geo);
    else ops.push({ op: 'set', name: c.name, index: c.index, props: { ...geo } });
  };
  const byName = (raw: unknown): ControlDef | undefined => {
    if (typeof raw !== 'string') return undefined;
    const s = splitName(raw);
    return find(s.name, s.index)[0];
  };
  const taken = (n: string, i: number | null): boolean => work.controls.some(c => c.name.toLowerCase() === n.toLowerCase() && (i === null || c.index === i));
  /** A new control may only join an existing name as a further member of a control array of the same type. */
  const clashes = (n: string, i: number | null, type: ControlType): boolean => {
    const same = work.controls.filter(c => c.name.toLowerCase() === n.toLowerCase());
    return same.length > 0 && (i === null || same.some(c => c.index === null || c.type !== type || c.index === i));
  };
  /** Names an add of this reply asked for but got renamed (taken): later ops that use them mean the new control. */
  const alias = new Map<string, string>();
  const renamed: { from: string; to: string }[] = [];
  const aliasUsed = new Set<string>();
  const find = (n: string, i: number | null) => {
    const to = alias.get(nameKey(n, i));
    if (to === undefined) return work.controls.filter(c => c.name.toLowerCase() === n.toLowerCase() && (i === null || c.index === i));
    if (!aliasUsed.has(to)) { aliasUsed.add(to); warnings.push(`Later changes in this answer to ${label(n, i)} went to the new ${to}, not the existing ${label(n, i)}.`); }
    return work.controls.filter(c => c.name.toLowerCase() === to.toLowerCase());
  };

  // an answer that repeated itself: exact duplicates of an op are dropped, the first one counts
  const seen = new Set<string>();
  let repeated = 0;
  for (const raw of rawOps) {
    if (!isObj(raw) || typeof raw.op !== 'string') continue;
    const key = JSON.stringify(raw);
    if (seen.has(key)) { repeated++; continue; }
    seen.add(key);
    const low = raw.op.trim().toLowerCase();
    const kind = OP_ALIASES[low] ?? low;
    if (kind === 'form') {
      const props = parseProps('Form', propsOf(raw), 'Form', warnings);
      for (const k of Object.keys(props)) {
        if (!formHasProp(form, k)) { delete props[k]; warnings.push(`Ignored ${k}: ${form.mdi ? 'an MDI form' : 'a form that is not the MDI form'} has no ${k}.`); }
      }
      if (Object.keys(props).length) ops.push({ op: 'form', props });
    } else if (kind === 'menu') {
      // {"op":"menu","name":"mnuOpen","caption":"&Open...","parent":"mnuFile","shortcut":"Ctrl+O"}: an add of a Menu, after the others
      const rawProps: Record<string, unknown> = isObj(raw.props) ? { ...raw.props } : {};
      for (const [k, v] of Object.entries(raw)) { const pn = MENU_KEYS[k.toLowerCase()]; if (pn && v !== undefined && v !== null) rawProps[pn] = v; }
      if (typeof raw.shortcut === 'string' && raw.shortcut.trim()) {
        const sc = shortcutValue(raw.shortcut);
        if (sc === null) warnings.push(`Ignored unknown shortcut ${raw.shortcut} for ${String(raw.name)}.`); else rawProps.Shortcut = SHORTCUT_LABELS[sc];
      }
      let parent: ControlDef | undefined;
      if (typeof raw.parent === 'string' && raw.parent.trim()) {
        const want = splitName(raw.parent);
        const plain = (c: ControlDef) => String(c.props.Caption ?? '').replace(/&(?!&)/g, '').toLowerCase();
        parent = find(want.name, want.index).find(isMenu) ?? work.controls.find(c => isMenu(c) && plain(c) === want.name.replace(/&(?!&)/g, '').toLowerCase());
        if (!parent) { warnings.push(`Ignored menu ${String(raw.name)}: there is no menu ${raw.parent}.`); continue; }
      }
      if (typeof raw.name !== 'string' || !raw.name.trim()) { warnings.push('Ignored a menu without a name.'); continue; }
      let { name, index } = splitName(raw.name);
      if (index === null && typeof raw.index === 'number' && raw.index >= 0) index = Math.floor(raw.index);
      if (!validateName(name) || clashes(name, index, 'Menu')) { warnings.push(`Ignored menu ${label(name, index)}: the name is not valid or taken.`); continue; }
      const props = parseProps('Menu', rawProps, label(name, index), warnings);
      if (props.Caption === undefined) props.Caption = name;
      const added = newControl(work, 'Menu', { left: 0, top: 0 }, parent?.id ?? null);
      Object.assign(added, { name, index });
      Object.assign(added.props, props);
      work.controls.push(added);
      ops.push({ op: 'add', type: 'Menu', name, index, container: parent ? label(parent.name, parent.index) : null, props });
    } else if (kind === 'add') {
      const typeName = typeof raw.type === 'string' ? raw.type : '';
      const type = resolveType(typeName);
      if (!type) { warnings.push(`Ignored unknown control type ${typeName}.`); continue; }
      const rawProps = propsOf(raw);
      const given = typeof raw.name === 'string' && raw.name.trim() ? raw.name : typeof rawProps.Name === 'string' ? rawProps.Name : '';
      let { name, index } = splitName(given);
      let renamedFrom: { key: string; from: string; to: string } | null = null;
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
        renamedFrom = { key: nameKey(name, index), from: label(name, index), to: `${name}${n}` };
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
        // a Menu goes in a menu, any other control in a container
        if (parent && (type === 'Menu' ? isMenu(parent) : CONTROL_TYPES[parent.type].isContainer)) container = label(parent.name, parent.index);
        else warnings.push(`Ignored unknown container ${raw.container} for ${name}.`);
      }
      const parent = container ? find(splitName(container).name, splitName(container).index)[0] : undefined;
      if (form.mdi && !parent && !mdiAllows(type)) {
        warnings.push(`Ignored ${type} ${name}: an MDI form holds only aligned controls (PictureBox, Toolbar, StatusBar, CoolBar) and invisible ones; put it on a child form (MDIChild = True) or in a PictureBox.`);
        continue;
      }
      if (form.mdi && !parent && type === 'PictureBox' && !props.Align) props.Align = 1;   // VB6: a PictureBox on an MDI form aligns
      const tab = parent?.type === 'SSTab' && typeof raw.tab === 'number' && raw.tab >= 0 ? Math.floor(raw.tab) : undefined;
      // the working control starts where buildCommands puts it (240, 240, default size), so placement relative to it is right
      const added = newControl(work, type, { left: 240, top: 240 }, parent?.id ?? null);
      const generated = added.name;
      added.name = name; added.index = index;
      if (added.props.Caption === generated) added.props.Caption = name;
      if (added.props.Text === generated) added.props.Text = name;
      if (tab !== undefined) added.tab = tab;
      Object.assign(added.props, props);
      work.controls.push(added);
      addedProps.set(added.id, props);
      if (raw.place !== undefined) Object.assign(props, resolvePlace(work, added, raw.place, byName, warnings, props));
      Object.assign(added.props, props);
      ops.push({ op: 'add', type, name, index, container, props, ...(tab !== undefined ? { tab } : {}) });
      if (renamedFrom) { alias.set(renamedFrom.key, renamedFrom.to); renamed.push({ from: renamedFrom.from, to: renamedFrom.to }); }
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
        for (const t of targets) Object.assign(t.props, props);
        if (raw.place !== undefined && targets.length > 1) {
          // a whole control array: its members in a column (in their current order) placed as one block
          if (Object.keys(props).length) ops.push({ op: 'set', name: targets[0].name, index: s.index, props });
          for (const [c, geo] of placeGroup(work, targets, raw.place, byName, warnings, props)) setGeometry(c, geo);
          continue;
        }
        if (raw.place !== undefined) {
          const geo = resolvePlace(work, targets[0], raw.place, byName, warnings, props);
          Object.assign(props, geo);
          for (const t of targets) Object.assign(t.props, geo);
        }
        if (Object.keys(props).length) ops.push({ op: 'set', name: targets[0].name, index: s.index, props });
      }
    } else if (kind === 'arrange' || kind === 'autosize') {
      const names = Array.isArray(raw.names) ? raw.names : [];
      const ctrls: ControlDef[] = [];
      for (const n of names) {
        const c = byName(n);
        if (c && !ctrls.includes(c)) ctrls.push(c);
        else if (!c) warnings.push(`Ignored ${kind} of missing control ${String(n)}.`);
      }
      if (kind === 'autosize') for (const c of ctrls) { const geo = autosize(c, warnings); if (geo) setGeometry(c, geo); }
      else for (const [c, geo] of arrange(ctrls, raw, warnings)) setGeometry(c, geo);
    } else warnings.push(`Ignored unknown operation ${raw.op}.`);
  }

  if (repeated) warnings.push(`Ignored ${repeated} repeated ${repeated === 1 ? 'operation' : 'operations'} (exact copies of an earlier one).`);

  let code: string | null = null;
  let codeChanges: CodeApplyResult['changes'] | undefined;
  let codeSkipped: string[] | undefined;
  let text: string | undefined;
  if (typeof json.code === 'string' && json.code.trim()) {
    const extracted = json.code.includes('```') ? extractCode(json.code) ?? json.code : json.code;
    text = fixCode ? fixCode(extracted) : extracted;
    const refusal: { refused?: string } = {};
    const r = applyCodeProposal(form.code, text, null, null, refusal);
    if (r?.skipped) { codeSkipped = r.skipped; warnings.push(`Kept ${r.skipped.join(', ')} as they are: the answer had them without their code.`); }
    if (r && r.changes.length) { code = r.source; codeChanges = r.changes; }
    else if (!r) warnings.push(refusal.refused ? `Ignored the code: ${refusal.refused.replace(/\n/g, ' ')}` : 'Ignored code that could not be merged into the form.');
  }
  if (!ops.length && code === null) return warnings.length ? { ...fail, raw: `${reply}\n\nIgnored:\n${warnings.join('\n')}` } : fail;
  return { ok: true, ops, code, warnings, ...(codeChanges ? { codeChanges } : {}), ...(code !== null && text !== undefined ? { codeText: text } : {}), ...(codeSkipped ? { codeSkipped } : {}),
    ...(renamed.length ? { renamed } : {}) };
}

const DEFAULT_GAP = 120;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
const rectOf = (c: ControlDef) => ({ left: Number(c.props.Left) || 0, top: Number(c.props.Top) || 0, ...sizeOf(c) });
const PLACE_KEYS: Record<string, 'below' | 'above' | 'rightOf' | 'leftOf'> = { below: 'below', under: 'below', above: 'above', rightof: 'rightOf', right: 'rightOf', leftof: 'leftOf', left: 'leftOf' };

/**
 * Left and Top for `place` ({"below"|"above"|"rightOf"|"leftOf": name, gap?, align?}): next to the named control, `gap` twips away
 * (default 120). Below/above line up the left edges (align "center": the centres); rightOf/leftOf line up the tops (align "center":
 * the middles). A Left (below/above) or Top (rightOf/leftOf) given in the same op's `given` props is kept unless "align" is set.
 * Works across containers (the position is converted to the target's container).
 */
function resolvePlace(work: FormDef, target: ControlDef, place: unknown, byName: (n: unknown) => ControlDef | undefined, warnings: string[],
  given: Record<string, PropValue>, size: { width: number; height: number } = sizeOf(target)): Record<string, number> {
  if (!isObj(place)) return {};
  if (!movable(target, 'place', warnings)) return {};
  const entry = Object.entries(place).find(([k]) => PLACE_KEYS[k.toLowerCase()]);
  if (!entry) { warnings.push(`Ignored "place" of ${target.name} without below, above, rightOf or leftOf.`); return {}; }
  const ref = byName(entry[1]);
  if (!ref || ref === target) { warnings.push(`Ignored "place" of ${target.name}: no control ${String(entry[1])}.`); return {}; }
  const dir = PLACE_KEYS[entry[0].toLowerCase()];
  const gap = Math.max(0, num(place.gap) ?? DEFAULT_GAP);
  const align = typeof place.align === 'string' ? place.align.toLowerCase() : '';
  const r = absoluteRect(work, ref.id);
  const { width: w, height: h } = size;
  const origin = target.parentId ? absoluteRect(work, target.parentId) : { left: 0, top: 0 };
  let left: number, top: number;
  if (dir === 'below' || dir === 'above') {
    top = dir === 'below' ? r.top + r.height + gap : r.top - gap - h;
    left = align === 'center' ? r.left + (r.width - w) / 2 : align === 'right' ? r.left + r.width - w : r.left;
  } else {
    left = dir === 'rightOf' ? r.left + r.width + gap : r.left - gap - w;
    top = align === 'center' || align === 'middle' ? r.top + (r.height - h) / 2 : align === 'bottom' ? r.top + r.height - h : r.top;
  }
  const out = { Left: Math.round(left - origin.left), Top: Math.round(top - origin.top) };
  const cross = dir === 'below' || dir === 'above' ? 'Left' : 'Top';
  if (!align && typeof given[cross] === 'number') out[cross] = given[cross] as number;
  return out;
}

/** Whether place/arrange can move `c` by Left/Top: not a Line (X1..Y2) and not a docked control (its edge decides); else a warning. */
function movable(c: ControlDef, what: string, warnings: string[]): boolean {
  if (isMenu(c)) { warnings.push(`Ignored ${what} of ${label(c.name, c.index)}: a menu has no position.`); return false; }
  if (isLine(c)) { warnings.push(`Ignored ${what} of ${label(c.name, c.index)}: a Line is placed by X1, Y1, X2 and Y2.`); return false; }
  if (isDocked(c)) { warnings.push(`Ignored ${what} of ${label(c.name, c.index)}: it is docked (Align), so it sits at its edge.`); return false; }
  return true;
}

/** "place" for all members of a control array: a column of them (current order, top to bottom) placed as one block. */
function placeGroup(work: FormDef, members: ControlDef[], place: unknown, byName: (n: unknown) => ControlDef | undefined, warnings: string[],
  given: Record<string, PropValue>): [ControlDef, Record<string, number>][] {
  const order = [...members].sort((a, b) => rectOf(a).top - rectOf(b).top || rectOf(a).left - rectOf(b).left || (a.index ?? 0) - (b.index ?? 0));
  const gap = isObj(place) ? Math.max(0, num(place.gap) ?? DEFAULT_GAP) : DEFAULT_GAP;
  const column = arrange(order, { as: 'column', left: 0, top: 0, gap }, warnings);
  if (!column.length) return [];
  const block = {
    width: Math.max(...column.map(([c]) => sizeOf(c).width)),
    height: Math.max(...column.map(([c, g]) => g.Top + sizeOf(c).height)),
  };
  const at = resolvePlace(work, column[0][0], place, byName, warnings, given, block);
  if (at.Left === undefined || at.Top === undefined) return [];
  return column.map(([c, g]) => [c, { Left: at.Left + g.Left, Top: at.Top + g.Top }]);
}

/**
 * "arrange": the controls in a row, a column or a grid (`columns`, default about square), `gap` twips apart (default 120), starting at
 * `left`/`top` (default: where the first one is). A grid's columns are as wide as their widest control; in a row or a grid each control
 * is centred vertically in its row, so a Label next to a TextBox lines up with its text.
 */
function arrange(all: ControlDef[], raw: Record<string, unknown>, warnings: string[]): [ControlDef, Record<string, number>][] {
  const ctrls = all.filter(c => movable(c, 'arrange', warnings));
  if (!ctrls.length) return [];
  const same = ctrls.filter(c => c.parentId === ctrls[0].parentId);
  if (same.length < ctrls.length) warnings.push(`Ignored arrange of ${ctrls.filter(c => !same.includes(c)).map(c => c.name).join(', ')}: in another container than ${ctrls[0].name}.`);
  const as = String(raw.as ?? 'row').toLowerCase();
  const gap = Math.max(0, num(raw.gap) ?? DEFAULT_GAP);
  const first = rectOf(same[0]);
  const left = num(raw.left) ?? first.left, top = num(raw.top) ?? first.top;
  const cols = as === 'column' || as === 'vertical' ? 1 : as === 'grid' ? Math.max(1, num(raw.columns) ?? Math.ceil(Math.sqrt(same.length))) : same.length;
  const sizes = same.map(sizeOf);
  const colW: number[] = [], rowH: number[] = [];
  sizes.forEach((s, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c] ?? 0, s.width); rowH[r] = Math.max(rowH[r] ?? 0, s.height);
  });
  const x0 = (c: number) => left + colW.slice(0, c).reduce((a, b) => a + b, 0) + c * gap;
  const y0 = (r: number) => top + rowH.slice(0, r).reduce((a, b) => a + b, 0) + r * gap;
  return same.map((c, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const dy = cols === 1 ? 0 : Math.round((rowH[row] - sizes[i].height) / 2);
    return [c, { Left: x0(col), Top: y0(row) + dy }];
  });
}

const roundUp = (twips: number) => Math.ceil(twips / 15) * 15;
/** "autosize": Width (and a Label's Height) that fit the caption; a CommandButton gets some room around it and at least 375 height. */
function autosize(c: ControlDef, warnings: string[]): Record<string, number> | null {
  const pad = CAPTION_PAD[c.type];
  if (pad === undefined || c.type === 'Frame') { warnings.push(`Ignored autosize of ${c.name}: only Labels, CommandButtons, CheckBoxes and OptionButtons are sized to their caption.`); return null; }
  const caption = typeof c.props.Caption === 'string' ? c.props.Caption : c.name;
  const textW = textWidthPx(captionText(caption), c.props.Font);
  const lines = Math.max(1, caption.split(/\r?\n/).length);
  const size = typeof c.props.Font === 'object' && c.props.Font && 'size' in c.props.Font ? c.props.Font.size : 8;
  if (c.type === 'Label') return { Width: roundUp((textW + 4) * 15), Height: roundUp(lines * Math.round(13 * size / 8) * 15) };
  if (c.type === 'CommandButton') {
    const h = sizeOf(c).height;
    return { Width: Math.max(735, roundUp((textW + 24) * 15)), ...(h < 375 ? { Height: 375 } : {}) };
  }
  return { Width: roundUp((textW + pad + 4) * 15), Height: Math.max(255, roundUp(Math.round(13 * size / 8) * 15)) };
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
