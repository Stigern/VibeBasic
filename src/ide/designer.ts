// The interactive form designer: an MDI window around a design-mode FormSurface plus a selection overlay.
// Pointer gestures preview with ghost outlines and commit ONE command on release; the surface follows the model
// through 'project' events (so undo/redo and the Properties window need no special handling here).
import { formMetrics, renderFormSurface, type FormSurface } from '../controls/render';
import {
  addAssetCmd, addControlsCmd, compositeCmd, deleteControlsCmd, moveResizeCmd, renameCmd, reparentCmd, setPropertyCmd, zOrderCmd, type Command,
} from '../model/commands';
import { addComponentsCmd } from '../model/components';
import { CONTROL_TYPES, newControl, nextDefaultName, newId } from '../model/controls';
import { ssTabAt, ssTabLayout } from '../model/ssTab';
import { controlPos, isLine, setControlPos } from '../model/geometry';
import { pxToTwips, twipsToPx } from '../model/twips';
import type { Asset, ControlDef, ControlType, FormDef, PropValue } from '../model/types';
import { controlAssetIds } from '../model/assetRefs';
import { messageBox98, vbYes } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { createMdiWindow, type MdiWindow } from '../ui98/mdiWindow';
import { clipboardHasControls, getClipboard, getClipboardAssets, setClipboard } from './clipboard';
import {
  absoluteRect, alignRects, computeMove, snap, computeResize, containerAt, controlsInRect, hasSize, hitTest, shownInDesign, sizeOf,
  type AlignHow, type Handle, type Rect, type SnapOpts,
} from './designerLogic';
import type { IdeState } from './ideState';
import type { IdeActions } from './menus';
import './designer.css';

export interface DesignerEnv { mdiHost: HTMLElement; actions?: IdeActions }
interface Designer { win: MdiWindow; formId: string; placeCentered(tool: ControlType): void; focus(): void }

/** Window frame around the body (borders + title bar) and the margin that keeps the form's own handles visible. */
const MDI_CHROME_W = 8, MDI_CHROME_H = 30, STAGE_PAD = 6, DRAG_THRESHOLD = 3, VB_YESNO = 4, VB_QUESTION = 32;
const designers = new WeakMap<IdeState, Map<string, Designer>>();
const registryOf = (ide: IdeState): Map<string, Designer> => {
  let m = designers.get(ide);
  if (!m) designers.set(ide, m = new Map());
  return m;
};

const formOf = (ide: IdeState, id: string): FormDef | undefined => ide.project.forms.find(f => f.id === id);
const snapOpts = (ide: IdeState): SnapOpts => ({ grid: ide.options.gridWidth, gridY: ide.options.gridHeight, snap: ide.options.alignToGrid });
const isEditable = (t: EventTarget | null): boolean => {
  const e = t as HTMLElement | null;
  return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName ?? ''));
};
const relRect = (c: ControlDef): Rect => ({ ...controlPos(c), ...sizeOf(c) });

/** The SSTab tab a control placed in `parentId` goes on (its current tab), or undefined when the parent is not an SSTab. */
export function tabFor(form: FormDef, parentId: string | null): number | undefined {
  const p = parentId ? form.controls.find(c => c.id === parentId) : undefined;
  return p?.type === 'SSTab' ? Number(p.props.Tab) || 0 : undefined;
}

/** Selected ids that still exist, minus those whose ancestor is also selected (the ancestor carries them). */
function topLevelOf(form: FormDef, ids: string[]): string[] {
  const set = new Set(ids), map = new Map(form.controls.map(c => [c.id, c]));
  return ids.filter(id => {
    for (let p = map.get(id)?.parentId, n = 0; p && n < 64; p = map.get(p)?.parentId, n++) if (set.has(p)) return false;
    return map.has(id);
  });
}

export function placeControlCentered(ide: IdeState, tool: ControlType | 'Pointer'): void {
  if (ide.mode !== 'design') return;
  if (tool === 'Pointer' || ide.activeView.kind !== 'designer') return;
  registryOf(ide).get(ide.activeView.formId)?.placeCentered(tool);
}

