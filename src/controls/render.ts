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
import { joinFields, splitFields } from '../model/fieldLines';
import { dockEdge, isDocked } from '../model/geometry';
import { findListImage, type ImageLookup, type ImageSource } from '../model/imageList';
import { TBR_DROPDOWN, TBR_PLACEHOLDER, TBR_SEPARATOR, parseButton } from '../model/toolbar';
import { flagOn, ssTabLayout } from '../model/ssTab';
import { twipsToPx } from '../model/twips';
import { decodeRuns, encodeRuns, formatAt, readRuns, replaceRange, selectionOffsets, setSelectionOffsets, writeRuns, type Run, type RtfFormat, type RtfPatch } from './richText';
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
  /** Containers with several hosts (SSTab: one page per tab) pick the host of each child; wins over childHost. */
  childHostFor?(child: ControlDef): HTMLElement;
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
  /** A control got a new name (the ImageList a Toolbar names by it is found again). */
  rename(id: string, name: string): void;
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
/** An <img> of an ImageList picture, at the ImageList's size. */
const imageEl = (src: ImageSource, cls: string): HTMLElement =>
  h('img', { class: cls, src: src.url, draggable: 'false', style: { width: `${src.width}px`, height: `${src.height}px` } });
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Per type: every registry default, so partially filled `props` still render. */
const DEFAULTS: Record<string, Record<string, PropValue>> = {};
for (const [t, td] of Object.entries(CONTROL_TYPES)) {
  const m: Record<string, PropValue> = {};
  for (const pd of td.props) m[pd.name] = pd.default;
  DEFAULTS[t] = m;
}

/** Pseudo property: the ImageList a control uses changed (the form surface sends it to the controls that name it). */
export const IMAGES_CHANGED = '*images';
const IMAGE_USERS = new Set<string>(['Toolbar', 'TreeView', 'ListView', 'TabStrip']);

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
  /** The image `ref` (an index or a key) of the ImageList that the property `listProp` names; null when there is none. */
  image(listProp: string, ref: string): ImageSource | null;
  setInput(e: HTMLElement | undefined): void;
  setHost(e: HTMLElement | undefined): void;
  setHostFor(f: (child: ControlDef) => HTMLElement): void;
  applySize(): void;
  /** Dispatches a bubbling event on the current inputEl. */
  fire(type: string, detail?: unknown): void;
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

/** DriveListBox: a drop-down of the `Drives` lines ('path|name'); `Drive` is the chosen path. Run mode: a pick dispatches `vbdrive` ({ drive }). */
function driveListBox(c: Ctx): Renderer {
  let input: HTMLInputElement, list: HTMLElement, field: HTMLElement;
  let open = false;
  const drives = () => c.list('Drives').map(splitFields);
  const label = (path: string): string => { const n = drives().find(d => d[0] === path)?.[1]; return path === '/' && n && n !== '/' ? `/ [${n}]` : path; };
  const doc = () => c.el.ownerDocument;
  const onOutside = (e: Event) => { if (!c.el.contains(e.target as Node)) close(); };
  function close() { open = false; list.classList.remove('open'); doc().removeEventListener('mousedown', onOutside, true); }
  function openList() {
    if (c.mode !== 'run' || open) return;
    open = true;
    list.classList.add('open');
    c.fire('vbdropdown');
    doc().addEventListener('mousedown', onOutside, true);
  }
  function pick(path: string) {
    close();
    if (path === c.str('Drive')) return;
    c.props.Drive = path;
    input.value = label(path);
    markSel();
    c.fire('vbdrive', { drive: path });
  }
  const markSel = () => list.querySelectorAll<HTMLElement>('.vb-item').forEach(e => e.classList.toggle('sel', e.dataset.path === c.str('Drive')));
  return {
    build() {
      if (open) close();
      input = h('input', { type: 'text', class: 'vb-input', spellcheck: false, autocomplete: 'off' });
      input.readOnly = true;
      const btn = h('div', { class: 'vb-combo-btn' }, h('span', { class: 'vb-glyph' }));
      field = h('div', { class: 'vb-combo-field' }, input, btn);
      list = h('div', { class: 'vb-combo-list' });
      c.el.replaceChildren(field, list);
      c.setInput(input);
      if (c.mode !== 'run') return;
      const toggle = (e: Event) => { e.preventDefault(); input.focus(); open ? close() : openList(); };
      btn.addEventListener('mousedown', toggle);
      input.addEventListener('mousedown', toggle);
      list.addEventListener('mousedown', e => {
        const it = (e.target as Element).closest<HTMLElement>('.vb-item');
        if (!it) return;
        e.preventDefault();
        pick(it.dataset.path!);
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Escape' && open) { e.preventDefault(); close(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const all = drives(), i = all.findIndex(d => d[0] === c.str('Drive'));
          const next = all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
          if (next) pick(next[0]);
        }
      });
    },
    patch(k) {
      if (has(k, 'Drives')) {
        list.replaceChildren(...drives().map(d => h('div', { class: 'vb-item', dataset: { path: d[0] } }, label(d[0]))));
      }
      if (has(k, 'Drive', 'Drives')) { input.value = label(c.str('Drive')); markSel(); }
      if (has(k, 'BackColor')) { field.style.backgroundColor = c.color('BackColor'); list.style.backgroundColor = c.color('BackColor'); }
    },
    bg: () => null,
  };
}

/** DirListBox: the folders above `Path` (each one level further in), the current folder, and the sub-folders from `List` (full paths) below it.
 *  Run mode: a click dispatches `vbdirclick` ({ index }: the sub-folder number, or -1 current, -2 its parent ...); a double click on a folder
 *  other than the current one dispatches `vbdiropen` ({ path }). */
