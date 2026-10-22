// Pure designer geometry (all values in twips). Containment follows parentId, never array position:
// FormDef.controls is a flat z-ordered list where a child may precede its parent; siblings later in the array are on top,
// and children of a container are above the container.
import { CONTROL_TYPES } from '../model/controls';
import { controlPos, dockedRect, isDocked, isLine } from '../model/geometry';
import { onCurrentTab } from '../model/ssTab';
import type { ControlDef, FormDef } from '../model/types';

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export interface Rect { left: number; top: number; width: number; height: number }
export interface SnapOpts { grid: number; snap: boolean; /** Defaults to `grid`. */ gridY?: number }
export type AlignHow = 'lefts' | 'centers' | 'rights' | 'tops' | 'middles' | 'bottoms';

export function snap(v: number, grid: number, enabled: boolean): number {
  return enabled && grid > 0 ? Math.round(v / grid) * grid : v;
}

export function computeResize(r: Rect, h: Handle, dx: number, dy: number, o: SnapOpts): Rect {
  const gx = o.grid, gy = o.gridY ?? o.grid;
  let left = r.left, top = r.top, right = r.left + r.width, bottom = r.top + r.height;
  if (h.includes('e')) right = Math.max(left + gx, snap(right + dx, gx, o.snap));
  if (h.includes('w')) left = Math.min(right - gx, snap(left + dx, gx, o.snap));
  if (h.includes('s')) bottom = Math.max(top + gy, snap(bottom + dy, gy, o.snap));
  if (h.includes('n')) top = Math.min(bottom - gy, snap(top + dy, gy, o.snap));
  return { left, top, width: right - left, height: bottom - top };
}

/** Snaps the first rect's new position to the grid; the others move by the same amount. */
export function computeMove(rects: Rect[], dx: number, dy: number, o: SnapOpts): Rect[] {
  if (!rects.length) return [];
  const ddx = snap(rects[0].left + dx, o.grid, o.snap) - rects[0].left;
  const ddy = snap(rects[0].top + dy, o.gridY ?? o.grid, o.snap) - rects[0].top;
  return rects.map(r => ({ ...r, left: r.left + ddx, top: r.top + ddy }));
}

const byId = (form: FormDef): Map<string, ControlDef> => new Map(form.controls.map(c => [c.id, c]));

/** Controls without Width/Height (Timer) have a fixed size from the registry. */
export function sizeOf(def: ControlDef): { width: number; height: number } {
  if (isLine(def)) return { width: Math.abs(Number(def.props.X2) - Number(def.props.X1)) || 0, height: Math.abs(Number(def.props.Y2) - Number(def.props.Y1)) || 0 };
  const td = CONTROL_TYPES[def.type];
  const w = def.props.Width, h = def.props.Height;
  return { width: typeof w === 'number' ? w : td.defaultWidth, height: typeof h === 'number' ? h : td.defaultHeight };
}
export function hasSize(def: ControlDef): boolean { return 'Width' in def.props; }

/** Position relative to the form's client area. */
export function absoluteRect(form: FormDef, id: string): Rect {
  const map = byId(form);
  let c = map.get(id);
  if (!c) return { left: 0, top: 0, width: 0, height: 0 };
  if (isDocked(c)) return dockedRect(form, c);   // a StatusBar sits at the bottom edge, full width
  const { width, height } = sizeOf(c);
  let left = 0, top = 0;
  const seen = new Set<string>();
  while (c && !seen.has(c.id)) {
    seen.add(c.id);
    const pos = controlPos(c);
    left += pos.left;
    top += pos.top;
    c = c.parentId ? map.get(c.parentId) : undefined;
  }
  return { left, top, width, height };
}

/** Distance in twips from a point to a Line's segment (form client coordinates). */
export function distanceToLine(form: FormDef, id: string, x: number, y: number): number {
  const c = form.controls.find(k => k.id === id);
  if (!c) return Infinity;
  const r = absoluteRect(form, id);
  const rightward = Number(c.props.X2) >= Number(c.props.X1), downward = Number(c.props.Y2) >= Number(c.props.Y1);
  const ax = rightward ? r.left : r.left + r.width, ay = downward ? r.top : r.top + r.height;
  const bx = rightward ? r.left + r.width : r.left, by = downward ? r.top + r.height : r.top;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}
const LINE_HIT = 60;   // twips (4 px) either side of a Line

const inside = (r: Rect, x: number, y: number): boolean => x >= r.left && y >= r.top && x < r.left + r.width && y < r.top + r.height;
const intersects = (a: Rect, b: Rect): boolean =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/** The direct children of `parentId` that are shown: an SSTab's children on its other tabs are left out. */
function childrenOf(form: FormDef, parentId: string | null): ControlDef[] {
  const map = byId(form);
  return form.controls.filter(c => (c.parentId !== null && map.has(c.parentId) ? c.parentId : null) === parentId
    && onCurrentTab(c, c.parentId ? map.get(c.parentId) : undefined));
}

/** False when the control or one of its ancestors sits on an SSTab tab that is not the current one. */
export function shownInDesign(form: FormDef, id: string): boolean {
  const map = byId(form);
  for (let c = map.get(id), n = 0; c && n < 64; c = c.parentId ? map.get(c.parentId) : undefined, n++) {
    if (!onCurrentTab(c, c.parentId ? map.get(c.parentId) : undefined)) return false;
  }
  return true;
}

/** The topmost control at (x, y) (form client coordinates), descending into containers. */
export function hitTest(form: FormDef, x: number, y: number): string | null {
  const walk = (parentId: string | null, depth: number): string | null => {
    if (depth > 64) return null;
    const kids = childrenOf(form, parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (isLine(k) ? distanceToLine(form, k.id, x, y) > Math.max(LINE_HIT, (Number(k.props.BorderWidth) || 1) * 8) : !inside(absoluteRect(form, k.id), x, y)) continue;
      return walk(k.id, depth + 1) ?? k.id;
    }
    return null;
  };
  return walk(null, 0);
}

/** Ids of the direct children of `parentId` (null = the form) that touch `r` (form client coordinates). */
export function controlsInRect(form: FormDef, r: Rect, parentId: string | null): string[] {
  return childrenOf(form, parentId).filter(c => intersects(absoluteRect(form, c.id), r)).map(c => c.id);
}

/** The innermost, topmost container (Frame/PictureBox) at the point that is not one of `exclude` or inside one. */
export function containerAt(form: FormDef, x: number, y: number, exclude: string[]): string | null {
  const ex = new Set(exclude);
  const walk = (parentId: string | null, depth: number): string | null => {
    if (depth > 64) return null;
    const kids = childrenOf(form, parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (ex.has(k.id) || !CONTROL_TYPES[k.type].isContainer || !inside(absoluteRect(form, k.id), x, y)) continue;
      return walk(k.id, depth + 1) ?? k.id;
    }
    return null;
  };
  return walk(null, 0);
}

/** Aligns to the last rect (the primary selection, as in VB6). */
export function alignRects(rects: Rect[], how: AlignHow): Rect[] {
  const p = rects[rects.length - 1];
  if (!p) return [];
  return rects.map(r => {
    switch (how) {
      case 'lefts': return { ...r, left: p.left };
      case 'rights': return { ...r, left: p.left + p.width - r.width };
      case 'centers': return { ...r, left: Math.round(p.left + (p.width - r.width) / 2) };
      case 'tops': return { ...r, top: p.top };
      case 'bottoms': return { ...r, top: p.top + p.height - r.height };
      case 'middles': return { ...r, top: Math.round(p.top + (p.height - r.height) / 2) };
    }
  });
}
