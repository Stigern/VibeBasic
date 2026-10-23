// Renders one form of the running program and maps DOM events to FromWindow messages (and ToWindow patches to the DOM).
// Shared by the inline host (tests, browser) and the real Tauri form windows (form.html).
//
// A picture whose asset key is a data URL (LoadPicture at run time) is shown from that URL.
// If `root.dataset.vbWindow` is set, root fills a native window: size changes of root resize the form and send `resized`.

import { renderFormSurface, type ControlView } from '../controls/render';
import { encodeRuns, readRuns } from '../controls/richText';
import { ribbonClick } from '../model/sheridan';
import { userClickButton } from '../model/toolbar';
import type { ControlDef, PropValue } from '../model/types';
import { domText, vbPos, vbText } from '../controls/textPos';
import type { FormSnapshot, FromWindow, ToWindow } from './protocol';

type Props = Record<string, PropValue>;
type Target = { id: string; def: ControlDef | null };

const CLICK_TYPES = new Set(['CommandButton', 'Label', 'Image', 'PictureBox', 'Frame', 'StatusBar', 'Toolbar', 'DTPicker', 'MSChart', 'TreeView', 'ListView', 'MSFlexGrid', 'RichTextBox', 'DataGrid', 'SSPanel', 'SSFrame', 'SSCommand', 'CoolBar', 'Animation']);   // Calendar raises its own Click
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
const CTRL_PUNCT: Record<string, number> = { '[': 27, '\\': 28, ']': 29 };
/** KeyAscii for the keys that raise KeyPress: typable characters, Enter, Backspace, Escape (27) and Ctrl+A .. Ctrl+Z (1 .. 26),
 *  Ctrl+[ \ ] (27 .. 29). Cmd combinations are the menus' (none). */
function keyAscii(e: KeyboardEvent): number | null {
  if (e.isComposing || e.metaKey) return null;
  if (e.key === 'Escape') return 27;
  if (e.ctrlKey) {
    if (e.altKey) return null;
    if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase().charCodeAt(0) - 64;
    return CTRL_PUNCT[e.key] ?? null;
  }
  if (e.key === 'Enter') return 13;
  if (e.key === 'Backspace') return 8;
  return e.key.length === 1 ? e.key.charCodeAt(0) : null;
}
/** A KeyAscii that puts something in a text field (the control characters of Escape and Ctrl+letter do not). */
const typable = (ascii: number): boolean => ascii >= 32 || ascii === 8 || ascii === 13;

/** One RichTextBox change of an RtfOps list (props in the order the program set them). */
function parseOp(o: string): Props {
  try { const v: unknown = JSON.parse(o); return v && typeof v === 'object' ? v as Props : {}; } catch { return {}; }
}

function isTextField(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'password'));
}

