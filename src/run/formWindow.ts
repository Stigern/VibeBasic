// Renders one form of the running program and maps DOM events to FromWindow messages (and ToWindow patches to the DOM).
// Shared by the inline host (tests, browser) and the real Tauri form windows (form.html).
//
// A picture whose asset key is a data URL (LoadPicture at run time) is shown from that URL.
// If `root.dataset.vbWindow` is set, root fills a native window: size changes of root resize the form and send `resized`.

import { renderFormSurface, type ControlView } from '../controls/render';
import { encodeRuns, readRuns } from '../controls/richText';
import type { ControlDef, PropValue } from '../model/types';
import type { FormSnapshot, FromWindow, ToWindow } from './protocol';

type Props = Record<string, PropValue>;
type Target = { id: string; def: ControlDef | null };

const CLICK_TYPES = new Set(['CommandButton', 'Label', 'Image', 'PictureBox', 'Frame', 'StatusBar', 'TreeView', 'ListView', 'MSFlexGrid', 'RichTextBox']);
const KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
};

function vbKeyCode(e: KeyboardEvent): number {
  if (e.keyCode) return e.keyCode;
  if (KEY_CODES[e.key] !== undefined) return KEY_CODES[e.key];
  if (/^F\d+$/.test(e.key)) return 111 + Number(e.key.slice(1));
  return e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : 0;
}
const shiftBits = (e: MouseEvent | KeyboardEvent): number => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0);
/** KeyAscii for the keys that raise KeyPress: typable characters, Enter and Backspace. */
function keyAscii(e: KeyboardEvent): number | null {
  if (e.isComposing || e.ctrlKey || e.metaKey) return null;
  if (e.key === 'Enter') return 13;
  if (e.key === 'Backspace') return 8;
  return e.key.length === 1 ? e.key.charCodeAt(0) : null;
}

function isTextField(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'password'));
}

