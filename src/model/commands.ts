// Undoable commands. The designer, Properties window, Project Explorer and the AI assistant change the project
// only through these. Commands look up forms/controls by id every time they run, and capture what undo needs
// (old values, array positions, deleted subtrees) at do-time, so they work as long as the stack is used in order.

import { assetRefCount, controlAssetIds } from './assetRefs';
import { CONTROL_TYPES } from './controls';
import { setControlPos } from './geometry';
import type { Asset, ControlDef, FormDef, ModuleDef, Project, PropValue } from './types';

export interface Command { label: string; do(p: Project): void; undo(p: Project): void }

export class CommandStack {
  private done: Command[] = [];
  private undone: Command[] = [];
  /** Length of `done` at the last save; -1 when that state can no longer be reached. */
  private savedPos = 0;
  private externalDirty = false;

  constructor(private getProject: () => Project, private onChange: () => void) {}

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }
  get undoLabel(): string | null { return this.done.length ? this.done[this.done.length - 1].label : null; }
  get isDirty(): boolean { return this.externalDirty || this.done.length !== this.savedPos; }

  execute(c: Command): void {
    c.do(this.getProject());
    this.done.push(c);
    if (this.undone.length && this.savedPos > this.done.length - 1) this.savedPos = -1; // saved state was on the redo branch
    this.undone = [];
    this.onChange();
  }
  undo(): boolean {
    const c = this.done[this.done.length - 1];
    if (!c) return false;
    c.undo(this.getProject()); // if this throws, the stacks stay as they were
    this.done.pop();
    this.undone.push(c);
    this.onChange();
    return true;
  }
  redo(): boolean {
    const c = this.undone[this.undone.length - 1];
    if (!c) return false;
    c.do(this.getProject()); // if this throws, the stacks stay as they were
    this.undone.pop();
    this.done.push(c);
    this.onChange();
    return true;
  }
  markSaved(): void { this.savedPos = this.done.length; this.externalDirty = false; this.onChange(); }
  /** Code edits have their own undo in CodeMirror; they just mark the project as modified. */
  markDirtyExternal(): void {
    if (this.externalDirty) return;   // already dirty: nothing to refresh
    this.externalDirty = true;
    this.onChange();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const clone = <T>(v: T): T => (v !== null && typeof v === 'object' ? structuredClone(v) : v);

function formOf(p: Project, formId: string): FormDef {
  const f = p.forms.find(x => x.id === formId);
  if (!f) throw new Error(`Form not found: ${formId}`);
  return f;
}
function controlOf(f: FormDef, id: string): ControlDef {
  const c = f.controls.find(x => x.id === id);
  if (!c) throw new Error(`Control not found: ${id}`);
  return c;
}
/** The given ids plus all their descendants (containers inside containers included). */
function withDescendants(f: FormDef, ids: string[]): Set<string> {
  const set = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of f.controls) {
      if (c.parentId !== null && set.has(c.parentId) && !set.has(c.id)) { set.add(c.id); grew = true; }
    }
  }
  return set;
}

// ---------------------------------------------------------------------------------------------------------------
// Control commands

export function addControlsCmd(formId: string, defs: ControlDef[]): Command {
  const pristine = defs.map(d => structuredClone(d));
  return {
    label: pristine.length === 1 ? `Add ${pristine[0].name}` : `Add ${pristine.length} controls`,
    do(p) { formOf(p, formId).controls.push(...pristine.map(d => structuredClone(d))); },
    undo(p) {
      const f = formOf(p, formId);
      const ids = new Set(pristine.map(d => d.id));
      f.controls = f.controls.filter(c => !ids.has(c.id));
    },
  };
}

/** Deletes controls and their descendants. As in VB6 the pictures only they used go with them (the assets nothing else names
 *  are removed), and the TabIndex values of the remaining controls are renumbered without gaps. */
