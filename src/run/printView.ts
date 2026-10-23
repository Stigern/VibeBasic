// The pages of a print job as a document, for the print window (form.html#print-<n>, see tauriFormHost.ts) and the inline host:
// one sheet per page at its paper size (a CSS px is 1/96 inch, 15 twips, so a page prints at its real size), with a Win98 "Print
// Preview" frame around them on the screen only.
//
// - Printer pages: the GfxOps drawn again by the drawing layer at PRINT_SCALE times the screen resolution, shown as an image.
// - PrintForm pages: the form mounted as its window shows it (controls and drawing), cut to its client area.
// - A landscape page is shown as such on the screen and turned a quarter (counter-clockwise) onto portrait paper in print, so the
//   print dialog's own orientation can stay portrait.
// - Copies: the document holds the pages `copies` times (collated); the extra copies only print.

import { formMetrics } from '../controls/render';
import { canvasAvailable, imageSource, textGlyphs } from '../gfx/dom';
import { GfxRenderer, type GfxOp, type ImageSource } from '../gfx/raster';
import { createTitleBar, h } from '../ui98/dom';
import { mountFormWindow } from './formWindow';
import { PAPER_TWIPS, type PrintJob, type PrintPage } from './printing';

/** Printer pages are drawn at 192 dpi. */
const PRINT_SCALE = 2;

const CSS = `
.vb-print-root { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.vb-print-root > .window-body { flex: 1; display: flex; flex-direction: column; margin: 0; min-height: 0; }
.vb-print-bar { display: flex; gap: 6px; padding: 4px; align-items: center; }
.vb-print-bar .vb-print-count { margin-left: auto; padding-right: 4px; }
.vb-print-list { flex: 1; overflow: auto; background: #808080; padding: 12px; box-shadow: inset 1px 1px #0a0a0a, inset -1px -1px #fff; }
.vb-print-zoom { zoom: 0.75; }
.vb-print-sheet { width: var(--sw); height: var(--sh); position: relative; overflow: hidden; background: #fff; margin: 0 auto 16px; box-shadow: 3px 3px 0 #000; }
.vb-print-sheet.landscape { width: var(--sh); height: var(--sw); }
.vb-print-page { position: absolute; left: 0; top: 0; width: var(--pw); height: var(--ph); }
.vb-print-area { position: absolute; overflow: hidden; }
.vb-print-area img { display: block; }
.vb-print-form { position: absolute; left: 0; top: 0; pointer-events: none; }
.vb-print-copy { display: none; }
@media print {
  html, body, #form { height: auto !important; overflow: visible !important; background: #fff !important; }
  .vb-print-root { display: block; height: auto; box-shadow: none !important; padding: 0 !important; border: none !important; }
  .vb-print-root > .title-bar, .vb-print-bar { display: none !important; }
  .vb-print-root > .window-body { display: block; margin: 0; }
  .vb-print-list { overflow: visible; background: none; padding: 0; box-shadow: none; }
  .vb-print-zoom { zoom: 1; }
  .vb-print-copy { display: block; }
  .vb-print-sheet, .vb-print-sheet.landscape { width: var(--sw); height: var(--sh); margin: 0; box-shadow: none; break-after: page; page-break-after: always; }
  .vb-print-last { break-after: auto; page-break-after: auto; }
  .vb-print-sheet.landscape > .vb-print-page { transform: translateY(var(--sh)) rotate(-90deg); transform-origin: 0 0; }
}
`;

/** A Printer op at `k` times the size (a PaintPicture without a size gets the picture's own, which has to be loaded by now). */
function scaled(op: GfxOp, k: number, images: ImageSource): GfxOp {
  const pen = (w: number): number => Math.max(1, Math.round(w * k));
  switch (op.o) {
    case 'pset': return { ...op, x: op.x * k, y: op.y * k, w: pen(op.w) };
    case 'line': case 'box': return { ...op, x1: op.x1 * k, y1: op.y1 * k, x2: op.x2 * k, y2: op.y2 * k, w: pen(op.w) };
    case 'arc': return { ...op, x: op.x * k, y: op.y * k, rx: op.rx * k, ry: op.ry * k, w: pen(op.w) };
    case 'text': return { ...op, x: op.x * k, y: op.y * k, lh: op.lh * k, f: op.f.replace(/(\d+(?:\.\d+)?)px/, (_, n: string) => `${Number(n) * k}px`) };
    case 'pic': {
      const img = images.get(op.src);
      const sw = op.sw !== undefined && op.sw !== 0 ? op.sw : (img?.w ?? 0) - (op.sx ?? 0);
      const sh = op.sh !== undefined && op.sh !== 0 ? op.sh : (img?.h ?? 0) - (op.sy ?? 0);
      return { ...op, x: op.x * k, y: op.y * k, w: (op.w ?? sw) * k, h: (op.h ?? sh) * k };
    }
    default: return op;
  }
}