export function mountFormWindow(root: HTMLElement, s: FormSnapshot, send: (m: FromWindow) => void): { receive(m: ToWindow): void; dispose(): void } {
  const surface = renderFormSurface(s.form, 'run', ref => s.assets[ref.asset] ?? (ref.asset.startsWith('data:') ? ref.asset : null));
  surface.el.tabIndex = -1;   // so keys reach the form's listeners when no control has focus
  surface.el.style.outline = 'none';
  root.appendChild(surface.el);
  const ac = new AbortController();
  const on = <T extends Event>(type: string, fn: (e: T) => void) =>
    surface.el.addEventListener(type, fn as EventListener, { signal: ac.signal });

  const defs = new Map<string, ControlDef>(s.form.controls.map(d => [d.id, d]));
  const state = new Map<string, Props>(s.form.controls.map(d => [d.id, { ...d.props }]));
  const formState: Props = { ...s.form.props };
  let blocked = false;
  let disposed = false;
  let overlay: HTMLElement | null = null;
  let reqSeq = 0;
  const pending = new Map<number, { rest: string[]; el: EventTarget | null }>();

  const handles = (id: string, ev: string): boolean => s.handled[id]?.includes(ev) ?? false;
  const propsOf = (id: string): Props => (id === 'form' ? formState : state.get(id) ?? {});

  // --- tab order: TabIndex per container, containers depth first (render.ts resets tabIndex on every update) ---
  let tabRank = new Map<string, number>();
  function computeTabOrder(): void {
    const kids = new Map<string | null, ControlDef[]>();
    for (const d of defs.values()) {
      const p = d.parentId !== null && defs.has(d.parentId) ? d.parentId : null;
      (kids.get(p) ?? kids.set(p, []).get(p)!).push(d);
    }
    const num = (d: ControlDef) => { const v = state.get(d.id)?.TabIndex; return typeof v === 'number' ? v : 0; };
    tabRank = new Map();
    const walk = (p: string | null): void => {
      for (const d of (kids.get(p) ?? []).slice().sort((a, b) => num(a) - num(b))) { tabRank.set(d.id, tabRank.size + 1); walk(d.id); }
    };
    walk(null);
  }
  function retab(id: string): void {
    const ie = surface.views.get(id)?.inputEl;
    if (ie && ie.tabIndex >= 0 && tabRank.has(id)) ie.tabIndex = tabRank.get(id)!;
  }
  /** Applies props to the mirror and the DOM (also keeps text typed by the user across rebuilds of the control). */
  function apply(id: string, props: Props): void {
    Object.assign(propsOf(id), props);
    surface.update(id, props);
    if (id === 'form') return;
    if ('TabIndex' in props) { computeTabOrder(); for (const k of defs.keys()) retab(k); } else retab(id);
  }
  computeTabOrder();
  for (const id of defs.keys()) retab(id);

  // --- sending ---
  /** `event` only when the event has code; changed state always (on the event, or alone). */
  function emit(id: string, event: string, args: (number | string)[] = [], st?: Props): void {
    if (st) apply(id, st);
    if (handles(id, event)) send({ t: 'event', id, event, args, ...(st ? { state: st } : {}) });
    else if (st && id !== 'form') send({ t: 'state', id, props: st });
  }

  function targetOf(t: EventTarget | null): Target | null {
    if (!(t instanceof Node)) return null;
    const el = (t instanceof Element ? t : t.parentElement)?.closest<HTMLElement>('[data-control-id]');
    if (el && surface.el.contains(el)) { const id = el.dataset.controlId!; return { id, def: defs.get(id) ?? null }; }
    return surface.clientEl.contains(t) ? { id: 'form', def: null } : null;
  }
  /** Like targetOf(e.target), but also for a click whose target a handler has already replaced (a list or grid repaints on click). */
  function clickTarget(e: Event): Target | null {
    if (e.target instanceof Node && e.target.isConnected) return targetOf(e.target);
    const el = e.composedPath().find((n): n is HTMLElement => n instanceof HTMLElement && n.dataset?.controlId !== undefined && surface.el.contains(n));
    return el ? targetOf(el) : null;
  }
  const viewOf = (id: string): ControlView | undefined => surface.views.get(id);
  const usable = (id: string): boolean => { const p = propsOf(id); return p.Enabled !== false && p.Visible !== false; };

  // --- clicks ---
  on<MouseEvent>('click', e => {
    const closeBtn = (e.target as Element).closest?.('.title-bar-controls button[aria-label="Close"]');
    if (closeBtn) { if (!blocked) send({ t: 'closeRequest' }); return; }
    const tg = clickTarget(e);
    if (blocked || !tg) return;
    if (tg.id === 'form') { emit('form', 'Click'); return; }
    const type = tg.def!.type;
    if (!usable(tg.id)) return;
    if (CLICK_TYPES.has(type)) emit(tg.id, 'Click');
    else if (type === 'CheckBox') {
      const v = state.get(tg.id)!.Value;
      emit(tg.id, 'Click', [], { Value: v === 1 || v === true ? 0 : 1 });
    } else if (type === 'OptionButton') {
      const v = state.get(tg.id)!.Value;
      const was = v === true || (typeof v === 'number' && v !== 0);
      for (const d of defs.values()) {
        if (d.type === 'OptionButton' && d.id !== tg.id && d.parentId === tg.def!.parentId) { apply(d.id, { Value: false }); send({ t: 'state', id: d.id, props: { Value: false } }); }
      }
      if (was) apply(tg.id, { Value: true }); else emit(tg.id, 'Click', [], { Value: true });
    }
  });
  on<MouseEvent>('dblclick', e => { const tg = clickTarget(e); if (!blocked && tg && usable(tg.id)) emit(tg.id, 'DblClick'); });

  // --- mouse ---
  function mouse(event: string) {
    return (e: MouseEvent) => {
      const tg = targetOf(e.target);
      if (blocked || !tg || !usable(tg.id)) return;   // a disabled control gets no mouse events
      const box = (tg.id === 'form' ? surface.clientEl : viewOf(tg.id)!.el).getBoundingClientRect();
      const button = event === 'MouseMove' ? e.buttons & 7 : e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0;
      emit(tg.id, event, [button, shiftBits(e), Math.round((e.clientX - box.left) * 15), Math.round((e.clientY - box.top) * 15)]);
    };
  }
  on('mousedown', mouse('MouseDown'));
  on('mouseup', mouse('MouseUp'));
  on('mousemove', mouse('MouseMove'));

  // --- focus ---
  on<FocusEvent>('focusin', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || targetOf(e.relatedTarget)?.id === tg.id) return;
    emit(tg.id, 'GotFocus');
  });
  on<FocusEvent>('focusout', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || targetOf(e.relatedTarget)?.id === tg.id) return;
    emit(tg.id, 'LostFocus');
  });

  // --- text, lists, scroll bars ---
  on<Event>('input', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl) return;
    const type = tg.def.type, el = e.target as HTMLElement;
    if (type === 'TextBox' || (type === 'ComboBox' && !(el as HTMLInputElement).readOnly)) {
      emit(tg.id, 'Change', [], { Text: (el as HTMLInputElement).value });
    } else if (type === 'RichTextBox') {
      emit(tg.id, 'Change', [], { Text: el.textContent ?? '', Runs: encodeRuns(readRuns(el)) });
    } else if (type === 'HScrollBar' || type === 'VScrollBar' || type === 'Slider') emit(tg.id, 'Scroll', [], { Value: Number(el.dataset.value) || 0 });
  });
  on<Event>('change', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl) return;
    const type = tg.def.type, el = e.target as HTMLElement;
    if (type === 'ListBox' || type === 'FileListBox') emit(tg.id, 'Click', [], { ListIndex: (el as HTMLSelectElement).selectedIndex });
    else if (type === 'HScrollBar' || type === 'VScrollBar' || type === 'Slider' || type === 'UpDown') emit(tg.id, 'Change', [], { Value: Number(el.dataset.value) || 0 });
  });
  // UpDown arrows: UpClick / DownClick (then Change, from the `change` event above)
  for (const [dom, event] of [['vbupclick', 'UpClick'], ['vbdownclick', 'DownClick']] as const) {
    on<Event>(dom, e => {
      const tg = targetOf(e.target);
      if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl) return;
      emit(tg.id, event, [], { Value: Number((e.target as HTMLElement).dataset.value) || 0 });
    });
  }
  // StatusBar panel click (PanelClick gets the panel's 1-based index; the run session turns it into the Panel object)
  on<CustomEvent>('vbpanelclick', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl || !usable(tg.id)) return;
    emit(tg.id, 'PanelClick', [Number(e.detail.index)]);
  });
  // TabStrip: a click on a tab selects it, then Click
  on<CustomEvent>('vbtabclick', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl || !usable(tg.id)) return;
    emit(tg.id, 'Click', [], { SelectedTab: Number(e.detail.index) });
  });
  // TreeView / ListView / MSFlexGrid: the renderer reports clicks by 1-based collection index (the run session maps them to objects)
  const custom = (type: string, fn: (id: string, d: Record<string, number | boolean | string>) => void) => on<CustomEvent>(type, e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl || !usable(tg.id)) return;
    fn(tg.id, e.detail);
  });
  custom('vbnodeclick', (id, d) => emit(id, 'NodeClick', [Number(d.index)], { SelectedNode: Number(d.index) }));
  custom('vbnodetoggle', (id, d) => emit(id, d.expanded ? 'Expand' : 'Collapse', [Number(d.index)], { Toggled: `${d.index}|${d.expanded ? 1 : 0}` }));
  custom('vbitemclick', (id, d) => emit(id, 'ItemClick', [Number(d.index)], { SelectedIndex: Number(d.index) }));
  // DriveListBox / DirListBox: the drive picked, a folder clicked (its ListIndex) or opened by a double click (the new Path)
  custom('vbdrive', (id, d) => emit(id, 'Change', [], { Drive: String(d.drive) }));
  custom('vbdropdown', id => emit(id, 'DropDown'));
  custom('vbdirclick', (id, d) => emit(id, 'Click', [], { ListIndex: Number(d.index) }));
  custom('vbdiropen', (id, d) => emit(id, 'Change', [], { Path: String(d.path), List: [], ListIndex: -1 }));
  custom('vbcolclick', (id, d) => emit(id, 'ColumnClick', [Number(d.index)]));
  custom('vbcellclick', (id, d) => {
    const cur = propsOf(id);
    if (cur.Row === d.row && cur.Col === d.col) return;
    emit(id, 'RowColChange', [], { Row: Number(d.row), Col: Number(d.col) });
    emit(id, 'SelChange');
  });
  // RichTextBox: the selection (and the format of it) changed; SelChange only when something differs from what the program knows
  on<CustomEvent>('vbselchange', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl) return;
    const st = e.detail as Props, cur = propsOf(tg.id);
    if (Object.keys(st).every(k => cur[k] === st[k])) return;
    emit(tg.id, 'SelChange', [], st);
  });
  on<CustomEvent>('vbselect', e => {
    const tg = targetOf(e.target);
    const ie = tg && viewOf(tg.id)?.inputEl as HTMLInputElement | undefined;
    if (blocked || !tg || !ie) return;
    emit(tg.id, 'Click', [], { ListIndex: e.detail.index, Text: ie.value });
  });

  // --- keyboard ---
  function insertKey(el: EventTarget | null, ascii: number): void {
    if (!isTextField(el) || el.readOnly) return;
    const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? start;
    let text = String.fromCharCode(ascii), from = start;
    if (ascii === 8) {
      if (start === end) { if (start === 0) return; from = start - 1; }
      text = '';
    } else if (ascii === 13) {
      if (!(el instanceof HTMLTextAreaElement)) return;
      text = '\n';
    } else if (el.maxLength > 0 && el.value.length - (end - start) >= el.maxLength) return;
    el.setRangeText(text, from, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function sendKeyPress(chain: string[], ascii: number, el: EventTarget | null): void {
    const [id, ...rest] = chain;
    const requestId = ++reqSeq;
    pending.set(requestId, { rest, el });
    send({ t: 'event', id, event: 'KeyPress', args: [ascii], requestId });
  }
  function clickButton(prop: 'Default' | 'Cancel'): void {
    for (const d of defs.values()) {
      if (d.type === 'CommandButton' && state.get(d.id)![prop] === true && usable(d.id)) { viewOf(d.id)?.inputEl?.click(); return; }
    }
  }
  const chainOf = (id: string): string[] => (id !== 'form' && formState.KeyPreview === true ? ['form', id] : [id]);

  on<KeyboardEvent>('keydown', e => {
    const tg = targetOf(e.target) ?? { id: 'form', def: null };
    if (blocked) { e.preventDefault(); return; }
    const prevented = e.defaultPrevented;   // e.g. an open combo list closing on Escape
    const chain = chainOf(tg.id);
    const code = vbKeyCode(e), shift = shiftBits(e);
    for (const id of chain) emit(id, 'KeyDown', [code, shift]);
    const ascii = keyAscii(e);
    const pc = ascii === null ? [] : chain.filter(id => handles(id, 'KeyPress'));
    if (pc.length) { if (isTextField(e.target)) e.preventDefault(); sendKeyPress(pc, ascii!, e.target); }
    if (e.key === 'Enter' && !prevented && tg.def?.type !== 'CommandButton' && tg.def?.type !== 'RichTextBox' && !(e.target instanceof HTMLTextAreaElement)) clickButton('Default');
    else if (e.key === 'Escape' && !prevented) clickButton('Cancel');
  });
  on<KeyboardEvent>('keyup', e => {
    const tg = targetOf(e.target) ?? { id: 'form', def: null };
    if (blocked) return;
    for (const id of chainOf(tg.id)) emit(id, 'KeyUp', [vbKeyCode(e), shiftBits(e)]);
  });

  // --- blocked overlay ---
  function setBlocked(b: boolean): void {
    blocked = b;
    if (b && !overlay) {
      overlay = document.createElement('div');
      overlay.className = 'vb-blocked';
      overlay.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:transparent;cursor:default';
      surface.el.appendChild(overlay);
    } else if (!b && overlay) { overlay.remove(); overlay = null; }
  }

  // --- window size ---
  let observer: ResizeObserver | null = null;
  if (root.dataset.vbWindow !== undefined && typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(entries => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r || disposed) return;
      const width = Math.round(r.width * 15), height = Math.round(r.height * 15);
      // same pixel size as the form state: no change (also the echo of a size set by code, which need not be whole pixels)
      const px = (v: PropValue | undefined) => Math.round(Number(v) / 15);
      if (Math.round(r.width) === px(formState.Width) && Math.round(r.height) === px(formState.Height)) return;
      apply('form', { Width: width, Height: height });
      send({ t: 'resized', width, height });
    });
    observer.observe(root);
  }

  /** VB6: a shown form focuses the first control in tab order; without one the form itself gets the keys. */
  function focusInitial(): void {
    const first = [...tabRank].sort((a, b) => a[1] - b[1]).map(([id]) => id)
      .find(id => usable(id) && (viewOf(id)?.inputEl?.tabIndex ?? -1) >= 0);
    (first ? viewOf(first)!.inputEl! : surface.el).focus();
  }
  queueMicrotask(() => { if (disposed) return; send({ t: 'ready' }); focusInitial(); });

  return {
    receive(m) {
      switch (m.t) {
        case 'patch': if (m.id === 'form' || defs.has(m.id)) apply(m.id, m.props); break;
        case 'patches': for (const p of m.items) if (p.id === 'form' || defs.has(p.id)) apply(p.id, p.props); break;
        case 'focus': viewOf(m.id)?.inputEl?.focus(); break;
        case 'show': surface.el.style.display = ''; focusInitial(); break;
        case 'hide': surface.el.style.display = 'none'; break;
        case 'blocked': setBlocked(m.blocked); break;
        case 'keyResult': {
          const p = pending.get(m.requestId);
          pending.delete(m.requestId);
          if (!p || m.keyAscii === 0) break;
          if (p.rest.length) sendKeyPress(p.rest, m.keyAscii, p.el); else insertKey(p.el, m.keyAscii);
          break;
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ac.abort();
      observer?.disconnect();
      // an open combo list holds a document listener until it is closed
      for (const v of surface.views.values()) v.inputEl?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      surface.el.remove();
    },
  };
}