export function openDesigner(ide: IdeState, formId: string, env: DesignerEnv): MdiWindow {
  const reg = registryOf(ide);
  const existing = reg.get(formId);
  if (existing) {
    existing.win.activate();
    ide.setActiveView({ kind: 'designer', formId });
    existing.focus();   // keyboard focus follows the active view (Edit commands check it)
    return existing.win;
  }
  const form0 = formOf(ide, formId);
  if (!form0) throw new Error(`Form not found: ${formId}`);
  const getForm = (): FormDef | undefined => formOf(ide, formId);
  const assets = (ref: { asset: string }): string | null => {
    const a = ide.project.assets[ref.asset];
    return a ? `data:${a.mime};base64,${a.dataBase64}` : null;
  };
  const grid = () => ({ showGrid: ide.options.showGrid, gridX: ide.options.gridWidth, gridY: ide.options.gridHeight });
  const surface: FormSurface = renderFormSurface(structuredClone(form0), 'design', assets, grid());
  const stage = h('div', { class: 'dsg-stage', tabindex: '0' });
  const overlay = h('div', { class: 'dsg-overlay' });
  stage.append(surface.el, overlay);
  const title = () => `${ide.project.name} - ${getForm()?.name ?? ''} (Form)`;
  const open = reg.size;
  const win = createMdiWindow(env.mdiHost, { title: title(), x: 20 + 24 * open, y: 20 + 24 * open, width: 0, height: 0, resizable: true });
  win.body.appendChild(stage);
  let closed = false;

  const layoutStage = () => {
    const m = formMetrics(getForm()?.props ?? {});
    stage.style.width = `${m.outerWidth + STAGE_PAD}px`;
    stage.style.height = `${m.outerHeight + STAGE_PAD}px`;
  };
  layoutStage();
  {
    const m = formMetrics(form0.props);
    win.el.style.width = `${m.outerWidth + STAGE_PAD + MDI_CHROME_W}px`;
    win.el.style.height = `${m.outerHeight + STAGE_PAD + MDI_CHROME_H}px`;
  }

  // ---- model -> surface sync ----------------------------------------------------------------------------------
  const snapshot = (c: ControlDef) => JSON.stringify(c.props);
  let lastForm = JSON.stringify(form0.props);
  const last = new Map(form0.controls.map(c => [c.id, { json: snapshot(c), props: structuredClone(c.props), name: c.name }]));
  const structOf = (cs: ControlDef[]) => cs.map(c => `${c.id}:${c.parentId}:${c.tab ?? ''}`).join('|');
  let lastStruct = structOf(form0.controls);
  const dflt = (type: ControlType, k: string): PropValue =>
    CONTROL_TYPES[type].props.find(p => p.name === k)?.default ?? null;
  const diff = (type: ControlType, a: Record<string, PropValue>, b: Record<string, PropValue>): Record<string, PropValue> => {
    const out: Record<string, PropValue> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = structuredClone(k in b ? b[k] : dflt(type, k));
    }
    return out;
  };
  function sync(): void {
    if (closed) return;
    const form = getForm();
    if (!form) { win.close(); return; }
    win.setTitle(title());
    const cur = new Set(form.controls.map(c => c.id));
    for (const id of [...last.keys()]) if (!cur.has(id)) { surface.removeControl(id); last.delete(id); }
    form.controls.forEach((c, i) => {
      const prev = last.get(c.id);
      if (!prev) { surface.addControl(structuredClone(c), i); }
      else {
        if (prev.name !== c.name) surface.rename(c.id, c.name);   // a Toolbar finds its ImageList by name
        if (prev.json !== snapshot(c)) { const d = diff(c.type, prev.props, c.props); if (Object.keys(d).length) surface.update(c.id, d); }
      }
      last.set(c.id, { json: snapshot(c), props: structuredClone(c.props), name: c.name });
    });
    const struct = structOf(form.controls);
    if (struct !== lastStruct) { surface.reorder(structuredClone(form.controls)); lastStruct = struct; }
    const fj = JSON.stringify(form.props);
    if (fj !== lastForm) {
      surface.update('form', diff('Form', JSON.parse(lastForm), form.props));
      lastForm = fj;
      layoutStage();
    }
    if (ide.selection?.formId === formId) {
      const ids = ide.selection.ids.filter(i => cur.has(i));
      if (ids.length !== ide.selection.ids.length) { ide.setSelection({ formId, ids }); return; }
    }
    drawOverlay();
  }

  // ---- selection ----------------------------------------------------------------------------------------------
  const selectedIds = (): string[] => (ide.selection?.formId === formId ? ide.selection.ids : []);
  const select = (ids: string[]) => ide.setSelection({ formId, ids });
  const activate = () => {
    if (ide.activeView.kind !== 'designer' || ide.activeView.formId !== formId) ide.setActiveView({ kind: 'designer', formId });
    if (ide.selection?.formId !== formId) select([]);
  };
  const origin = () => {
    const m = formMetrics(getForm()?.props ?? {});
    return { x: m.border, y: m.border + m.titleHeight, m };
  };

  // ---- overlay ------------------------------------------------------------------------------------------------
  let ghosts: Rect[] | null = null;   // preview rects in form client twips, or form outer rect when `ghostForm`
  let ghostForm = false;
  const HANDLES: Handle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  const CURSORS: Record<Handle, string> = { n: 'ns', s: 'ns', e: 'ew', w: 'ew', ne: 'nesw', sw: 'nesw', nw: 'nwse', se: 'nwse' };
  function drawOverlay(): void {
    overlay.textContent = '';
    const form = getForm();
    if (!form || closed) return;
    const o = origin();
    const box = (cls: string, x: number, y: number, w: number, hh: number) =>
      overlay.appendChild(h('div', { class: cls, style: { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` } }));
    if (ghosts) {
      for (const g of ghosts) {
        if (ghostForm) box('dsg-ghost', 0, 0, twipsToPx(g.width), twipsToPx(g.height));
        else box('dsg-ghost', o.x + twipsToPx(g.left), o.y + twipsToPx(g.top), twipsToPx(g.width), twipsToPx(g.height));
      }
      return;
    }
    if (ide.selection?.formId !== formId) return;
    const handle = (hd: Handle, cx: number, cy: number, cls: string, id: string) =>
      overlay.appendChild(h('div', {
        class: `dsg-h ${cls}`, 'data-handle': hd, 'data-id': id,
        style: { left: `${cx - 3}px`, top: `${cy - 3}px`, cursor: `${CURSORS[hd]}-resize` },
      }));
    const ids = selectedIds();
    if (!ids.length) {   // the form: right, bottom and corner handles
      const w = o.m.outerWidth, hh = o.m.outerHeight;
      handle('e', w, hh / 2, 'filled', 'form'); handle('s', w / 2, hh, 'filled', 'form'); handle('se', w, hh, 'filled', 'form');
      return;
    }
    const primary = ids[ids.length - 1];
    for (const id of ids) {
      const c = form.controls.find(x => x.id === id);
      if (!c || !shownInDesign(form, id)) continue;   // on another SSTab tab
      const r = absoluteRect(form, id);
      if (isLine(c)) {   // a Line has two end point handles instead of a box and eight resize handles
        const right = Number(c.props.X2) >= Number(c.props.X1), down = Number(c.props.Y2) >= Number(c.props.Y1);
        const filledL = ids.length === 1 || id === primary ? 'filled' : 'hollow';
        const end = (which: 'p1' | 'p2', first: boolean) => {
          const atRight = first ? right : !right, atDown = first ? down : !down;
          const cx = o.x + twipsToPx(r.left + (atRight ? r.width : 0)), cy = o.y + twipsToPx(r.top + (atDown ? r.height : 0));
          overlay.appendChild(h('div', {
            class: `dsg-h ${filledL}`, 'data-handle': which, 'data-id': id,
            style: { left: `${cx - 3}px`, top: `${cy - 3}px`, cursor: 'crosshair' },
          }));
        };
        // p1 is (X1, Y1): at the box's top-left when X2 >= X1 and Y2 >= Y1, mirrored otherwise
        end('p1', false); end('p2', true);
        continue;
      }
      const x = o.x + twipsToPx(r.left), y = o.y + twipsToPx(r.top), w = twipsToPx(r.width), hh = twipsToPx(r.height);
      box('dsg-sel', x, y, w, hh);
      if (!hasSize(c)) continue;   // Timer: fixed size
      const filled = ids.length === 1 || id === primary ? 'filled' : 'hollow';
      const xs = { w: x, e: x + w, c: x + w / 2 }, ys = { n: y, s: y + hh, c: y + hh / 2 };
      for (const hd of HANDLES) {
        handle(hd, hd.includes('w') ? xs.w : hd.includes('e') ? xs.e : xs.c, hd.includes('n') ? ys.n : hd.includes('s') ? ys.s : ys.c, filled, id);
      }
    }
  }

  // ---- pointer gestures ---------------------------------------------------------------------------------------
  const toTwips = (e: MouseEvent) => {
    const r = surface.clientEl.getBoundingClientRect();
    return { x: pxToTwips(e.clientX - r.left), y: pxToTwips(e.clientY - r.top) };
  };
  const doc = stage.ownerDocument;
  let cancel: (() => void) | null = null;
  /** Runs a drag: `move` gets the total pixel delta and the event; `up(moved)` commits. Escape cancels. */
  function track(e: MouseEvent, move: (dx: number, dy: number, ev: MouseEvent) => void, up: (moved: boolean, ev: MouseEvent) => void): void {
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const end = () => {
      doc.removeEventListener('pointermove', onMove, true);
      doc.removeEventListener('pointerup', onUp, true);
      doc.removeEventListener('pointercancel', onCancel, true);
      doc.removeEventListener('keydown', onKey, true);
      cancel = null;
      ghosts = null; ghostForm = false;
    };
    const onMove = (ev: Event) => {
      const m = ev as MouseEvent;
      if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < DRAG_THRESHOLD) return;
      moved = true;
      move(m.clientX - sx, m.clientY - sy, m);
      drawOverlay();
    };
    const onUp = (ev: Event) => { end(); up(moved, ev as MouseEvent); drawOverlay(); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { end(); drawOverlay(); } };
    const onCancel = () => { end(); drawOverlay(); };
    cancel = () => { end(); drawOverlay(); };
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onCancel, true);
    doc.addEventListener('keydown', onKey, true);
  }

  function startDraw(e: MouseEvent, tool: Exclude<ControlType, 'Form'>, form: FormDef): void {
    const p0 = toTwips(e), so = snapOpts(ide);
    const sx = (v: number) => Math.round(v / so.grid) * so.grid, sy = (v: number) => Math.round(v / (so.gridY ?? so.grid)) * (so.gridY ?? so.grid);
    const rectFor = (p: { x: number; y: number }, moved: boolean): Rect => {
      const x0 = so.snap ? sx(p0.x) : p0.x, y0 = so.snap ? sy(p0.y) : p0.y;
      const x1 = so.snap ? sx(p.x) : p.x, y1 = so.snap ? sy(p.y) : p.y;
      const w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
      if (!moved || !w || !hh) return { left: x0, top: y0, width: CONTROL_TYPES[tool].defaultWidth, height: CONTROL_TYPES[tool].defaultHeight };
      return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: w, height: hh };
    };
    const lineRect = (p: { x: number; y: number }): Rect => {
      const a = { x: so.snap ? sx(p0.x) : p0.x, y: so.snap ? sy(p0.y) : p0.y }, b = { x: so.snap ? sx(p.x) : p.x, y: so.snap ? sy(p.y) : p.y };
      return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    };
    track(e, (_dx, _dy, ev) => { ghosts = [tool === 'Line' ? lineRect(toTwips(ev)) : rectFor(toTwips(ev), true)]; },
      (moved, ev) => {
        const r = rectFor(toTwips(ev), moved);
        const parentId = containerAt(form, p0.x, p0.y, []);
        const po = parentId ? absoluteRect(form, parentId) : { left: 0, top: 0 };
        const def = newControl(form, tool, { left: r.left - po.left, top: r.top - po.top, width: r.width, height: r.height }, parentId);
        const tab = tabFor(form, parentId);
        if (tab !== undefined) def.tab = tab;   // onto the SSTab's current tab
        if (tool === 'Line' && moved) {   // the line runs from where the drag began to where it ended
          const q = toTwips(ev);
          const pt = (v: number, g: number) => (so.snap ? Math.round(v / g) * g : v);
          Object.assign(def.props, { X1: pt(p0.x, so.grid) - po.left, Y1: pt(p0.y, so.gridY ?? so.grid) - po.top,
            X2: pt(q.x, so.grid) - po.left, Y2: pt(q.y, so.gridY ?? so.grid) - po.top });
        }
        ide.stack.execute(addControlsCmd(formId, [def]));
        select([def.id]);
        ide.setTool('Pointer');
      });
  }

  function startMove(e: MouseEvent, form: FormDef, primaryId: string): void {
    const ids = topLevelOf(form, selectedIds());
    const movable = [primaryId, ...ids.filter(i => i !== primaryId)].filter(i => ids.includes(i));
    if (!movable.length) return;
    const orig = movable.map(id => ({ id, abs: absoluteRect(form, id), parentId: form.controls.find(c => c.id === id)!.parentId }));
    let result: { parentId: string | null; rects: Rect[] } | null = null;
    track(e, (dx, dy, ev) => {
      const p = toTwips(ev);
      const parentId = containerAt(form, p.x, p.y, movable);
      const po = parentId ? absoluteRect(form, parentId) : { left: 0, top: 0 };
      const rel = orig.map(o => ({ ...o.abs, left: o.abs.left - po.left, top: o.abs.top - po.top }));
      const rects = computeMove(rel, pxToTwips(dx), pxToTwips(dy), snapOpts(ide));
      result = { parentId, rects };
      ghosts = rects.map(r => ({ ...r, left: r.left + po.left, top: r.top + po.top }));
    }, moved => {
      if (!moved || !result) return;
      const { parentId, rects } = result as { parentId: string | null; rects: Rect[] };
      const sameParent = orig.every(o => o.parentId === parentId);
      const unchanged = sameParent && orig.every((o, i) => {
        const c = form.controls.find(x => x.id === o.id)!;
        return controlPos(c).left === rects[i].left && controlPos(c).top === rects[i].top;
      });
      if (unchanged) return;
      ide.stack.execute(sameParent
        ? moveResizeCmd(formId, orig.map((o, i) => ({ id: o.id, ...rects[i] })))
        : reparentCmd(formId, orig.map((o, i) => ({ id: o.id, parentId, left: rects[i].left, top: rects[i].top, tab: tabFor(form, parentId) }))));
    });
  }

  /** Resizes every selected sized control by what the primary's handle did. */
  function resizedRects(form: FormDef, hd: Handle, primaryId: string, dx: number, dy: number): { id: string; rect: Rect }[] {
    const so = snapOpts(ide);
    const ids = topLevelOf(form, selectedIds()).filter(i => hasSize(form.controls.find(c => c.id === i)!));
    const prim = form.controls.find(c => c.id === primaryId)!;
    const pr = relRect(prim), nr = computeResize(pr, hd, dx, dy, so);
    return ids.map(id => {
      const r = relRect(form.controls.find(c => c.id === id)!);
      if (id === primaryId) return { id, rect: nr };
      return { id, rect: {
        left: r.left + nr.left - pr.left, top: r.top + nr.top - pr.top,
        width: Math.max(so.grid, r.width + nr.width - pr.width), height: Math.max(so.gridY ?? so.grid, r.height + nr.height - pr.height) } };
    });
  }

  function startResize(e: MouseEvent, form: FormDef, hd: Handle, id: string): void {
    if (ide.controlsLocked && id !== 'form') return;
    if (id === 'form') {
      const fr: Rect = { left: 0, top: 0, width: Number(form.props.Width) || 0, height: Number(form.props.Height) || 0 };
      let nr = fr;
      track(e, (dx, dy) => {
        nr = computeResize(fr, hd, pxToTwips(dx), pxToTwips(dy), snapOpts(ide));
        ghosts = [nr]; ghostForm = true;
      }, moved => {
        if (!moved) return;
        const cmds: Command[] = [];
        if (nr.width !== fr.width) cmds.push(setPropertyCmd(formId, 'form', 'Width', nr.width));
        if (nr.height !== fr.height) cmds.push(setPropertyCmd(formId, 'form', 'Height', nr.height));
        if (cmds.length) ide.stack.execute(cmds.length === 1 ? cmds[0] : compositeCmd('Resize form', cmds));
      });
      return;
    }
    let res: { id: string; rect: Rect }[] = [];
    track(e, (dx, dy) => {
      res = resizedRects(form, hd, id, pxToTwips(dx), pxToTwips(dy));
      ghosts = res.map(r => {
        const a = absoluteRect(form, r.id), c = relRect(form.controls.find(x => x.id === r.id)!);
        return { ...r.rect, left: r.rect.left + a.left - c.left, top: r.rect.top + a.top - c.top };
      });
    }, moved => { if (moved && res.length) ide.stack.execute(moveResizeCmd(formId, res.map(r => ({ id: r.id, ...r.rect })))); });
  }

  /** Drags one end point (p1 = X1/Y1, p2 = X2/Y2) of a Line. */
  function startLineEnd(e: MouseEvent, form: FormDef, id: string, which: 'p1' | 'p2'): void {
    if (ide.controlsLocked) return;
    const c = form.controls.find(x => x.id === id);
    if (!c) return;
    const kx = which === 'p1' ? 'X1' : 'X2', ky = which === 'p1' ? 'Y1' : 'Y2';
    const parentId = c.parentId;
    const po = parentId ? absoluteRect(form, parentId) : { left: 0, top: 0 };
    const so = snapOpts(ide);
    let to: { x: number; y: number } | null = null;
    const bbox = (pt: { x: number; y: number }): Rect => {
      const ox = Number(c.props[which === 'p1' ? 'X2' : 'X1']), oy = Number(c.props[which === 'p1' ? 'Y2' : 'Y1']);
      return { left: po.left + Math.min(ox, pt.x), top: po.top + Math.min(oy, pt.y), width: Math.abs(pt.x - ox), height: Math.abs(pt.y - oy) };
    };
    const from = { x: Number(c.props[kx]), y: Number(c.props[ky]) };
    track(e, (dx, dy) => {
      to = { x: snap(from.x + pxToTwips(dx), so.grid, so.snap), y: snap(from.y + pxToTwips(dy), so.gridY ?? so.grid, so.snap) };
      ghosts = [bbox(to)];
    }, moved => {
      if (!moved || !to) return;
      ide.stack.execute(compositeCmd('Move line end', [setPropertyCmd(formId, id, kx, to.x), setPropertyCmd(formId, id, ky, to.y)]));
    });
  }

  function startBand(e: MouseEvent, form: FormDef): void {
    const p0 = toTwips(e);
    const rectOf = (ev: MouseEvent): Rect => {
      const p = toTwips(ev);
      return { left: Math.min(p0.x, p.x), top: Math.min(p0.y, p.y), width: Math.abs(p.x - p0.x), height: Math.abs(p.y - p0.y) };
    };
    track(e, (_dx, _dy, ev) => { ghosts = [rectOf(ev)]; },
      (moved, ev) => select(moved ? controlsInRect(form, rectOf(ev), null) : []));
  }

  stage.addEventListener('pointerdown', ev => {
    const e = ev as PointerEvent;
    if (e.button !== 0) return;
    win.activate();   // preventDefault below suppresses the mousedown that normally raises the window
    if (ide.mode !== 'design' || cancel) return;
    const form = getForm();
    if (!form) return;
    stage.focus({ preventScroll: true });
    activate();
    const tgt = e.target as Element;
    const hEl = tgt.closest?.('[data-handle]') as HTMLElement | null;
    if (hEl) {
      e.preventDefault();
      const hd = hEl.dataset.handle as string;
      if (hd === 'p1' || hd === 'p2') startLineEnd(e, form, hEl.dataset.id ?? '', hd);
      else startResize(e, form, hd as Handle, hEl.dataset.id ?? '');
      return;
    }
    const p = toTwips(e), m = origin().m;
    const inClient = p.x >= 0 && p.y >= 0 && p.x < pxToTwips(m.clientWidth) && p.y < pxToTwips(m.clientHeight);
    if (!inClient) { select([]); return; }
    e.preventDefault();
    if (ide.currentTool !== 'Pointer') { startDraw(e, ide.currentTool as Exclude<ControlType, 'Form'>, form); return; }
    const hit = hitTest(form, p.x, p.y);
    if (!hit) { startBand(e, form); return; }
    const hitDef = form.controls.find(c => c.id === hit);
    if (hitDef?.type === 'SSTab') {   // a click on another tab's header shows that tab (the Tab property)
      const a = absoluteRect(form, hit), t = ssTabAt(hitDef.props, p.x - a.left, p.y - a.top);
      if (t !== null && t !== Number(hitDef.props.Tab)) ide.stack.execute(setPropertyCmd(formId, hit, 'Tab', t));
    }
    const ids = selectedIds();
    const parentOf = (id: string) => form.controls.find(c => c.id === id)?.parentId ?? null;
    if (e.ctrlKey || e.shiftKey || e.metaKey) {
      select(ids.includes(hit) ? ids.filter(i => i !== hit)
        : [...ids.filter(i => parentOf(i) === parentOf(hit)), hit]);
      return;
    }
    if (!ids.includes(hit)) select([hit]);
    else if (ids[ids.length - 1] !== hit) select([...ids.filter(i => i !== hit), hit]);
    if (!ide.controlsLocked) startMove(e, form, hit);
  });

  stage.addEventListener('dblclick', ev => {
    const form = getForm();
    if (!form || ide.mode !== 'design' || (ev.target as Element).closest?.('[data-handle]')) return;
    const p = toTwips(ev as MouseEvent), hit = hitTest(form, p.x, p.y);
    const c = hit ? form.controls.find(x => x.id === hit) : undefined;
    if (hit) select([hit]);
    env.actions?.viewCode?.(form.id, c ? c.name : 'Form', CONTROL_TYPES[c ? c.type : 'Form'].defaultEvent);
  });

  stage.addEventListener('keydown', ev => {
    const form = getForm();
    if (!form || ide.mode !== 'design' || isEditable(ev.target) || ide.controlsLocked) return;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (!dir || (!ctrl && !ev.shiftKey)) return;
    const ids = topLevelOf(form, selectedIds());
    if (!ids.length) return;
    ev.preventDefault();
    const so = snapOpts(ide), gy = so.gridY ?? so.grid;
    const defs = ids.map(i => form.controls.find(c => c.id === i)!);
    if (ctrl) {
      ide.stack.execute(moveResizeCmd(formId, defs.map(c => {
        const r = relRect(c);
        return { id: c.id, ...r, left: r.left + dir[0] * so.grid, top: r.top + dir[1] * gy };
      })));
    } else {
      const sized = defs.filter(hasSize);
      if (!sized.length) return;
      ide.stack.execute(moveResizeCmd(formId, sized.map(c => {
        const r = relRect(c);
        return { id: c.id, ...r, width: Math.max(so.grid, r.width + dir[0] * so.grid), height: Math.max(gy, r.height + dir[1] * gy) };
      })));
    }
  });

  /** Double-click in the Toolbox: centred on the current tab of the one selected SSTab, else on the form. */
  const placeCentered = (tool: ControlType) => {
    const form = getForm();
    if (!form || tool === 'Form') return;
    const td = CONTROL_TYPES[tool], m = formMetrics(form.props), so = snapOpts(ide);
    const sel = selectedIds(), host = sel.length === 1 ? form.controls.find(c => c.id === sel[0]) : undefined;
    const parent = host?.type === 'SSTab' ? host : undefined;
    const area = parent ? sizeOf(parent) : { width: pxToTwips(m.clientWidth), height: pxToTwips(m.clientHeight) };
    const snapv = (v: number, g: number) => (so.snap ? Math.round(v / g) * g : v);
    const bodyTop = parent?.type === 'SSTab' ? ssTabLayout(parent.props).bodyTop : 0;
    // a control larger than the form (WebBrowser, MediaPlayer on a small form) shrinks to fit instead of starting off-form
    const fits = tool !== 'Line' && td.defaultWidth > 0;
    const width = fits ? Math.min(td.defaultWidth, Math.max(so.grid, area.width)) : td.defaultWidth;
    const height = fits ? Math.min(td.defaultHeight, Math.max(so.gridY ?? so.grid, area.height - bodyTop)) : td.defaultHeight;
    const left = Math.max(0, snapv((area.width - width) / 2, so.grid));
    const top = Math.max(bodyTop, snapv(bodyTop + (area.height - bodyTop - height) / 2, so.gridY ?? so.grid));
    const def = newControl(form, tool, fits ? { left, top, width, height } : { left, top }, parent?.id ?? null);
    const tab = tabFor(form, parent?.id ?? null);
    if (tab !== undefined) def.tab = tab;
    ide.stack.execute(addControlsCmd(formId, [def]));
    select([def.id]);
    ide.setTool('Pointer');
  };

  // ---- wiring -------------------------------------------------------------------------------------------------
  const isActive = () => ide.activeView.kind === 'designer' && ide.activeView.formId === formId;
  const unsubs = [
    ide.on('project', sync),
    ide.on('closeWindows', () => { if (!closed) win.close(); }),
    ide.on('selection', () => { if (!closed) drawOverlay(); }),
    ide.on('activeView', () => { if (!closed) surface.setActive(isActive()); }),
    ide.on('options', () => { if (!closed) surface.setGrid(grid()); }),
    ide.on('tool', () => { if (!closed) stage.classList.toggle('dsg-draw', ide.currentTool !== 'Pointer'); }),
  ];
  win.el.addEventListener('mousedown', activate, true);
  win.onClose = () => {
    cancel?.();
    closed = true;
    unsubs.forEach(u => u());
    reg.delete(formId);
    if (isActive()) ide.setActiveView({ kind: 'none' });
    if (!getForm() && ide.selection?.formId === formId) ide.setSelection(null);
    return true;
  };
  reg.set(formId, { win, formId, placeCentered, focus: () => stage.focus({ preventScroll: true }) });
  win.activate();
  activate();
  stage.focus({ preventScroll: true });
  drawOverlay();
  return win;
}

// ---------------------------------------------------------------------------------------------------------------
// Paste

/** Pastes copies of `defs` into the form, or into the container `parentId` (an SSTab: onto its current tab): new ids,
 *  top-level controls (those whose parent is not in `defs`) with their group's top-left corner at (0,0) (in an SSTab just
 *  under its tabs). A name that already exists asks whether to create a control array. Components the controls need are checked.
 *  Pictures the controls name that the project lacks are added from `assets` (copied along). Pasted controls come last in the
 *  tab order (VB6). */
export async function pasteControls(ide: IdeState, formId: string, defs: ControlDef[], parentId: string | null = null,
  assets: Record<string, Asset> = {}): Promise<void> {
  const form = formOf(ide, formId);
  if (!form || !defs.length) return;
  const container = parentId ? form.controls.find(c => c.id === parentId) : undefined;
  if (parentId && !container) parentId = null;
  const tab = tabFor(form, parentId);
  const offsetTop = container?.type === 'SSTab' ? ssTabLayout(container.props).bodyTop : 0;
  const idMap = new Map(defs.map(d => [d.id, newId()]));
  const top = defs.filter(d => !d.parentId || !idMap.has(d.parentId));
  const minL = Math.min(...top.map(d => controlPos(d).left)), minT = Math.min(...top.map(d => controlPos(d).top));
  const work: ControlDef[] = form.controls.map(c => ({ ...c }));
  const renames: Command[] = [];
  const answers = new Map<string, boolean>();
  const fresh: ControlDef[] = [];
  let nextTab = form.controls.reduce((m, c) => (typeof c.props.TabIndex === 'number' ? Math.max(m, c.props.TabIndex + 1) : m), 0);
  const lowestFree = (name: string): number => {
    const used = new Set(work.filter(w => w.name.toLowerCase() === name.toLowerCase()).map(w => w.index));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  };
  for (const d of defs) {
    const nd: ControlDef = structuredClone(d);
    nd.id = idMap.get(d.id)!;
    nd.parentId = d.parentId && idMap.has(d.parentId) ? idMap.get(d.parentId)! : parentId;
    if (top.includes(d)) {
      const q = controlPos(d);
      setControlPos(nd, q.left - minL, q.top - minT + offsetTop);
      if (tab !== undefined) nd.tab = tab; else delete nd.tab;
    }
    if (typeof nd.props.TabIndex === 'number') nd.props.TabIndex = nextTab++;
    const same = work.filter(w => w.name.toLowerCase() === d.name.toLowerCase());
    const fresh_ = () => { nd.name = nextDefaultName({ ...form, controls: work }, d.type); nd.index = null; };
    if (same.length) {
      const sameType = same[0].type === d.type, isArray = same.some(s => s.index !== null);
      let join = sameType && isArray;
      if (sameType && !isArray) {
        const key = d.name.toLowerCase();
        if (!answers.has(key)) {
          const r = await messageBox98(document, {
            prompt: `You already have a control named '${same[0].name}'. Do you want to create a control array?`,
            title: 'VibeBasic', buttons: VB_YESNO | VB_QUESTION,
          });
          answers.set(key, r === vbYes);
          if (r === vbYes) { renames.push(renameCmd(formId, same[0].id, same[0].name, 0)); same[0].index = 0; }
        }
        join = answers.get(key) === true;
      }
      if (join) { nd.name = same[0].name; nd.index = lowestFree(nd.name); } else fresh_();
    }
    work.push(nd);
    fresh.push(nd);
  }
  const add = addControlsCmd(formId, fresh);
  const comps = addComponentsCmd(ide.project, fresh.map(d => d.type));   // controls copied from a project with other components
  const missing = [...new Set(fresh.flatMap(controlAssetIds))].filter(a => !(a in ide.project.assets) && a in assets);
  const pre = [...(comps ? [comps] : []), ...missing.map(a => addAssetCmd(a, assets[a])), ...renames];
  ide.stack.execute(pre.length ? compositeCmd('Paste', [...pre, add]) : add);
  ide.setSelection({ formId, ids: top.map(d => idMap.get(d.id)!) });
}

// ---------------------------------------------------------------------------------------------------------------
// IDE actions (Edit and Format menus)

export function registerDesignerActions(ide: IdeState, actions: IdeActions, refresh: () => void = () => {}): void {
  /** Edit actions only act when focus is in a designer window or nowhere (menu / toolbar clicks leave it on body). */
  const focusOk = () => {
    const a = document.activeElement;
    return !a || a === document.body || !!a.closest('.dsg-stage');
  };
  const ctx = (): { form: FormDef; ids: string[] } | null => {
    if (!focusOk()) return null;
    if (ide.mode !== 'design' || ide.activeView.kind !== 'designer') return null;
    const form = formOf(ide, ide.activeView.formId);
    if (!form || ide.selection?.formId !== form.id) return null;
    return { form, ids: ide.selection.ids.filter(i => form.controls.some(c => c.id === i)) };
  };
  const withIds = (min: number, f: (form: FormDef, ids: string[]) => void) => () => {
    const c = ctx();
    if (c && c.ids.length >= min) f(c.form, c.ids);
  };
  const copy = (form: FormDef, ids: string[]) => {
    const tops = topLevelOf(form, ids);
    const all = new Set(tops);
    for (let grew = true; grew;) {
      grew = false;
      for (const c of form.controls) if (c.parentId && all.has(c.parentId) && !all.has(c.id)) { all.add(c.id); grew = true; }
    }
    const defs = form.controls.filter(c => all.has(c.id));
    const assets = Object.fromEntries(defs.flatMap(controlAssetIds).filter(a => a in ide.project.assets).map(a => [a, ide.project.assets[a]]));
    setClipboard(defs.map(c => {
      const d = structuredClone(c);
      if (tops.includes(c.id)) { const a = absoluteRect(form, c.id); d.parentId = null; setControlPos(d, a.left, a.top); }
      return d;
    }), assets);
    refresh();
  };
  const del = (form: FormDef, ids: string[]) => { ide.stack.execute(deleteControlsCmd(form.id, topLevelOf(form, ids))); ide.setSelection({ formId: form.id, ids: [] }); };
  actions.copy = withIds(1, copy);
  actions.cut = withIds(1, (f, ids) => { copy(f, ids); del(f, ids); });
  actions.delete = withIds(1, del);
  actions.paste = () => {
    const c = ctx();
    if (!c || !clipboardHasControls()) return;
    // with one container selected (Frame, PictureBox, SSTab: onto its current tab) into it (VB6); otherwise onto the form
    const sel = c.ids.length === 1 ? c.form.controls.find(x => x.id === c.ids[0]) : undefined;
    const into = sel && CONTROL_TYPES[sel.type]?.isContainer ? sel.id : null;
    void pasteControls(ide, c.form.id, getClipboard(), into, getClipboardAssets());
  };
  actions.selectAll = () => {
    const c = ctx();
    if (!c) return;
    const parent = c.ids.length ? c.form.controls.find(x => x.id === c.ids[0])?.parentId ?? null : null;
    ide.setSelection({ formId: c.form.id, ids: c.form.controls.filter(x => x.parentId === parent && shownInDesign(c.form, x.id)).map(x => x.id) });
  };
  const absOf = (form: FormDef, ids: string[]) => ids.map(id => absoluteRect(form, id));
  const align = (how: AlignHow) => withIds(2, (form, ids) => {
    const abs = absOf(form, ids), out = alignRects(abs, how);
    ide.stack.execute(moveResizeCmd(form.id, ids.map((id, i) => {
      const c = form.controls.find(x => x.id === id)!, r = relRect(c);
      return { id, ...r, left: r.left + out[i].left - abs[i].left, top: r.top + out[i].top - abs[i].top };
    })));
  });
  Object.assign(actions, {
    alignLefts: align('lefts'), alignCenters: align('centers'), alignRights: align('rights'),
    alignTops: align('tops'), alignMiddles: align('middles'), alignBottoms: align('bottoms'),
  });
  const same = (w: boolean, hh: boolean) => withIds(2, (form, ids) => {
    const defs = ids.map(id => form.controls.find(c => c.id === id)!);
    const p = relRect(defs[defs.length - 1]);
    const sized = defs.filter(hasSize);
    if (sized.length < 2) return;
    ide.stack.execute(moveResizeCmd(form.id, sized.map(c => {
      const r = relRect(c);
      return { id: c.id, ...r, width: w ? p.width : r.width, height: hh ? p.height : r.height };
    })));
  });
  actions.sameWidth = same(true, false);
  actions.sameHeight = same(false, true);
  actions.sameBoth = same(true, true);
  actions.bringToFront = withIds(1, (f, ids) => ide.stack.execute(zOrderCmd(f.id, ids, 'front')));
  actions.sendToBack = withIds(1, (f, ids) => ide.stack.execute(zOrderCmd(f.id, ids, 'back')));
  actions.lockControls = () => { ide.controlsLocked = !ide.controlsLocked; refresh(); };
}