function dirListBox(c: Ctx): Renderer {
  let root: HTMLElement;
  let sel = -1;
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  function paint() {
    const path = c.str('Path') || '/', segs = path.split('/').filter(Boolean);
    const chain = ['/', ...segs.map((_, i) => '/' + segs.slice(0, i + 1).join('/'))];
    const row = (p: string, level: number, index: number, name: string, isOpen: boolean) =>
      h('div', { class: index === sel ? 'dir-row sel' : 'dir-row', dataset: { path: p, index: String(index) }, style: { paddingLeft: `${level * 12 + 2}px` } },
        h('span', { class: isOpen ? 'dir-ico open' : 'dir-ico' }), h('span', { class: 'dir-text' }, name));
    const rows = chain.map((p, i) => row(p, i, -(chain.length - i), i === 0 ? '/' : base(p), true));
    for (const [i, p] of c.list('List').entries()) rows.push(row(p, chain.length, i, base(p), false));
    root.replaceChildren(...rows);
  }
  return {
    build() {
      root = h('div', { class: 'vb-dir', tabindex: '0' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      const rowOf = (e: Event) => { const r = (e.target as Element).closest<HTMLElement>('.dir-row'); return r && root.contains(r) && root.getAttribute('aria-disabled') !== 'true' ? r : null; };
      root.addEventListener('click', e => {
        const r = rowOf(e);
        if (!r) return;
        sel = Number(r.dataset.index);
        c.props.ListIndex = sel;
        paint();
        c.fire('vbdirclick', { index: sel });
      });
      root.addEventListener('dblclick', e => {
        const r = rowOf(e);
        if (r && Number(r.dataset.index) !== -1) c.fire('vbdiropen', { path: r.dataset.path! });
      });
    },
    patch(k) {
      if (has(k, 'ListIndex')) sel = c.num('ListIndex');
      if (has(k, 'Path', 'List', 'ListIndex')) paint();
    },
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

const COMMONDIALOG_SVG = '<svg viewBox="0 0 32 32" width="32" height="32" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">'
  + '<rect x="4.5" y="5.5" width="23" height="21" fill="#fff" stroke="#000"/><rect x="5" y="6" width="22" height="3" fill="#000080"/>'
  + '<path d="M7 13h14M7 16h14M7 19h9" stroke="#000"/><rect x="19.500" y="19.500" width="6" height="5" fill="#ffff00" stroke="#000"/></svg>';

/** Invisible at run time; in the designer an icon, like the Timer. */
function commonDialog(c: Ctx): Renderer {
  return {
    build() { c.el.innerHTML = COMMONDIALOG_SVG; },
    patch() { /* nothing: the icon is fixed */ },
  };
}

/** Sel* property -> the format key it holds. */
const RTF_PROPS: readonly [string, keyof RtfFormat][] = [
  ['SelBold', 'bold'], ['SelItalic', 'italic'], ['SelUnderline', 'underline'], ['SelColor', 'color'], ['SelFontName', 'fontName'], ['SelFontSize', 'fontSize'],
];

/**
 * RichTextBox: an editable div (content: see richText.ts). Text is the plain text. The selection and its format are reported with
 * `vbselchange` ({ SelStart, SelLength, SelBold ... }) after the user moved or typed. Text with formats arrives as the prop `Runs` (see
 * encodeRuns; the run session computes SelText and Sel<Format> on its own copy), the selection as SelStart / SelLength, and a format set at an
 * insertion point as Sel<Format> (it waits for the next typing).
 */
function richTextBox(c: Ctx): Renderer {
  let input: HTMLElement;
  let cur = { start: 0, length: 0 };
  let pending: RtfPatch | null = null;
  let mouse = false;
  const font = (): FontValue => { const f = c.props.Font; return isFont(f) ? f : DEFAULTS.RichTextBox.Font as FontValue; };
  const base = (): RtfFormat => {
    const f = font();
    return { bold: f.bold, italic: f.italic, underline: f.underline, color: c.num('ForeColor'), fontName: f.name, fontSize: f.size };
  };
  const style = (el: HTMLElement, f: RtfPatch): void => {
    if (f.bold !== undefined) el.style.fontWeight = f.bold ? '700' : '400';
    if (f.italic !== undefined) el.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.underline !== undefined) el.style.textDecoration = f.underline ? 'underline' : 'none';
    if (f.color !== undefined) el.style.color = vbColorToCss(f.color);
    if (f.fontName !== undefined) el.style.fontFamily = fontFamily(f.fontName);
    if (f.fontSize !== undefined) el.style.fontSize = `${Math.round(f.fontSize * 96 / 72)}px`;
  };
  const length = (): number => (input.textContent ?? '').length;
  const clamp = (n: number): number => Math.min(Math.max(0, Math.round(n) || 0), length());
  const focused = (): boolean => input.ownerDocument.activeElement === input;
  const show = (): void => { if (focused()) setSelectionOffsets(input, cur.start, cur.length); };
  /** The format at the selection: the control's own, what the text says there, and what waits for the next typing. */
  const effective = (runs: Run[] = readRuns(input)): RtfFormat => ({ ...base(), ...formatAt(runs, cur.start, cur.length), ...(cur.length === 0 ? pending : null) });
  const write = (runs: Run[]): void => writeRuns(input, runs, style);

  /** The user moved the selection or typed. */
  function report(): void {
    const s = selectionOffsets(input);
    if (!s) return;
    if (s.start !== cur.start || s.length !== cur.length) pending = null;
    cur = s;
    const f = effective();
    c.fire('vbselchange', { SelStart: s.start, SelLength: s.length, SelBold: f.bold, SelItalic: f.italic, SelUnderline: f.underline,
      SelColor: f.color, SelFontName: f.fontName, SelFontSize: f.fontSize });
  }
  /** Typed text, Enter and paste go through the runs when a format is waiting (and always for Enter and paste: plain text only). */
  function insert(text: string): void {
    const s = selectionOffsets(input) ?? cur;
    cur = s;
    const runs = readRuns(input);
    write(replaceRange(runs, s.start, s.length, text, pending ? { ...formatAt(runs, s.start, s.length), ...pending } : null));
    cur = { start: s.start + text.length, length: 0 };
    pending = null;
    setSelectionOffsets(input, cur.start, 0);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  return {
    build() {
      input = h('div', { class: 'vb-input vb-rtf', contenteditable: 'true', spellcheck: false, role: 'textbox', 'aria-multiline': 'true' });
      input.addEventListener('input', report);
      input.addEventListener('keyup', report);
      input.addEventListener('mouseup', () => { mouse = false; report(); });
      input.addEventListener('mousedown', () => { mouse = true; });
      input.addEventListener('focus', () => { if (!mouse) show(); });   // SelStart set before SetFocus; a click puts the caret where it hit
      input.addEventListener('beforeinput', e => {
        const ie = e as InputEvent;
        let text: string | null = null;
        if (ie.inputType === 'insertParagraph' || ie.inputType === 'insertLineBreak') text = '\n';
        else if (ie.inputType === 'insertFromPaste' || ie.inputType === 'insertFromDrop') text = ie.dataTransfer?.getData('text/plain') ?? null;
        else if (ie.inputType === 'insertText' && pending) text = ie.data;
        if (text === null) return;
        ie.preventDefault();
        insert(text);
      });
      c.el.replaceChildren(input);
      c.setInput(input);
    },
    patch(k) {
      let rewrote = false;
      if (has(k, 'Runs') && c.str('Runs') !== '' && encodeRuns(readRuns(input)) !== c.str('Runs')) {   // text with formats (set by code, or the echo of the user's own typing)
        const runs = decodeRuns(c.str('Runs'));
        if (runs) { write(runs); rewrote = true; }
      }
      if (has(k, 'Text') && (input.textContent ?? '') !== c.str('Text')) {
        input.textContent = c.str('Text');
        pending = null;
        rewrote = true;
      }
      if (has(k, 'ScrollBars')) {
        const sb = c.num('ScrollBars');
        input.style.overflowX = sb === 1 || sb === 3 ? 'scroll' : 'hidden';
        input.style.overflowY = sb === 2 || sb === 3 ? 'scroll' : 'hidden';
        input.style.whiteSpace = sb === 1 || sb === 3 ? 'pre' : 'pre-wrap';
      }
      if (has(k, 'Locked', 'Enabled')) input.contentEditable = c.mode === 'run' && !c.bool('Locked') && c.bool('Enabled') ? 'true' : 'false';
      if (k === null) return;
      if (rewrote) { cur = { start: clamp(cur.start), length: 0 }; cur.length = clamp(cur.start + cur.length) - cur.start; }
      if (k.has('SelStart') || k.has('SelLength')) {
        const start = clamp(c.num('SelStart')), len = clamp(start + c.num('SelLength')) - start;
        if (start !== cur.start || len !== cur.length) { cur = { start, length: len }; pending = null; rewrote = true; }
      }
      if (rewrote) show();
      // a format set at an insertion point waits for the next typing (a format of a selection arrives as Runs)
      if (cur.length === 0) {
        const want: Record<string, string | number | boolean> = {};
        const eff = effective();
        for (const [prop, key] of RTF_PROPS) {
          if (!k.has(prop)) continue;
          const v = key === 'bold' || key === 'italic' || key === 'underline' ? c.bool(prop) : key === 'fontName' ? c.str(prop) : c.num(prop);
          if (v !== eff[key]) want[key] = v;
        }
        if (Object.keys(want).length) pending = { ...pending, ...want as RtfPatch };
      }
    },
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

// ---------------------------------------------------------------------------------------------------------------
// Shape, Line, Slider, UpDown

let svgSeq = 0;
const DASHES: Record<number, string> = { 2: '6 3', 3: '2 2', 4: '6 2 2 2', 5: '6 2 2 2 2 2' };
const HATCH: Record<number, string> = { 2: 'M0 3.5H8', 3: 'M3.5 0V8', 4: 'M0 8L8 0', 5: 'M0 0L8 8', 6: 'M0 3.5H8M3.5 0V8', 7: 'M0 8L8 0M0 0L8 8' };
const strokeAttrs = (style: number, width: number, color: string): string =>
  style === 0 || width <= 0 ? 'stroke="none"' : `stroke="${color}" stroke-width="${width}"${DASHES[style] ? ` stroke-dasharray="${DASHES[style]}"` : ''}`;

/** VB6 Shape: 0 Rectangle, 1 Square, 2 Oval, 3 Circle, 4 Rounded Rectangle, 5 Rounded Square; FillStyle 0 Solid, 1 Transparent, 2..7 hatches. */
function shape(c: Ctx): Renderer {
  const uid = `vbhatch${++svgSeq}`;
  let svg: SVGSVGElement;
  return {
    build() {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      c.el.replaceChildren(svg);
    },
    patch() {
      const W = Math.max(1, Math.round(twipsToPx(c.num('Width')))), H = Math.max(1, Math.round(twipsToPx(c.num('Height'))));
      const kind = c.num('Shape'), bw = Math.max(0, c.num('BorderWidth'));
      const square = kind === 1 || kind === 3 || kind === 5;
      const w = square ? Math.min(W, H) : W, hh = square ? Math.min(W, H) : H, x = (W - w) / 2, y = (hh === H ? 0 : (H - hh) / 2);
      const inset = bw / 2, iw = Math.max(0, w - bw), ih = Math.max(0, hh - bw);
      const geom = (attrs: string): string => kind === 2 || kind === 3
        ? `<ellipse cx="${x + w / 2}" cy="${y + hh / 2}" rx="${iw / 2}" ry="${ih / 2}" ${attrs}/>`
        : `<rect x="${x + inset}" y="${y + inset}" width="${iw}" height="${ih}"${kind === 4 || kind === 5 ? ` rx="${Math.min(w, hh) / 6}"` : ''} ${attrs}/>`;
      const fs = c.num('FillStyle');
      let out = '';
      if (c.num('BackStyle') === 1) out += geom(`fill="${c.color('BackColor')}" stroke="none"`);
      if (fs === 0) out += geom(`fill="${c.color('FillColor')}" stroke="none"`);
      else if (HATCH[fs]) {
        out += `<defs><pattern id="${uid}" width="8" height="8" patternUnits="userSpaceOnUse"><path d="${HATCH[fs]}" stroke="${c.color('FillColor')}" fill="none"/></pattern></defs>`;
        out += geom(`fill="url(#${uid})" stroke="none"`);
      }
      out += geom(`fill="none" ${strokeAttrs(c.num('BorderStyle'), bw, c.color('BorderColor'))}`);
      svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H));
      svg.innerHTML = out;
    },
    bg: () => null,
  };
}

/** VB6 Line: X1, Y1, X2, Y2 (twips, relative to the parent). The element is the bounding box; renderControl positions it. */
function line(c: Ctx): Renderer {
  let svg: SVGSVGElement;
  return {
    build() {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      c.el.replaceChildren(svg);
    },
    patch() {
      const x1 = twipsToPx(c.num('X1')), y1 = twipsToPx(c.num('Y1')), x2 = twipsToPx(c.num('X2')), y2 = twipsToPx(c.num('Y2'));
      const mx = Math.min(x1, x2), my = Math.min(y1, y2);
      const bw = Math.max(1, c.num('BorderWidth'));
      svg.setAttribute('width', String(Math.abs(x2 - x1))); svg.setAttribute('height', String(Math.abs(y2 - y1)));
      svg.innerHTML = `<line x1="${x1 - mx}" y1="${y1 - my}" x2="${x2 - mx}" y2="${y2 - my}" ${strokeAttrs(c.num('BorderStyle'), bw, c.color('BorderColor'))}/>`;
    },
    bg: () => null,
  };
}

/** Slider: a groove with a thumb and tick marks. User changes dispatch `input` (VB Scroll) and `change` (VB Change) on
 *  inputEl, like the scroll bars; the value is readable from `inputEl.dataset.value`. A vertical slider has Min at the top. */
function slider(c: Ctx): Renderer {
  let root: HTMLElement, rail: HTMLElement, thumb: HTMLElement, ticks: HTMLElement;
  let value = 0;
  let pending = false;
  const vertical = () => c.num('Orientation') === 1;
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
    const pct = `${round3(range > 0 ? ((value - lo()) / range) * 100 : 0)}%`;
    thumb.style.left = vertical() ? '' : pct;
    thumb.style.top = vertical() ? pct : '';
  }
  function drawTicks() {
    const style = c.num('TickStyle');
    ticks.replaceChildren();
    ticks.dataset.style = String(style);
    if (style === 3) return;
    const range = hi() - lo(), freq = Math.max(1, c.num('TickFrequency'));
    const count = Math.min(500, Math.floor(range / freq));
    const marks: string[] = [];
    for (let i = 0; i <= count; i++) marks.push(`${round3(range > 0 ? ((i * freq) / range) * 100 : 0)}%`);
    if (range > 0 && count * freq < range) marks.push('100%');
    const sides = style === 2 ? ['a', 'b'] : [style === 1 ? 'a' : 'b'];
    for (const side of sides) for (const m of marks) {
      ticks.appendChild(h('div', { class: `sl-tick ${side}`, style: { [vertical() ? 'top' : 'left']: m } }));
    }
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
  const fromPoint = (e: MouseEvent): number => {
    const r = rail.getBoundingClientRect();
    const len = vertical() ? r.height : r.width;
    const pos = vertical() ? e.clientY - r.top : e.clientX - r.left;
    return len > 0 ? lo() + Math.round((pos / len) * (hi() - lo())) : value;
  };

  return {
    structural: ['Orientation'],
    build() {
      c.el.classList.toggle('sl-vertical', vertical());
      thumb = h('div', { class: 'sl-thumb' });
      ticks = h('div', { class: 'sl-ticks' });
      rail = h('div', { class: 'sl-rail' }, h('div', { class: 'sl-groove' }), ticks, thumb);
      root = h('div', { class: 'vb-sl', role: 'slider', tabindex: '0', 'aria-orientation': vertical() ? 'vertical' : 'horizontal' }, rail);
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      const doc = c.el.ownerDocument;
      root.addEventListener('mousedown', e => {
        if (e.button !== 0 || root.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        root.focus();
        if (e.target === thumb) {
          const grab = fromPoint(e) - value;   // keeps the point where the thumb was grabbed under the pointer
          const move = (m: MouseEvent) => { set(fromPoint(m) - grab); };
          const up = () => { doc.removeEventListener('mousemove', move); commit(); };
          doc.addEventListener('mousemove', move);
          doc.addEventListener('mouseup', up, { once: true });
        } else {
          set(value + (fromPoint(e) < value ? -large() : large()));
          commit();
        }
      });
      root.addEventListener('keydown', e => {
        let next: number | null = null;
        const rev = vertical();   // Min is at the top of a vertical slider: Up/Left lower the value
        switch (e.key) {
          case 'ArrowLeft': case 'ArrowUp': next = value - small(); break;
          case 'ArrowRight': case 'ArrowDown': next = value + small(); break;
          case 'PageUp': next = rev ? value - large() : value + large(); break;
          case 'PageDown': next = rev ? value + large() : value - large(); break;
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
      if (has(k, 'Value', 'Min', 'Max', 'Orientation')) layout();
      if (has(k, 'Min', 'Max', 'TickFrequency', 'TickStyle', 'Orientation')) drawTicks();
    },
    bg: () => null,
  };
}

/** UpDown: two arrow buttons (stacked, or side by side when horizontal) that step Value by Increment, with Wrap.
 *  A click dispatches `vbupclick` / `vbdownclick`, then `change` when the value changed; value in `inputEl.dataset.value`. */
function upDown(c: Ctx): Renderer {
  let root: HTMLElement;
  let value = 0;
  let repeatTimer: ReturnType<typeof setTimeout> | undefined;
  let repeatInterval: ReturnType<typeof setInterval> | undefined;
  const lo = () => Math.min(c.num('Min'), c.num('Max'));
  const hi = () => Math.max(c.num('Min'), c.num('Max'));
  const stopRepeat = () => { clearTimeout(repeatTimer); clearInterval(repeatInterval); repeatTimer = repeatInterval = undefined; };

  function step(dir: 1 | -1): void {
    let v = value + dir * Math.max(1, c.num('Increment'));
    if (v > hi()) v = c.bool('Wrap') ? lo() : hi();
    else if (v < lo()) v = c.bool('Wrap') ? hi() : lo();
    const changed = v !== value;
    value = v;
    c.props.Value = v;
    root.dataset.value = String(v);
    root.setAttribute('aria-valuenow', String(v));
    c.fire(dir > 0 ? 'vbupclick' : 'vbdownclick');
    if (changed) c.fire('change');
  }

  return {
    structural: ['Orientation'],
    build() {
      stopRepeat();
      c.el.classList.toggle('ud-horizontal', c.num('Orientation') === 1);
      const up = h('div', { class: 'ud-btn up' }), down = h('div', { class: 'ud-btn down' });
      root = h('div', { class: 'vb-ud', role: 'spinbutton', tabindex: '0' }, up, down);
      root.dataset.value = String(value);
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      const doc = c.el.ownerDocument;
      const press = (dir: 1 | -1) => (e: Event) => {
        if ((e as MouseEvent).button !== 0 || root.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        root.focus();
        stopRepeat();
        step(dir);
        repeatTimer = setTimeout(() => { repeatInterval = setInterval(() => step(dir), 100); }, 400);
        doc.addEventListener('mouseup', stopRepeat, { once: true });
      };
      up.addEventListener('mousedown', press(1));
      down.addEventListener('mousedown', press(-1));
      root.addEventListener('keydown', e => {
        const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        step(dir);
      });
    },
    patch(k) {
      if (has(k, 'Value', 'Min', 'Max')) {
        value = Math.min(hi(), Math.max(lo(), c.num('Value')));
        root.dataset.value = String(value);
        root.setAttribute('aria-valuenow', String(value));
      }
    },
    bg: () => null,
  };
}

/** StatusBar: sunken panels ('Text|Key|Width|Alignment' lines; Width 0 shares the space left over) or, with Style
 *  sbrSimple, one panel with SimpleText. A click on a panel dispatches `vbpanelclick` ({ index }, 1-based) on inputEl. */
function statusBar(c: Ctx): Renderer {
  let root: HTMLElement;
  const ALIGN = ['left', 'center', 'right'];
  return {
    build() {
      root = h('div', { class: 'vb-stb' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode === 'run') {
        root.addEventListener('click', e => {
          const p = (e.target as Element).closest<HTMLElement>('.stb-panel');
          if (p && root.contains(p)) c.fire('vbpanelclick', { index: Number(p.dataset.index) });
        });
      }
    },
    patch(k) {
      if (!has(k, 'Panels', 'Style', 'SimpleText')) return;
      const simple = c.num('Style') === 1;
      const lines = simple ? [c.str('SimpleText')] : c.list('Panels');
      const panels = lines.map((line, i) => {
        const f = simple ? [line] : splitFields(line);
        const w = simple ? 0 : Number(f[2]) || 0, a = simple ? 0 : Number(f[3]) || 0;
        const p = h('div', { class: 'stb-panel', dataset: { index: String(i + 1) } }, h('span', {}, f[0] ?? ''));
        p.style.textAlign = ALIGN[a] ?? 'left';
        if (w > 0) { p.style.flex = 'none'; p.style.width = `${twipsToPx(w)}px`; } else p.style.flex = '1 1 0';
        return p;
      });
      root.replaceChildren(...panels, h('div', { class: 'stb-grip' }));
    },
    bg: () => null,
  };
}

/** TabStrip: tab headers over an empty body (not a container). The selected tab is `SelectedTab` (1-based); a click
 *  on a header (run mode) selects it and dispatches `vbtabclick` ({ index }) on inputEl. */
function tabStrip(c: Ctx): Renderer {
  let root: HTMLElement, tabs: HTMLElement;
  const select = (i: number) => {
    c.props.SelectedTab = i;
    paint();
    c.fire('vbtabclick', { index: i });
  };
  function paint() {
    const sel = c.num('SelectedTab');
    Array.from(tabs.children).forEach((t, i) => t.classList.toggle('selected', i + 1 === sel));
  }
  return {
    build() {
      tabs = h('div', { class: 'ts-tabs' });
      root = h('div', { class: 'vb-ts', tabindex: '0' }, h('div', { class: 'ts-body' }), tabs);
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      root.addEventListener('mousedown', e => {
        const t = (e.target as Element).closest<HTMLElement>('.ts-tab');
        if (!t || !tabs.contains(t) || e.button !== 0 || root.getAttribute('aria-disabled') === 'true') return;
        const i = Number(t.dataset.index);
        if (i !== c.num('SelectedTab')) select(i);
      });
      root.addEventListener('keydown', e => {
        const n = c.list('Tabs').length, d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d || !n) return;
        e.preventDefault();
        const next = Math.min(n, Math.max(1, c.num('SelectedTab') + d));
        if (next !== c.num('SelectedTab')) select(next);
      });
    },
    patch(k) {
      if (has(k, 'Tabs', 'ImageList', IMAGES_CHANGED)) {
        tabs.replaceChildren(...c.list('Tabs').map((line, i) => {
          const f = splitFields(line), img = f[2] ? c.image('ImageList', f[2]) : null;
          return h('div', { class: 'ts-tab', dataset: { index: String(i + 1) } }, ...(img ? [imageEl(img, 'ts-img')] : []), h('span', {}, ...mnemonicNodes(f[0] ?? '')));
        }));
      }
      if (has(k, 'Tabs', 'SelectedTab')) paint();
    },
    bg: () => null,
  };
}

/** TreeView: rows from the `Nodes` lines ('level|index|expanded|key|text', tree order); `SelectedNode` is the selected index.
 *  Run mode: a click on a +/- box (or a double click) toggles and dispatches `vbnodetoggle` ({ index, expanded }), a click on a node
 *  selects it and dispatches `vbnodeclick` ({ index }). */
function treeView(c: Ctx): Renderer {
  let root: HTMLElement;
  function paint() {
    const f = c.list('Nodes').map(splitFields), sel = c.num('SelectedNode'), indent = Math.max(0, twipsToPx(c.num('Indentation')));
    const rows: HTMLElement[] = [];
    let skip = -1;   // level below which the nodes are hidden by a collapsed parent
    f.forEach((n, i) => {
      const level = Number(n[0]) || 0;
      if (skip >= 0 && level > skip) return;
      skip = -1;
      const kids = i + 1 < f.length && Number(f[i + 1][0]) > level, open = n[2] === '1';
      if (kids && !open) skip = level;
      const isSel = Number(n[1]) === sel, img = c.image('ImageList', (isSel && n[6]) || n[5] || '');
      rows.push(h('div', { class: 'tv-row', dataset: { index: n[1] ?? '', kids: kids ? '1' : '0', open: open ? '1' : '0' },
        style: { paddingLeft: `${level * indent + 2}px`, ...(img && img.height > 16 ? { height: `${img.height}px` } : {}) } },
        h('span', { class: kids ? 'tv-tog' : 'tv-tog none' }, kids ? (open ? '-' : '+') : ''),
        ...(img ? [imageEl(img, 'tv-img')] : []),
        h('span', { class: Number(n[1]) === sel ? 'tv-text sel' : 'tv-text' }, n[4] ?? '')));
    });
    root.replaceChildren(...rows);
  }
  function toggle(row: HTMLElement): void {
    const index = row.dataset.index!, expanded = row.dataset.open !== '1';
    c.props.Nodes = c.list('Nodes').map(line => { const f = splitFields(line); if (f[1] !== index) return line; f[2] = expanded ? '1' : '0'; return joinFields(f); });
    paint();
    c.fire('vbnodetoggle', { index: Number(index), expanded });
  }
  return {
    build() {
      root = h('div', { class: 'vb-tv', tabindex: '0' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      const rowOf = (e: Event) => { const r = (e.target as Element).closest<HTMLElement>('.tv-row'); return r && root.contains(r) && root.getAttribute('aria-disabled') !== 'true' ? r : null; };
      root.addEventListener('click', e => {
        const row = rowOf(e);
        if (!row) return;
        if ((e.target as Element).closest('.tv-tog') && row.dataset.kids === '1') { toggle(row); return; }
        c.props.SelectedNode = Number(row.dataset.index);
        paint();
        c.fire('vbnodeclick', { index: Number(row.dataset.index) });
      });
      root.addEventListener('dblclick', e => { const row = rowOf(e); if (row?.dataset.kids === '1') toggle(row); });
    },
    patch(k) { if (has(k, 'Nodes', 'SelectedNode', 'Indentation', 'LineStyle', 'ImageList', IMAGES_CHANGED)) paint(); },
    bg: () => null,
  };
}

/** ListView: `ListItems` lines ('index|text|sub1|sub2…', index = collection index) in the four views; Report shows the
 *  `ColumnHeaders` ('Text|Key|Width|Alignment'). Sorted / SortKey / SortOrder only change the display order. Run mode: a click on an item
 *  dispatches `vbitemclick` ({ index }), on a column header `vbcolclick` ({ index }). */
function listView(c: Ctx): Renderer {
  let root: HTMLElement;
  const ALIGN = ['left', 'right', 'center'];
  function paint() {
    const view = c.num('View'), sel = c.num('SelectedIndex');
    let items = c.list('ListItems').map(splitFields);
    const icons = c.list('ListIcons').map(splitFields);
    // lvwIcon shows the big icon of the Icons list, the other views the small one of SmallIcons
    const iconOf = (f: string[]): ImageSource | null => {
      const ic = icons[Number(f[0]) - 1] ?? [];
      return view === 0 ? (ic[0] ? c.image('Icons', ic[0]) : null) : (ic[1] ? c.image('SmallIcons', ic[1]) : null);
    };
    if (c.bool('Sorted')) {
      const key = c.num('SortKey'), dir = c.num('SortOrder') === 1 ? -1 : 1;
      const val = (f: string[]): string => (f[1 + key] ?? '').toLowerCase();
      items = items.map((f, i) => ({ f, i })).sort((a, b) => (val(a.f) < val(b.f) ? -dir : val(a.f) > val(b.f) ? dir : a.i - b.i)).map(x => x.f);
    }
    root.className = `vb-lv lv-view${view}${c.bool('GridLines') ? ' lv-grid' : ''}${c.bool('FullRowSelect') ? ' lv-full' : ''}`;
    if (view === 3) {
      const cols = c.list('ColumnHeaders').map(splitFields);
      if (!cols.length) cols.push(['']);
      const style = (f: string[]) => ({ width: `${twipsToPx(Number(f[2]) || 1440)}px`, textAlign: ALIGN[Number(f[3])] ?? 'left' });
      const head = h('div', { class: 'lv-head' }, ...cols.map((f, i) => h('div', { class: 'lv-hcol', dataset: { index: String(i + 1) }, style: style(f) }, f[0] ?? '')));
      const rows = items.map(f => {
        const img = iconOf(f);
        return h('div', { class: Number(f[0]) === sel ? 'lv-row sel' : 'lv-row', dataset: { index: f[0] ?? '' } },
          ...cols.map((cf, j) => h('div', { class: j === 0 ? 'lv-cell first' : 'lv-cell', style: style(cf) }, ...(j === 0 && img ? [imageEl(img, 'lv-img')] : []), f[1 + j] ?? '')));
      });
      root.replaceChildren(head, ...rows);
    } else {
      root.replaceChildren(...items.map(f => {
        const img = iconOf(f);
        return h('div', { class: Number(f[0]) === sel ? 'lv-item sel' : 'lv-item', dataset: { index: f[0] ?? '' } },
          img ? imageEl(img, 'lv-ico lv-img') : h('span', { class: 'lv-ico' }), h('span', { class: 'lv-label' }, f[1] ?? ''));
      }));
    }
  }
  return {
    build() {
      root = h('div', { class: 'vb-lv', tabindex: '0' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      root.addEventListener('click', e => {
        if (root.getAttribute('aria-disabled') === 'true') return;
        const t = e.target as Element, col = t.closest<HTMLElement>('.lv-hcol'), item = t.closest<HTMLElement>('.lv-row, .lv-item');
        if (col && root.contains(col)) c.fire('vbcolclick', { index: Number(col.dataset.index) });
        else if (item && root.contains(item)) {
          c.props.SelectedIndex = Number(item.dataset.index);
          paint();
          c.fire('vbitemclick', { index: Number(item.dataset.index) });
        }
      });
    },
    patch(k) { if (has(k, 'ListItems', 'ListIcons', 'ColumnHeaders', 'SelectedIndex', 'View', 'GridLines', 'FullRowSelect', 'Sorted', 'SortKey', 'SortOrder', 'Icons', 'SmallIcons', IMAGES_CHANGED)) paint(); },
    bg: () => null,
  };
}

/** MSFlexGrid: a table of Rows x Cols; `Cells` is row-major, `ColWidths` / `RowHeights` / `ColAligns` are per column / row (twips,
 *  flexAlign*). The fixed rows and columns are grey. Run mode: a click on a cell that is not fixed sets Row and Col
 *  and dispatches `vbcellclick` ({ row, col }). */
function flexGrid(c: Ctx): Renderer {
  let root: HTMLElement;
  const nums = (n: string, d: number): number[] => c.list(n).map(x => (x === '' ? d : Number(x)));
  function paint() {
    const rows = Math.max(1, c.num('Rows')), cols = Math.max(1, c.num('Cols'));
    const fr = Math.min(c.num('FixedRows'), rows), fc = Math.min(c.num('FixedCols'), cols);
    const cells = c.list('Cells'), widths = nums('ColWidths', 975), heights = nums('RowHeights', 240), aligns = nums('ColAligns', 1);
    const row = c.num('Row'), col = c.num('Col'), mode = c.num('SelectionMode');
    const px = (t: number | undefined, d: number): number => Math.max(0, twipsToPx(t ?? d));
    const table = h('table', { class: `fg-table fg-lines${c.num('GridLines')}` });
    table.style.width = `${Array.from({ length: cols }, (_, i) => px(widths[i], 975)).reduce((a, b) => a + b, 0)}px`;
    table.append(h('colgroup', {}, ...Array.from({ length: cols }, (_, i) => h('col', { style: { width: `${px(widths[i], 975)}px` } }))));
    for (let r = 0; r < rows; r++) {
      const tr = h('tr', { style: { height: `${px(heights[r], 240)}px` } });
      for (let i = 0; i < cols; i++) {
        const fixed = r < fr || i < fc, text = cells[r * cols + i] ?? '', a = aligns[i] ?? 1;
        const on = !fixed && (mode === 1 ? r === row : mode === 2 ? i === col : r === row && i === col);
        const td = h('td', { class: `${fixed ? 'fixed' : ''}${on ? ' sel' : ''}`.trim() }, text);
        td.dataset.r = String(r); td.dataset.c = String(i);
        td.style.textAlign = fixed ? 'center' : a === 9 ? (text !== '' && !isNaN(Number(text)) ? 'right' : 'left') : (['left', 'center', 'right'][Math.floor(a / 3)] ?? 'left');
        td.style.verticalAlign = a === 9 ? 'middle' : (['top', 'middle', 'bottom'][a % 3] ?? 'middle');
        tr.append(td);
      }
      table.append(tr);
    }
    root.replaceChildren(table);
  }
  return {
    build() {
      root = h('div', { class: 'vb-fg', tabindex: '0' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      root.addEventListener('click', e => {
        const td = (e.target as Element).closest<HTMLElement>('td');
        if (!td || !root.contains(td) || td.classList.contains('fixed') || root.getAttribute('aria-disabled') === 'true') return;
        const [r, i] = [Number(td.dataset.r), Number(td.dataset.c)];
        c.props.Row = r; c.props.Col = i;
        paint();
        c.fire('vbcellclick', { row: r, col: i });
      });
    },
    patch(k) { if (has(k, 'Rows', 'Cols', 'FixedRows', 'FixedCols', 'Cells', 'ColWidths', 'RowHeights', 'ColAligns', 'Row', 'Col', 'GridLines', 'SelectionMode')) paint(); },
    bg: () => null,
  };
}

/** SSTab: tab headers (laid out by ssTabLayout) over a raised body, and one page per tab that holds the tab's children; only
 *  the page of `Tab` shows. A click on an enabled header (run mode) selects it and dispatches `vbsstabclick` ({ index, previous }). */
function ssTab(c: Ctx): Renderer {
  let root: HTMLElement, strip: HTMLElement, body: HTMLElement;
  const pages = new Map<number, HTMLElement>();
  const page = (i: number): HTMLElement => {
    let pg = pages.get(i);
    if (!pg) {
      pg = h('div', { class: 'sst-page', dataset: { tab: String(i) } });
      pg.style.display = i === c.num('Tab') ? '' : 'none';
      pages.set(i, pg);
      root.appendChild(pg);
    }
    return pg;
  };
  function paint() {
    const all: Record<string, PropValue> = { ...DEFAULTS.SSTab, Width: CONTROL_TYPES.SSTab.defaultWidth };
    for (const [k, v] of Object.entries(c.props)) if (v !== undefined) all[k] = v;
    const lay = ssTabLayout(all);
    const caps = c.list('TabCaption'), cur = c.num('Tab');
    strip.replaceChildren(...lay.tabs.map(t => {
      const el = h('div', { class: 'sst-tab', dataset: { index: String(t.index) } }, h('span', {}, ...mnemonicNodes(caps[t.index] ?? '')));
      Object.assign(el.style, { left: `${twipsToPx(t.left)}px`, top: `${twipsToPx(t.top)}px`, width: `${twipsToPx(t.width)}px`, height: `${twipsToPx(t.height)}px` });
      el.classList.toggle('selected', t.index === cur);
      el.classList.toggle('sst-disabled', !flagOn(all.TabEnabled, t.index));
      return el;
    }));
    body.style.top = `${twipsToPx(lay.bodyTop)}px`;
    for (const [i, pg] of pages) pg.style.display = i === cur ? '' : 'none';
  }
  const select = (i: number) => {
    const previous = c.num('Tab');
    c.props.Tab = i;
    c.props.Caption = c.list('TabCaption')[i] ?? '';
    paint();
    c.fire('vbsstabclick', { index: i, previous });
  };
  return {
    build() {
      strip = h('div', { class: 'sst-tabs' });
      body = h('div', { class: 'sst-body' });
      root = h('div', { class: 'vb-sst', tabindex: '0' }, body, strip);
      pages.clear();
      c.el.replaceChildren(root);
      c.setInput(root);
      c.setHostFor(child => page(Math.max(0, Math.floor(child.tab ?? 0))));
      if (c.mode !== 'run') return;
      root.addEventListener('mousedown', e => {
        const t = (e.target as Element).closest<HTMLElement>('.sst-tab');
        if (!t || !strip.contains(t) || e.button !== 0 || root.getAttribute('aria-disabled') === 'true' || t.classList.contains('sst-disabled')) return;
        const i = Number(t.dataset.index);
        if (i !== c.num('Tab')) select(i);
      });
      root.addEventListener('keydown', e => {
        if (e.target !== root) return;
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const n = c.num('Tabs');
        for (let i = c.num('Tab') + d; i >= 0 && i < n; i += d) {
          if (flagOn(c.props.TabEnabled, i) && flagOn(c.props.TabVisible, i)) { select(i); break; }
        }
      });
    },
    patch(k) { if (has(k, 'Tab', 'Tabs', 'TabCaption', 'TabsPerRow', 'Style', 'TabHeight', 'TabEnabled', 'TabVisible', 'Width', 'Caption')) paint(); },
    bg: () => null,
  };
}

const IMAGELIST_SVG = '<svg viewBox="0 0 32 32" width="32" height="32" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">'
  + '<rect x="3.500" y="4.500" width="14" height="12" fill="#fff" stroke="#000"/><path d="M4 16l4-5 3 3 2-2 4 4z" fill="#0000c0"/>'
  + '<rect x="12.500" y="14.500" width="14" height="12" fill="#fff" stroke="#000"/><path d="M13 26l4-5 3 3 2-2 4 4z" fill="#008000"/>'
  + '<circle cx="22" cy="18.500" r="1.500" fill="#c00000"/></svg>';

/** Invisible at run time; in the designer an icon, like the Timer. */
function imageList(c: Ctx): Renderer {
  return {
    build() { c.el.innerHTML = IMAGELIST_SVG; },
    patch() { /* nothing: the icon is fixed */ },
  };
}

/** Toolbar: buttons from the `Buttons` lines ('Caption|Key|Style|Image|ToolTipText', plus 'Value|Enabled|Visible' at run time), each with
 *  the picture `Image` (index or key) of the ImageList and its caption. Run mode: a click on an enabled button dispatches `vbbuttonclick`
 *  ({ index }, 1-based) on inputEl; the window toggles check and group buttons. */
function toolbar(c: Ctx): Renderer {
  let root: HTMLElement;
  function paint() {
    const bw = Math.max(1, twipsToPx(c.num('ButtonWidth'))), bh = Math.max(1, twipsToPx(c.num('ButtonHeight')));
    root.className = `vb-tbr${c.num('Style') === 1 ? ' tbr-flat' : ''}`;
    const els: HTMLElement[] = [];
    c.list('Buttons').map(parseButton).forEach((b, i) => {
      if (!b.visible) return;
      if (b.style === TBR_SEPARATOR) { els.push(h('div', { class: 'tbr-sep' })); return; }
      if (b.style === TBR_PLACEHOLDER) { els.push(h('div', { class: 'tbr-gap', style: { width: `${bw}px` } })); return; }
      const img = b.image ? c.image('ImageList', b.image) : null;
      const btn = h('div', {
        class: `tbr-btn${b.value ? ' pressed' : ''}${b.enabled ? '' : ' off'}`, dataset: { index: String(i + 1), enabled: b.enabled ? '1' : '0' },
        style: { minWidth: `${bw}px`, height: `${Math.max(bh, img ? img.height + 6 : 0)}px` },
      }, ...(img ? [imageEl(img, 'tbr-img')] : []), ...(b.caption ? [h('span', { class: 'tbr-cap' }, ...mnemonicNodes(b.caption))] : []),
        ...(b.style === TBR_DROPDOWN ? [h('span', { class: 'tbr-arrow' })] : []));
      if (c.mode === 'run' && c.bool('ShowTips') && b.tip) btn.title = b.tip;
      els.push(btn);
    });
    root.replaceChildren(...els);
  }
  return {
    build() {
      root = h('div', { class: 'vb-tbr' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (c.mode !== 'run') return;
      root.addEventListener('click', e => {
        const b = (e.target as Element).closest<HTMLElement>('.tbr-btn');
        if (b && root.contains(b) && b.dataset.enabled === '1' && root.getAttribute('aria-disabled') !== 'true') c.fire('vbbuttonclick', { index: Number(b.dataset.index) });
      });
    },
    patch(k) { if (has(k, 'Buttons', 'Style', 'ButtonWidth', 'ButtonHeight', 'ShowTips', 'ImageList', IMAGES_CHANGED)) paint(); },
    bg: () => null,
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
  DriveListBox: driveListBox,
  DirListBox: dirListBox,
  FileListBox: listBox,
  PictureBox: pictureBox,
  Image: image,
  Timer: timer,
  HScrollBar: c => scrollBar(c, true),
  VScrollBar: c => scrollBar(c, false),
  ProgressBar: progressBar,
  Shape: shape,
  Line: line,
  Slider: slider,
  UpDown: upDown,
  StatusBar: statusBar,
  TabStrip: tabStrip,
  TreeView: treeView,
  ListView: listView,
  MSFlexGrid: flexGrid,
  CommonDialog: commonDialog,
  RichTextBox: richTextBox,
  SSTab: ssTab,
  ImageList: imageList,
  Toolbar: toolbar,
};

// ---------------------------------------------------------------------------------------------------------------
// Control core

export function renderControl(def: ControlDef, mode: RenderMode, assets: AssetResolver, images: ImageLookup = () => null): ControlView {
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
    image: (listProp, ref) => images(ctx.str(listProp), ref),
    setInput: e => { view.inputEl = e; },
    setHost: e => { view.childHost = e; },
    setHostFor: f => { view.childHostFor = f; },
    fire: (type, detail) => {
      view.inputEl?.dispatchEvent(detail === undefined ? new Event(type, { bubbles: true }) : new CustomEvent(type, { bubbles: true, detail }));
    },
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
    if (def.type === 'Line') {
      if (has(keys, 'X1', 'Y1', 'X2', 'Y2')) {
        const [x1, x2, y1, y2] = [ctx.num('X1'), ctx.num('X2'), ctx.num('Y1'), ctx.num('Y2')];
        el.style.left = `${twipsToPx(Math.min(x1, x2))}px`;
        el.style.top = `${twipsToPx(Math.min(y1, y2))}px`;
        el.style.width = `${twipsToPx(Math.abs(x2 - x1))}px`;
        el.style.height = `${twipsToPx(Math.abs(y2 - y1))}px`;
      }
    } else if (has(keys, 'Left', 'Top', 'Width', 'Height')) {
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
        ie.tabIndex = props.TabStop === false || def.type === 'StatusBar' || def.type === 'Toolbar' ? -1 : 0;
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

  /** A StatusBar sits at the bottom edge of the form, full width; a Toolbar at the top (Align) or the bottom (it follows the form when it is resized). */
  function dock(): void {
    const m = formMetrics(props);
    for (const [id, d] of defs) {
      const v = views.get(id);
      const edge = dockEdge(d);
      if (!v || !edge) continue;
      const hPx = parseFloat(v.el.style.height) || twipsToPx(CONTROL_TYPES[d.type].defaultHeight);
      v.el.style.left = '0px';
      v.el.style.width = `${m.clientWidth}px`;
      v.el.style.top = edge === 'top' ? '0px' : `${Math.max(0, m.clientHeight - hPx)}px`;
    }
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
    return pv?.childHostFor?.(def) ?? pv?.childHost ?? clientEl;
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

  /** An ImageList's pictures by index or key (its current props, also after a change); null for an unknown list or image. */
  const imageLookup: ImageLookup = (name, ref) => {
    if (!name) return null;
    const l = name.toLowerCase();
    for (const d of defs.values()) {
      if (d.type !== 'ImageList' || d.name.toLowerCase() !== l) continue;
      const lines = Array.isArray(d.props.ListImages) ? d.props.ListImages.map(String) : [];
      const img = findListImage(lines, ref);
      const url = img && img.asset ? assets({ asset: img.asset }) : null;
      const dim = (k: string): number => (typeof d.props[k] === 'number' && (d.props[k] as number) > 0 ? d.props[k] as number : 16);
      return url ? { url, width: dim('ImageWidth'), height: dim('ImageHeight') } : null;
    }
    return null;
  };
  /** The controls that show pictures of an ImageList repaint them (an ImageList changed, was added, removed or renamed). */
  function imagesChanged(): void {
    for (const d of defs.values()) if (IMAGE_USERS.has(d.type)) views.get(d.id)?.update({ [IMAGES_CHANGED]: 1 });
  }

  function add(def: ControlDef, index?: number): void {
    if (views.has(def.id)) return;
    defs.set(def.id, def);
    views.set(def.id, renderControl(def, mode, assets, imageLookup));
    order.splice(index === undefined ? order.length : Math.max(0, Math.min(index, order.length)), 0, def.id);
  }

  const surface: FormSurface = {
    el, clientEl, drawLayer, views,
    update(id, changed) {
      if (id !== 'form') {
        let d = defs.get(id);
        if (d && !(IMAGES_CHANGED in changed)) defs.set(id, d = { ...d, props: { ...d.props, ...changed } });   // the lookups and dock() see the new values
        views.get(id)?.update(changed);
        if (!d) return;
        if ('Align' in changed && !isDocked(d)) views.get(id)?.update({ Left: d.props.Left ?? 0, Top: d.props.Top ?? 0, Width: d.props.Width ?? 0, Height: d.props.Height ?? 0 });
        if (isDocked(d)) dock();
        if (d.type === 'ImageList') imagesChanged();
        return;
      }
      const keys = new Set(Object.keys(changed));
      Object.assign(props, changed);
      const chrome = ['Width', 'Height', 'BorderStyle', 'ControlBox', 'MinButton', 'MaxButton', 'Icon'];
      if (chrome.some(k => keys.has(k))) { layoutChrome(); dock(); }
      else if (keys.has('Caption')) { const t = el.querySelector('.title-bar-text'); if (t) t.textContent = str('Caption'); }
      patchClient(keys);
    },
    rename(id, name) {
      const d = defs.get(id);
      if (!d || d.name === name) return;
      defs.set(id, { ...d, name });
      if (d.type === 'ImageList') imagesChanged();
    },
    addControl(def, index) {
      add(def, index);
      if (def.type === 'ImageList') imagesChanged();
      place(def.id);
      for (const d of defs.values()) if (d.parentId === def.id) place(d.id);   // children that arrived before their parent
      dock();
    },
    removeControl(id) {
      const doomed = new Set<string>([id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const d of defs.values()) if (d.parentId !== null && doomed.has(d.parentId) && !doomed.has(d.id)) { doomed.add(d.id); grew = true; }
      }
      const hadImages = [...doomed].some(d => defs.get(d)?.type === 'ImageList');
      for (const d of doomed) { views.get(d)?.el.remove(); views.delete(d); defs.delete(d); }
      order = order.filter(o => !doomed.has(o));
      if (hadImages) imagesChanged();
    },
    reorder(controls) {
      for (const d of controls) if (views.has(d.id)) defs.set(d.id, d);
      order = controls.map(d => d.id).filter(i => views.has(i));
      for (const i of order) hostOf(defs.get(i)!).appendChild(views.get(i)!.el);
      dock();
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
  for (const d of form.controls) defs.set(d.id, d);   // an ImageList further down the form is known when a Toolbar above it renders
  for (const d of form.controls) add(d);
  for (const id of [...order]) place(id);
  dock();
  return surface;
}