export function deleteControlsCmd(formId: string, idList: string[]): Command {
  const ids = [...idList];
  let removed: { index: number; def: ControlDef }[] = [];
  let droppedAssets: [string, Asset][] = [];
  const del: Command = {
    label: '',
    do(p) {
      const f = formOf(p, formId);
      const all = withDescendants(f, ids);
      removed = [];
      f.controls.forEach((def, index) => { if (all.has(def.id)) removed.push({ index, def }); });
      f.controls = f.controls.filter(c => !all.has(c.id));
      droppedAssets = [];
      for (const a of new Set(removed.flatMap(r => controlAssetIds(r.def)))) {
        if (a in p.assets && a !== p.iconAsset && assetRefCount(p, a) === 0) { droppedAssets.push([a, p.assets[a]]); delete p.assets[a]; }
      }
    },
    undo(p) {
      for (const [a, asset] of droppedAssets) p.assets[a] = asset;
      const f = formOf(p, formId);
      for (const r of removed) f.controls.splice(r.index, 0, r.def); // ascending index: each lands at its original slot
    },
  };
  return compositeCmd(ids.length === 1 ? 'Delete control' : `Delete ${ids.length} controls`, [del, tabIndexCmd(formId)]);
}

/** Renumbers the TabIndex of the form's controls 0, 1, 2, ... in their current tab order, without gaps (VB6). With `place`, that
 *  control is first moved to position `place.index` (clamped to the last one), and the others shift around it. */
export function tabIndexCmd(formId: string, place?: { id: string; index: number }): Command {
  let old: { id: string; value: PropValue }[] = [];
  return {
    label: 'Change TabIndex',
    do(p) {
      const f = formOf(p, formId);
      const order = f.controls.filter(c => typeof c.props.TabIndex === 'number')
        .map((c, i) => ({ c, i })).sort((a, b) => (a.c.props.TabIndex as number) - (b.c.props.TabIndex as number) || a.i - b.i).map(x => x.c);
      if (place) {
        const at = order.findIndex(c => c.id === place.id);
        if (at < 0) throw new Error(`Control not found: ${place.id}`);
        const [c] = order.splice(at, 1);
        order.splice(Math.max(0, Math.min(place.index, order.length)), 0, c);
      }
      old = [];
      order.forEach((c, i) => { if (c.props.TabIndex !== i) { old.push({ id: c.id, value: c.props.TabIndex }); c.props.TabIndex = i; } });
    },
    undo(p) {
      const f = formOf(p, formId);
      for (const o of old) controlOf(f, o.id).props.TabIndex = o.value;
    },
  };
}

type Rect = { id: string; left: number; top: number; width: number; height: number };
const RECT_KEYS = ['Left', 'Top', 'Width', 'Height', 'X1', 'Y1', 'X2', 'Y2'] as const;

export function moveResizeCmd(formId: string, rects: Rect[]): Command {
  const changes = rects.map(c => ({ ...c }));
  let old: { id: string; props: Record<string, PropValue | undefined> }[] = [];
  return {
    label: changes.length === 1 ? 'Move/resize control' : `Move/resize ${changes.length} controls`,
    do(p) {
      const f = formOf(p, formId);
      const targets = changes.map(ch => controlOf(f, ch.id)); // validate everything before mutating anything
      old = [];
      changes.forEach((ch, i) => {
        const c = targets[i];
        const prev: Record<string, PropValue | undefined> = {};
        for (const k of RECT_KEYS) prev[k] = c.props[k];
        old.push({ id: c.id, props: prev });
        setControlPos(c, ch.left, ch.top);   // a Line only moves (its size is set through its end points)
        if ('Width' in c.props) { c.props.Width = ch.width; c.props.Height = ch.height; } // Timer etc. have no size
      });
    },
    undo(p) {
      const f = formOf(p, formId);
      const targets = old.map(o => controlOf(f, o.id));
      for (let i = old.length - 1; i >= 0; i--) { // reverse: a duplicated id must end at its first old value
        const c = targets[i], o = old[i];
        for (const k of RECT_KEYS) {
          if (o.props[k] === undefined) delete c.props[k]; else c.props[k] = o.props[k] as PropValue;
        }
      }
    },
  };
}

const POS_KEYS = ['Left', 'Top', 'X1', 'Y1', 'X2', 'Y2'] as const;

/** Moves controls into another container (or the form: `parentId` null). Left/Top are relative to the new parent; `tab` is the
 *  SSTab tab for a move into an SSTab (left out: the control has no tab). */
