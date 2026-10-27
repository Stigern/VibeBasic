// Pure helpers and dialogs for the Properties window: parsing/formatting of property values, the colour and font
// editors, and picture loading helpers.
import { PALETTE_48, SYSTEM_COLORS, vbColorToCss } from '../model/colors';
import type { PropDef } from '../model/controls';
import { generalDateText, localeDateParser } from '../lang/builtins/format';
import { parseDate } from '../lang/values';
import type { FontValue, PropValue } from '../model/types';
import { showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { createTabs } from '../ui98/tabs';
import './pickers.css';

export type ParseResult = { ok: true; value: PropValue } | { ok: false };
const FAIL: ParseResult = { ok: false };

/** Names of the system colours in the colour picker's System tab (keys of SYSTEM_COLORS). */
export const SYSTEM_COLOR_NAMES: Readonly<Record<number, string>> = {
  0x80000000: 'Scroll Bars', 0x80000001: 'Desktop', 0x80000002: 'Active Title Bar', 0x80000003: 'Inactive Title Bar',
  0x80000005: 'Window Background', 0x80000006: 'Window Frame', 0x80000008: 'Window Text', 0x80000009: 'Title Bar Text',
  0x8000000d: 'Highlight', 0x8000000e: 'Highlight Text', 0x8000000f: 'Button Face', 0x80000010: 'Button Shadow',
  0x80000011: 'Disabled Text', 0x80000012: 'Button Text', 0x80000014: 'Button Highlight', 0x80000015: 'Button Dark Shadow',
  0x80000016: 'Button Light Shadow', 0x80000017: 'Tooltip Text', 0x80000018: 'Tooltip Background',
};

/** `&H8000000F&` (8 unsigned hex digits). */
export function formatColor(n: number): string {
  return `&H${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}&`;
}

/** Accepts `&H…&`, `&H…` and decimal; values >= 0x80000000 are stored signed, like the interpreter produces them. */
function parseColor(text: string): ParseResult {
  const t = text.trim();
  let n: number;
  const hex = /^&h([0-9a-f]{1,8})&?$/i.exec(t);
  if (hex) n = parseInt(hex[1], 16);
  else if (/^-?\d+$/.test(t)) n = Number(t);
  else return FAIL;
  if (n < -0x80000000 || n > 0xffffffff) return FAIL;
  return { ok: true, value: n >= 0x80000000 ? n | 0 : n };
}

export function parsePropertyInput(def: PropDef, text: string): ParseResult {
  switch (def.kind) {
    case 'string': case 'text': return { ok: true, value: text };
    case 'list': return { ok: true, value: text === '' ? [] : text.split(/\r?\n/) };
    case 'int': {
      const t = text.trim();
      if (!(def.fraction ? /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i : /^-?\d+$/).test(t)) return FAIL;
      const n = Number(t);
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) return FAIL;
      return { ok: true, value: n };
    }
    case 'bool': {
      const t = text.trim().toLowerCase();
      if (t === 'true' || t === '-1') return { ok: true, value: true };
      if (t === 'false' || t === '0') return { ok: true, value: false };
      return FAIL;
    }
    case 'enum': {
      const t = text.trim();
      const m = /^(-?\d+)(\s*-\s*.*)?$/.exec(t);
      const byLabel = def.enumValues?.find(e => e.label.toLowerCase() === t.toLowerCase());
      const n = byLabel ? byLabel.value : m ? Number(m[1]) : NaN;
      return def.enumValues?.some(e => e.value === n) ? { ok: true, value: n } : FAIL;
    }
    case 'color': return parseColor(text);
    case 'date': {   // a date or time as CDate reads it; blank is no date (a DTPicker with CheckBox)
      if (text.trim() === '') return { ok: true, value: null };
      const d = parseDate(text, localeDateParser(Intl.DateTimeFormat().resolvedOptions().locale));
      return d ? { ok: true, value: d.serial } : FAIL;
    }
    default: return FAIL;
  }
}

/** The text shown in the Properties window for a value. */
export function formatPropertyValue(def: PropDef, value: PropValue | undefined): string {
  const v = value ?? def.default;
  switch (def.kind) {
    case 'bool': return v ? 'True' : 'False';
    case 'enum': return def.enumValues?.find(e => e.value === v)?.label ?? String(v);
    case 'color': return typeof v === 'number' ? formatColor(v) : '';
    case 'date': return typeof v === 'number' ? generalDateText(v, Intl.DateTimeFormat().resolvedOptions().locale) : '';
    case 'font': return typeof v === 'object' && v && 'name' in v ? v.name : '';
    case 'picture': return v ? '(Bitmap)' : '(None)';
    case 'list': return def.name === 'ListImages' ? '(Collection)' : Array.isArray(v) ? v.join(', ') : '';
    case 'text': return typeof v === 'string' ? v.replace(/\r?\n/g, ' ') : '';
    default: return v === null ? '' : String(v);
  }
}

