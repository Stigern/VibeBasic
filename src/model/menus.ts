// Menus of a form: ControlDefs of type 'Menu' in FormDef.controls, in menu order. A top-level menu has parentId null; an item or
// submenu names its parent menu. Up to 5 levels (the menu bar and 4 levels of submenus), as in VB6. Elements of a menu control
// array share a Name and have an Index; they stay together in index order (Load adds one after the others).
// Used by the designer, the run-time menu bar (controls/menuBar.ts), the Menu Editor and the AI.
import { CONTROL_TYPES, newId, validateName } from './controls';
import type { Command } from './commands';
import type { ControlDef, FormDef, PropValue } from './types';

export { SHORTCUT_LABELS, shortcutMatches, shortcutText, shortcutValue } from './menuShortcuts';

/** Height of a form's menu bar in pixels (Win98 SM_CYMENU), 285 twips. */
export const MENU_BAR_HEIGHT = 19;
/** The deepest level: 0 is the menu bar, 4 the fourth submenu. */
export const MAX_MENU_LEVEL = 4;

export const isMenu = (c: Pick<ControlDef, 'type'>): boolean => c.type === 'Menu';
const lc = (s: string): string => s.toLowerCase();
const shown = (c: ControlDef): boolean => c.props.Visible !== false;

/** Whether the form shows a menu bar: it has a top-level menu that is visible. */
export function hasMenuBar(controls: readonly ControlDef[] | undefined): boolean {
  return !!controls?.some(c => isMenu(c) && c.parentId === null && shown(c));
}

export interface MenuNode { def: ControlDef; children: MenuNode[] }

/** The menus of `defs` (other controls are skipped) as a tree. Siblings keep their order, except that the elements of a control
 *  array follow its first one in index order. A menu whose parent is missing is left out. */
export function menuTree(defs: readonly ControlDef[]): MenuNode[] {
  const menus = defs.filter(isMenu);
  const ids = new Set(menus.map(m => m.id));
  const kids = new Map<string | null, ControlDef[]>();
  for (const m of menus) {
    const p = m.parentId !== null && ids.has(m.parentId) ? m.parentId : m.parentId === null ? null : undefined;
    if (p === undefined) continue;
    (kids.get(p) ?? kids.set(p, []).get(p)!).push(m);
  }
  const build = (p: string | null, depth: number): MenuNode[] => {
    if (depth > MAX_MENU_LEVEL + 8) return [];
    return orderSiblings(kids.get(p) ?? []).map(def => ({ def, children: build(def.id, depth + 1) }));
  };
  return build(null, 0);
}

function orderSiblings(sibs: ControlDef[]): ControlDef[] {
  const groups = new Map<string, ControlDef[]>();
  const out: (ControlDef | ControlDef[])[] = [];
  for (const d of sibs) {
    if (d.index === null) { out.push(d); continue; }
    let g = groups.get(lc(d.name));
    if (!g) { groups.set(lc(d.name), g = []); out.push(g); }
    g.push(d);
  }
  return out.flatMap(x => (Array.isArray(x) ? [...x].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [x]));
}