export function mountFormWindow(root: HTMLElement, s: FormSnapshot, post: (m: FromWindow) => void): { receive(m: ToWindow): void; dispose(): void } {
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
  /** Applies props to the mirror and the DOM (also keeps text typed by the user across rebuilds of the control). The user's own
   *  TextBox selection (`fromUser`) is already in the field: it goes to the mirror only (selecting again would lose its direction). */
  function apply(id: string, props: Props, fromUser = false): void {
    const { RtfOps: ops, ...plain } = props;
    Object.assign(propsOf(id), plain);
    if (Array.isArray(ops)) for (const o of ops) Object.assign(propsOf(id), parseOp(o));   // the mirror ends where the replay ends
    if (fromUser && isTextBox(id) && ('SelStart' in props || 'SelLength' in props)) {
      const { SelStart: _s, SelLength: _l, ...rest } = props;
      props = rest;
    }
    surface.update(id, props);
    if (id === 'form') return;
    if ('TabIndex' in props) { computeTabOrder(); for (const k of defs.keys()) retab(k); } else retab(id);
  }
  computeTabOrder();
  for (const id of defs.keys()) retab(id);

  // --- TextBox selection ---
  // The user's caret and selection reach the run session as state only when they differ from what it knows, and only before the
  // next message (an event that may read SelStart) or after a pause: moving the caret sends nothing while nothing can read it.
  const selDirty = new Set<string>();
  let selTimer: ReturnType<typeof setTimeout> | null = null;
  const isTextBox = (id: string): boolean => defs.get(id)?.type === 'TextBox';
  /** SelStart / SelLength of a TextBox field in VB characters (`vb`: the text the field shows). */
  function selOf(id: string, vb?: string): Props | null {
    const el = viewOf(id)?.inputEl ?? null;
    if (!isTextField(el)) return null;
    const multi = el instanceof HTMLTextAreaElement, cur = propsOf(id).Text;
    const t = vb ?? (typeof cur === 'string' && domText(cur, multi) === el.value ? cur : vbText(el.value, multi));
    const a = vbPos(t, el.selectionStart ?? 0, multi), b = vbPos(t, el.selectionEnd ?? 0, multi);
    return { SelStart: a, SelLength: b - a };
  }
  function flushSel(): void {
    if (selTimer) { clearTimeout(selTimer); selTimer = null; }
    for (const id of selDirty) {
      const sel = selOf(id), cur = propsOf(id);
      if (sel && (sel.SelStart !== (cur.SelStart ?? 0) || sel.SelLength !== (cur.SelLength ?? 0))) { Object.assign(cur, sel); post({ t: 'state', id, props: sel }); }
    }
    selDirty.clear();
  }
  function markSel(e: Event): void {
    const tg = targetOf(e.target);
    if (blocked || !tg || !isTextBox(tg.id) || e.target !== viewOf(tg.id)?.inputEl) return;
    selDirty.add(tg.id);
    if (selTimer) clearTimeout(selTimer);
    selTimer = setTimeout(() => { selTimer = null; if (!disposed) flushSel(); }, 150);
  }
  // capture: marked before the KeyUp / MouseUp / GotFocus of the same event is sent
  for (const type of ['select', 'keyup', 'mouseup', 'focusin']) surface.el.addEventListener(type, markSel, { capture: true, signal: ac.signal });

  // --- sending ---
  function send(m: FromWindow): void {
    if (selDirty.size) flushSel();
    post(m);
  }
  /** `event` only when the event has code; changed state always (on the event, or alone). */
  function emit(id: string, event: string, args: (number | string)[] = [], st?: Props): void {
    if (st) apply(id, st, true);
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
    } else if (type === 'SSCheck') {   // Click(Value As Integer): the new Value, True = -1
      const now = state.get(tg.id)!.Value !== true;
      emit(tg.id, 'Click', [now ? -1 : 0], { Value: now });
    } else if (type === 'SSOption') {
      const was = state.get(tg.id)!.Value === true;
      for (const d of defs.values()) {
        if (d.type === 'SSOption' && d.id !== tg.id && d.parentId === tg.def!.parentId && state.get(d.id)!.Value === true) {
          apply(d.id, { Value: false }); send({ t: 'state', id: d.id, props: { Value: false } });
        }
      }
      if (was) apply(tg.id, { Value: true }); else emit(tg.id, 'Click', [-1], { Value: true });
    } else if (type === 'SSRibbon') {   // a toggle; ribbons of one container with the same GroupNumber (above 0) release each other
      const me = state.get(tg.id)!, group = Number(me.GroupNumber) || 0;
      const down = group > 0 ? [...defs.values()].filter(d => d.type === 'SSRibbon' && d.id !== tg.id && d.parentId === tg.def!.parentId
        && (Number(state.get(d.id)!.GroupNumber) || 0) === group && state.get(d.id)!.Value === true).map(d => d.id) : [];
      const r = ribbonClick({ value: me.Value === true, group, allowAllUp: me.GroupAllowAllUp !== false }, down);
      for (const id of r.release) { apply(id, { Value: false }); send({ t: 'state', id, props: { Value: false } }); }
      if (r.value === (me.Value === true)) return;   // a ribbon that stays down (GroupAllowAllUp = False): nothing changed, no Click
      emit(tg.id, 'Click', [r.value ? -1 : 0], { Value: r.value });
    }
  });
  on<MouseEvent>('dblclick', e => { const tg = clickTarget(e); if (!blocked && tg && usable(tg.id)) emit(tg.id, 'DblClick'); });

  // --- mouse ---
  // VB6 mouse capture: the control that got MouseDown gets MouseMove and MouseUp until the button is released, also outside its
  // area (X / Y relative to it, maybe negative). The document's listeners see the pointer anywhere while a button is down.
  let captured: string | null = null;
  function mouseTo(id: string, event: string, e: MouseEvent): void {
    const v = id === 'form' ? surface.clientEl : viewOf(id)?.el;
    if (!v) return;
    const box = v.getBoundingClientRect();
    const button = event === 'MouseMove' ? e.buttons & 7 : e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0;
    emit(id, event, [button, shiftBits(e), Math.round((e.clientX - box.left) * 15), Math.round((e.clientY - box.top) * 15)]);
  }
  on<MouseEvent>('mousedown', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg || !usable(tg.id)) return;   // a disabled control gets no mouse events
    captured = tg.id;
    mouseTo(tg.id, 'MouseDown', e);
  });
  for (const [type, event] of [['mousemove', 'MouseMove'], ['mouseup', 'MouseUp']] as const) {
    root.ownerDocument.addEventListener(type, (e: MouseEvent) => {
      const id = captured;
      if (type === 'mouseup') captured = null;
      if (blocked) { captured = null; return; }
      if (id !== null) { if (usable(id) && (id === 'form' || defs.has(id))) mouseTo(id, event, e); return; }
      const tg = targetOf(e.target);
      if (tg && usable(tg.id)) mouseTo(tg.id, event, e);
    }, { signal: ac.signal });
  }

  // --- focus ---
  // the focus came from outside the form (another form, or the window became the key window): the form is the active one
  on<FocusEvent>('focusin', e => {
    if (!blocked && !(e.relatedTarget instanceof Node && surface.el.contains(e.relatedTarget))) send({ t: 'activated' });
  });
  const view = root.ownerDocument.defaultView;
  if (root.dataset.vbWindow !== undefined && view) view.addEventListener('focus', () => { if (!blocked && !disposed) send({ t: 'activated' }); }, { signal: ac.signal });
  on<FocusEvent>('focusin', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || targetOf(e.relatedTarget)?.id === tg.id) return;
    if (handles(tg.id, 'GotFocus')) emit(tg.id, 'GotFocus');
    else send({ t: 'focused', id: tg.id });   // the run session keeps ActiveControl
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
    if (type === 'TextBox') {   // a multi-line box gives CR LF line breaks (the textarea holds LF); the caret moved with the text
      const text = vbText((el as HTMLInputElement).value, el instanceof HTMLTextAreaElement);
      selDirty.delete(tg.id);
      emit(tg.id, 'Change', [], { Text: text, ...selOf(tg.id, text) });
    } else if (type === 'ComboBox' && !(el as HTMLInputElement).readOnly) {   // typed text is no item of the list: ListIndex -1
      const pick = el.dataset.vbPick;
      emit(tg.id, 'Change', [], { Text: (el as HTMLInputElement).value, ListIndex: pick === undefined ? -1 : Number(pick) });
    } else if (type === 'MaskedEdit' || ((type === 'DataCombo' || type === 'ImageCombo') && !(el as HTMLInputElement).readOnly)) {
      emit(tg.id, 'Change', [], { Text: (el as HTMLInputElement).value });
    } else if (type === 'RichTextBox') {
      emit(tg.id, 'Change', [], { Text: el.textContent ?? '', Runs: encodeRuns(readRuns(el)) });
    } else if (type === 'HScrollBar' || type === 'VScrollBar' || type === 'Slider' || type === 'FlatScrollBar') emit(tg.id, 'Scroll', [], { Value: Number(el.dataset.value) || 0 });
  });
  on<Event>('change', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl) return;
    const type = tg.def.type, el = e.target as HTMLElement;
    if (type === 'ListBox' && (el as HTMLSelectElement).multiple) {
      // MultiSelect: every item's flag; ListIndex is the item the user changed (the focus), as in VB6
      const opts = [...(el as HTMLSelectElement).options], was = String(propsOf(tg.id).SelFlags ?? '');
      const flags = opts.map(o => (o.selected ? '1' : '0')).join('');
      const changed = opts.findIndex((o, i) => o.selected !== (was[i] === '1'));
      const li = changed >= 0 ? changed : Number(propsOf(tg.id).ListIndex ?? -1);
      emit(tg.id, 'Click', [], { ListIndex: li, SelFlags: flags });
    } else if (type === 'ListBox' || type === 'FileListBox' || type === 'DataList') emit(tg.id, 'Click', [], { ListIndex: (el as HTMLSelectElement).selectedIndex });
    else if (type === 'HScrollBar' || type === 'VScrollBar' || type === 'Slider' || type === 'UpDown' || type === 'FlatScrollBar') emit(tg.id, 'Change', [], { Value: Number(el.dataset.value) || 0 });
    else if (type === 'DTPicker') emit(tg.id, 'Change', [], { Value: el.dataset.value ? Number(el.dataset.value) : null });
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
  // Toolbar: a click on a button toggles a check button or presses a group button (the new lines carry the state), then ButtonClick(Button)
  on<CustomEvent>('vbbuttonclick', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl || !usable(tg.id)) return;
    const index = Number(e.detail.index), cur = propsOf(tg.id).Buttons;
    const lines = userClickButton(Array.isArray(cur) ? cur.map(String) : [], index);
    if (lines) emit(tg.id, 'ButtonClick', [index], { Buttons: lines });
  });
  // TabStrip: a click on a tab selects it, then Click
  on<CustomEvent>('vbtabclick', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl || !usable(tg.id)) return;
    emit(tg.id, 'Click', [], { SelectedTab: Number(e.detail.index) });
  });
  // SSTab: a click on another tab shows it, then Click(PreviousTab)
  on<CustomEvent>('vbsstabclick', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl || !usable(tg.id)) return;
    emit(tg.id, 'Click', [Number(e.detail.previous)], { Tab: Number(e.detail.index) });
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
  // ImageCombo: an item was picked (its 1-based index; Text follows from the field), the list opened. CoolBar: bands were dragged (the new lines).
  custom('vbcomboitem', (id, d) => emit(id, 'Click', [], { SelectedIndex: Number(d.index), Text: (viewOf(id)!.inputEl as HTMLInputElement).value }));
  custom('vbcombodrop', id => emit(id, 'Dropdown'));
  on<CustomEvent>('vbbandresize', e => {
    const tg = targetOf(e.target);
    if (blocked || !tg?.def || e.target !== viewOf(tg.id)?.inputEl) return;
    emit(tg.id, 'BandResize', [], { Bands: (e.detail as { lines: string[] }).lines });
  });
  // DTPicker closed its calendar; MonthView: a selection by the user (then DateClick on the mouse release) and a double click on a day
  custom('vbcloseup', id => emit(id, 'CloseUp'));
  custom('vbmvselect', (id, d) => {
    const cur = propsOf(id);
    if (cur.SelStart === d.start && cur.SelEnd === d.end) return;
    emit(id, 'SelChange', [Number(d.start), Number(d.end)], { SelStart: Number(d.start), SelEnd: Number(d.end), Value: Number(d.start) });
  });
  custom('vbdateclick', (id, d) => emit(id, 'DateClick', [Number(d.serial)]));
  custom('vbdatedblclick', (id, d) => emit(id, 'DateDblClick', [Number(d.serial)]));
  // MaskedEdit: a character the mask refuses, and a full mask with AutoTab (the focus moves on)
  custom('vbvalidationerror', (id, d) => emit(id, 'ValidationError', [String(d.text), Number(d.pos)]));
  custom('vbautotab', id => focusNext(id));
  // MSChart: a click on a bar, point or slice (1-based series = column, data point = row; MouseFlags 0; Cancel is not used)
  custom('vbpointselect', (id, d) => emit(id, 'PointSelected', [Number(d.series), Number(d.point), Number(d.flags), 0]));
  // MMControl / MediaPlayer buttons, Agent characters clicked or dragged: the run session decides what happens (and which events follow)
  custom('vbuseraction', (id, d) => send({ t: 'state', id, props: { UserAction: JSON.stringify(d) } }));
  // MMControl / MediaPlayer: the media element ended or knows its length (reported even while the form is blocked or disabled: a
  // Play with Wait or Notify waits for it)
  on<CustomEvent>('vbmediastate', e => {
    const tg = targetOf(e.target);
    if (tg?.def && e.target === viewOf(tg.id)?.inputEl) send({ t: 'state', id: tg.id, props: { UserAction: JSON.stringify(e.detail) } });
  });
  custom('vbdirclick', (id, d) => emit(id, 'Click', [], { ListIndex: Number(d.index) }));
  custom('vbdiropen', (id, d) => emit(id, 'Change', [], { Path: String(d.path), List: [], ListIndex: -1 }));
  // WebBrowser: the page of a Navigate has loaded (reported even while the form is blocked: the run session raises the events)
  on<CustomEvent>('vbwebload', e => {
    const tg = targetOf(e.target);
    if (tg?.def?.type === 'WebBrowser') send({ t: 'state', id: tg.id, props: { Loaded: Number(e.detail.seq), LoadedTitle: String(e.detail.title ?? '') } });
  });
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
  /** The next control in tab order that can take the focus (MaskedEdit AutoTab). */
  function focusNext(id: string): void {
    const order = [...tabRank].sort((a, b) => a[1] - b[1]).map(([i]) => i);
    const at = order.indexOf(id);
    for (let k = 1; k < order.length; k++) {
      const n = order[(at + k) % order.length];
      if (usable(n) && (viewOf(n)?.inputEl?.tabIndex ?? -1) >= 0) { viewOf(n)!.inputEl!.focus(); return; }
    }
  }
  /** A MaskedEdit with a Mask puts typed characters in itself (see calendar.ts). */
  const isMasked = (el: EventTarget | null): el is HTMLInputElement => el instanceof HTMLInputElement && el.dataset.mask === '1';
  function insertKey(el: EventTarget | null, ascii: number): void {
    if (!typable(ascii)) return;
    if (isMasked(el)) { if (!el.readOnly) el.dispatchEvent(new CustomEvent('vbmaskkey', { detail: { ascii } })); return; }
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
    // a control character (Esc, Ctrl+C ...) is reported, but the field keeps its own action for it (copy, paste ...)
    if (pc.length) { if (isTextField(e.target) && typable(ascii!)) e.preventDefault(); sendKeyPress(pc, ascii!, e.target); }
    else if (ascii !== null && typable(ascii) && isMasked(e.target)) { e.preventDefault(); insertKey(e.target, ascii); }
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
  // the session sends focusInitial once Form_Activate has run (VB6: Load, Resize, Activate, then the first control's GotFocus)
  queueMicrotask(() => { if (!disposed) send({ t: 'ready' }); });

  return {
    receive(m) {
      switch (m.t) {
        case 'patch': if (m.id === 'form' || defs.has(m.id)) apply(m.id, m.props); break;
        case 'patches': for (const p of m.items) if (p.id === 'form' || defs.has(p.id)) apply(p.id, p.props); break;
        case 'focus': viewOf(m.id)?.inputEl?.focus(); break;
        case 'addControl':
          if (defs.has(m.def.id)) break;
          defs.set(m.def.id, m.def);
          state.set(m.def.id, { ...m.def.props });
          s.handled[m.def.id] = m.handled;
          surface.addControl(m.def);
          computeTabOrder();
          for (const k of defs.keys()) retab(k);
          break;
        case 'removeControl':
          if (!defs.has(m.id)) break;
          surface.removeControl(m.id);
          defs.delete(m.id);
          state.delete(m.id);
          computeTabOrder();
          break;
        case 'show': surface.el.style.display = ''; break;
        case 'focusInitial':   // unless code (SetFocus in Form_Activate) has already put the focus in the form
          if (!surface.el.contains(root.ownerDocument.activeElement)) focusInitial();
          break;
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
      if (selTimer) clearTimeout(selTimer);
      ac.abort();
      observer?.disconnect();
      // an open combo list holds a document listener until it is closed
      for (const v of surface.views.values()) v.inputEl?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      surface.dispose();   // media Blob URLs
      surface.el.remove();
    },
  };
}
