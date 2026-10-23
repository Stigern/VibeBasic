// Drag and drop inside a form window (0.9 B4), driven by mouse events (Tauri takes the native drops of the webview for its file
// drop events, so HTML5 drag and drop does not reach the page).
//
// Classic: DragMode = 1 starts a drag on a left press (the source gets no mouse events then), Ctl.Drag 1 from code at the pointer;
// an outline of the source (or its DragIcon as the cursor) follows the mouse. The control under the pointer (a Shape, Line or
// disabled control: its container) gets DragOver(Source, X, Y, State) - vbEnter, vbOver, vbLeave - and DragDrop on the release.
// Only within this form: a drag that leaves the window has no target.
//
// OLE: OLEDragMode = 1 starts a drag when the mouse moves (4 px) with the button down - on a TextBox only from its selected text,
// which the drag carries; Ctl.OLEDrag from code at once. Targets are the controls with OLEDropMode 1 or 2 (a Label or Image
// without one passes the drop to its container, as VB6's windowless controls do); the run session raises the events (OleMessage)
// and answers the Effect, which picks the cursor. Escape cancels. Files dragged from Finder come as `fileDrag` calls (formWindowMain
// forwards Tauri's drag-drop events; their position is in CSS pixels of the window).

import { cursorCss } from '../controls/cursor';
import { vbPos, vbText } from '../controls/textPos';
import { CONTROL_TYPES } from '../model/controls';
import type { ControlDef, PictureRef, PropValue } from '../model/types';
import type { FromWindow, ToWindow } from './protocol';

type Props = Record<string, PropValue>;

/** What the drag code needs from its form window. */
export interface DragHost {
  doc: Document;
  /** The form's element: the drag outline goes in it. */
  layer: HTMLElement;
  /** The client area (the form as a target when the browser cannot tell what is under a point). */
  client: HTMLElement;
  blocked(): boolean;
  /** The control id (or 'form') an element belongs to; null outside the form's client area. */
  idAt(t: EventTarget | null): string | null;
  defOf(id: string): ControlDef | undefined;
  propsOf(id: string): Props;
  usable(id: string): boolean;
  elOf(id: string): HTMLElement | undefined;
  /** The field of a TextBox. */
  fieldOf(id: string): HTMLInputElement | HTMLTextAreaElement | null;
  /** Twips from the origin of the control (a PictureBox: inside its border) or of the client area. */
  pos(id: string, clientX: number, clientY: number): [number, number] | null;
  /** An event to the program when it has code for it. */
  emit(id: string, event: string, args: (number | string)[]): void;
  send(m: FromWindow): void;
  asset(ref: PictureRef): string | null;
}

export interface FileDrag { type: 'enter' | 'over' | 'drop' | 'leave'; paths?: string[]; x?: number; y?: number }

/** Controls without a window of their own in VB6: without OLEDropMode their container takes the drop. */
const WINDOWLESS = new Set(['Label', 'Image']);
const VB_ENTER = 0, VB_LEAVE = 1, VB_OVER = 2;
const isRef = (v: PropValue | undefined): v is PictureRef => typeof v === 'object' && v !== null && 'asset' in v;
const shiftBits = (e: MouseEvent | KeyboardEvent | null): number => (e ? (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) : 0);

/**
 * Where (x, y) falls in a text field: the caret index there and whether it is on the selected text (in the field's own characters).
 * A hidden copy of the field's text with the same font and size is laid over it. Null when the browser cannot tell (no layout).
 */