/** Every menu node, depth first (the Menu Editor's list order). */
export function flattenMenus(nodes: MenuNode[], level = 0, out: { def: ControlDef; level: number }[] = []): { def: ControlDef; level: number }[] {
  for (const n of nodes) { out.push({ def: n.def, level }); flattenMenus(n.children, level + 1, out); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Menu Editor rows

/** One line of the Menu Editor. `id` is the menu's id ('' for a line made in the editor); `rest` keeps the other properties (Tag). */
export interface MenuRow {
  id: string; level: number; caption: string; name: string; index: number | null; shortcut: number; helpContextId: number;
  negotiatePosition: number; checked: boolean; enabled: boolean; visible: boolean; windowList: boolean; rest: Record<string, PropValue>;
}

const EDITOR_PROPS = new Set(['Caption', 'Shortcut', 'HelpContextID', 'NegotiatePosition', 'Checked', 'Enabled', 'Visible', 'WindowList']);

export function blankRow(level = 0): MenuRow {
  return { id: '', level, caption: '', name: '', index: null, shortcut: 0, helpContextId: 0, negotiatePosition: 0,
    checked: false, enabled: true, visible: true, windowList: false, rest: {} };
}

/** The form's menus as editor lines, depth first. */
export function menuRows(form: FormDef): MenuRow[] {
  return flattenMenus(menuTree(form.controls)).map(({ def, level }) => {
    const p = def.props, num = (k: string) => (typeof p[k] === 'number' ? p[k] as number : 0);
    return {
      id: def.id, level, caption: typeof p.Caption === 'string' ? p.Caption : '', name: def.name, index: def.index,
      shortcut: num('Shortcut'), helpContextId: num('HelpContextID'), negotiatePosition: num('NegotiatePosition'),
      checked: p.Checked === true, enabled: p.Enabled !== false, visible: p.Visible !== false, windowList: p.WindowList === true,
      rest: Object.fromEntries(Object.entries(p).filter(([k]) => !EDITOR_PROPS.has(k))),
    };
  });
}

/** A line the user left empty (no caption, no name): dropped on OK. */
export const isBlankRow = (r: MenuRow): boolean => r.caption === '' && r.name.trim() === '';

/** What is wrong with the lines (VB6's Menu Editor checks on OK), or null. `form` gives the names of the other controls. */
export function checkMenuRows(rows: MenuRow[], form: FormDef): { row: number; message: string } | null {
  const others = new Set(form.controls.filter(c => !isMenu(c)).map(c => lc(c.name)));
  const used = rows.map((r, i) => ({ r, i })).filter(x => !isBlankRow(x.r));
  let prev = -1;
  for (const { r, i } of used) {
    if (r.level > prev + 1) return { row: i, message: 'Menu item is indented too far: it needs a menu one level above it.' };
    prev = r.level;
    const name = r.name.trim();
    if (!name) return { row: i, message: 'Menu control must have a name.' };
    if (!validateName(name)) return { row: i, message: `'${name}' is not a valid name.` };
    if (others.has(lc(name))) return { row: i, message: `A control named '${name}' already exists.` };
    if (r.index !== null && (r.index < 0 || r.index > 32767)) return { row: i, message: 'Index must be between 0 and 32767.' };
  }
  const parents = parentsOf(used.map(x => x.r));
  for (const [k, { r, i }] of used.entries()) {
    const same = used.filter((o, j) => j !== k && lc(o.r.name.trim()) === lc(r.name.trim()));
    if (!same.length) continue;
    if (r.index === null || same.some(o => o.r.index === null)) return { row: i, message: `Menu control array element must have an index: '${r.name.trim()}' is used more than once.` };
    if (same.some(o => o.r.index === r.index)) return { row: i, message: `'${r.name.trim()}(${r.index})' is used more than once.` };
    if (same.some(o => parents[used.indexOf(o)] !== parents[k])) return { row: i, message: `The elements of the menu control array '${r.name.trim()}' must be in the same menu.` };
  }
  return null;
}

/** For each line, the position of its parent line (-1 on the menu bar). */
function parentsOf(rows: MenuRow[]): number[] {
  const stack: number[] = [];
  return rows.map((r, i) => {
    stack.length = Math.min(stack.length, r.level);
    const p = r.level > 0 ? stack[r.level - 1] ?? -1 : -1;
    stack[r.level] = i;
    return p;
  });
}

/** The menus the lines stand for (blank lines dropped; a line made in the editor gets a new id). Check them first (checkMenuRows). */
export function rowsToMenus(rows: MenuRow[]): ControlDef[] {
  const used = rows.filter(r => !isBlankRow(r));
  const ids = used.map(r => r.id || newId());
  const parents = parentsOf(used);
  const defaults: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES.Menu.props) if (pd.designTime) defaults[pd.name] = pd.default;
  return used.map((r, i) => ({
    id: ids[i], type: 'Menu', name: r.name.trim(), index: r.index, parentId: parents[i] >= 0 ? ids[parents[i]] : null,
    props: { ...defaults, ...r.rest, Caption: r.caption, Checked: r.checked, Enabled: r.enabled, Visible: r.visible, WindowList: r.windowList,
      Shortcut: r.shortcut, HelpContextID: r.helpContextId, NegotiatePosition: r.negotiatePosition },
  }));
}

/** Replaces the form's menus with `menus` (one undo step; the other controls stay as they are, the menus go after them). */
export function setMenusCmd(formId: string, menus: ControlDef[], label = 'Menu Editor'): Command {
  const fresh = menus.map(m => structuredClone(m));
  let old: ControlDef[] | null = null;
  const formOf = (p: { forms: FormDef[] }): FormDef => {
    const f = p.forms.find(x => x.id === formId);
    if (!f) throw new Error(`Form not found: ${formId}`);
    return f;
  };
  return {
    label,
    do(p) {
      const f = formOf(p);
      old = f.controls;
      f.controls = [...f.controls.filter(c => !isMenu(c)), ...fresh.map(m => structuredClone(m))];
    },
    undo(p) { if (old) formOf(p).controls = old; },
  };
}

/** Whether the menus differ from the form's (the editor's OK changes nothing otherwise). */
export function sameMenus(form: FormDef, menus: ControlDef[]): boolean {
  const key = (ms: ControlDef[]) => JSON.stringify(ms.map(m => [m.id, m.name, m.index, m.parentId,
    Object.entries(m.props).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]));
  return key(form.controls.filter(isMenu)) === key(menus);
}
