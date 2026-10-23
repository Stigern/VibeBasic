// What the drawing layer needs from the browser: text pixels and decoded pictures (both through a canvas), and the canvas a
// form window shows a surface on (GfxLayer). Without a canvas (jsdom in tests) text and pictures are not drawn and the layer
// shows nothing; the run session's copy of the pixels still works.

import { GfxRenderer, type Decoded, type GfxOp, type Glyphs, type ImageSource } from './raster';

let scratch: CanvasRenderingContext2D | null | undefined;
/** A 2D context for text and pictures; null without a canvas (or in jsdom, which has none). */
function context(): CanvasRenderingContext2D | null {
  if (scratch !== undefined) return scratch;
  scratch = null;
  try {
    if (typeof document !== 'undefined' && !/jsdom/i.test(globalThis.navigator?.userAgent ?? '')) {
      scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    }
  } catch { /* no canvas */ }
  return scratch;
}

export const canvasAvailable = (): boolean => context() !== null;

/** The pixels of a text in a CSS font (the top of the em box at row 0). */
export function textGlyphs(t: string, font: string): Glyphs | null {
  const ctx = context();
  if (!ctx || t === '') return null;
  ctx.font = font;
  const m = ctx.measureText(t);
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 11);
  const w = Math.max(1, Math.ceil(m.width)), h = Math.max(1, Math.ceil(px * 1.5));
  const cv = ctx.canvas;
  if (cv.width < w) cv.width = w;
  if (cv.height < h) cv.height = h;
  ctx.font = font;   // a canvas resize resets the state
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  const ascent = Math.round(m.fontBoundingBoxAscent ?? px * 0.8);
  ctx.fillText(t, 0, ascent);
  const data = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3];
  return { w, h, a, base: ascent };
}

const decoded = new Map<string, Decoded | null>();
const loading = new Map<string, Promise<void>>();

/** Decoded pictures by URL, shared by every surface of this document. `resolve` turns an asset key into a URL. */
export function imageSource(resolve: (src: string) => string | null): ImageSource {
  return {
    get(src) {
      const url = resolve(src);
      if (url === null || !canvasAvailable()) return null;
      return decoded.has(url) ? decoded.get(url)! : undefined;
    },
    load(src) {
      const url = resolve(src);
      if (url === null || !canvasAvailable() || decoded.has(url)) return Promise.resolve();
      let p = loading.get(url);
      if (!p) {
        p = decode(url).then(d => {
          if (decoded.size > 48) decoded.delete(decoded.keys().next().value!);
          decoded.set(url, d);
          loading.delete(url);
        });
        loading.set(url, p);
      }
      return p;
    },
  };
}

function decode(url: string): Promise<Decoded | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        if (!ctx || w === 0 || h === 0) { resolve(null); return; }
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;
        resolve({ w, h, px: new Uint32Array(data.buffer.slice(0)) });
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The drawing of one Form or PictureBox in a form window: a canvas in its draw-layer, behind the child controls. */
export class GfxLayer {
  private readonly renderer: GfxRenderer | null = null;
  private readonly canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private scheduled = false;

  constructor(host: HTMLElement, resolve: (src: string) => string | null) {
    if (!canvasAvailable()) return;
    this.canvas = host.ownerDocument.createElement('canvas');
    this.canvas.className = 'vb-gfx';
    this.canvas.style.cssText = 'position:absolute;left:0;top:0;image-rendering:pixelated;pointer-events:none';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.renderer = new GfxRenderer(imageSource(resolve), textGlyphs, () => this.schedule());
  }

  /** Ops as the session sends them (one JSON string each). */
  push(ops: readonly unknown[]): void {
    if (!this.renderer) return;
    const list: GfxOp[] = [];
    for (const o of ops) {
      try { const v: unknown = JSON.parse(String(o)); if (v && typeof v === 'object' && 'o' in v) list.push(v as GfxOp); } catch { /* skip */ }
    }
    this.renderer.push(list);
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const raf = globalThis.requestAnimationFrame ?? ((f: FrameRequestCallback) => setTimeout(() => f(0), 16));
    raf(() => { this.scheduled = false; this.blit(); });
  }

  private blit(): void {
    const r = this.renderer?.raster, cv = this.canvas, ctx = this.ctx;
    if (!r || !cv || !ctx) return;
    if (r.resized || !this.image || this.image.width !== r.cw || this.image.height !== r.ch) {
      if (cv.width !== r.w) cv.width = r.w;
      if (cv.height !== r.h) cv.height = r.h;
      this.image = r.cw > 0 && r.ch > 0 ? new ImageData(new Uint8ClampedArray(r.px.buffer, 0, r.cw * r.ch * 4), r.cw, r.ch) : null;
      r.resized = false;
      r.dirty = [0, 0, r.w - 1, r.h - 1];
    }
    const d = r.dirty;
    r.dirty = null;
    if (!d || !this.image) return;
    const x0 = Math.max(0, d[0]), y0 = Math.max(0, d[1]), x1 = Math.min(r.w - 1, d[2]), y1 = Math.min(r.h - 1, d[3]);
    if (x1 < x0 || y1 < y0) return;
    ctx.putImageData(this.image, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  dispose(): void { this.canvas?.remove(); }
}