export function textHit(field: HTMLInputElement | HTMLTextAreaElement, x: number, y: number): { index: number; inSel: boolean } | null {
  const doc = field.ownerDocument, win = doc.defaultView;
  const caretAt = (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint;
  const r = field.getBoundingClientRect();
  if (!win || typeof caretAt !== 'function' || !r.width) return null;
  const cs = win.getComputedStyle(field), multi = field instanceof HTMLTextAreaElement;
  const m = doc.createElement('div');
  m.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;overflow:hidden;opacity:0;`
    + `z-index:2147483647;box-sizing:border-box;border:${cs.borderTopWidth} solid transparent;padding:${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft};`
    + `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};`
    + `letter-spacing:${cs.letterSpacing};line-height:${cs.lineHeight};text-align:${cs.textAlign};`
    // a single line is centred in the field's height, as an input shows it
    + (multi ? 'white-space:pre-wrap;overflow-wrap:break-word' : `white-space:pre;padding-top:0;padding-bottom:0;line-height:${field.clientHeight}px`);
  const v = field.value, a = field.selectionStart ?? 0, b = field.selectionEnd ?? a;
  const before = doc.createTextNode(v.slice(0, a)), sel = doc.createElement('span'), after = doc.createTextNode(v.slice(b));
  sel.textContent = v.slice(a, b);
  m.append(before, sel, after);
  doc.body.appendChild(m);
  try {
    m.scrollTop = field.scrollTop; m.scrollLeft = field.scrollLeft;
    const inSel = [...sel.getClientRects()].some(q => x >= q.left && x <= q.right && y >= q.top && y <= q.bottom);
    const range = caretAt.call(doc, x, y);
    let index = v.length;
    const n = range?.startContainer, off = range?.startOffset ?? 0;
    if (n === before) index = off;
    else if (n === sel.firstChild) index = a + off;
    else if (n === after) index = b + off;
    else if (n === m) index = off === 0 ? 0 : off === 1 ? a : off === 2 ? b : v.length;
    return { index, inSel };
  } finally {
    m.remove();
  }
}

export function installDragDrop(h: DragHost) {
  const doc = h.doc;
  const ac = new AbortController();
  /** The last pointer position (Ctl.Drag from code starts there). */
  let pointer: { x: number; y: number; target: EventTarget | null; e: MouseEvent | null } = { x: 0, y: 0, target: null, e: null };
  let drag: { source: string; ghost: HTMLElement | null; dx: number; dy: number; over: string | null } | null = null;
  let ole: { source: string | null; files: boolean; ghost: HTMLElement | null; over: string | null; button: number } | null = null;
  /** An OLEDragMode = 1 press that becomes a drag once the mouse moves. */
  let pending: { id: string; x: number; y: number; text?: string; sel?: [number, number]; field?: HTMLInputElement | HTMLTextAreaElement } | null = null;
  let eat = false;

  // --- cursor over everything while dragging ---
  let style: HTMLStyleElement | null = null;
  function setCursor(css: string | null): void {
    h.layer.toggleAttribute('data-vb-drag', css !== null);
    if (css === null) { style?.remove(); style = null; return; }
    if (!style) { style = doc.createElement('style'); doc.head.appendChild(style); }
    style.textContent = `[data-vb-drag], [data-vb-drag] * { cursor: ${css} !important; }`;
  }
  const ghostBox = (w: number, hgt: number, border: string): HTMLElement => {
    const g = doc.createElement('div');
    g.className = 'vb-drag-outline';
    g.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${hgt}px;box-sizing:border-box;border:${border};pointer-events:none;z-index:2147483646`;
    h.layer.appendChild(g);
    return g;
  };
  const place = (g: HTMLElement | null, x: number, y: number): void => { if (g) { g.style.left = `${x}px`; g.style.top = `${y}px`; } };
  function finish(): void {
    drag?.ghost?.remove();
    ole?.ghost?.remove();
    drag = null; ole = null;
    setCursor(null);
    eat = true;   // the click that ends a drag is not a Click
    setTimeout(() => { eat = false; }, 0);
  }

  // --- classic ---
  /** The control that takes a classic drop at an element: one with DragDrop, shown and enabled; else its container, the form. */
  function classicTarget(t: EventTarget | null): string | null {
    let id = h.idAt(t);
    for (let n = 0; id !== null && id !== 'form' && n < 50; n++) {
      const d = h.defOf(id);
      if (d && h.usable(id) && CONTROL_TYPES[d.type].events.some(e => e.name === 'DragDrop')) return id;
      id = d?.parentId ?? 'form';
    }
    return id;
  }
  function overTo(id: string, state: number): void {
    const p = h.pos(id, pointer.x, pointer.y);
    if (p && drag) h.emit(id, 'DragOver', [drag.source, p[0], p[1], state]);
  }
  function beginClassic(source: string): void {
    if (drag || ole || !h.defOf(source)) return;
    pending = null;
    drag = { source, ghost: null, dx: 0, dy: 0, over: null };
    showDragIcon();
    moveClassic(pointer.target);
  }
  /** The source's DragIcon as the pointer; without one an outline of the source that follows the pointer. Again when the program
   *  changes Source.DragIcon during the drag (in DragOver: the usual drop feedback). */
  function showDragIcon(): void {
    if (!drag) return;
    const icon = h.propsOf(drag.source).DragIcon, url = isRef(icon) ? h.asset(icon) : null;
    if (url) {
      drag.ghost?.remove();
      drag.ghost = null;
      setCursor(`url(${JSON.stringify(url)}) 16 16, default`);
    } else {
      if (!drag.ghost) {
        const r = h.elOf(drag.source)?.getBoundingClientRect();
        drag.ghost = ghostBox(r?.width ?? 0, r?.height ?? 0, '2px solid #808080');
        drag.dx = pointer.x - (r?.left ?? pointer.x); drag.dy = pointer.y - (r?.top ?? pointer.y);
        place(drag.ghost, pointer.x - drag.dx, pointer.y - drag.dy);
      }
      setCursor('default');
    }
  }
  function moveClassic(t: EventTarget | null): void {
    if (!drag) return;
    place(drag.ghost, pointer.x - drag.dx, pointer.y - drag.dy);
    const id = classicTarget(t);
    if (id === drag.over) { if (id) overTo(id, VB_OVER); return; }
    if (drag.over) overTo(drag.over, VB_LEAVE);
    drag.over = id;
    if (id) overTo(id, VB_ENTER);
  }
  function dropClassic(t: EventTarget | null): void {
    if (!drag) return;
    const id = classicTarget(t), source = drag.source;
    if (drag.over && drag.over !== id) overTo(drag.over, VB_LEAVE);
    const p = id ? h.pos(id, pointer.x, pointer.y) : null;
    finish();
    if (id && p) h.emit(id, 'DragDrop', [source, p[0], p[1]]);
  }

  // --- OLE ---
  /** The OLE drop target at an element: OLEDropMode 1 or 2; a Label or Image without one passes it to its container. */
  function oleTarget(id: string | null): string | null {
    for (let n = 0; id !== null && n < 50; n++) {
      if (Number(h.propsOf(id).OLEDropMode ?? 0) > 0 && h.usable(id)) return id;
      if (id === 'form') return null;
      const d = h.defOf(id);
      if (!d || !WINDOWLESS.has(d.type)) return null;
      id = d.parentId ?? 'form';
    }
    return null;
  }
  const effectCursor = (effect: number): string => (effect & 2 ? 'default' : effect & 1 ? 'copy' : cursorCss(12));
  function oleOver(id: string, state: number, x: number, y: number, e: MouseEvent | null): void {
    const p = h.pos(id, x, y);
    if (p && ole) h.send({ t: 'ole', phase: 'over', id, state, x: p[0], y: p[1], button: ole.button, shift: shiftBits(e) });
  }
  function beginOle(source: string | null, extra: { auto?: boolean; text?: string; sel?: [number, number]; files?: string[] }): void {
    if (drag || ole) return;
    pending = null;
    // Finder shows its own drag image; a drag inside the form a small dotted box under the arrow
    ole = { source, files: extra.files !== undefined, ghost: extra.files ? null : ghostBox(16, 12, '1px dotted #000'), over: null, button: extra.files ? 0 : 1 };
    setCursor(cursorCss(12));
    h.send({ t: 'ole', phase: 'start', id: source, ...extra });
  }
  function moveOle(id: string | null, x: number, y: number, e: MouseEvent | null): void {
    if (!ole) return;
    place(ole.ghost, x + 4, y + 16);
    const tg = oleTarget(id);
    if (tg === ole.over) { if (tg) oleOver(tg, VB_OVER, x, y, e); return; }
    if (ole.over) oleOver(ole.over, VB_LEAVE, x, y, e);
    ole.over = tg;
    if (tg) oleOver(tg, VB_ENTER, x, y, e);
    else setCursor(cursorCss(12));
  }
  function dropOle(id: string | null, x: number, y: number, e: MouseEvent | null): void {
    if (!ole) return;
    const tg = oleTarget(id), button = ole.button;
    if (ole.over && ole.over !== tg) oleOver(ole.over, VB_LEAVE, x, y, e);
    const p = tg ? h.pos(tg, x, y) : null;
    // an automatic text drop goes in at the character under the pointer
    const field = tg && Number(h.propsOf(tg).OLEDropMode) === 2 ? h.fieldOf(tg) : null;
    const hit = field ? textHit(field, x, y) : null;
    const at = field && hit ? vbPos(vbText(field.value, field instanceof HTMLTextAreaElement), hit.index, field instanceof HTMLTextAreaElement) : undefined;
    finish();
    h.send({ t: 'ole', phase: 'drop', id: p ? tg : null, x: p?.[0] ?? 0, y: p?.[1] ?? 0, button, shift: shiftBits(e), ...(at !== undefined ? { at } : {}) });
  }
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !ole || ole.files) return;
    e.preventDefault(); e.stopPropagation();
    if (ole.over) oleOver(ole.over, VB_LEAVE, pointer.x, pointer.y, null);
    finish();
    h.send({ t: 'ole', phase: 'drop', id: null, x: 0, y: 0, button: 1, shift: 0 });
  }, { capture: true, signal: ac.signal });

  // native drags (selected text, pictures) would take the mouse away from the form
  h.layer.addEventListener('dragstart', e => e.preventDefault(), { signal: ac.signal });

  const track = (e: MouseEvent): void => { pointer = { x: e.clientX, y: e.clientY, target: e.target, e }; };

  return {
    /** A press on a control: true when it started a classic automatic drag (the control gets no MouseDown then). */
    mouseDown(e: MouseEvent, id: string): boolean {
      track(e);
      if (e.button !== 0 || id === 'form' || drag || ole) return false;
      const p = h.propsOf(id);
      if (p.DragMode === 1) { e.preventDefault(); beginClassic(id); return true; }
      if (p.OLEDragMode !== 1) return false;
      const field = h.defOf(id)?.type === 'TextBox' ? h.fieldOf(id) : null;
      if (!field) { pending = { id, x: e.clientX, y: e.clientY }; return false; }
      const a = field.selectionStart ?? 0, b = field.selectionEnd ?? a;
      if (a === b || field.ownerDocument.activeElement !== field || textHit(field, e.clientX, e.clientY)?.inSel === false) return false;
      e.preventDefault();   // the selection stays: it is what the drag carries
      const multi = field instanceof HTMLTextAreaElement, t = vbText(field.value, multi), s = vbPos(t, a, multi), end = vbPos(t, b, multi);
      pending = { id, x: e.clientX, y: e.clientY, text: t.slice(s, end), sel: [s, end - s], field };
      return false;
    },
    /** The mouse moved (anywhere in the document): true when a drag took it. */
    mouseMove(e: MouseEvent): boolean {
      track(e);
      if (drag) { moveClassic(e.target); return true; }
      if (ole && !ole.files) { moveOle(h.idAt(e.target), e.clientX, e.clientY, e); return true; }
      if (!pending) return false;
      if (!(e.buttons & 1)) { pending = null; return false; }
      if (Math.abs(e.clientX - pending.x) + Math.abs(e.clientY - pending.y) < 4) return false;
      const pd = pending;
      beginOle(pd.id, { auto: true, ...(pd.text !== undefined ? { text: pd.text, sel: pd.sel } : {}) });
      moveOle(h.idAt(e.target), e.clientX, e.clientY, e);
      return true;
    },
    /** The button was released: true when it ended a drag. */
    mouseUp(e: MouseEvent): boolean {
      track(e);
      if (drag) { dropClassic(e.target); return true; }
      if (ole && !ole.files) { dropOle(h.idAt(e.target), e.clientX, e.clientY, e); return true; }
      const pd = pending;
      pending = null;
      if (pd?.field) {   // a click on the selected text, no drag: the caret goes where it was clicked
        const hit = textHit(pd.field, e.clientX, e.clientY);
        if (hit) pd.field.setSelectionRange(hit.index, hit.index);
      }
      return false;
    },
    /** The program set a control's DragIcon: when it is the source of the drag, the pointer (or the outline) follows. */
    dragIconChanged(id: string): void { if (drag?.source === id) showDragIcon(); },
    /** The click that ends a drag (the browser sends one to the element under both press and release). */
    eatClick(): boolean { return eat; },
    receive(m: Extract<ToWindow, { t: 'drag' | 'oleDrag' | 'oleEffect' }>): void {
      if (m.t === 'oleEffect') { if (ole?.over) setCursor(effectCursor(m.effect)); return; }
      if (h.blocked()) return;
      if (m.t === 'oleDrag') { beginOle(m.id, {}); moveOle(h.idAt(pointer.target), pointer.x, pointer.y, pointer.e); return; }
      if (m.action === 1) beginClassic(m.id);
      else if (drag && drag.source === m.id) {
        if (m.action === 2) dropClassic(pointer.target);
        else finish();   // vbCancel: no DragDrop
      }
    },
    /** Files dragged from Finder over the window (Tauri's drag-drop events). */
    fileDrag(f: FileDrag): void {
      const x = f.x ?? pointer.x, y = f.y ?? pointer.y;
      const at = (): string | null => {
        const el = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : h.client;
        return h.idAt(el);
      };
      if (f.type === 'enter') {
        if (h.blocked() || ole || drag || !f.paths?.length) return;
        beginOle(null, { files: [...f.paths] });
        moveOle(at(), x, y, null);
        return;
      }
      if (!ole?.files) return;
      if (f.type === 'over') moveOle(at(), x, y, null);
      else if (f.type === 'drop') { if (h.blocked()) f.type = 'leave'; else { dropOle(at(), x, y, null); return; } }
      if (f.type === 'leave' && ole) {
        if (ole.over) oleOver(ole.over, VB_LEAVE, x, y, null);
        finish();
        h.send({ t: 'ole', phase: 'drop', id: null, x: 0, y: 0, button: 0, shift: 0 });
      }
    },
    dispose(): void {
      ac.abort();
      drag?.ghost?.remove();
      ole?.ghost?.remove();
      style?.remove();
      drag = null; ole = null; pending = null;
    },
  };
}
