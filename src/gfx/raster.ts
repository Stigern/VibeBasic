// The drawing surface of a Form, a PictureBox (and the Printer page): a bitmap of 32-bit pixels and the VB6 drawing operations
// on it (GfxOp), done in software. The run session keeps one copy (Point, Image, SavePicture) and the form window another (its
// canvas); both apply the same ops in the same order, so they hold the same pixels.
//
// Pixels are 0xAABBGGRR, the byte order of ImageData on a little-endian machine, so a drawn pixel is 0xFF000000 | a VB colour
// (&H00BBGGRR); 0 means "not drawn" (the BackColor and the Picture show through there). Coordinates in ops are pixels of the
// surface (floats; rounded here), already converted from the program's ScaleMode by the session.
//
// GDI rules kept: a Line leaves out its last pixel; DrawWidth > 1 draws solid with round ends (DrawStyle 1-4 only apply to
// DrawWidth 1); DrawMode is the ROP2 of the pen and of the fill, and every pixel of one shape is touched once (vbXorPen twice over
// the same shape restores it); FillStyle 2-7 are 8x8 hatches aligned to the surface; a dash gap and a hatch background take the
// BackColor only when the background mode is opaque (FontTransparent = False).

/** A drawing operation, as the session sends it to the window (JSON, one string per op). */
export type GfxOp =
  | { o: 'size'; w: number; h: number }            // the visible size in px (the bitmap grows to it and never shrinks)
  | { o: 'back'; c: number }                       // the BackColor (BGR): what undrawn pixels read as
  | { o: 'cls' }
  | ({ o: 'pset'; x: number; y: number } & Pen)
  | ({ o: 'line'; x1: number; y1: number; x2: number; y2: number } & Pen)
  /** `Line ..., B` (fs, fc: FillStyle and FillColor of the inside) or `BF` (fs -1: filled with the pen colour). */
  | ({ o: 'box'; x1: number; y1: number; x2: number; y2: number; fs: number; fc: number } & Pen)
  /** Circle: an ellipse, or an arc from a1 to a2 (radians, counter-clockwise from 3 o'clock; a negative one also draws its radius). */
  | ({ o: 'arc'; x: number; y: number; rx: number; ry: number; a1?: number; a2?: number; fs: number; fc: number } & Pen)
  /** Print: one line of text, top left at x, y; lh the line height; u underline; ob an opaque background (FontTransparent False). */
  | { o: 'text'; x: number; y: number; t: string; c: number; f: string; lh: number; u?: 1; ob?: 1 }
  /** PaintPicture: `src` an asset key or data URL; w/h the destination size (absent: the picture's own, negative: mirrored),
   *  sx..sh the part of the picture (absent: all of it); `rop` the raster operation (vbSrcCopy &HCC0020 ...). */
  | { o: 'pic'; src: string; x: number; y: number; w?: number; h?: number; sx?: number; sy?: number; sw?: number; sh?: number; rop: number }
  /** A copy of drawn pixels (the session's copy when the window opens): base64 of 0xAABBGGRR pixels, row by row. */
  | { o: 'bits'; x: number; y: number; w: number; h: number; d: string };

/** The pen of a shape: colour (BGR), DrawWidth (px), DrawStyle, DrawMode; ob: the dash gaps take the BackColor. */
export interface Pen { c: number; w: number; s: number; m: number; ob?: 1 }

/** Text pixels: coverage 0..255 per pixel (w x h), `base` the baseline row. */
export interface Glyphs { w: number; h: number; a: Uint8Array; base: number }
/** A decoded picture: 0xAABBGGRR pixels. */
export interface Decoded { w: number; h: number; px: Uint32Array }

export interface RasterHooks {
  /** The pixels of a text in a CSS font; null when nothing can draw text here (tests). */
  text?(t: string, font: string): Glyphs | null;
  /** A decoded picture; null when it cannot be decoded. */
  image?(src: string): Decoded | null;
}

const OPAQUE = 0xff000000;
const TWO_PI = Math.PI * 2;
/** Win9x cosmetic pen patterns (on, off, ...) for DrawStyle 1-4. */
const PATTERNS: Record<number, number[]> = { 1: [18, 6], 2: [3, 3], 3: [9, 6, 3, 6], 4: [9, 3, 3, 3, 3, 3] };

