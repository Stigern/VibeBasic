// Shared control rendering. The designer (design mode) and the running program's windows (run mode, plan 03)
// both build their controls with renderControl / renderFormSurface, so the look and the DOM structure live here.
//
// DOM contract (see the CSS in controls.css):
//  - every control is `div.vb-ctl.vb-<Type>.vb-<mode>[data-control-id]`, absolutely positioned in its parent host;
//  - `inputEl` is the real interactive element (button / input / textarea / select, or the focusable scroll bar
//    widget). In design mode it is inert (pointer-events: none, tabIndex -1). Plan 03 attaches DOM events to it;
//  - Frame and PictureBox expose `childHost`; Form and PictureBox also own an empty `div.draw-layer` that the
//    drawing methods of phase 6 will fill, below all child controls.
import './controls.css';
import { vbColorToCss } from '../model/colors';
import { CONTROL_TYPES } from '../model/controls';
import { twipsToPx } from '../model/twips';
import type { ControlDef, FontValue, PictureRef, PropValue } from '../model/types';
import { h, mnemonicNodes } from '../ui98/dom';

export type AssetResolver = (ref: PictureRef) => string | null;   // data URL
export type RenderMode = 'design' | 'run';
type ConcreteType = ControlDef['type'];

export interface ControlView {
  /** Positioned absolutely in its parent. */
  el: HTMLElement;
  /** Focusable inner element (input, textarea, select, button, scroll bar). Replaced when the control is rebuilt (e.g. TextBox MultiLine). */
  inputEl?: HTMLElement;
  /** Container for child controls (Frame, PictureBox). */
  childHost?: HTMLElement;
  /** Applies changed properties (design-time and run-time ones, e.g. Caption, Value, ListIndex). Never mutates the ControlDef. */
  update(changed: Record<string, PropValue>): void;
}

