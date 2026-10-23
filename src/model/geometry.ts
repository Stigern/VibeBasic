// Position helpers for controls whose geometry is not Left/Top/Width/Height: a Line is X1, Y1, X2, Y2.
import { MENU_BAR_HEIGHT, hasMenuBar } from './menus';
import type { ControlDef, PropValue } from './types';

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

export const isLine = (c: Pick<ControlDef, 'type'>): boolean => c.type === 'Line';

/** Top-left of the control's bounding box, relative to its parent. */
export function controlPos(c: ControlDef): { left: number; top: number } {
  if (isLine(c)) return { left: Math.min(n(c.props.X1), n(c.props.X2)), top: Math.min(n(c.props.Y1), n(c.props.Y2)) };
  return { left: n(c.props.Left), top: n(c.props.Top) };
}

/** Moves the control so that its bounding box starts at (left, top); a Line keeps its shape and direction. */
export function setControlPos(c: ControlDef, left: number, top: number): void {
  if (!isLine(c)) { c.props.Left = left; c.props.Top = top; return; }
  const p = controlPos(c), dx = left - p.left, dy = top - p.top;
  c.props.X1 = n(c.props.X1) + dx; c.props.X2 = n(c.props.X2) + dx;
  c.props.Y1 = n(c.props.Y1) + dy; c.props.Y2 = n(c.props.Y2) + dy;
}

export type DockEdge = 'top' | 'bottom' | 'left' | 'right';
const ALIGN_EDGES: (DockEdge | null)[] = [null, 'top', 'bottom', 'left', 'right'];

/** The edge a control on the form docks to (its Left, Top and Width, or Height for left / right, are ignored): a StatusBar at the
 *  bottom, a Toolbar or CoolBar by its Align (vbAlignTop 1, the default; vbAlignBottom 2; vbAlignNone 0 leaves it where it is), a
 *  PictureBox by its Align (vbAlignNone 0, the default; Top 1, Bottom 2, Left 3, Right 4). */
export function dockEdge(c: Pick<ControlDef, 'type' | 'parentId' | 'props'>): DockEdge | null {
  if (c.parentId !== null) return null;
  if (c.type === 'StatusBar') return 'bottom';
  if (c.type === 'PictureBox') return ALIGN_EDGES[typeof c.props?.Align === 'number' ? c.props.Align : 0] ?? null;
  if (c.type !== 'Toolbar' && c.type !== 'CoolBar') return null;
  const a = typeof c.props?.Align === 'number' ? c.props.Align : 1;
  return a === 1 ? 'top' : a === 2 ? 'bottom' : null;
}
export const isDocked = (c: Pick<ControlDef, 'type' | 'parentId' | 'props'>): boolean => dockEdge(c) !== null;

export interface Rect { left: number; top: number; width: number; height: number }

/** Docked controls in z-order (back first), each `size` thick (height for top / bottom, width for left / right), take their edge of
 *  what the ones before them left: a top one spans the free width, a left one the free height. `rest` is what is left (an MDI
 *  form's workspace). Any unit. */
export function stackDocks<K>(items: { key: K; edge: DockEdge; size: number }[], width: number, height: number): { rects: Map<K, Rect>; rest: Rect } {
  const rest: Rect = { left: 0, top: 0, width, height };
  const rects = new Map<K, Rect>();
  for (const { key, edge, size } of items) {
    const horizontal = edge === 'top' || edge === 'bottom';
    const s = Math.max(0, Math.min(size, horizontal ? rest.height : rest.width));
    if (edge === 'top') { rects.set(key, { left: rest.left, top: rest.top, width: rest.width, height: s }); rest.top += s; rest.height -= s; }
    else if (edge === 'bottom') { rects.set(key, { left: rest.left, top: rest.top + rest.height - s, width: rest.width, height: s }); rest.height -= s; }
    else if (edge === 'left') { rects.set(key, { left: rest.left, top: rest.top, width: s, height: rest.height }); rest.left += s; rest.width -= s; }
    else { rects.set(key, { left: rest.left + rest.width - s, top: rest.top, width: s, height: rest.height }); rest.width -= s; }
  }
  return { rects, rest };
}

/** The client area of a form in twips (Width/Height are the outer size; see formMetrics in controls/render.ts). `menuBar`: the form
 *  shows a menu bar (menus.ts hasMenuBar), which takes MENU_BAR_HEIGHT pixels off the top. */
export function formClientTwips(props: Record<string, PropValue>, menuBar = false): { width: number; height: number } {
  const num = (k: string, d: number): number => (typeof props[k] === 'number' ? (props[k] as number) : d);
  const bs = num('BorderStyle', 2);
  const border = bs === 0 ? 0 : bs === 2 || bs === 5 ? 4 : 3, title = bs === 0 ? 0 : 18;
  const w = Math.round(num('Width', 4800) / 15), h = Math.round(num('Height', 3600) / 15);
  return { width: Math.max(0, w - 2 * border) * 15, height: Math.max(0, h - 2 * border - title - (menuBar ? MENU_BAR_HEIGHT : 0)) * 15 };
}

/** The rectangle a docked control really occupies, in client twips (docked controls stack in z-order, see stackDocks). */
export function dockedRect(form: { props: Record<string, PropValue>; controls?: ControlDef[] }, c: ControlDef): Rect {
  const cl = formClientTwips(form.props, hasMenuBar(form.controls));
  const items = (form.controls?.some(x => x.id === c.id) ? form.controls : [...form.controls ?? [], c])
    .filter(isDocked).map(x => {
      const edge = dockEdge(x)!;
      const v = edge === 'top' || edge === 'bottom' ? x.props.Height : x.props.Width;
      return { key: x.id, edge, size: typeof v === 'number' ? v : 315 };
    });
  return stackDocks(items, cl.width, cl.height).rects.get(c.id)!;
}
