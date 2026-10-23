// A picture of a form for the AI: a Win98-style schematic of the client area drawn on a canvas (no DOM screenshot), with each
// control drawn simply by type, its name small in its top-right corner, and light twip rulers (every 600 twips) along the top and left.
import { absoluteRect, shownInDesign } from '../ide/designerLogic';
import { CONTROL_TYPES } from '../model/controls';
import { dockedRect, formClientTwips, isDocked, isLine } from '../model/geometry';
import type { ControlDef, FormDef, PropValue } from '../model/types';
import { cssFont } from './layoutCheck';

export interface FormImageOptions {
  /** The largest picture in px (default 800 x 800; the probe on Qwen: 800 px wide is about 500 prompt tokens). */
  maxWidth?: number; maxHeight?: number;
  doc?: Document;
}
/** Rulers: a mark and label every 600 twips. */
export const RULER_STEP = 600;
const RULER_TOP = 18, RULER_LEFT = 34, TW = 15;

export interface PlacedControl { c: ControlDef; name: string; x: number; y: number; w: number; h: number; depth: number }
export interface FormImageLayout {
  width: number; height: number;
  /** Image px per form px (twips / 15). */
  scale: number;
  /** Where the client area starts in the image, and its size in px. */
  ox: number; oy: number; cw: number; ch: number;
  /** Ruler marks: their image position and the twips they stand for. */
  xMarks: { at: number; twips: number }[]; yMarks: { at: number; twips: number }[];
  /** The controls shown in the designer, containers before their children, siblings in z-order. */
  controls: PlacedControl[];
}

const nameOf = (c: ControlDef) => (c.index === null ? c.name : `${c.name}(${c.index})`);

/** Where everything goes in the picture (pure; the tests check this rather than pixels). */
export function layoutFormImage(form: FormDef, opts: FormImageOptions = {}): FormImageLayout {
  const cl = formClientTwips(form.props);
  const pw = Math.max(1, cl.width / TW), ph = Math.max(1, cl.height / TW);
  const scale = Math.max(0.25, Math.min(3, ((opts.maxWidth ?? 800) - RULER_LEFT) / pw, ((opts.maxHeight ?? 800) - RULER_TOP) / ph));
  const px = (twips: number) => (twips / TW) * scale;
  const cw = Math.round(px(cl.width)), ch = Math.round(px(cl.height));
  const xMarks: FormImageLayout['xMarks'] = [], yMarks: FormImageLayout['yMarks'] = [];
  for (let t = 0; t <= cl.width; t += RULER_STEP) xMarks.push({ at: RULER_LEFT + Math.round(px(t)), twips: t });
  for (let t = 0; t <= cl.height; t += RULER_STEP) yMarks.push({ at: RULER_TOP + Math.round(px(t)), twips: t });
  const controls: PlacedControl[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const c of form.controls) {
      if (c.parentId !== parentId) continue;
      if (shownInDesign(form, c.id)) {
        const r = isDocked(c) ? dockedRect(form, c) : absoluteRect(form, c.id);
        controls.push({ c, name: nameOf(c), x: RULER_LEFT + px(r.left), y: RULER_TOP + px(r.top), w: px(r.width), h: px(r.height), depth });
        visit(c.id, depth + 1);
      }
    }
  };
  visit(null, 0);
  return { width: RULER_LEFT + cw + 1, height: RULER_TOP + ch + 1, scale, ox: RULER_LEFT, oy: RULER_TOP, cw, ch, xMarks, yMarks, controls };
}

/** A VB6 colour (BGR Long) as CSS; system colours and missing values give `fallback`. */
function color(v: PropValue | undefined, fallback: string): string {
  if (typeof v !== 'number' || v < 0 || v > 0xffffff) return fallback;
  return `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`;
}
const str = (v: PropValue | undefined): string => (typeof v === 'string' ? v : '');
const caption = (c: ControlDef): string => str(c.props.Caption).replace(/&(.)/g, '$1');
const lines = (v: PropValue | undefined): string[] => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(/\r?\n/) : []);

/** The canvas calls the drawing uses (a CanvasRenderingContext2D, or a recording stub in tests). */
export type Ctx = Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'beginPath' | 'rect' | 'clip' | 'fillRect' | 'strokeRect' | 'fillText' | 'moveTo' | 'lineTo'
  | 'stroke' | 'fill' | 'arc' | 'ellipse' | 'measureText' | 'setLineDash'> & { fillStyle: unknown; strokeStyle: unknown; font: string; lineWidth: number; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline };

/** Draws the picture of `layout` (from layoutFormImage) on `ctx`. */
export function drawFormImage(ctx: Ctx, form: FormDef, L: FormImageLayout): void {
  const s = L.scale;
  const font = (px: number, bold = false) => `${bold ? 'bold ' : ''}${Math.max(8, Math.round(px))}px Tahoma, Arial, sans-serif`;
  // captions in the designer's font, scaled, so what fits in the picture fits in the form (and in the layout check)
  const textFont = cssFont(undefined).replace(/^(\d+)px/, (_m, n) => `${Math.round(Number(n) * s)}px`);
  const line = (x1: number, y1: number, x2: number, y2: number, c: string) => {
    ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(x1 + 0.5, y1 + 0.5); ctx.lineTo(x2 + 0.5, y2 + 0.5); ctx.stroke();
  };
  const fill = (x: number, y: number, w: number, h: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  /** A raised (button) or sunken (text box) 3D box. */
  const bevel = (x: number, y: number, w: number, h: number, raised: boolean, face: string) => {
    fill(x, y, w, h, face);
    const [tl, br] = raised ? ['#ffffff', '#000000'] : ['#808080', '#ffffff'];
    line(x, y, x + w - 1, y, tl); line(x, y, x, y + h - 1, tl);
    line(x, y + h - 1, x + w - 1, y + h - 1, br); line(x + w - 1, y, x + w - 1, y + h - 1, br);
    if (raised && w > 4 && h > 4) { line(x + 1, y + h - 2, x + w - 2, y + h - 2, '#808080'); line(x + w - 2, y + 1, x + w - 2, y + h - 2, '#808080'); }
  };
  const text = (t: string, x: number, y: number, align: CanvasTextAlign = 'left', c = '#000000', f = textFont) => {
    if (!t) return;
    ctx.font = f; ctx.fillStyle = c; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y);
  };
  const lineH = 13 * s, pad = 3 * s;

  // rulers and light guide lines
  fill(0, 0, L.width, L.height, '#ffffff');
  fill(L.ox, L.oy, L.cw, L.ch, color(form.props.BackColor, '#c0c0c0'));
  ctx.lineWidth = 1;
  for (const m of L.xMarks) {
    line(m.at, L.oy - 6, m.at, L.oy - 1, '#808080');
    if (m.twips) { ctx.setLineDash([2, 4]); line(m.at, L.oy, m.at, L.oy + L.ch, 'rgba(0,0,0,0.12)'); ctx.setLineDash([]); }
    text(String(m.twips), m.at, 7, m.twips ? 'center' : 'left', '#606060', font(9));
  }
  for (const m of L.yMarks) {
    line(L.ox - 6, m.at, L.ox - 1, m.at, '#808080');
    if (m.twips) { ctx.setLineDash([2, 4]); line(L.ox, m.at, L.ox + L.cw, m.at, 'rgba(0,0,0,0.12)'); ctx.setLineDash([]); }
    text(String(m.twips), L.ox - 8, m.at + (m.twips ? 0 : 4), 'right', '#606060', font(9));
  }
  ctx.strokeStyle = '#000000'; ctx.strokeRect(L.ox - 0.5, L.oy - 0.5, L.cw + 1, L.ch + 1);

  const clipTo = (x: number, y: number, w: number, h: number) => { ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); };
  const byId = new Map(L.controls.map(p => [p.c.id, p]));
  /** Draws one control, clipped to its rectangle (a caption that does not fit is cut, as in the form). */
  const draw = (p: PlacedControl) => {
    const x = Math.round(p.x), y = Math.round(p.y), w = Math.max(1, Math.round(p.w)), h = Math.max(1, Math.round(p.h));
    ctx.save();
    if (!isLine(p.c)) clipTo(x, y, w, h);
    drawControl(p, x, y, w, h);
    ctx.restore();
  };
  const drawControl = (p: PlacedControl, x: number, y: number, w: number, h: number) => {
    const { c } = p;
    const cap = caption(c), back = color(c.props.BackColor, '#c0c0c0'), fore = color(c.props.ForeColor, '#000000');
    const midY = y + h / 2;
    switch (c.type) {
      case 'CommandButton':
        bevel(x, y, w, h, true, back); text(cap, x + w / 2, midY, 'center', fore); break;
      case 'TextBox': case 'RichTextBox': case 'MaskedEdit':
        bevel(x, y, w, h, false, color(c.props.BackColor, '#ffffff'));
        text(str(c.props.Text), x + pad, c.props.MultiLine === true ? y + pad + lineH / 2 : midY, 'left', fore); break;
      case 'Label': {
        if (c.props.BackStyle !== 0) fill(x, y, w, h, back);
        if (c.props.BorderStyle === 1) bevel(x, y, w, h, false, back);
        else { ctx.setLineDash([3, 3]); ctx.strokeStyle = '#8a8a8a'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); ctx.setLineDash([]); }
        const al = c.props.Alignment === 1 ? 'right' : c.props.Alignment === 2 ? 'center' : 'left';
        text(cap, al === 'left' ? x + 1 : al === 'right' ? x + w - 1 : x + w / 2, y + lineH / 2, al, fore); break;
      }
      case 'CheckBox': case 'OptionButton': {
        const b = 13 * s, by = midY - b / 2;
        if (c.type === 'CheckBox') { bevel(x, by, b, b, false, '#ffffff'); if (c.props.Value === 1) text('x', x + b / 2, midY, 'center', '#000000', font(11 * s, true)); }
        else {
          ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#808080'; ctx.beginPath(); ctx.arc(x + b / 2, midY, b / 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          if (c.props.Value === true) { ctx.fillStyle = '#000000'; ctx.beginPath(); ctx.arc(x + b / 2, midY, b / 5, 0, Math.PI * 2); ctx.fill(); }
        }
        text(cap, x + b + 5 * s, midY, 'left', fore); break;
      }
      case 'Frame': {
        const top = y + lineH / 2;
        fill(x, y, w, h, back);
        ctx.strokeStyle = '#808080'; ctx.strokeRect(x + 0.5, top + 0.5, w - 2, h - (top - y) - 2);
        ctx.strokeStyle = '#ffffff'; ctx.strokeRect(x + 1.5, top + 1.5, w - 2, h - (top - y) - 2);
        if (cap) { ctx.font = textFont; const tw = ctx.measureText(cap).width; fill(x + 7 * s, y, tw + 4 * s, lineH, back); text(cap, x + 9 * s, top, 'left', fore); }
        break;
      }
      case 'ListBox': case 'FileListBox': case 'DirListBox': {
        bevel(x, y, w, h, false, color(c.props.BackColor, '#ffffff'));
        const items = c.type === 'ListBox' ? lines(c.props.List) : [c.type === 'DirListBox' ? '[folders]' : '[files]'];
        items.slice(0, Math.max(0, Math.floor((h - 4) / lineH))).forEach((t, i) => text(t, x + pad, y + 2 + lineH * (i + 0.5), 'left', fore));
        break;
      }
      case 'ComboBox': case 'DriveListBox': case 'DTPicker': {
        bevel(x, y, w, h, false, '#ffffff');
        const bw = Math.min(w / 2, 16 * s);
        bevel(x + w - bw - 2, y + 2, bw, h - 4, true, '#c0c0c0');
        text('v', x + w - bw / 2 - 2, midY, 'center', '#000000', font(9 * s, true));
        text(c.type === 'ComboBox' ? str(c.props.Text) : c.type === 'DTPicker' ? str(c.props.Value) : str(c.props.Drive), x + pad, midY, 'left', fore);
        break;
      }
      case 'HScrollBar': case 'VScrollBar': {
        fill(x, y, w, h, '#e0e0e0');
        const hz = c.type === 'HScrollBar', b = hz ? Math.min(h, w / 3) : Math.min(w, h / 3);
        if (hz) { bevel(x, y, b, h, true, '#c0c0c0'); bevel(x + w - b, y, b, h, true, '#c0c0c0'); bevel(x + b, y, b, h, true, '#c0c0c0'); }
        else { bevel(x, y, w, b, true, '#c0c0c0'); bevel(x, y + h - b, w, b, true, '#c0c0c0'); bevel(x, y + b, w, b, true, '#c0c0c0'); }
        break;
      }
      case 'Shape': {
        ctx.strokeStyle = color(c.props.BorderColor, '#000000');
        const shape = Number(c.props.Shape) || 0;
        if (shape === 2 || shape === 3) { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
        else ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        break;
      }
      case 'Line': {
        const n = (k: string) => Number(c.props[k]) || 0;
        const parent = c.parentId ? byId.get(c.parentId) : undefined;
        const bx = parent ? parent.x : L.ox, byy = parent ? parent.y : L.oy;
        line(bx + (n('X1') / TW) * s, byy + (n('Y1') / TW) * s, bx + (n('X2') / TW) * s, byy + (n('Y2') / TW) * s, color(c.props.BorderColor, '#000000'));
        break;
      }
      case 'StatusBar': case 'Toolbar': {
        bevel(x, y, w, h, true, '#c0c0c0');
        const items = lines(c.type === 'StatusBar' ? c.props.Panels : c.props.Buttons).map(l => l.split('|')[0]);
        let at = x + pad;
        for (const t of items) {
          ctx.font = textFont;
          const tw = Math.max(ctx.measureText(t).width + 8 * s, 20 * s);
          if (c.type === 'StatusBar') bevel(at, y + 2, tw, h - 4, false, '#c0c0c0'); else bevel(at, y + 2, tw, h - 4, true, '#c0c0c0');
          text(t, at + 4 * s, midY); at += tw + 2 * s;
        }
        break;
      }
      case 'SSTab': case 'TabStrip': {
        const tabH = c.type === 'SSTab' ? ((typeof c.props.TabHeight === 'number' ? c.props.TabHeight : 520) / TW) * s : 20 * s;
        const caps = c.type === 'SSTab' ? lines(c.props.TabCaption) : lines(c.props.Tabs).map(l => l.split('|')[0]);
        const count = c.type === 'SSTab' ? Math.max(1, Number(c.props.Tabs) || caps.length || 1) : Math.max(1, caps.length);
        const current = c.type === 'SSTab' ? Number(c.props.Tab) || 0 : 0;
        bevel(x, y + tabH, w, h - tabH, true, '#c0c0c0');
        const tw = w / count;
        for (let i = 0; i < count; i++) {
          bevel(x + i * tw, y + (i === current ? 0 : 2 * s), tw - 1, tabH - (i === current ? 0 : 2 * s), true, '#c0c0c0');
          text(caps[i] ?? `Tab ${i}`, x + i * tw + tw / 2, y + tabH / 2, 'center', fore);
        }
        break;
      }
      case 'ProgressBar': case 'Slider': case 'UpDown':
        if (c.type === 'ProgressBar') { bevel(x, y, w, h, false, '#c0c0c0'); for (let i = 0; i < 4; i++) fill(x + 3 + i * 10 * s, y + 3, 8 * s, h - 6, '#000080'); }
        else if (c.type === 'Slider') { line(x + pad, midY, x + w - pad, midY, '#808080'); bevel(x + w / 3, y + 2, 10 * s, h - 4, true, '#c0c0c0'); }
        else { bevel(x, y, w, h / 2, true, '#c0c0c0'); bevel(x, y + h / 2, w, h / 2, true, '#c0c0c0'); }
        break;
      case 'PictureBox': case 'Image':
        if (c.type === 'PictureBox') bevel(x, y, w, h, false, back);
        else { ctx.setLineDash([4, 3]); ctx.strokeStyle = '#000000'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); ctx.setLineDash([]); }
        if (c.type === 'Image' || c.props.Picture) text('(picture)', x + w / 2, midY, 'center', '#606060');
        break;
      default:
        if (CONTROL_TYPES[c.type].invisibleAtRuntime) { bevel(x, y, w, h, true, '#c0c0c0'); text(c.type, x + w / 2, midY, 'center', '#000000', font(8 * s)); }
        else { bevel(x, y, w, h, false, '#ffffff'); text(c.type, x + w / 2, midY, 'center', '#808080'); }
    }
  };
  /** Draws `p` and, clipped to it, its children. */
  const drawTree = (p: PlacedControl) => {
    draw(p);
    if (!CONTROL_TYPES[p.c.type].isContainer) return;
    ctx.save();
    clipTo(Math.round(p.x), Math.round(p.y), Math.round(p.w), Math.round(p.h));
    for (const k of L.controls) if (k.c.parentId === p.c.id) drawTree(k);
    ctx.restore();
  };
  ctx.save();
  clipTo(L.ox, L.oy, L.cw, L.ch);
  for (const p of L.controls) if (p.depth === 0) drawTree(p);
  // the names last, on top of everything: small and navy in each control's bottom-right corner; for a control whose caption fills it
  // (low ones, Labels, CheckBoxes, OptionButtons) just below it, so the tag does not hide the end of the caption
  const tag = font(Math.min(10, 7 + s)), TAG_H = 11;
  ctx.font = tag;
  for (const p of L.controls) {
    if (isLine(p.c)) continue;
    const tw = ctx.measureText(p.name).width + 4;
    const outside = (p.h < 40 || p.c.type === 'Label' || p.c.type === 'CheckBox' || p.c.type === 'OptionButton') && p.y + p.h + TAG_H <= L.oy + L.ch;
    const tx = Math.round(p.x + p.w) - tw - 1, ty = outside ? Math.round(p.y + p.h) + 1 : Math.round(p.y + p.h) - TAG_H - 2;
    fill(tx, ty, tw, TAG_H, 'rgba(255,255,225,0.85)');
    text(p.name, tx + 2, ty + 6, 'left', '#000080', tag);
  }
  ctx.restore();
}

/** The picture of `form` as a PNG data URL. Rejects where there is no canvas (jsdom). */
export async function renderFormImage(form: FormDef, opts: FormImageOptions = {}): Promise<string> {
  const doc = opts.doc ?? document;
  const L = layoutFormImage(form, opts);
  const canvas = doc.createElement('canvas');
  canvas.width = L.width; canvas.height = L.height;
  if (/jsdom/i.test(doc.defaultView?.navigator.userAgent ?? '')) throw new Error('No canvas here.');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas here.');
  drawFormImage(ctx, form, L);
  return canvas.toDataURL('image/png');
}
