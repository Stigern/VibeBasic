// The layout check of a proposed form (form mode): overlapping controls, controls outside their container, sizes below a
// sensible minimum, captions that do not fit, near-misaligned edges and uneven gaps. Each problem names the controls and numbers.
// Also the caption measure that "autosize" uses (formMode.ts).
import { sizeOf } from '../ide/designerLogic';
import { CONTROL_TYPES } from '../model/controls';
import { dockedRect, formClientTwips, isDocked, isLine } from '../model/geometry';
import { hasMenuBar } from '../model/menus';
import type { ControlDef, ControlType, FontValue, FormDef } from '../model/types';

const TW = 15;
const PIXEL_FONT = '"Pixelated MS Sans Serif", Tahoma, Geneva, sans-serif';

/** Advance widths in px of MS Sans Serif 8 (11 px), roughly; other characters count 6 (lower case) or 7 (upper case). */
const CHAR_PX: Record<string, number> = { ' ': 3, m: 9, w: 8, M: 9, W: 11, I: 3, J: 5 };
for (const c of "il.,:;'!|") CHAR_PX[c] = 3;
for (const c of 'fjrt()[]-') CHAR_PX[c] = 4;

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** A canvas 2D context for measuring text, or null (no canvas, or jsdom, which has none). */
function measurer(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  measureCtx = null;
  try {
    if (typeof document !== 'undefined' && !/jsdom/i.test(globalThis.navigator?.userAgent ?? '')) measureCtx = document.createElement('canvas').getContext('2d');
  } catch { /* no canvas */ }
  return measureCtx;
}

