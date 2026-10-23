// Position helpers for controls whose geometry is not Left/Top/Width/Height: a Line is X1, Y1, X2, Y2.
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

/** The edge a control on the form docks to, full width (its Left, Top and Width are ignored): a StatusBar at the bottom, a Toolbar
 *  by its Align (vbAlignTop 1, the default; vbAlignBottom 2; vbAlignNone 0 leaves it where it is). */
export function dockEdge(c: Pick<ControlDef, 'type' | 'parentId' | 'props'>): 'top' | 'bottom' | null {
  if (c.parentId !== null) return null;
  if (c.type === 'StatusBar') return 'bottom';
  if (c.type !== 'Toolbar') return null;
  const a = typeof c.props?.Align === 'number' ? c.props.Align : 1;
  return a === 1 ? 'top' : a === 2 ? 'bottom' : null;
}
export const isDocked = (c: Pick<ControlDef, 'type' | 'parentId' | 'props'>): boolean => dockEdge(c) !== null;

/** The client area of a form in twips (Width/Height are the outer size; see formMetrics in controls/render.ts). */
export function formClientTwips(props: Record<string, PropValue>): { width: number; height: number } {
  const num = (k: string, d: number): number => (typeof props[k] === 'number' ? (props[k] as number) : d);
  const bs = num('BorderStyle', 2);
  const border = bs === 0 ? 0 : bs === 2 || bs === 5 ? 4 : 3, title = bs === 0 ? 0 : 18;
  const w = Math.round(num('Width', 4800) / 15), h = Math.round(num('Height', 3600) / 15);
  return { width: Math.max(0, w - 2 * border) * 15, height: Math.max(0, h - 2 * border - title) * 15 };
}

/** The rectangle a docked control really occupies, in client twips. */
export function dockedRect(form: { props: Record<string, PropValue> }, c: ControlDef): { left: number; top: number; width: number; height: number } {
  const cl = formClientTwips(form.props);
  const height = typeof c.props.Height === 'number' ? c.props.Height : 315;
  return { left: 0, top: dockEdge(c) === 'top' ? 0 : Math.max(0, cl.height - height), width: cl.width, height };
}
