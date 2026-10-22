import { CONTROL_TYPES, TOOLBOX_ORDER } from '../model/controls';
import { h } from '../ui98/dom';
import { placeControlCentered } from './designer';
import type { IdeState } from './ideState';
import { TOOLBOX_ICONS } from './icons/toolboxIcons';

export interface ToolboxLayout { docked: boolean; x: number; y: number; width: number }

const BTN = 24;
const GRID_PAD = 8;   // 4px padding on each side of the grid
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 6;
export const MIN_TOOLBOX_WIDTH = MIN_COLUMNS * BTN + GRID_PAD;
export const MAX_TOOLBOX_WIDTH = MAX_COLUMNS * BTN + GRID_PAD;
export const DEFAULT_TOOLBOX_LAYOUT: ToolboxLayout = { docked: true, x: 20, y: 20, width: 58 };
/** How much of a floating toolbox must stay inside the area (its title bar). */
const KEEP_H = 18;

/** Number of 24px tool columns that fit a toolbox of `width` px (2..6). */
export function columnsFor(width: number): number {
  const n = Math.floor((width - GRID_PAD) / BTN);
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Number.isFinite(n) ? n : MIN_COLUMNS));
}

/** Clamps width to 2..6 columns and a floating position into the area; an area of 0x0 (not laid out) is left unclamped. */
export function clampToolboxLayout(l: ToolboxLayout, area: { width: number; height: number }): ToolboxLayout {
  const width = Math.max(MIN_TOOLBOX_WIDTH, Math.min(MAX_TOOLBOX_WIDTH, Math.round(l.width) || DEFAULT_TOOLBOX_LAYOUT.width));
  let x = Number.isFinite(l.x) ? l.x : DEFAULT_TOOLBOX_LAYOUT.x;
  let y = Number.isFinite(l.y) ? l.y : DEFAULT_TOOLBOX_LAYOUT.y;
  if (area.width > 0 && area.height > 0) {
    x = Math.max(0, Math.min(area.width - width, x));
    y = Math.max(0, Math.min(area.height - KEEP_H, y));
  }
  return { docked: l.docked !== false, x: Math.round(x), y: Math.round(y), width };
}

export interface ToolboxWindow {
  getLayout(): ToolboxLayout;
  /** Applies a (possibly stale or hand-edited) layout, clamped; `persist` schedules a save. */
  setLayout(l: Partial<ToolboxLayout>, persist?: boolean): void;
  dock(): void;
  /** Runs a pending debounced save now. */
  flush(): void;
}

export interface ToolboxWindowOptions {
  pane: HTMLElement;
  /** The pane's title bar: drag to float, double-click to dock. */
  bar: HTMLElement;
  grid: HTMLElement;
  /** The IDE area the floating toolbox is confined to (the pane's offset parent). */
  area: HTMLElement;
  save?: (l: ToolboxLayout) => void;
  saveDelayMs?: number;
}

/** Makes the toolbox pane a dockable, draggable, edge-resizable tool window. */
export function attachToolboxWindow(o: ToolboxWindowOptions): ToolboxWindow {
  const { pane, bar, grid, area } = o;
  const doc = pane.ownerDocument;
  let cur: ToolboxLayout = { ...DEFAULT_TOOLBOX_LAYOUT };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounds = () => ({ width: area.clientWidth, height: area.clientHeight });

  const apply = () => {
    cur = clampToolboxLayout(cur, bounds());
    pane.classList.toggle('tbx98-floating', !cur.docked);
    pane.style.width = `${cur.width}px`;
    grid.style.gridTemplateColumns = `repeat(${columnsFor(cur.width)}, ${BTN}px)`;
    if (cur.docked) {
      pane.style.left = pane.style.top = pane.style.maxHeight = '';
    } else {
      pane.style.left = `${cur.x}px`;
      pane.style.top = `${cur.y}px`;
      pane.style.maxHeight = area.clientHeight > 0 ? `${area.clientHeight - cur.y}px` : '';
    }
  };
  const flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer); timer = undefined;
    o.save?.({ ...cur });
  };
  const persist = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, o.saveDelayMs ?? 300);
  };

  const track = (e: MouseEvent, move: (dx: number, dy: number) => void) => {
    const sx = e.clientX, sy = e.clientY;
    const onMove = (ev: MouseEvent) => move(ev.clientX - sx, ev.clientY - sy);
    const onUp = () => {
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('mouseup', onUp, true);
      persist();
    };
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('mouseup', onUp, true);
  };

  bar.addEventListener('mousedown', e => {
    if (e.button !== 0 || (e.target as Element).closest('.title-bar-controls')) return;
    e.preventDefault();
    const wasDocked = cur.docked;
    const pr = pane.getBoundingClientRect(), ar = area.getBoundingClientRect();
    const x0 = wasDocked ? pr.left - ar.left : cur.x, y0 = wasDocked ? pr.top - ar.top : cur.y;
    let moved = false;
    track(e, (dx, dy) => {
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;   // a plain click or double-click must not float it
      moved = true;
      cur = { ...cur, docked: false, x: x0 + dx, y: y0 + dy };
      apply();
    });
  });
  bar.addEventListener('dblclick', e => {
    if ((e.target as Element).closest('.title-bar-controls')) return;
    win.dock();
  });

  const edge = h('div', { class: 'tbx98-edge', title: 'Drag to resize' });
  pane.appendChild(edge);
  edge.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const w0 = cur.width;
    track(e, dx => { cur = { ...cur, width: w0 + dx }; apply(); });
  });
  doc.defaultView?.addEventListener('resize', apply);

  const win: ToolboxWindow = {
    getLayout: () => ({ ...cur }),
    setLayout(l, save = false) {
      cur = { ...cur, ...l };
      apply();
      if (save) persist();
    },
    dock() {
      if (cur.docked) return;
      cur = { ...cur, docked: true };
      apply(); persist();
    },
    flush,
  };
  apply();
  return win;
}

/** Tool buttons in a grid that reflows to the toolbox width (2..6 columns) and scrolls when too tall. Selecting a tool sets ide.currentTool (Pointer resets). */
export function createToolbox(host: HTMLElement, ide: IdeState): { refresh(): void; buttons: Map<string, HTMLElement> } {
  const buttons = new Map<string, HTMLElement>();
  const grid = h('div', { class: 'tbx98-grid' });
  for (const tool of TOOLBOX_ORDER) {
    const title = tool === 'Pointer' ? 'Pointer' : CONTROL_TYPES[tool].toolboxTooltip;
    const btn = h('div', { class: 'tbx98-btn', role: 'button', title, 'data-tool': tool });
    btn.innerHTML = TOOLBOX_ICONS[tool];
    btn.addEventListener('click', () => { if (ide.mode === 'design') ide.setTool(tool); });
    btn.addEventListener('dblclick', () => { if (ide.mode === 'design') placeControlCentered(ide, tool); });
    grid.appendChild(btn);
    buttons.set(tool, btn);
  }
  host.appendChild(grid);
  const refresh = () => { for (const [t, b] of buttons) b.classList.toggle('checked', t === ide.currentTool); };
  ide.on('tool', refresh);
  // Inert while a program runs or is in break mode
  const lock = () => { grid.classList.toggle('tbx98-locked', ide.mode !== 'design'); if (ide.mode !== 'design') ide.setTool('Pointer'); };
  ide.on('mode', lock);
  refresh();
  return { refresh, buttons };
}