const rnd = (v: number): number => Math.floor(v + 0.5);

/** DrawMode (ROP2) of pen colour p over destination d, both BGR. */
function rop2(m: number, p: number, d: number): number {
  switch (m) {
    case 1: return 0;
    case 2: return ~(p | d);
    case 3: return d & ~p;
    case 4: return ~p;
    case 5: return p & ~d;
    case 6: return ~d;
    case 7: return p ^ d;
    case 8: return ~(p & d);
    case 9: return p & d;
    case 10: return ~(p ^ d);
    case 11: return d;
    case 12: return d | ~p;
    case 14: return p | ~d;
    case 15: return p | d;
    case 16: return 0xffffff;
    default: return p;   // 13 vbCopyPen
  }
}

/** PaintPicture's raster operations that use only source and destination; any other is drawn as vbSrcCopy. */
function rop3(op: number, s: number, d: number): number {
  switch (op) {
    case 0xee0086: return s | d;          // vbSrcPaint
    case 0x8800c6: return s & d;          // vbSrcAnd
    case 0x660046: return s ^ d;          // vbSrcInvert
    case 0x440328: return s & ~d;         // vbSrcErase
    case 0x330008: return ~s;             // vbNotSrcCopy
    case 0x1100a6: return ~(s | d);       // vbNotSrcErase
    case 0xbb0226: return ~s | d;         // vbMergePaint
    case 0x550009: return ~d;             // vbDstInvert
    case 0x000042: return 0;              // BLACKNESS
    case 0xff0062: return 0xffffff;       // WHITENESS
    default: return s;                    // vbSrcCopy (and the pattern operations)
  }
}

/** Whether FillStyle `fs` (0 solid, 2..7 hatches) paints the pixel (x, y). */
function hatch(fs: number, x: number, y: number): boolean {
  switch (fs) {
    case 0: return true;
    case 2: return (y & 7) === 0;
    case 3: return (x & 7) === 0;
    case 4: return ((x + y) & 7) === 0;
    case 5: return ((x - y) & 7) === 0;
    case 6: return (y & 7) === 0 || (x & 7) === 0;
    case 7: return ((x + y) & 7) === 0 || ((x - y) & 7) === 0;
    default: return false;
  }
}