export function reparentCmd(formId: string, items: { id: string; parentId: string | null; left: number; top: number; tab?: number }[]): Command {
  const changes = items.map(i => ({ ...i }));
  let old: { id: string; parentId: string | null; tab: number | undefined; props: Record<string, PropValue | undefined> }[] = [];
  return {
    label: changes.length === 1 ? 'Move control' : `Move ${changes.length} controls`,
    do(p) {
      const f = formOf(p, formId);
      const targets = changes.map(ch => controlOf(f, ch.id));
      for (const ch of changes) {
        if (ch.parentId === null) continue;
        controlOf(f, ch.parentId);
        if (withDescendants(f, [ch.id]).has(ch.parentId)) throw new Error('A control cannot be placed inside itself');
      }
      old = targets.map(c => ({ id: c.id, parentId: c.parentId, tab: c.tab, props: Object.fromEntries(POS_KEYS.map(k => [k, c.props[k]])) }));
      changes.forEach((ch, i) => {
        targets[i].parentId = ch.parentId;
        if (ch.tab === undefined) delete targets[i].tab; else targets[i].tab = ch.tab;
        setControlPos(targets[i], ch.left, ch.top);
      });
    },
    undo(p) {
      const f = formOf(p, formId);
      const targets = old.map(o => controlOf(f, o.id));
      for (let i = old.length - 1; i >= 0; i--) {
        targets[i].parentId = old[i].parentId;
        if (old[i].tab === undefined) delete targets[i].tab; else targets[i].tab = old[i].tab;
        for (const k of POS_KEYS) { const v = old[i].props[k]; if (v === undefined) delete targets[i].props[k]; else targets[i].props[k] = v; }
      }
    },
  };
}

/** Sets one property. A control type with linked properties (ControlTypeDef.onPropSet, e.g. SSTab Caption / Tab / TabCaption)
 *  updates them too; undo then restores all of its properties. */
export function setPropertyCmd(formId: string, targetId: string | 'form', name: string, value: PropValue): Command {
  const newValue = clone(value);
  let had = false;
  let oldValue: PropValue = null;
  let snapshot: Record<string, PropValue> | null = null;
  const target = (p: Project): { props: Record<string, PropValue>; hook?: (props: Record<string, PropValue>, name: string) => void } => {
    const f = formOf(p, formId);
    if (targetId === 'form') return { props: f.props };
    const c = controlOf(f, targetId);
    return { props: c.props, hook: CONTROL_TYPES[c.type]?.onPropSet };
  };
  return {
    label: `Change ${name}`,
    do(p) {
      const { props, hook } = target(p);
      had = name in props;
      oldValue = clone(props[name] ?? null);
      snapshot = hook ? structuredClone(props) : null;
      props[name] = clone(newValue);
      hook?.(props, name);
    },
    undo(p) {
      const { props } = target(p);
      if (snapshot) {
        for (const k of Object.keys(props)) delete props[k];
        Object.assign(props, structuredClone(snapshot));
      } else if (had) props[name] = clone(oldValue); else delete props[name];
    },
  };
}

/** Common prefix length and common suffix length (not overlapping the prefix) of two strings. */
function commonEnds(a: string, b: string): [number, number] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return [s, e];
}

/**
 * Changes the code of a form or module (AI proposals). Only the changed span is recorded: the code window writes
 * keystrokes straight to `code`, so undo/redo swap just that span back, and only while it is still intact
 * (hand edits elsewhere are kept). If the span was edited by hand, undo/redo leave the code alone (no throw).
 */