const isFont = (v: unknown): v is FontValue => typeof v === 'object' && v !== null && !Array.isArray(v) && 'size' in v;
/** The CSS font of a control's caption (as the designer draws it). */
export function cssFont(font: unknown): string {
  const f = isFont(font) ? font : null;
  const px = Math.round((f?.size ?? 8) * 96 / 72);
  const name = f?.name.replace(/["\\]/g, '').trim();
  const family = !name || /^ms sans serif$/i.test(name) ? PIXEL_FONT : `"${name}", ${PIXEL_FONT}`;
  return `${f?.italic ? 'italic ' : ''}${f?.bold ? 'bold ' : ''}${px}px ${family}`;
}

/** The width in px of `text` in `font` (a Font property value): canvas measureText when there is a canvas, else an estimate. */
export function textWidthPx(text: string, font?: unknown): number {
  const ctx = measurer();
  if (ctx) { ctx.font = cssFont(font); return Math.ceil(ctx.measureText(text).width); }
  const f = isFont(font) ? font : null;
  const scale = (f?.size ?? 8) / 8 * (f?.bold ? 1.1 : 1);
  let w = 0;
  for (const c of text) w += CHAR_PX[c] ?? (c >= 'A' && c <= 'Z' ? 7 : 6);
  return Math.ceil(w * scale);
}

/** The caption as shown: the longest line, without the & of an access key. */
export const captionText = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/&(.)/g, '$1').split(/\r?\n/).reduce((a, b) => (b.length > a.length ? b : a), '') : '';

/** Extra width in px a control needs around its caption text (borders, padding, the box of a CheckBox). */
export const CAPTION_PAD: Partial<Record<ControlType, number>> = { CommandButton: 10, Label: 1, CheckBox: 22, OptionButton: 22, Frame: 22 };

/** The smallest sensible Width and Height per type (twips); 0 = no rule. */
const MIN_SIZE: Partial<Record<ControlType, [number, number]>> = {
  CommandButton: [375, 255], TextBox: [375, 255], Label: [120, 195], CheckBox: [255, 195], OptionButton: [255, 195],
  ListBox: [375, 255], ComboBox: [600, 0], Frame: [600, 375], MaskedEdit: [375, 255], DTPicker: [900, 255],
};
/** Types that count as similar for the alignment and gap rules. */
const GROUP: Partial<Record<ControlType, string>> = {
  TextBox: 'input', ComboBox: 'input', ListBox: 'input', MaskedEdit: 'input', DTPicker: 'input', RichTextBox: 'input',
  CheckBox: 'check', OptionButton: 'check',
};

interface Item { c: ControlDef; name: string; left: number; top: number; width: number; height: number; key: string }
const nameOf = (c: ControlDef) => (c.index === null ? c.name : `${c.name}(${c.index})`);
const right = (r: Item) => r.left + r.width, bottom = (r: Item) => r.top + r.height;

/** One layout problem: its text and a stable key (the rule and the controls it names, not its numbers). */
export interface LayoutProblem { key: string; text: string }

/** The layout problems of `form` as text, at most `limit` (default 12). See layoutProblems. */
export function checkLayout(form: FormDef, only?: Set<string>, limit = 12): string[] {
  return [...new Set(layoutProblems(form, only).map(p => p.text))].slice(0, limit);
}

/**
 * All layout problems of `form` (no cap). With `only` (lower-case names), just the problems that name one of those controls.
 * Controls that are hidden (Visible = False), invisible at run time, Lines and Shapes are left out.
 * Valid VB6 idioms are not reported: a Frame without caption or border has no caption strip, a Label without caption
 * (a separator line) has no minimum size, and an Image (a background picture) may lie under other controls.
 */
export function layoutProblems(form: FormDef, only?: Set<string>): LayoutProblem[] {
  const byId = new Map(form.controls.map(c => [c.id, c]));
  const items: Item[] = [];
  for (const c of form.controls) {
    const td = CONTROL_TYPES[c.type];
    if (td.invisibleAtRuntime || isLine(c) || c.type === 'Shape' || c.type === 'Menu' || c.props.Visible === false) continue;
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    const r = isDocked(c) ? dockedRect(form, c) : { left: Number(c.props.Left) || 0, top: Number(c.props.Top) || 0, ...sizeOf(c) };
    items.push({ c, name: nameOf(c), ...r, key: `${c.parentId ?? ''}|${parent?.type === 'SSTab' ? c.tab ?? 0 : ''}` });
  }
  const problems: LayoutProblem[] = [];
  const seen = new Set<string>();
  const add = (names: string[], text: string, rule: string) => {
    if (only && !names.some(n => only.has(n.toLowerCase()))) return;
    const key = `${rule}|${names.map(n => n.toLowerCase()).sort().join(',')}`;
    if (!seen.has(key)) { seen.add(key); problems.push({ key, text }); }
  };
  const client = formClientTwips(form.props, hasMenuBar(form.controls));

  for (const it of items) {
    const { c, name } = it;
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    // outside the container's client area
    if (!isDocked(c)) {
      const pw = parent ? sizeOf(parent).width : client.width, ph = parent ? sizeOf(parent).height : client.height;
      const where = parent ? `${parent.type} ${nameOf(parent)} (Width ${pw}, Height ${ph})` : `the form (client area ${client.width} x ${client.height})`;
      if (it.left < 0) add([name], `${name} (Left ${it.left}) starts left of ${where}.`, 'out-left');
      if (it.top < 0) add([name], `${name} (Top ${it.top}) starts above ${where}.`, 'out-top');
      if (right(it) > pw) add([name], `${name} (Left ${it.left}, Width ${it.width}) goes ${right(it) - pw} twips past the right edge of ${where}.`, 'out-right');
      if (bottom(it) > ph) add([name], `${name} (Top ${it.top}, Height ${it.height}) goes ${bottom(it) - ph} twips past the bottom edge of ${where}.`, 'out-bottom');
      if (!parent) {
        // squeezed against the form's edge (1 to 59 twips away): leave a margin
        const gaps: [string, number][] = [['left', it.left], ['top', it.top], ['right', pw - right(it)], ['bottom', ph - bottom(it)]];
        for (const [edge, d] of gaps) if (d >= 1 && d < 60) add([name], `${name} is only ${d} twips from the ${edge} edge of the form; leave about 240 (or resize the form).`, `edge-${edge}`);
      }
      const frameCaption = parent?.type === 'Frame' && captionText(parent.props.Caption) !== '' && parent.props.BorderStyle !== 0;
      if (frameCaption && it.top >= 0 && it.top < 120) add([name], `${name} (Top ${it.top}) is under the caption of Frame ${nameOf(parent!)}; use Top 240 or more.`, 'frame');
      const tabH = parent?.type === 'SSTab' ? (typeof parent.props.TabHeight === 'number' ? parent.props.TabHeight : 520) : 0;
      if (tabH && it.top >= 0 && it.top < tabH) add([name], `${name} (Top ${it.top}) is under the tabs of SSTab ${nameOf(parent!)} (TabHeight ${tabH}); use Top ${tabH + 120} or more.`, 'tab');
    }
    // too small
    const min = c.type === 'Label' && captionText(c.props.Caption) === '' ? undefined : MIN_SIZE[c.type];
    if (min && !isDocked(c)) {
      if (min[0] && it.width < min[0]) add([name], `${name} is ${it.width} twips wide; a ${c.type} needs at least ${min[0]}.`, 'min-width');
      if (min[1] && it.height < min[1]) add([name], `${name} is ${it.height} twips high; a ${c.type} needs at least ${min[1]}${c.type === 'CommandButton' ? ' (a normal one is 375 to 495)' : ''}.`, 'min-height');
    }
    // caption that does not fit
    const pad = CAPTION_PAD[c.type];
    const caption = captionText(c.props.Caption);
    if (pad !== undefined && caption && !(c.type === 'Label' && c.props.AutoSize === true)) {
      const need = (textWidthPx(caption, c.props.Font) + pad) * TW;
      const wrap = c.type === 'Label' && c.props.WordWrap === true;
      const lineH = Math.round(13 * (isFont(c.props.Font) ? c.props.Font.size : 8) / 8) * TW;
      if (wrap ? Math.ceil(need / Math.max(1, it.width)) * lineH > it.height + TW : need > it.width + TW) {
        add([name], `The Caption "${caption}" of ${name} needs about ${Math.ceil(need / 15) * 15} twips but the ${c.type} is ${it.width} wide${wrap ? ` and ${it.height} high` : ''}; it is cut off.`, 'caption');
      }
    }
  }

  // siblings: overlaps, near-misaligned edges, uneven gaps
  const groups = new Map<string, Item[]>();
  for (const it of items) groups.set(it.key, [...(groups.get(it.key) ?? []), it]);
  for (const sib of groups.values()) {
    for (let i = 0; i < sib.length; i++) {
      for (let j = i + 1; j < sib.length; j++) {
        const a = sib[i], b = sib[j];
        const ox = Math.min(right(a), right(b)) - Math.max(a.left, b.left), oy = Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top);
        if (ox > 0 && oy > 0) {
          if (!CONTROL_TYPES[a.c.type].isContainer && !CONTROL_TYPES[b.c.type].isContainer && a.c.type !== 'Image' && b.c.type !== 'Image') {
            add([a.name, b.name], `${a.name} (Left ${a.left}, Top ${a.top}, ${a.width} x ${a.height}) and ${b.name} (Left ${b.left}, Top ${b.top}, ${b.width} x ${b.height}) overlap by ${ox} x ${oy} twips.`, 'overlap');
          }
          continue;
        }
        if ((GROUP[a.c.type] ?? a.c.type) !== (GROUP[b.c.type] ?? b.c.type) || isDocked(a.c) || isDocked(b.c)) continue;
        const dl = Math.abs(a.left - b.left), dt = Math.abs(a.top - b.top);
        if (ox > 0 && dl >= 1 && dl <= 60) add([a.name, b.name], `${a.name} (Left ${a.left}) and ${b.name} (Left ${b.left}) are in one column but ${dl} twips apart; give them the same Left.`, 'column');
        if (oy > 0 && dt >= 1 && dt <= 60) add([a.name, b.name], `${a.name} (Top ${a.top}) and ${b.name} (Top ${b.top}) are in one row but ${dt} twips apart; give them the same Top.`, 'row');
      }
    }
    // rows (same Top within 60) and columns (same Left within 60) of 3 or more similar controls
    for (const axis of ['row', 'column'] as const) {
      const by = new Map<string, Item[]>();
      for (const it of sib) if (!isDocked(it.c)) by.set(GROUP[it.c.type] ?? it.c.type, [...(by.get(GROUP[it.c.type] ?? it.c.type) ?? []), it]);
      for (const list of by.values()) {
        const pos = (r: Item) => (axis === 'row' ? r.top : r.left);
        const used = new Set<Item>();
        for (const seed of list) {
          if (used.has(seed)) continue;
          const line = list.filter(r => !used.has(r) && Math.abs(pos(r) - pos(seed)) <= 60);
          line.forEach(r => used.add(r));
          if (line.length < 3) continue;
          line.sort((p, q) => (axis === 'row' ? p.left - q.left : p.top - q.top));
          const gaps = line.slice(1).map((r, k) => (axis === 'row' ? r.left - right(line[k]) : r.top - bottom(line[k])));
          const lo = Math.min(...gaps), hi = Math.max(...gaps);
          if (lo >= 0 && hi - lo > 120 && hi > 1.5 * lo) {
            add(line.map(r => r.name), `The gaps between ${line.map(r => r.name).join(', ')} (a ${axis}) are ${gaps.join(', ')} twips; make them equal.`, `gaps-${axis}`);
          }
        }
      }
    }
  }
  return problems;
}