const discs = new Map<number, Int16Array>();
/** The pixel offsets (dx, dy pairs) of a round pen DrawWidth `w` wide. */
function disc(w: number): Int16Array {
  let d = discs.get(w);
  if (d) return d;
  const a = Math.floor((w - 1) / 2), b = w - 1 - a, c = (b - a) / 2, r2 = (w / 2) * (w / 2);
  const out: number[] = [];
  for (let j = -a; j <= b; j++) for (let i = -a; i <= b; i++) if ((i - c) ** 2 + (j - c) ** 2 <= r2 + 0.25) out.push(i, j);
  d = Int16Array.from(out);
  if (discs.size < 64) discs.set(w, d);
  return d;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class Raster {
  /** The visible size (px). */
  w = 0;
  h = 0;
  /** The bitmap's size (it grows, so drawings survive a smaller window). */
  cw = 0;
  ch = 0;
  px = new Uint32Array(0);
  /** BackColor (BGR): what an undrawn pixel reads as. */
  back = 0xc0c0c0;
  /** The area drawn on since the last Cls (x0, y0, x1, y1 inclusive); null when nothing was drawn. */
  drawn: [number, number, number, number] | null = null;
  /** The area changed since the owner last looked (it resets it). */
  dirty: [number, number, number, number] | null = null;
  /** The bitmap was replaced (new size): the owner redraws all of it. */
  resized = false;
  private stamp = new Int32Array(0);
  private serial = 0;
  // the current shape's pen
  private pc = 0;
  private pm = 13;
  private pattern: number[] | null = null;
  private patTotal = 0;
  private patPos = 0;
  private gapBack = false;

  constructor(private hooks: RasterHooks = {}) {}

  /** The colour (BGR) at a pixel; -1 outside the surface. */
  get(x: number, y: number): number {
    const xi = rnd(x), yi = rnd(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return -1;
    const p = this.px[yi * this.cw + xi];
    return p === 0 ? this.back : p & 0xffffff;
  }

  /** Whether the pixel was drawn on (not BackColor or Picture). */
  isDrawn(x: number, y: number): boolean {
    const xi = rnd(x), yi = rnd(y);
    return xi >= 0 && yi >= 0 && xi < this.w && yi < this.h && this.px[yi * this.cw + xi] !== 0;
  }

  apply(op: GfxOp): void {
    switch (op.o) {
      case 'size': this.resize(Math.max(0, Math.round(op.w)), Math.max(0, Math.round(op.h))); return;
      case 'back': this.back = op.c & 0xffffff; return;
      case 'cls':
        this.px.fill(0);
        this.drawn = null;
        this.mark(0, 0, this.w - 1, this.h - 1);
        return;
      case 'pset': {
        if (op.s === 5) return;
        this.begin(op);
        const x = rnd(op.x), y = rnd(op.y);
        if (op.w > 1) this.dot(x, y, op.w); else this.plot(x, y, this.pc);
        return;
      }
      case 'line': {
        if (op.s === 5) return;
        this.begin(op);
        const thin = op.w <= 1;
        this.stroke([rnd(op.x1), rnd(op.y1), rnd(op.x2), rnd(op.y2)], op.w, !thin);   // GDI: the last pixel is left out
        return;
      }
      case 'box': return this.box(op);
      case 'arc': return this.arc(op);
      case 'text': return this.text(op);
      case 'pic': return this.picture(op);
      case 'bits': {
        const bytes = fromBase64(op.d);
        const src = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
        for (let j = 0; j < op.h; j++) {
          const y = op.y + j;
          if (y < 0 || y >= this.ch) continue;
          for (let i = 0; i < op.w; i++) {
            const x = op.x + i;
            if (x >= 0 && x < this.cw) this.px[y * this.cw + x] = src[j * op.w + i];
          }
        }
        this.extend(op.x, op.y, op.x + op.w - 1, op.y + op.h - 1);
        this.mark(op.x, op.y, op.x + op.w - 1, op.y + op.h - 1);
        return;
      }
    }
  }

  /** A `bits` op of everything drawn since the last Cls (null when nothing is). */
  bitsOp(): GfxOp | null {
    const d = this.drawn;
    if (!d) return null;
    const x0 = Math.max(0, d[0]), y0 = Math.max(0, d[1]), x1 = Math.min(this.cw - 1, d[2]), y1 = Math.min(this.ch - 1, d[3]);
    if (x1 < x0 || y1 < y0) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const out = new Uint32Array(w * h);
    for (let j = 0; j < h; j++) out.set(this.px.subarray((y0 + j) * this.cw + x0, (y0 + j) * this.cw + x0 + w), j * w);
    return { o: 'bits', x: x0, y: y0, w, h, d: toBase64(new Uint8Array(out.buffer)) };
  }

  /** The visible surface as opaque RGBA bytes: BackColor, then the background picture (at 0, 0), then the drawn pixels. */
  composite(background?: Decoded | null): Uint8Array {
    const { w, h } = this;
    const out = new Uint32Array(w * h);
    out.fill((OPAQUE | this.back) >>> 0);
    if (background) {
      for (let y = 0; y < Math.min(h, background.h); y++) {
        for (let x = 0; x < Math.min(w, background.w); x++) {
          const s = background.px[y * background.w + x];
          if (s >>> 24 >= 128) out[y * w + x] = (OPAQUE | (s & 0xffffff)) >>> 0;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) { const p = this.px[y * this.cw + x]; if (p !== 0) out[y * w + x] = p; }
    }
    return new Uint8Array(out.buffer);
  }

  // -- bitmap ---------------------------------------------------------------------------------------------------

  private resize(w: number, h: number): void {
    if (w > this.cw || h > this.ch) {
      const cw = Math.max(w, this.cw), ch = Math.max(h, this.ch);
      const px = new Uint32Array(cw * ch);
      for (let y = 0; y < this.ch; y++) px.set(this.px.subarray(y * this.cw, (y + 1) * this.cw), y * cw);
      this.px = px;
      this.stamp = new Int32Array(cw * ch);
      this.serial = 0;
      this.cw = cw;
      this.ch = ch;
      this.resized = true;
    }
    if (w !== this.w || h !== this.h) this.resized = true;
    this.w = w;
    this.h = h;
  }

  private mark(x0: number, y0: number, x1: number, y1: number): void {
    const d = this.dirty;
    if (!d) this.dirty = [x0, y0, x1, y1];
    else { d[0] = Math.min(d[0], x0); d[1] = Math.min(d[1], y0); d[2] = Math.max(d[2], x1); d[3] = Math.max(d[3], y1); }
  }

  private extend(x0: number, y0: number, x1: number, y1: number): void {
    const d = this.drawn;
    if (!d) this.drawn = [x0, y0, x1, y1];
    else { d[0] = Math.min(d[0], x0); d[1] = Math.min(d[1], y0); d[2] = Math.max(d[2], x1); d[3] = Math.max(d[3], y1); }
  }

  /** Starts a shape: its pixels are drawn once each (see plot). */
  private begin(pen: Pen): void {
    if (++this.serial > 0x7ffffff0) { this.stamp.fill(0); this.serial = 1; }
    this.pc = pen.c & 0xffffff;
    this.pm = pen.m;
    const s = pen.w > 1 && pen.s >= 1 && pen.s <= 4 ? 0 : pen.s;
    this.pattern = PATTERNS[s] ?? null;
    this.patTotal = this.pattern ? this.pattern.reduce((a, b) => a + b, 0) : 0;
    this.patPos = 0;
    this.gapBack = pen.ob === 1;
  }

  /** One pixel of the current shape, in colour c (BGR) with the shape's DrawMode; a pixel already drawn by the shape is left. */
  private plot(x: number, y: number, c: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.cw + x;
    if (this.stamp[i] === this.serial) return;
    this.stamp[i] = this.serial;
    const m = this.pm;
    if (m === 11) return;
    if (m === 13) this.px[i] = (OPAQUE | c) >>> 0;
    else {
      const p = this.px[i];
      this.px[i] = (OPAQUE | (rop2(m, c, p === 0 ? this.back : p & 0xffffff) & 0xffffff)) >>> 0;
    }
    this.extend(x, y, x, y);
    this.mark(x, y, x, y);
  }

  private dot(x: number, y: number, w: number): void {
    const d = disc(w);
    for (let k = 0; k < d.length; k += 2) this.plot(x + d[k], y + d[k + 1], this.pc);
  }

  /** A pixel of a line: the pen's pattern decides whether it is drawn (or takes the BackColor in a gap). */
  private penPixel(x: number, y: number, w: number): void {
    const pat = this.pattern;
    if (pat) {
      let n = this.patPos++ % this.patTotal, k = 0;
      while (n >= pat[k]) n -= pat[k++];
      if (k % 2 === 1) { if (this.gapBack) this.plot(x, y, this.back); return; }
    }
    if (w > 1) this.dot(x, y, w); else this.plot(x, y, this.pc);
  }

  /** A polyline (x, y pairs); `last` also draws the final pixel. */
  private stroke(pts: number[], w: number, last: boolean): void {
    for (let k = 0; k + 3 < pts.length; k += 2) {
      let x0 = pts[k], y0 = pts[k + 1];
      const x1 = pts[k + 2], y1 = pts[k + 3];
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      const final = last && k + 4 >= pts.length;
      for (;;) {
        if (x0 === x1 && y0 === y1) { if (final) this.penPixel(x0, y0, w); break; }
        this.penPixel(x0, y0, w);
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
  }

  /** Fills the pixels `inside(x, y)` within the rectangle with FillStyle fs (FillColor fc), after the border (same shape). */
  private fill(x0: number, y0: number, x1: number, y1: number, fs: number, fc: number, inside: (x: number, y: number) => boolean): void {
    if (fs === 1) return;
    const c = fc & 0xffffff;
    const ya = Math.max(0, y0), yb = Math.min(this.h - 1, y1), xa = Math.max(0, x0), xb = Math.min(this.w - 1, x1);
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        if (!inside(x, y)) continue;
        if (fs === -1 || hatch(fs, x, y)) this.plot(x, y, fs === -1 ? this.pc : c);
        else if (this.gapBack) this.plot(x, y, this.back);
      }
    }
  }

  private box(op: Extract<GfxOp, { o: 'box' }>): void {
    this.begin(op);
    let x0 = rnd(Math.min(op.x1, op.x2)), y0 = rnd(Math.min(op.y1, op.y2));
    let x1 = rnd(Math.max(op.x1, op.x2)), y1 = rnd(Math.max(op.y1, op.y2));
    const all = (): boolean => true;
    if (op.fs === -1) {   // BF: the box filled with the pen colour (a wide pen makes it bigger, as in GDI)
      if (op.w > 1) { this.pattern = null; this.stroke([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0], op.w, true); }
      this.fill(x0, y0, x1, y1, -1, op.c, all);
      return;
    }
    if (op.s === 6 && op.w > 1) { const k = Math.floor(op.w / 2); x0 += k; y0 += k; x1 -= k; y1 -= k; }   // Inside Solid
    if (op.s !== 5) this.stroke([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0], op.w, true);
    this.fill(x0, y0, x1, y1, op.fs, op.fc, all);
  }

  private arc(op: Extract<GfxOp, { o: 'arc' }>): void {
    this.begin(op);
    const cx = op.x, cy = op.y;
    let rx = Math.abs(op.rx), ry = Math.abs(op.ry);
    if (op.s === 6 && op.w > 1) { const k = Math.floor(op.w / 2); rx = Math.max(0, rx - k); ry = Math.max(0, ry - k); }
    const full = op.a1 === undefined && op.a2 === undefined;
    const s = Math.abs(op.a1 ?? 0);
    let sweep = Math.abs(op.a2 ?? TWO_PI) - s;
    if (sweep <= 0) sweep += TWO_PI;
    if (full) sweep = TWO_PI;
    const n = Math.max(8, Math.ceil(sweep * Math.max(rx, ry) * 1.5));
    const pts: number[] = [];
    const at = (t: number): void => { pts.push(rnd(cx + rx * Math.cos(t)), rnd(cy - ry * Math.sin(t))); };
    if ((op.a1 ?? 0) < 0) pts.push(rnd(cx), rnd(cy));
    for (let k = 0; k <= n; k++) at(s + (sweep * k) / n);
    if ((op.a2 ?? 0) < 0) pts.push(rnd(cx), rnd(cy));
    if (op.s !== 5) this.stroke(pts, op.w, true);
    const pie = (op.a1 ?? 0) < 0 && (op.a2 ?? 0) < 0;
    if (!full && !pie) return;
    const inside = (x: number, y: number): boolean => {
      const u = rx > 0 ? (x - cx) / rx : 0, v = ry > 0 ? (cy - y) / ry : 0;
      if (u * u + v * v > 1) return false;
      if (full) return true;
      let a = Math.atan2(v, u) - s;
      a = ((a % TWO_PI) + TWO_PI) % TWO_PI;
      return a <= sweep;
    };
    this.fill(Math.floor(cx - rx), Math.floor(cy - ry), Math.ceil(cx + rx), Math.ceil(cy + ry), op.fs, op.fc, inside);
  }

  private text(op: Extract<GfxOp, { o: 'text' }>): void {
    const g = this.hooks.text?.(op.t, op.f) ?? null;
    const x0 = rnd(op.x), y0 = rnd(op.y);
    const c = op.c & 0xffffff;
    this.begin({ c, w: 1, s: 0, m: 13 });
    const width = g?.w ?? 0;
    if (op.ob && width > 0) {
      for (let y = y0; y < y0 + op.lh; y++) for (let x = x0; x < x0 + width; x++) this.plot(x, y, this.back);
      this.begin({ c, w: 1, s: 0, m: 13 });
    }
    if (!g) return;
    for (let j = 0; j < g.h; j++) {
      const y = y0 + j;
      if (y < 0 || y >= this.h) continue;
      for (let i = 0; i < g.w; i++) {
        const a = g.a[j * g.w + i];
        const x = x0 + i;
        if (a === 0 || x < 0 || x >= this.w) continue;
        const k = y * this.cw + x;
        if (a >= 250) { this.px[k] = (OPAQUE | c) >>> 0; continue; }
        const p = this.px[k], d = p === 0 ? this.back : p & 0xffffff;
        const mix = (sh: number): number => {
          const dv = (d >>> sh) & 0xff, cv = (c >>> sh) & 0xff;
          return Math.round(dv + ((cv - dv) * a) / 255) << sh;
        };
        this.px[k] = (OPAQUE | mix(0) | mix(8) | mix(16)) >>> 0;
      }
    }
    if (op.u) for (let x = x0; x < x0 + g.w; x++) this.plot(x, y0 + g.base + 1, c);
    this.extend(x0, y0, x0 + g.w - 1, y0 + Math.max(g.h, op.lh) - 1);
    this.mark(x0, y0, x0 + g.w - 1, y0 + Math.max(g.h, op.lh) - 1);
  }

  private picture(op: Extract<GfxOp, { o: 'pic' }>): void {
    const img = this.hooks.image?.(op.src) ?? null;
    if (!img || img.w === 0 || img.h === 0) return;
    const sx = rnd(op.sx ?? 0), sy = rnd(op.sy ?? 0);
    const sw = op.sw !== undefined && op.sw !== 0 ? op.sw : img.w - sx, sh = op.sh !== undefined && op.sh !== 0 ? op.sh : img.h - sy;
    const dw = op.w ?? sw, dh = op.h ?? sh;
    const aw = Math.abs(rnd(dw)), ah = Math.abs(rnd(dh));
    if (aw === 0 || ah === 0) return;
    const x0 = rnd(op.x) - (dw < 0 ? aw : 0), y0 = rnd(op.y) - (dh < 0 ? ah : 0);
    const flipX = (dw < 0) !== (sw < 0), flipY = (dh < 0) !== (sh < 0);
    const asw = Math.abs(sw), ash = Math.abs(sh);
    for (let j = 0; j < ah; j++) {
      const y = y0 + j;
      if (y < 0 || y >= this.h) continue;
      const v = sy + Math.floor(((flipY ? ah - 1 - j : j) * ash) / ah);
      if (v < 0 || v >= img.h) continue;
      for (let i = 0; i < aw; i++) {
        const x = x0 + i;
        if (x < 0 || x >= this.w) continue;
        const u = sx + Math.floor(((flipX ? aw - 1 - i : i) * asw) / aw);
        if (u < 0 || u >= img.w) continue;
        const s = img.px[v * img.w + u], a = s >>> 24;
        if (a === 0) continue;
        const k = y * this.cw + x, p = this.px[k], d = p === 0 ? this.back : p & 0xffffff;
        let r: number;
        if (op.rop === 0xcc0020 || !op.rop) {
          if (a >= 250) r = s & 0xffffff;
          else {
            const mix = (sh2: number): number => Math.round(((d >>> sh2) & 0xff) + ((((s >>> sh2) & 0xff) - ((d >>> sh2) & 0xff)) * a) / 255) << sh2;
            r = mix(0) | mix(8) | mix(16);
          }
        } else {
          if (a < 128) continue;
          r = rop3(op.rop, s & 0xffffff, d) & 0xffffff;
        }
        this.px[k] = (OPAQUE | r) >>> 0;
      }
    }
    this.extend(x0, y0, x0 + aw - 1, y0 + ah - 1);
    this.mark(x0, y0, x0 + aw - 1, y0 + ah - 1);
  }
}

/** Where a GfxRenderer gets pictures: `get` undefined = not loaded yet (`load` it). */
export interface ImageSource {
  get(src: string): Decoded | null | undefined;
  load(src: string): Promise<void>;
}

/**
 * A Raster fed with ops in order. A PaintPicture whose picture is still being decoded holds back the ops after it until the
 * picture is there, so the result is the same as when it was ready at once.
 */
export class GfxRenderer {
  readonly raster: Raster;
  private queue: GfxOp[] = [];
  private waiting = false;

  constructor(private images: ImageSource, text?: RasterHooks['text'], private changed?: () => void) {
    this.raster = new Raster({ text, image: src => images.get(src) ?? null });
  }

  push(ops: GfxOp[]): void {
    if (this.waiting) { this.queue.push(...ops); return; }
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.o === 'pic' && this.images.get(op.src) === undefined) {
        this.waiting = true;
        this.queue = ops.slice(i);
        void this.images.load(op.src).catch(() => {}).then(() => {
          this.waiting = false;
          const q = this.queue;
          this.queue = [];
          // still not there (failed): skip it rather than wait forever
          if (q.length && q[0].o === 'pic' && this.images.get(q[0].src) === undefined) q.shift();
          this.push(q);
        });
        break;
      }
      this.raster.apply(op);
    }
    this.changed?.();
  }

  /** Ops not applied yet (a picture is loading). */
  get pending(): readonly GfxOp[] { return this.queue; }
}