export function setCodeCmd(itemId: string, newCode: string): Command {
  const find = (p: Project): { code: string } | undefined => p.forms.find(f => f.id === itemId) ?? p.modules.find(m => m.id === itemId);
  let span: { at: number; oldText: string; newText: string } | null = null;
  let last = '';            // the code right after our last write
  let showing: 'new' | 'old' = 'new';
  let detached = false;     // the span was edited by hand: undo/redo no longer touch the code
  const swap = (p: Project, want: 'new' | 'old') => {
    const it = find(p);
    if (!it || !span || detached || showing === want) return;
    const cur = it.code;
    const present = want === 'old' ? span.newText : span.oldText;
    const next = want === 'old' ? span.oldText : span.newText;
    let at = -1;
    if (cur === last) at = span.at;
    else {
      const [s, e] = commonEnds(last, cur);
      if (last.length - e <= span.at) at = span.at + cur.length - last.length;      // edits before the span only
      else if (s >= span.at + present.length) at = span.at;                          // edits after the span only
      else if (present && cur.indexOf(present) >= 0 && cur.indexOf(present) === cur.lastIndexOf(present)) at = cur.indexOf(present);
    }
    if (at < 0 || cur.slice(at, at + present.length) !== present) { detached = true; return; }
    it.code = cur.slice(0, at) + next + cur.slice(at + present.length);
    span.at = at; last = it.code; showing = want;
  };
  return {
    label: 'Change code',
    do(p) {
      if (span) { swap(p, 'new'); return; }
      const it = find(p);
      if (!it) throw new Error(`Code item not found: ${itemId}`);
      const [s, e] = commonEnds(it.code, newCode);
      span = { at: s, oldText: it.code.slice(s, it.code.length - e), newText: newCode.slice(s, newCode.length - e) };
      it.code = newCode; last = newCode; showing = 'new';
    },
    undo(p) { swap(p, 'old'); },
  };
}

/** Adds an asset (picture data) under `id`. Combine with setPropertyCmd in a compositeCmd so both undo together. */
export function addAssetCmd(id: string, asset: Asset): Command {
  return {
    label: 'Add Picture',
    do(p) { p.assets[id] = { ...asset }; },
    undo(p) { delete p.assets[id]; },
  };
}

export function removeAssetCmd(id: string): Command {
  let old: Asset | undefined;
  return {
    label: 'Remove Picture',
    do(p) { old = p.assets[id]; delete p.assets[id]; },
    undo(p) { if (old) p.assets[id] = old; },
  };
}

/** Changes the name (and optionally the control-array index). Never touches code: event procedures keep the old name (VB6). */
export function renameCmd(formId: string, targetId: string | 'form', newName: string, newIndex: number | null): Command {
  let oldName = '';
  let oldIndex: number | null = null;
  let oldStartup = '';
  return {
    label: 'Rename',
    do(p) {
      const f = formOf(p, formId);
      oldStartup = p.startupForm;
      if (targetId === 'form') {
        oldName = f.name;
        f.name = newName;
        if (p.startupForm === oldName) p.startupForm = newName;
      } else {
        const c = controlOf(f, targetId);
        oldName = c.name; oldIndex = c.index;
        c.name = newName; c.index = newIndex;
      }
    },
    undo(p) {
      const f = formOf(p, formId);
      if (targetId === 'form') { f.name = oldName; p.startupForm = oldStartup; }
      else { const c = controlOf(f, targetId); c.name = oldName; c.index = oldIndex; }
    },
  };
}

/** Renames a standard module (Properties window, (Name)). Like renameCmd it never touches code. */
export function renameModuleCmd(moduleId: string, newName: string): Command {
  let oldName = '';
  const mod = (p: Project): ModuleDef => {
    const m = p.modules.find(x => x.id === moduleId);
    if (!m) throw new Error(`Module not found: ${moduleId}`);
    return m;
  };
  return {
    label: 'Rename',
    do(p) { const m = mod(p); oldName = m.name; m.name = newName; },
    undo(p) { mod(p).name = oldName; },
  };
}

export function zOrderCmd(formId: string, idList: string[], where: 'front' | 'back'): Command {
  const ids = [...idList];
  let oldOrder: string[] = [];
  return {
    label: where === 'front' ? 'Bring to Front' : 'Send to Back',
    do(p) {
      const f = formOf(p, formId);
      oldOrder = f.controls.map(c => c.id);
      const sel = new Set(ids);
      const moved = f.controls.filter(c => sel.has(c.id));
      const rest = f.controls.filter(c => !sel.has(c.id));
      f.controls = where === 'front' ? [...rest, ...moved] : [...moved, ...rest];
    },
    undo(p) {
      const f = formOf(p, formId);
      const rank = new Map(oldOrder.map((id, i) => [id, i] as const));
      f.controls = [...f.controls].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    },
  };
}