const MIMES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };
export function mimeFromPath(path: string): string {
  return MIMES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------------------------------------------------------
// Colour picker (Palette / System tabs), shown under the value cell

export function createColorPopup(onPick: (n: number) => void, close: () => void): HTMLElement {
  const grid = h('div', { class: 'pw98-palette' }, ...PALETTE_48.map(c =>
    h('div', { class: 'pw98-swatch', title: formatColor(c), style: { background: vbColorToCss(c) }, onclick: () => { onPick(c); close(); } })));
  const sys = h('div', { class: 'pw98-syslist' }, ...Object.keys(SYSTEM_COLOR_NAMES).map(k => {
    const code = Number(k);
    return h('div', { class: 'pw98-sysitem', onclick: () => { onPick(code | 0); close(); } },
      h('span', { class: 'pw98-swatch-sm', style: { background: SYSTEM_COLORS[code] } }), SYSTEM_COLOR_NAMES[code]);
  }));
  const tabs = createTabs([{ label: 'Palette', content: grid }, { label: 'System', content: sys }]);
  return h('div', { class: 'pw98-popup' }, tabs.el);
}

/** The colour picker as a dialog (CommonDialog.ShowColor). Resolves with the chosen colour, or null when cancelled. */
export async function showColorDialog(doc: Document, cur: number): Promise<number | null> {
  let picked = cur;
  const preview = h('span', { class: 'pw98-swatch', style: { background: vbColorToCss(cur) } });
  const text = h('span', {}, formatColor(cur));
  const popup = createColorPopup(n => {
    picked = n;
    preview.style.background = vbColorToCss(n);
    text.textContent = formatColor(n);
  }, () => {});
  const content = h('div', { class: 'pw98-colordlg' }, popup, h('div', { class: 'pw98-colorpreview' }, 'Color:', preview, text));
  const r = await showDialog98(doc, { title: 'Color', content, buttons: [
    { label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }] });
  return r === 'ok' ? picked : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Font dialog

export const FONT_NAMES = ['MS Sans Serif', 'Arial', 'Courier New', 'Times New Roman', 'Tahoma', 'Verdana', 'Georgia',
  'Comic Sans MS', 'Helvetica', 'Geneva', 'Monaco'];

let chkSeq = 0;

/** Resolves with the chosen font, or null when cancelled. */
export async function showFontDialog(doc: Document, cur: FontValue): Promise<FontValue | null> {
  const names = FONT_NAMES.includes(cur.name) ? FONT_NAMES : [cur.name, ...FONT_NAMES];
  const fontList = h('select', { size: '7', class: 'pw98-fontlist', 'data-autofocus': '' },
    ...names.map(n => h('option', { value: n, selected: n === cur.name }, n)));
  const size = h('input', { type: 'number', min: '1', max: '999', step: '1', class: 'pw98-fontsize', value: String(cur.size) });
  // 98.css draws a checkbox only as `input + label[for]`
  const chk = (label: string, on: boolean) => {
    const id = `pw98-font-${label.toLowerCase()}-${++chkSeq}`;
    const box = h('input', { type: 'checkbox', checked: on, id });
    return { box, el: h('div', { class: 'pw98-fontchk' }, box, h('label', { for: id }, label)) };
  };
  const bold = chk('Bold', cur.bold), italic = chk('Italic', cur.italic), underline = chk('Underline', cur.underline);
  const sample = h('div', { class: 'pw98-fontsample' }, 'AaBbYyZz');
  const update = () => {
    sample.style.fontFamily = fontList.value;
    sample.style.fontWeight = bold.box.checked ? 'bold' : 'normal';
    sample.style.fontStyle = italic.box.checked ? 'italic' : 'normal';
    sample.style.textDecoration = underline.box.checked ? 'underline' : 'none';
  };
  for (const e of [fontList, bold.box, italic.box, underline.box]) e.addEventListener('change', update);
  update();
  const content = h('div', { class: 'pw98-fontdlg' },
    h('div', {}, h('div', {}, 'Font:'), fontList),
    h('div', {}, h('div', {}, 'Size:'), size, bold.el, italic.el, underline.el),
    h('div', {}, h('div', {}, 'Sample'), sample));
  const r = await showDialog98(doc, { title: 'Font', content, buttons: [
    { label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }] });
  if (r !== 'ok') return null;
  const n = Math.round(Number(size.value));
  return { name: fontList.value || cur.name, size: n >= 1 && n <= 999 ? n : cur.size,
    bold: bold.box.checked, italic: italic.box.checked, underline: underline.box.checked };
}
