// Position helpers for controls whose geometry is not Left/Top/Width/Height: a Line is X1, Y1, X2, Y2.
import type { ControlDef } from './types';

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