/** Several commands as one undo step; undone in reverse order. If a step fails midway, the steps already
 *  applied are rolled back before the error is rethrown, so the project is left as it was. */
export function compositeCmd(label: string, cmdList: Command[]): Command {
  const cmds = [...cmdList];
  return {
    label,
    do(p) {
      let n = 0;
      try {
        for (; n < cmds.length; n++) cmds[n].do(p);
      } catch (e) {
        for (let i = n - 1; i >= 0; i--) cmds[i].undo(p);
        throw e;
      }
    },
    undo(p) {
      let n = cmds.length - 1;
      try {
        for (; n >= 0; n--) cmds[n].undo(p);
      } catch (e) {
        for (let i = n + 1; i < cmds.length; i++) cmds[i].do(p);
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Project items

/** Adds a form or module. Undo keeps the live object that it takes out (with the code typed into it since, which never goes
 *  through the stack), and redo puts that same object back; only the first `do` uses the pristine copy. */
function addItemCmd<T extends { id: string; name: string }>(item: T, list: (p: Project) => T[], set: (p: Project, items: T[]) => void): Command {
  const pristine = structuredClone(item);
  let removed: T | null = null;
  return {
    label: `Add ${pristine.name}`,
    do(p) { list(p).push(removed ?? structuredClone(pristine)); removed = null; },
    undo(p) {
      const items = list(p);
      removed = items.find(x => x.id === pristine.id) ?? null;
      set(p, items.filter(x => x.id !== pristine.id));
    },
  };
}

export function addFormCmd(form: FormDef): Command {
  return addItemCmd(form, p => p.forms, (p, v) => { p.forms = v; });
}

export function addModuleCmd(m: ModuleDef): Command {
  return addItemCmd(m, p => p.modules, (p, v) => { p.modules = v; });
}

/** Removes a form or module by id. Removing the startup form requires `newStartupForm` (a form name); the command
 *  sets it and undo puts the old startup form back, so the project never has a dangling startup form. */
export function removeItemCmd(id: string, newStartupForm?: string): Command {
  let kind: 'form' | 'module' = 'form';
  let index = 0;
  let item: FormDef | ModuleDef | null = null;
  let oldStartup: string | null = null; // set only when this command changed startupForm
  return {
    label: 'Remove item',
    do(p) {
      oldStartup = null;
      const fi = p.forms.findIndex(f => f.id === id);
      if (fi >= 0) {
        const isStartup = p.forms[fi].name === p.startupForm;
        if (isStartup && newStartupForm === undefined) throw new Error('A new startup form is required when removing the startup form');
        kind = 'form'; index = fi; item = p.forms[fi];
        p.forms.splice(fi, 1);
        if (isStartup) { oldStartup = p.startupForm; p.startupForm = newStartupForm as string; }
        return;
      }
      const mi = p.modules.findIndex(m => m.id === id);
      if (mi >= 0) { kind = 'module'; index = mi; item = p.modules[mi]; p.modules.splice(mi, 1); return; }
      throw new Error(`Item not found: ${id}`);
    },
    undo(p) {
      if (!item) return;
      if (kind === 'form') p.forms.splice(index, 0, item as FormDef);
      else p.modules.splice(index, 0, item as ModuleDef);
      if (oldStartup !== null) p.startupForm = oldStartup;
    },
  };
}

/** Project Properties fields. `startupForm` is a form name. */
export function setProjectFieldCmd(field: 'name' | 'title' | 'startupForm', value: string): Command {
  let old = '';
  return {
    label: `Change project ${field}`,
    do(p) { old = p[field]; p[field] = value; },
    undo(p) { p[field] = old; },
  };
}

/** Project icon (Make tab): `iconAsset` is an asset id or null. */
export function setProjectIconCmd(id: string | null): Command {
  let old: string | null = null;
  return {
    label: 'Change project icon',
    do(p) { old = p.iconAsset; p.iconAsset = id; },
    undo(p) { p.iconAsset = old; },
  };
}
