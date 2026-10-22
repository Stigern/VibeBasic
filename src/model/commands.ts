// Undoable commands. The designer, Properties window, Project Explorer and the AI assistant change the project
// only through these. Commands look up forms/controls by id every time they run, and capture what undo needs
// (old values, array positions, deleted subtrees) at do-time, so they work as long as the stack is used in order.

import type { ControlDef, FormDef, ModuleDef, Project, PropValue } from './types';

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
    const c = this.done.pop();
    if (!c) return false;
    c.undo(this.getProject());
    this.undone.push(c);
    this.onChange();
    return true;
  }
  redo(): boolean {
    const c = this.undone.pop();
    if (!c) return false;
    c.do(this.getProject());
    this.done.push(c);
    this.onChange();
    return true;
  }
  markSaved(): void { this.savedPos = this.done.length; this.externalDirty = false; this.onChange(); }
  /** Code edits have their own undo in CodeMirror; they just mark the project as modified. */
  markDirtyExternal(): void { this.externalDirty = true; this.onChange(); }
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

export function deleteControlsCmd(formId: string, ids: string[]): Command {
  let removed: { index: number; def: ControlDef }[] = [];
  return {
    label: ids.length === 1 ? 'Delete control' : `Delete ${ids.length} controls`,
    do(p) {
      const f = formOf(p, formId);
      const all = withDescendants(f, ids);
      removed = [];
      f.controls.forEach((def, index) => { if (all.has(def.id)) removed.push({ index, def }); });
      f.controls = f.controls.filter(c => !all.has(c.id));
    },
    undo(p) {
      const f = formOf(p, formId);
      for (const r of removed) f.controls.splice(r.index, 0, r.def); // ascending index: each lands at its original slot
    },
  };
}

type Rect = { id: string; left: number; top: number; width: number; height: number };
const RECT_KEYS = ['Left', 'Top', 'Width', 'Height'] as const;

export function moveResizeCmd(formId: string, changes: Rect[]): Command {
  let old: { id: string; props: Record<string, PropValue | undefined> }[] = [];
  return {
    label: changes.length === 1 ? 'Move/resize control' : `Move/resize ${changes.length} controls`,
    do(p) {
      const f = formOf(p, formId);
      old = [];
      for (const ch of changes) {
        const c = controlOf(f, ch.id);
        const prev: Record<string, PropValue | undefined> = {};
        for (const k of RECT_KEYS) prev[k] = c.props[k];
        old.push({ id: c.id, props: prev });
        c.props.Left = ch.left;
        c.props.Top = ch.top;
        if ('Width' in c.props) { c.props.Width = ch.width; c.props.Height = ch.height; } // Timer etc. have no size
      }
    },
    undo(p) {
      const f = formOf(p, formId);
      for (const o of old) {
        const c = controlOf(f, o.id);
        for (const k of RECT_KEYS) {
          if (o.props[k] === undefined) delete c.props[k]; else c.props[k] = o.props[k] as PropValue;
        }
      }
    },
  };
}

export function setPropertyCmd(formId: string, targetId: string | 'form', name: string, value: PropValue): Command {
  const newValue = clone(value);
  let had = false;
  let oldValue: PropValue = null;
  const propsOf = (p: Project): Record<string, PropValue> => {
    const f = formOf(p, formId);
    return targetId === 'form' ? f.props : controlOf(f, targetId).props;
  };
  return {
    label: `Change ${name}`,
    do(p) {
      const props = propsOf(p);
      had = name in props;
      oldValue = clone(props[name] ?? null);
      props[name] = clone(newValue);
    },
    undo(p) {
      const props = propsOf(p);
      if (had) props[name] = clone(oldValue); else delete props[name];
    },
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

export function zOrderCmd(formId: string, ids: string[], where: 'front' | 'back'): Command {
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

/** Several commands as one undo step; undone in reverse order. */
export function compositeCmd(label: string, cmds: Command[]): Command {
  return {
    label,
    do(p) { for (const c of cmds) c.do(p); },
    undo(p) { for (let i = cmds.length - 1; i >= 0; i--) cmds[i].undo(p); },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Project items

export function addFormCmd(form: FormDef): Command {
  return {
    label: `Add ${form.name}`,
    do(p) { p.forms.push(form); },
    undo(p) { p.forms = p.forms.filter(f => f.id !== form.id); },
  };
}

export function addModuleCmd(m: ModuleDef): Command {
  return {
    label: `Add ${m.name}`,
    do(p) { p.modules.push(m); },
    undo(p) { p.modules = p.modules.filter(x => x.id !== m.id); },
  };
}

/** Removes a form or module by id. The caller picks a new startup form when removing the startup form;
 *  undo restores the startup form as it was before. */
export function removeItemCmd(id: string): Command {
  let kind: 'form' | 'module' = 'form';
  let index = 0;
  let item: FormDef | ModuleDef | null = null;
  let oldStartup = '';
  return {
    label: 'Remove item',
    do(p) {
      oldStartup = p.startupForm;
      const fi = p.forms.findIndex(f => f.id === id);
      if (fi >= 0) { kind = 'form'; index = fi; item = p.forms[fi]; p.forms.splice(fi, 1); return; }
      const mi = p.modules.findIndex(m => m.id === id);
      if (mi >= 0) { kind = 'module'; index = mi; item = p.modules[mi]; p.modules.splice(mi, 1); return; }
      throw new Error(`Item not found: ${id}`);
    },
    undo(p) {
      if (!item) return;
      if (kind === 'form') p.forms.splice(index, 0, item as FormDef);
      else p.modules.splice(index, 0, item as ModuleDef);
      p.startupForm = oldStartup;
    },
  };
}
