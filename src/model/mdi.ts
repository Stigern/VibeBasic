// MDI (VB6 MDIForm): the project's MDI form (FormDef.mdi, at most one) and its children (ordinary forms with MDIChild = True).
// The MDI form shares the Form registry entry; this file says which of its properties and events an MDI form has, which controls
// it may hold, how a new one starts, the Window list of its menu bar and the geometry of Arrange. Used by the IDE, the run time
// (run/mdiWorkspace.ts, objects/formInstance.ts) and the AI.
import { CONTROL_TYPES, newForm, type EventDef } from './controls';
import type { Rect } from './geometry';
import type { ControlDef, ControlType, FormDef } from './types';

const lc = (s: string): string => s.toLowerCase();

/** AppWorkspace (&H8000000C&), the MDI form's default BackColor, as the interpreter stores it. */
export const APP_WORKSPACE = 0x8000000c | 0;

/** The properties only an MDI form has. */
const MDI_ONLY = new Set(['autoshowchildren', 'scrollbars']);
/** The Form properties an MDI form has (VB6's MDIForm: no BorderStyle, ControlBox, Min/MaxButton, KeyPreview, Font, ForeColor). */
const MDI_PROPS = new Set(['left', 'top', 'width', 'height', 'visible', 'enabled', 'tag', 'caption', 'backcolor', 'startupposition',
  'windowstate', 'picture', 'icon', ...MDI_ONLY]);
/** The Form events an MDI form does not have (MDIForm_Load ... has no focus or key events). */
const NOT_MDI_EVENTS = new Set(['gotfocus', 'lostfocus', 'keypress', 'keydown', 'keyup', 'paint']);

export const isMdiChild = (f: Pick<FormDef, 'props' | 'mdi'>): boolean => !f.mdi && f.props.MDIChild === true;

/** Whether the form has this Form property: an MDI form only its own list, an ordinary form none of the MDI-only ones
 *  (MDIChild is an ordinary form's). */
export function formHasProp(f: Pick<FormDef, 'mdi'>, name: string): boolean {
  const l = lc(name);
  return f.mdi ? MDI_PROPS.has(l) : !MDI_ONLY.has(l);
}

/** The object name of the form's own events in its code: MDIForm_Load on the MDI form, Form_Load elsewhere. */
export const formObjectName = (f: Pick<FormDef, 'mdi'> | null | undefined): 'Form' | 'MDIForm' => (f?.mdi ? 'MDIForm' : 'Form');

/** The form's own events (an MDI form has fewer). */
export function formEvents(f: Pick<FormDef, 'mdi'>): EventDef[] {
  return f.mdi ? CONTROL_TYPES.Form.events.filter(e => !NOT_MDI_EVENTS.has(lc(e.name))) : CONTROL_TYPES.Form.events;
}

/** The controls an MDI form may hold (VB6): those that align to an edge and those without a view at run time. */
export function mdiAllows(type: ControlType): boolean {
  return type === 'PictureBox' || type === 'Toolbar' || type === 'StatusBar' || type === 'CoolBar' || type === 'Menu'
    || (type !== 'Form' && CONTROL_TYPES[type].invisibleAtRuntime);
}

/** A new MDI form: its properties at their defaults, the AppWorkspace grey, Caption = name. */
export function newMdiForm(name: string, code = ''): FormDef {
  const f = newForm(name, code);
  const props = Object.fromEntries(CONTROL_TYPES.Form.props.filter(p => p.designTime && MDI_PROPS.has(lc(p.name)))
    .map(p => [p.name, Array.isArray(p.default) ? [...p.default] : p.default]));
  return { ...f, mdi: true, props: { ...props, Caption: name, BackColor: APP_WORKSPACE, Width: 7200, Height: 5400 } };
}

// ---------------------------------------------------------------------------------------------------------------
// Window list

/** The id prefix of the Window list's items (the child's key follows). */
export const WINDOW_ITEM = 'mdiwindow:';

/**
 * The menus with the Window list: under the first visible menu whose WindowList is True, a separator (when it has visible items)
 * and one item per open child, "&1 Caption" ... (at most 9, as Windows), the active one checked. Unchanged without such a menu.
 */
export function withWindowList(menus: ControlDef[], windows: { key: string; caption: string }[], activeKey: string | null): ControlDef[] {
  const shown = (d: ControlDef) => d.props.Visible !== false;
  const list = menus.find(m => m.props.WindowList === true && shown(m));
  if (!list || !windows.length) return menus;
  const item = (id: string, caption: string, checked = false): ControlDef =>
    ({ id, type: 'Menu', name: '', index: null, parentId: list.id, props: { Caption: caption, Checked: checked, Enabled: true, Visible: true } });
  const extra = windows.slice(0, 9).map((w, i) => item(`${WINDOW_ITEM}${w.key}`, `&${i + 1} ${w.caption}`, w.key === activeKey));
  if (menus.some(m => m.parentId === list.id && shown(m))) extra.unshift(item(`${WINDOW_ITEM}-`, '-'));
  return [...menus, ...extra];
}

// ---------------------------------------------------------------------------------------------------------------
// Arrange (pixels in the workspace)

/** The step between two cascaded windows: a title bar and a sizable border. */
export const CASCADE_STEP = 22;

/** vbCascade 0: each window one step right and down of the one behind it (the active one last, in front); sizes are kept, but no
 *  window reaches past the workspace (it shrinks to fit when it would). */
export function cascadeRects(sizes: { width: number; height: number }[], ws: { width: number; height: number }): Rect[] {
  return sizes.map((s, i) => {
    const per = Math.max(1, Math.floor(Math.min(ws.width, ws.height) / 2 / CASCADE_STEP));   // then it starts again at the corner
    const off = (i % per) * CASCADE_STEP;
    return { left: off, top: off, width: Math.max(1, Math.min(s.width, ws.width - off)), height: Math.max(1, Math.min(s.height, ws.height - off)) };
  });
}

/** vbTileHorizontal 1: the windows one above the other, full width; vbTileVertical 2: side by side, full height. */
export function tileRects(n: number, ws: { width: number; height: number }, vertical: boolean): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(((vertical ? ws.width : ws.height) * i) / n), b = Math.floor(((vertical ? ws.width : ws.height) * (i + 1)) / n);
    out.push(vertical ? { left: a, top: 0, width: b - a, height: ws.height } : { left: 0, top: a, width: ws.width, height: b - a });
  }
  return out;
}

/** Width of a minimized child (its title bar), px. */
export const MINIMIZED_WIDTH = 160;
/** Height of a minimized child: the title bar and a fixed border. */
export const MINIMIZED_HEIGHT = 24;

/** vbArrangeIcons 3 (and where a window goes when minimized): slot i of the minimized title bars, left to right along the bottom of
 *  the workspace, then the row above. */
export function iconSlot(i: number, ws: { width: number; height: number }): { left: number; top: number } {
  const perRow = Math.max(1, Math.floor(ws.width / MINIMIZED_WIDTH));
  return { left: (i % perRow) * MINIMIZED_WIDTH, top: Math.max(0, ws.height - MINIMIZED_HEIGHT * (Math.floor(i / perRow) + 1)) };
}