export interface FormSurface {
  /** The whole window: border, title bar and client area. */
  el: HTMLElement;
  /** The client area; child controls live here. */
  clientEl: HTMLElement;
  /** The empty draw layer (first child of clientEl, under the controls). */
  drawLayer: HTMLElement;
  views: Map<string, ControlView>;
  /** `'form'` updates the form itself (Caption, BackColor, Width/Height, BorderStyle, ...). Unknown ids are ignored. */
  update(id: string | 'form', changed: Record<string, PropValue>): void;
  /** `index` is the position in the flat z-ordered list (default: in front of everything). */
  addControl(def: ControlDef, index?: number): void;
  /** Removes the control and all its descendants. */
  removeControl(id: string): void;
  /** Re-stacks and re-parents from the flat z-ordered list (after ZOrder / drag into a Frame / undo). */
  reorder(controls: ControlDef[]): void;
  /** Design-mode grid dots; gridX/gridY in twips. Ignored in run mode. */
  setGrid(o: { showGrid?: boolean; gridX?: number; gridY?: number }): void;
  setActive(active: boolean): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const PIXEL_FONT = '"Pixelated MS Sans Serif", Tahoma, Geneva, sans-serif';

function fontFamily(name: string): string {
  const n = name.replace(/["\\]/g, '').trim();
  return !n || /^ms sans serif$/i.test(n) ? PIXEL_FONT : `"${n}", ${PIXEL_FONT}`;
}

function applyFont(el: HTMLElement, f: FontValue): void {
  el.style.fontFamily = fontFamily(f.name);
  el.style.fontSize = `${Math.round(f.size * 96 / 72)}px`;
  el.style.fontWeight = f.bold ? '700' : '400';
  el.style.fontStyle = f.italic ? 'italic' : 'normal';
  el.style.textDecoration = f.underline ? 'underline' : 'none';
}

const cssUrl = (u: string): string => `url(${JSON.stringify(u)})`;
const isRef = (v: unknown): v is PictureRef => typeof v === 'object' && v !== null && !Array.isArray(v) && 'asset' in v;
const isFont = (v: unknown): v is FontValue => typeof v === 'object' && v !== null && !Array.isArray(v) && 'size' in v;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Per type: every registry default, so partially filled `props` still render. */
const DEFAULTS: Record<string, Record<string, PropValue>> = {};
for (const [t, td] of Object.entries(CONTROL_TYPES)) {
  const m: Record<string, PropValue> = {};
  for (const pd of td.props) m[pd.name] = pd.default;
  DEFAULTS[t] = m;
}

type Keys = ReadonlySet<string> | null;                       // null = everything (first render / rebuild)
const has = (k: Keys, ...names: string[]): boolean => k === null || names.some(n => k.has(n));

interface Ctx {
  readonly type: ConcreteType;
  readonly mode: RenderMode;
  readonly el: HTMLElement;
  readonly assets: AssetResolver;
  props: Record<string, PropValue>;
  str(n: string): string;
  num(n: string): number;
  bool(n: string): boolean;
  list(n: string): string[];
  color(n: string): string;
  pic(n: string): string | null;
  setInput(e: HTMLElement | undefined): void;
  setHost(e: HTMLElement | undefined): void;
  applySize(): void;
  /** Dispatches a bubbling event on the current inputEl. */
  fire(type: string): void;
}

interface Renderer {
  /** Property names that need `build()` to run again when they change. */
  structural?: readonly string[];
  build(): void;
  patch(keys: Keys): void;
  /** Background colour of `el`; null = none. Default: BackColor when the type has one. */
  bg?(): string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Renderers per control type

function commandButton(c: Ctx): Renderer {
  let btn: HTMLButtonElement;
  return {
    build() {
      btn = h('button', { type: 'button', class: 'vb-btn' });
      c.el.replaceChildren(btn);
      c.setInput(btn);
    },
    patch(k) {
      if (has(k, 'Caption')) btn.replaceChildren(...mnemonicNodes(c.str('Caption')));
      if (has(k, 'Default')) btn.classList.toggle('default', c.bool('Default'));
      if (has(k, 'Style', 'BackColor')) btn.style.backgroundColor = c.num('Style') === 1 ? c.color('BackColor') : '';
      if (has(k, 'Picture', 'Style')) {
        const u = c.pic('Picture');
        btn.style.backgroundImage = u ? cssUrl(u) : '';
      }
    },
    bg: () => null,
  };
}

function label(c: Ctx): Renderer {
  let text: HTMLElement;
  return {
    build() {
      text = h('span', { class: 'vb-text' });
      c.el.replaceChildren(text);
    },
    patch(k) {
      if (has(k, 'Caption')) text.replaceChildren(...mnemonicNodes(c.str('Caption')));
      if (has(k, 'Alignment')) c.el.style.textAlign = (['left', 'right', 'center'] as const)[c.num('Alignment')] ?? 'left';
      if (has(k, 'BorderStyle')) c.el.classList.toggle('vb-bordered', c.num('BorderStyle') === 1);
      if (has(k, 'WordWrap')) c.el.classList.toggle('vb-wrap', c.bool('WordWrap'));
      if (has(k, 'AutoSize', 'WordWrap', 'Width', 'Height')) {
        c.applySize();                                  // honours AutoSize for Labels
      }
    },
    bg: () => (c.num('BackStyle') === 0 ? 'transparent' : c.color('BackColor')),
  };
}

function textBox(c: Ctx): Renderer {
  let input: HTMLInputElement | HTMLTextAreaElement;
  return {
    structural: ['MultiLine'],
    build() {
      if (c.bool('MultiLine')) input = h('textarea', { class: 'vb-input', spellcheck: false, autocomplete: 'off' });
      else input = h('input', { type: 'text', class: 'vb-input vb-single', spellcheck: false, autocomplete: 'off' });
      c.el.replaceChildren(input);
      c.setInput(input);
    },
    patch(k) {
      if (has(k, 'Text') && input.value !== c.str('Text')) input.value = c.str('Text');
      if (input instanceof HTMLInputElement) {
        if (has(k, 'PasswordChar')) input.type = c.str('PasswordChar') ? 'password' : 'text';
      } else if (has(k, 'ScrollBars')) {
        const sb = c.num('ScrollBars');
        const horizontal = sb === 1 || sb === 3;
        input.style.overflowX = horizontal ? 'scroll' : 'hidden';
        input.style.overflowY = sb === 2 || sb === 3 ? 'scroll' : 'hidden';
        input.setAttribute('wrap', horizontal ? 'off' : 'soft');
      }
      if (has(k, 'MaxLength')) {
        if (c.num('MaxLength') > 0) input.maxLength = c.num('MaxLength'); else input.removeAttribute('maxlength');
      }
      if (has(k, 'Locked')) input.readOnly = c.bool('Locked');
      if (has(k, 'Alignment')) input.style.textAlign = (['left', 'right', 'center'] as const)[c.num('Alignment')] ?? 'left';
      if (has(k, 'BorderStyle')) c.el.classList.toggle('vb-bordered', c.num('BorderStyle') === 1);
    },
  };
}

/** CheckBox and OptionButton share one structure: a real (hidden) input over a drawn box and the caption. */
function checkOrOption(c: Ctx, kind: 'checkbox' | 'radio'): Renderer {
  let input: HTMLInputElement;
  let text: HTMLElement;
  return {
    build() {
      input = h('input', { type: kind, class: 'vb-hidden' });
      text = h('span', { class: 'vb-opt-text' });
      c.el.replaceChildren(h('span', { class: 'vb-opt' }, input, h('span', { class: 'vb-box' }), text));
      c.setInput(input);
    },
    patch(k) {
      if (has(k, 'Caption')) text.replaceChildren(...mnemonicNodes(c.str('Caption')));
      if (has(k, 'Value')) {
        const v = c.props.Value;
        if (kind === 'checkbox') {
          const n = typeof v === 'number' ? v : v === true ? 1 : 0;
          input.checked = n === 1;
          input.indeterminate = n === 2;
        } else {
          input.checked = v === true || (typeof v === 'number' && v !== 0);
        }
      }
      if (has(k, 'Alignment')) c.el.classList.toggle('vb-right', c.num('Alignment') === 1);
    },
  };
}

function frame(c: Ctx): Renderer {
  let legend: HTMLElement;
  return {
    build() {
      legend = h('span', { class: 'vb-frame-legend' });
      const host = h('div', { class: 'vb-host' });
      c.el.replaceChildren(h('div', { class: 'vb-frame-box' }), legend, host);
      c.setHost(host);
    },
    patch(k) {
      if (has(k, 'Caption')) {
        legend.replaceChildren(...mnemonicNodes(c.str('Caption')));
        legend.classList.toggle('vb-empty', c.str('Caption') === '');
      }
      if (has(k, 'BackColor')) legend.style.backgroundColor = c.color('BackColor');
      if (has(k, 'BorderStyle')) c.el.classList.toggle('vb-noborder', c.num('BorderStyle') === 0);
    },
  };
}

function listBox(c: Ctx): Renderer {
  let sel: HTMLSelectElement;
  return {
    build() {
      sel = h('select', { class: 'vb-listbox' });
      c.el.replaceChildren(sel);
      c.setInput(sel);
    },
    patch(k) {
      if (has(k, 'List', 'Sorted')) {
        const keep = k === null ? -1 : sel.selectedIndex;
        const items = c.list('List');
        if (c.bool('Sorted')) items.sort((a, b) => a.localeCompare(b));
        sel.replaceChildren(...items.map(t => h('option', {}, t)));
        sel.selectedIndex = keep < items.length ? keep : -1;
      }
      if (has(k, 'MultiSelect')) sel.multiple = c.num('MultiSelect') > 0;
      if (has(k, 'Height')) sel.size = Math.max(2, Math.floor((twipsToPx(c.num('Height')) - 4) / 13));
      if (has(k, 'ListIndex')) sel.selectedIndex = c.num('ListIndex');
    },
  };
}

function comboBox(c: Ctx): Renderer {
  let input: HTMLInputElement;
  let field: HTMLElement;
  let list: HTMLElement;
  let items: string[] = [];
  let sel = -1;
  let open = false;
  const doc = () => c.el.ownerDocument;
  const onOutside = (e: Event) => { if (!c.el.contains(e.target as Node)) close(); };
  function close() {
    open = false;
    list.classList.remove('open');
    doc().removeEventListener('mousedown', onOutside, true);
  }
  function openList() {
    if (c.mode !== 'run' || open) return;
    open = true;
    list.classList.add('open');
    doc().addEventListener('mousedown', onOutside, true);
  }
  const markSel = () => list.querySelectorAll('.vb-item').forEach((e, i) => e.classList.toggle('sel', i === sel));
  function pick(i: number) {
    if (i < 0 || i >= items.length) return;
    sel = i;
    input.value = items[i];
    c.props.Text = items[i];
    markSel();
    close();
    c.fire('input');
    c.fire('change');
    c.el.dispatchEvent(new CustomEvent('vbselect', { bubbles: true, detail: { index: i } }));
  }
  return {
    structural: ['Style'],
    build() {
      if (open) close();
      const style = c.num('Style');
      input = h('input', { type: 'text', class: 'vb-input', spellcheck: false, autocomplete: 'off' });
      input.readOnly = style === 2;
      const btn = style === 1 ? null : h('div', { class: 'vb-combo-btn' }, h('span', { class: 'vb-glyph' }));
      field = h('div', { class: 'vb-combo-field' }, input, btn ?? '');
      list = h('div', { class: 'vb-combo-list' });
      c.el.classList.toggle('vb-combo-simple', style === 1);
      c.el.replaceChildren(field, list);
      c.setInput(input);
      sel = -1;
      if (c.mode !== 'run') return;
      btn?.addEventListener('mousedown', e => { e.preventDefault(); input.focus(); open ? close() : openList(); });
      if (style === 2) input.addEventListener('mousedown', e => { e.preventDefault(); input.focus(); open ? close() : openList(); });
      list.addEventListener('mousedown', e => {
        const it = (e.target as Element).closest<HTMLElement>('.vb-item');
        if (!it) return;
        e.preventDefault();
        pick(Number(it.dataset.i));
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Escape' && open) { e.preventDefault(); close(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          pick(Math.min(items.length - 1, Math.max(0, sel + (e.key === 'ArrowDown' ? 1 : -1))));
        }
      });
    },
    patch(k) {
      if (has(k, 'List', 'Sorted')) {
        items = c.list('List');
        if (c.bool('Sorted')) items.sort((a, b) => a.localeCompare(b));
        list.replaceChildren(...items.map((t, i) => h('div', { class: 'vb-item', 'data-i': String(i) }, t)));
        if (sel >= items.length) sel = -1;
        markSel();
      }
      if (has(k, 'Text') && input.value !== c.str('Text')) input.value = c.str('Text');
      if (has(k, 'ListIndex')) {
        sel = c.num('ListIndex');
        if (sel >= 0 && sel < items.length) { input.value = items[sel]; c.props.Text = items[sel]; }
        markSel();
      }
      if (has(k, 'BackColor')) { field.style.backgroundColor = c.color('BackColor'); list.style.backgroundColor = c.color('BackColor'); }
    },
    bg: () => null,
  };
}

function pictureBox(c: Ctx): Renderer {
  let host: HTMLElement;
  return {
    build() {
      host = h('div', { class: 'vb-pic-host' }, h('div', { class: 'draw-layer' }));
      c.el.replaceChildren(host);
      c.setHost(host);
    },
    patch(k) {
      if (has(k, 'Picture')) {
        const u = c.pic('Picture');
        host.style.backgroundImage = u ? cssUrl(u) : '';
      }
      if (has(k, 'BorderStyle')) c.el.classList.toggle('vb-bordered', c.num('BorderStyle') === 1);
    },
  };
}

function image(c: Ctx): Renderer {
  return {
    build() { c.el.replaceChildren(); },
    patch(k) {
      if (has(k, 'Picture')) {
        const u = c.pic('Picture');
        c.el.replaceChildren(...(u ? [h('img', { class: 'vb-img', src: u, alt: '', draggable: false })] : []));
        c.el.classList.toggle('vb-empty', !u);
      }
      if (has(k, 'Stretch')) c.el.classList.toggle('vb-stretch', c.bool('Stretch'));
      if (has(k, 'BorderStyle')) c.el.classList.toggle('vb-bordered', c.num('BorderStyle') === 1);
    },
  };
}

const TIMER_SVG = '<svg viewBox="0 0 28 28" width="28" height="28" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">'
  + '<circle cx="14" cy="14" r="9" fill="#fff" stroke="#000" stroke-width="2"/>'
  + '<path d="M14 7v7h5" fill="none" stroke="#000" stroke-width="2"/>'
  + '<rect x="12" y="2" width="4" height="2" fill="#000"/></svg>';

function timer(c: Ctx): Renderer {
  return {
    build() { c.el.innerHTML = TIMER_SVG; },
    patch() { /* nothing: the icon is fixed */ },
  };
}

function progressBar(c: Ctx): Renderer {
  let fill: HTMLElement;
  return {
    build() {
      fill = h('div', { class: 'pb-fill' });
      c.el.replaceChildren(fill);
    },
    patch(k) {
      if (has(k, 'Scrolling')) c.el.classList.toggle('pb-smooth', c.num('Scrolling') === 1);
      if (has(k, 'Appearance')) c.el.classList.toggle('pb-flat', c.num('Appearance') === 0);
      if (has(k, 'BorderStyle')) c.el.classList.toggle('pb-bordered', c.num('BorderStyle') === 1);
      const vertical = c.num('Orientation') === 1;
      if (has(k, 'Orientation')) c.el.classList.toggle('pb-vertical', vertical);
      if (has(k, 'Min', 'Max', 'Value', 'Orientation')) {
        const min = c.num('Min'), max = c.num('Max');
        const frac = max > min ? Math.min(1, Math.max(0, (c.num('Value') - min) / (max - min))) : 0;
        const pct = `${round3(frac * 100)}%`;
        fill.style.width = vertical ? '' : pct;
        fill.style.height = vertical ? pct : '';
      }
    },
  };
}

/** Win98 scroll bar as a self-contained widget: arrows step by SmallChange (and repeat), the track by LargeChange,
 *  the thumb drags. User changes dispatch `input` (VB Scroll) and `change` (VB Change) on inputEl; the value is
 *  readable from `inputEl.dataset.value` / aria-valuenow. */
function scrollBar(c: Ctx, horizontal: boolean): Renderer {
  let root: HTMLElement, track: HTMLElement, thumb: HTMLElement;
  let value = 0;
  let pending = false;
  let repeatTimer: ReturnType<typeof setTimeout> | undefined;
  let repeatInterval: ReturnType<typeof setInterval> | undefined;
  const lo = () => Math.min(c.num('Min'), c.num('Max'));
  const hi = () => Math.max(c.num('Min'), c.num('Max'));
  const clamp = (v: number) => Math.min(hi(), Math.max(lo(), v));
  const small = () => Math.max(1, c.num('SmallChange'));
  const large = () => Math.max(1, c.num('LargeChange'));

  function layout() {
    const range = hi() - lo();
    root.dataset.value = String(value);
    root.setAttribute('aria-valuenow', String(value));
    root.setAttribute('aria-valuemin', String(lo()));
    root.setAttribute('aria-valuemax', String(hi()));
    thumb.style.display = range > 0 ? '' : 'none';
    if (range <= 0) return;
    const size = (large() / (range + large())) * 100;
    const pos = ((value - lo()) / range) * (100 - size);
    thumb.style[horizontal ? 'width' : 'height'] = `${round3(size)}%`;
    thumb.style[horizontal ? 'left' : 'top'] = `${round3(pos)}%`;
  }
  function set(v: number): boolean {
    v = clamp(v);
    if (v === value) return false;
    value = v;
    c.props.Value = v;
    layout();
    c.fire('input');
    pending = true;
    return true;
  }
  const commit = () => { if (pending) { pending = false; c.fire('change'); } };
  const stopRepeat = () => { clearTimeout(repeatTimer); clearInterval(repeatInterval); repeatTimer = repeatInterval = undefined; };

  return {
    build() {
      stopRepeat();
      c.el.classList.add(horizontal ? 'vb-horizontal' : 'vb-vertical');
      const dec = h('div', { class: 'vb-sb-btn dec' });
      const inc = h('div', { class: 'vb-sb-btn inc' });
      thumb = h('div', { class: 'vb-sb-thumb' });
      track = h('div', { class: 'vb-sb-track' }, thumb);
      root = h('div', { class: 'vb-sb', role: 'scrollbar', tabindex: '0', 'aria-orientation': horizontal ? 'horizontal' : 'vertical' }, dec, track, inc);
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      const doc = c.el.ownerDocument;
      const release = () => { stopRepeat(); commit(); };
      const stepButton = (dir: number) => (e: Event) => {
        if ((e as MouseEvent).button !== 0 || root.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        root.focus();
        stopRepeat();
        set(value + dir * small());
        repeatTimer = setTimeout(() => { repeatInterval = setInterval(() => set(value + dir * small()), 50); }, 400);
        doc.addEventListener('mouseup', release, { once: true });
      };
      dec.addEventListener('mousedown', stepButton(-1));
      inc.addEventListener('mousedown', stepButton(1));
      track.addEventListener('mousedown', e => {
        if (e.button !== 0 || root.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        root.focus();
        const r = thumb.getBoundingClientRect();
        if (e.target === thumb) {
          const start = horizontal ? e.clientX : e.clientY;
          const startVal = value;
          const move = (m: MouseEvent) => {
            const t = track.getBoundingClientRect();
            const room = (horizontal ? t.width - r.width : t.height - r.height);
            if (room <= 0) return;
            const delta = (horizontal ? m.clientX : m.clientY) - start;
            set(Math.round(startVal + (delta / room) * (hi() - lo())));
          };
          const up = () => { doc.removeEventListener('mousemove', move); commit(); };
          doc.addEventListener('mousemove', move);
          doc.addEventListener('mouseup', up, { once: true });
        } else {
          const before = horizontal ? e.clientX < r.left : e.clientY < r.top;
          set(value + (before ? -large() : large()));
          commit();
        }
      });
      root.addEventListener('keydown', e => {
        let next: number | null = null;
        switch (e.key) {
          case 'ArrowLeft': case 'ArrowUp': next = value - small(); break;
          case 'ArrowRight': case 'ArrowDown': next = value + small(); break;
          case 'PageUp': next = value - large(); break;
          case 'PageDown': next = value + large(); break;
          case 'Home': next = lo(); break;
          case 'End': next = hi(); break;
        }
        if (next === null) return;
        e.preventDefault();
        set(next);
        commit();
      });
    },
    patch(k) {
      if (has(k, 'Value', 'Min', 'Max')) value = clamp(c.num('Value'));
      if (has(k, 'Value', 'Min', 'Max', 'SmallChange', 'LargeChange')) layout();
    },
  };
}

const RENDERERS: Record<ConcreteType, (c: Ctx) => Renderer> = {
  CommandButton: commandButton,
  Label: label,
  TextBox: textBox,
  CheckBox: c => checkOrOption(c, 'checkbox'),
  OptionButton: c => checkOrOption(c, 'radio'),
  Frame: frame,
  ListBox: listBox,
  ComboBox: comboBox,
  PictureBox: pictureBox,
  Image: image,
  Timer: timer,
  HScrollBar: c => scrollBar(c, true),
  VScrollBar: c => scrollBar(c, false),
  ProgressBar: progressBar,
};

// ---------------------------------------------------------------------------------------------------------------
// Control core

export function renderControl(def: ControlDef, mode: RenderMode, assets: AssetResolver): ControlView {
  const td = CONTROL_TYPES[def.type];
  const defaults = DEFAULTS[def.type];
  const el = h('div', { class: `vb-ctl vb-${def.type} vb-${mode}`, dataset: { controlId: def.id } });
  const props: Record<string, PropValue> = { ...def.props };
  const view: ControlView = { el, update };

  const get = (n: string): PropValue => (props[n] !== undefined ? props[n] : defaults[n] ?? null);
  const ctx: Ctx = {
    type: def.type, mode, el, assets, props,
    str: n => { const v = get(n); return v === null || typeof v === 'object' ? '' : String(v); },
    num: n => { const v = get(n); return typeof v === 'number' ? v : v === true ? -1 : Number(v) || 0; },
    bool: n => { const v = get(n); return v === true || (typeof v === 'number' && v !== 0); },
    list: n => { const v = get(n); return Array.isArray(v) ? v.map(String) : []; },
    color: n => vbColorToCss(ctx.num(n)),
    pic: n => { const v = get(n); return isRef(v) ? assets(v) : null; },
    setInput: e => { view.inputEl = e; },
    setHost: e => { view.childHost = e; },
    fire: type => { view.inputEl?.dispatchEvent(new Event(type, { bubbles: true })); },
    applySize() {
      const w = typeof props.Width === 'number' ? props.Width : td.defaultWidth;
      const hh = typeof props.Height === 'number' ? props.Height : td.defaultHeight;
      el.style.width = `${twipsToPx(w)}px`;
      el.style.height = `${twipsToPx(hh)}px`;
      if (def.type === 'Label' && ctx.bool('AutoSize')) {   // the browser sizes the label to its text
        if (!ctx.bool('WordWrap')) el.style.width = 'auto';
        el.style.height = 'auto';
      }
    },
  };
  // `props` is reassigned by Object.assign below, never replaced, so the closures above stay valid.
  const r = RENDERERS[def.type](ctx);
  const hasFont = 'Font' in defaults, hasFore = 'ForeColor' in defaults, hasBack = 'BackColor' in defaults;

  function refresh(keys: Keys): void {
    if (has(keys, 'Left', 'Top', 'Width', 'Height')) {
      el.style.left = `${twipsToPx(typeof props.Left === 'number' ? props.Left : 0)}px`;
      el.style.top = `${twipsToPx(typeof props.Top === 'number' ? props.Top : 0)}px`;
      ctx.applySize();
    }
    const hidden = mode === 'run' && (td.invisibleAtRuntime || !ctx.bool('Visible'));
    el.style.display = hidden ? 'none' : '';
    const disabled = mode === 'run' && 'Enabled' in defaults && !ctx.bool('Enabled');
    el.classList.toggle('vb-disabled', disabled);
    if (mode === 'run' && has(keys, 'ToolTipText')) el.title = ctx.str('ToolTipText');

    r.patch(keys);

    if (hasFont && has(keys, 'Font')) { const f = get('Font'); if (isFont(f)) applyFont(el, f); }
    if (hasFore && has(keys, 'ForeColor')) el.style.color = ctx.color('ForeColor');
    if (hasBack) {
      const bg = r.bg ? r.bg() : ctx.color('BackColor');
      el.style.backgroundColor = bg ?? '';
    }

    const ie = view.inputEl;
    if (ie) {
      if (mode === 'design') { ie.tabIndex = -1; ie.style.pointerEvents = 'none'; }
      else {
        ie.tabIndex = props.TabStop === false ? -1 : 0;
        if ('disabled' in ie) (ie as HTMLButtonElement).disabled = disabled;
        else ie.setAttribute('aria-disabled', String(disabled));
      }
    }
  }

  function update(changed: Record<string, PropValue>): void {
    const keys = new Set(Object.keys(changed));
    Object.assign(props, changed);
    if (r.structural?.some(s => keys.has(s))) { r.build(); refresh(null); }
    else refresh(keys);
  }

  r.build();
  refresh(null);
  return view;
}

// ---------------------------------------------------------------------------------------------------------------
// Form surface

export interface FormMetrics {
  outerWidth: number; outerHeight: number;   // px
  border: number; titleHeight: number;       // px
  clientWidth: number; clientHeight: number; // px
}

const TITLE_BAR_HEIGHT = 18;

/** Window geometry from the Form properties (Width/Height are the OUTER size in twips). Plan 03 uses this for
 *  ScaleWidth/ScaleHeight so run mode and the designer agree: client = outer - title bar (18px) - borders
 *  (4px Sizable / Sizable ToolWindow, 3px otherwise, none for BorderStyle None). */
export function formMetrics(props: Record<string, PropValue>): FormMetrics {
  const num = (k: string): number => (typeof props[k] === 'number' ? (props[k] as number) : (DEFAULTS.Form[k] as number));
  const bs = num('BorderStyle');
  const border = bs === 0 ? 0 : bs === 2 || bs === 5 ? 4 : 3;
  const titleHeight = bs === 0 ? 0 : TITLE_BAR_HEIGHT;
  const outerWidth = twipsToPx(num('Width'));
  const outerHeight = twipsToPx(num('Height'));
  return {
    outerWidth, outerHeight, border, titleHeight,
    clientWidth: Math.max(0, outerWidth - 2 * border),
    clientHeight: Math.max(0, outerHeight - 2 * border - titleHeight),
  };
}

/** The client area in twips (the form's ScaleWidth/ScaleHeight at the default ScaleMode). */
export function formScaleSize(props: Record<string, PropValue>): { width: number; height: number } {
  const m = formMetrics(props);
  return { width: m.clientWidth * 15, height: m.clientHeight * 15 };
}

const DEFAULT_FORM_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" shape-rendering="crispEdges">'
  + '<rect x="1" y="2" width="14" height="12" fill="#c0c0c0" stroke="#000"/>'
  + '<rect x="2" y="3" width="12" height="3" fill="#000080"/><rect x="3" y="8" width="6" height="4" fill="#fff" stroke="#808080" stroke-width="1"/></svg>');

function gridImage(gx: number, gy: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${gx}" height="${gy}"><rect width="1" height="1" fill="#000"/></svg>`;
  return cssUrl('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
}

export function renderFormSurface(form: { props: Record<string, PropValue>; controls: ControlDef[] }, mode: RenderMode, assets: AssetResolver,
  opts: { showGrid?: boolean; gridX?: number; gridY?: number } = {}): FormSurface {
  const props: Record<string, PropValue> = { ...form.props };
  const get = (n: string): PropValue => (props[n] !== undefined ? props[n] : DEFAULTS.Form[n] ?? null);
  const num = (n: string): number => { const v = get(n); return typeof v === 'number' ? v : Number(v) || 0; };
  const bool = (n: string): boolean => get(n) === true || (typeof get(n) === 'number' && get(n) !== 0);
  const str = (n: string): string => { const v = get(n); return v === null || typeof v === 'object' ? '' : String(v); };

  const el = h('div', { class: `vb-form vb-${mode}` });
  const clientEl = h('div', { class: 'vb-form-client' });
  const drawLayer = h('div', { class: 'draw-layer' });
  clientEl.appendChild(drawLayer);
  el.appendChild(clientEl);
  let titleBar: HTMLElement | null = null;
  let active = true;
  const grid = { showGrid: opts.showGrid ?? false, gridX: opts.gridX ?? 120, gridY: opts.gridY ?? 120 };
  let gridEl: HTMLElement | null = null;

  function buildTitleBar(): HTMLElement | null {
    const bs = num('BorderStyle');
    if (bs === 0) return null;
    const controlBox = bool('ControlBox');
    const iconRef = get('Icon');
    const icon = controlBox ? (isRef(iconRef) ? assets(iconRef) : null) ?? DEFAULT_FORM_ICON : null;
    const buttons: HTMLButtonElement[] = [];
    if (controlBox) {
      const mk = (label: string, disabled = false) =>
        h('button', { type: 'button', 'aria-label': label, disabled, tabindex: mode === 'design' ? '-1' : null });
      const sizeable = bs === 1 || bs === 2;
      if (sizeable && (bool('MinButton') || bool('MaxButton'))) {
        buttons.push(mk('Minimize', !bool('MinButton')), mk('Maximize', !bool('MaxButton')));
      }
      buttons.push(mk('Close'));
    }
    const bar = h('div', { class: 'title-bar' + (active ? '' : ' inactive') },
      icon ? h('img', { class: 'title-bar-icon', src: icon, alt: '', draggable: false }) : '',
      h('div', { class: 'title-bar-text' }, str('Caption')),
      buttons.length ? h('div', { class: 'title-bar-controls' }, ...buttons) : '');
    if (mode === 'design') bar.style.pointerEvents = 'none';
    return bar;
  }

  function layoutChrome(): void {
    const m = formMetrics(props);
    el.style.width = `${m.outerWidth}px`;
    el.style.height = `${m.outerHeight}px`;
    el.style.padding = `${m.border}px`;
    el.classList.toggle('vb-noframe', m.border === 0);
    clientEl.style.width = `${m.clientWidth}px`;
    clientEl.style.height = `${m.clientHeight}px`;
    titleBar?.remove();
    titleBar = buildTitleBar();
    if (titleBar) el.insertBefore(titleBar, clientEl);
  }

  function patchClient(keys: Keys): void {
    if (has(keys, 'BackColor')) clientEl.style.backgroundColor = vbColorToCss(num('BackColor'));
    if (has(keys, 'ForeColor')) clientEl.style.color = vbColorToCss(num('ForeColor'));
    if (has(keys, 'Font')) { const f = get('Font'); if (isFont(f)) applyFont(clientEl, f); }
    if (has(keys, 'Picture')) {
      const ref = get('Picture');
      const u = isRef(ref) ? assets(ref) : null;
      clientEl.style.backgroundImage = u ? cssUrl(u) : '';
      clientEl.style.backgroundRepeat = 'no-repeat';
    }
  }

  function applyGrid(): void {
    const on = mode === 'design' && grid.showGrid;
    if (!on) { gridEl?.remove(); gridEl = null; return; }
    const gx = Math.max(2, twipsToPx(grid.gridX)), gy = Math.max(2, twipsToPx(grid.gridY));
    if (!gridEl) { gridEl = h('div', { class: 'vb-grid' }); clientEl.insertBefore(gridEl, clientEl.firstChild); }
    gridEl.style.backgroundImage = gridImage(gx, gy);
    gridEl.style.backgroundSize = `${gx}px ${gy}px`;
  }

  // --- controls: a flat z-ordered list rendered as a tree by parentId, whatever order the array has ---
  const views = new Map<string, ControlView>();
  const defs = new Map<string, ControlDef>();
  let order: string[] = [];

  /** The container a control really goes in: its parent's childHost, or the form when the parent is missing, not a
   *  container, or the chain loops. */
  function hostOf(def: ControlDef): HTMLElement {
    const seen = new Set<string>([def.id]);
    let p = def.parentId;
    while (p !== null) {
      if (seen.has(p) || !defs.has(p)) return clientEl;
      seen.add(p);
      p = defs.get(p)!.parentId;
    }
    const pv = def.parentId ? views.get(def.parentId) : undefined;
    return pv?.childHost ?? clientEl;
  }

  function place(id: string): void {
    const def = defs.get(id), view = views.get(id);
    if (!def || !view) return;
    const host = hostOf(def);
    let ref: Node | null = null;
    for (let i = order.indexOf(id) + 1; i < order.length; i++) {
      const e = views.get(order[i])?.el;
      if (e && e.parentElement === host) { ref = e; break; }
    }
    host.insertBefore(view.el, ref);
  }

  function add(def: ControlDef, index?: number): void {
    if (views.has(def.id)) return;
    defs.set(def.id, def);
    views.set(def.id, renderControl(def, mode, assets));
    order.splice(index === undefined ? order.length : Math.max(0, Math.min(index, order.length)), 0, def.id);
  }

  const surface: FormSurface = {
    el, clientEl, drawLayer, views,
    update(id, changed) {
      if (id !== 'form') { views.get(id)?.update(changed); return; }
      const keys = new Set(Object.keys(changed));
      Object.assign(props, changed);
      const chrome = ['Width', 'Height', 'BorderStyle', 'ControlBox', 'MinButton', 'MaxButton', 'Icon'];
      if (chrome.some(k => keys.has(k))) layoutChrome();
      else if (keys.has('Caption')) { const t = el.querySelector('.title-bar-text'); if (t) t.textContent = str('Caption'); }
      patchClient(keys);
    },
    addControl(def, index) {
      add(def, index);
      place(def.id);
      for (const d of defs.values()) if (d.parentId === def.id) place(d.id);   // children that arrived before their parent
    },
    removeControl(id) {
      const doomed = new Set<string>([id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const d of defs.values()) if (d.parentId !== null && doomed.has(d.parentId) && !doomed.has(d.id)) { doomed.add(d.id); grew = true; }
      }
      for (const d of doomed) { views.get(d)?.el.remove(); views.delete(d); defs.delete(d); }
      order = order.filter(o => !doomed.has(o));
    },
    reorder(controls) {
      for (const d of controls) if (views.has(d.id)) defs.set(d.id, d);
      order = controls.map(d => d.id).filter(i => views.has(i));
      for (const i of order) hostOf(defs.get(i)!).appendChild(views.get(i)!.el);
    },
    setGrid(o) {
      Object.assign(grid, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
      applyGrid();
    },
    setActive(a) {
      active = a;
      titleBar?.classList.toggle('inactive', !a);
    },
  };

  layoutChrome();
  patchClient(null);
  applyGrid();
  for (const d of form.controls) add(d);
  for (const id of [...order]) place(id);
  return surface;
}