/** A Printer page's drawing as an image of its printable area. */
async function drawnPage(p: PrintPage, resolve: (src: string) => string | null): Promise<HTMLImageElement> {
  const ops: GfxOp[] = [];
  for (const s of p.ops ?? []) {
    try { const v = JSON.parse(s) as GfxOp; if (v && typeof v === 'object' && 'o' in v && v.o !== 'size' && v.o !== 'back') ops.push(v); } catch { /* skip */ }
  }
  const images = imageSource(resolve);
  await Promise.all(ops.flatMap(op => (op.o === 'pic' ? [images.load(op.src).catch(() => {})] : [])));
  const k = PRINT_SCALE, pw = Math.ceil(p.w * k), ph = Math.ceil(p.h * k);
  const r = new GfxRenderer(images, textGlyphs);
  r.push([{ o: 'size', w: pw, h: ph }, { o: 'back', c: 0xffffff }, ...ops.map(op => scaled(op, k, images))]);
  const img = document.createElement('img');
  img.alt = '';
  img.style.cssText = `width:${p.w}px;height:${p.h}px`;
  const ras = r.raster;
  if (!canvasAvailable() || ras.cw === 0 || ras.ch === 0) return img;
  const cv = document.createElement('canvas');
  cv.width = pw; cv.height = ph;
  const ctx = cv.getContext('2d');
  if (ctx) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(ras.px.buffer, 0, ras.cw * ras.ch * 4), ras.cw, ras.ch), 0, 0);
    img.src = cv.toDataURL('image/png');
  }
  return img;
}

/** PrintForm: the form as its window shows it, cut to its client area. */
function formPage(p: PrintPage, area: HTMLElement): void {
  const s = p.form!;
  const holder = h('div', { class: 'vb-print-form' });
  area.appendChild(holder);
  mountFormWindow(holder, s, () => {});
  const m = formMetrics(s.form.props);
  const form = holder.querySelector<HTMLElement>('.vb-form'), client = holder.querySelector<HTMLElement>('.vb-form-client');
  if (form && client) {
    const fr = form.getBoundingClientRect(), cr = client.getBoundingClientRect();
    holder.style.left = `${fr.left - cr.left}px`;
    holder.style.top = `${fr.top - cr.top}px`;
  }
  area.style.width = `${Math.min(p.w, m.clientWidth)}px`;
  area.style.height = `${Math.min(p.h, m.clientHeight)}px`;
}

/** One sheet of paper with the page on it; `copy`: a further copy (printed only). */
async function sheet(p: PrintPage, paperSize: number, resolve: (src: string) => string | null, copy: boolean): Promise<HTMLElement> {
  const [pw, ph] = (PAPER_TWIPS[paperSize] ?? PAPER_TWIPS[9]).map(t => t / 15);
  const area = h('div', { class: 'vb-print-area' });
  area.style.cssText = `left:${p.left}px;top:${p.top}px;width:${p.w}px;height:${p.h}px`;
  const el = h('div', { class: `vb-print-sheet${p.paperW > p.paperH ? ' landscape' : ''}${copy ? ' vb-print-copy' : ''}` },
    h('div', { class: 'vb-print-page' }, area));
  el.style.cssText = `--sw:${pw}px;--sh:${ph}px;--pw:${p.paperW}px;--ph:${p.paperH}px`;
  if (!p.form) area.appendChild(await drawnPage(p, resolve));
  return el;
}

export interface PrintPreview { dispose(): void }

/**
 * Shows the job in `root` (the print window's body, or an overlay of the inline host): the frame, then the pages. Resolves when
 * every page is drawn, so printing can start.
 */
export async function mountPrintPreview(root: HTMLElement, job: PrintJob, o: { onPrint(): void; onClose(): void }): Promise<PrintPreview> {
  const doc = root.ownerDocument;
  const style = doc.createElement('style');
  const paper = job.paperSize === 1 ? 'letter' : 'A4';
  style.textContent = `${CSS}\n@page { size: ${paper} portrait; margin: 0; }`;
  doc.head.appendChild(style);
  const resolve = (src: string): string | null => job.assets?.[src] ?? (src.startsWith('data:') ? src : null);

  const zoom = h('div', { class: 'vb-print-zoom' });
  const list = h('div', { class: 'vb-print-list' }, zoom);
  const n = job.pages.length;
  const bar = h('div', { class: 'vb-print-bar' },
    h('button', { type: 'button', onclick: () => o.onPrint() }, 'Print...'),
    h('button', { type: 'button', onclick: () => o.onClose() }, 'Close'),
    h('span', { class: 'vb-print-count' }, n === 1 ? '1 page' : `${n} pages`));
  const title = createTitleBar(`Print Preview - ${job.title}`, { onClose: () => o.onClose() });
  const win = h('div', { class: 'window vb-print-root' }, title.bar, h('div', { class: 'window-body' }, bar, list));
  root.appendChild(win);

  const copies = Math.max(1, Math.min(99, Math.floor(job.copies) || 1));
  const total = copies * n;
  let i = 0;
  for (let c = 0; c < copies; c++) {
    for (const p of job.pages) {
      const el = await sheet(p, job.paperSize, resolve, c > 0);
      if (++i === total) el.classList.add('vb-print-last');
      zoom.appendChild(el);
      if (p.form) formPage(p, el.querySelector<HTMLElement>('.vb-print-area')!);   // measured: it has to be in the document
    }
  }
  return { dispose: () => { win.remove(); style.remove(); } };
}
