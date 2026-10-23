// The drawing of a Form or PictureBox in the run session: the VB6 graphics state (CurrentX/Y, the scale), the drawing statements
// and methods, and a copy of the pixels (Point, Image, SavePicture). Every drawing goes to the form window as GfxOps (one ordered
// list per flush, see PatchQueue), where the same raster code draws it on a canvas (gfx/dom.ts GfxLayer).
//
// The scale: ScaleMode 1-7 are fixed units (ScaleLeft/Top 0); ScaleMode 0 keeps ScaleLeft/Top/Width/Height as set (Scale or the
// properties), so the coordinates stretch with the surface when it is resized.

import { VBRuntimeError } from '../../lang/errors';
import type { GraphicsCall, PrintPiece } from '../../lang/host';
import { Empty, coerce, toNumber, toStr, type VBValue } from '../../lang/values';
import { vbColorToCss } from '../../model/colors';
import type { FontValue, PictureRef, PropValue } from '../../model/types';
import { cssFont, textWidthPx } from '../../ai/layoutCheck';
import { encodeBmp, encodePng } from '../../gfx/codec';
import { imageSource, textGlyphs } from '../../gfx/dom';
import { GfxRenderer, toBase64, type Decoded, type GfxOp, type ImageSource, type Pen } from '../../gfx/raster';
import { PictureObject } from './appObjects';

export interface SurfaceOwner {
  readonly props: Record<string, PropValue>;
  /** The inside of the Form or PictureBox in px. */
  clientPx(): { w: number; h: number };
  /** Queues ops (JSON strings) for the window. */
  emit(ops: string[]): void;
  resolveAsset(ref: PictureRef): string | null;
}

const TWIPS_PER_UNIT: Record<number, [number, number]> = {
  1: [1, 1], 2: [20, 20], 3: [15, 15], 4: [120, 240], 5: [1440, 1440], 6: [1440 / 25.4, 1440 / 25.4], 7: [1440 / 2.54, 1440 / 2.54],
  8: [1440 / 2540, 1440 / 2540],   // HiMetric (ScaleX / ScaleY only)
};
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TWO_PI = Math.PI * 2;

/** A VB colour (system colours too) as BGR. */
export function bgr(n: number): number {
  const css = vbColorToCss(n);
  const v = parseInt(css.slice(1), 16);
  return ((v & 0xff) << 16) | (v & 0xff00) | (v >>> 16);
}

const isFont = (v: unknown): v is FontValue => typeof v === 'object' && v !== null && 'size' in v;
const hasRef = (v: unknown): v is { pictureRef: PictureRef | null } => typeof v === 'object' && v !== null && 'pictureRef' in v;

/** A picture made from drawn pixels (Image): it can be saved as BMP or PNG. */
export class DrawnPicture extends PictureObject {
  constructor(readonly w: number, readonly h: number, readonly rgba: Uint8Array) {
    super({ asset: `data:image/png;base64,${toBase64(encodePng(w, h, rgba))}` });
  }
  fileBytes(ext: string): Uint8Array { return ext === 'bmp' ? encodeBmp(this.w, this.h, this.rgba) : encodePng(this.w, this.h, this.rgba); }
}

export class DrawSurface {
  /** ScaleMode 0: the user scale. */
  private ox = 0;
  private oy = 0;
  private sw = 1;
  private sh = 1;
  private sentW = -1;
  private sentH = -1;
  private sentBack = -1;
  private readonly images: ImageSource;
  readonly mirror: GfxRenderer;
  /** A Paint event of this surface is running (Refresh inside it does not raise another). */
  painting = false;

  constructor(private o: SurfaceOwner) {
    this.images = imageSource(src => o.resolveAsset({ asset: src }));
    this.mirror = new GfxRenderer(this.images, textGlyphs);
    if (this.mode() === 0) { const [w, h] = this.clientTwips(); this.sw = w; this.sh = h; }
    this.pictureChanged(false);
  }

  private get p(): Record<string, PropValue> { return this.o.props; }
  private mode(): number { return Number(this.p.ScaleMode ?? 1); }
  private clientTwips(): [number, number] {
    const { w, h } = this.o.clientPx();
    return [Math.max(1, w * 15), Math.max(1, h * 15)];
  }
  /** Units per twip, x and y (negative for a scale that runs right to left or upwards). */
  private units(): [number, number] {
    const m = this.mode();
    if (m === 0) { const [w, h] = this.clientTwips(); return [this.sw / w, this.sh / h]; }
    const t = TWIPS_PER_UNIT[m] ?? [1, 1];
    return [1 / t[0], 1 / t[1]];
  }
  private left(): number { return this.mode() === 0 ? this.ox : 0; }
  private top(): number { return this.mode() === 0 ? this.oy : 0; }

  // coordinates: program units <-> px of the surface
  private toPxX(u: number): number { return (u - this.left()) / this.units()[0] / 15; }
  private toPxY(u: number): number { return (u - this.top()) / this.units()[1] / 15; }
  private lenPxX(u: number): number { return u / this.units()[0] / 15; }
  private lenPxY(u: number): number { return u / this.units()[1] / 15; }
  private fromPxX(px: number): number { return px * 15 * this.units()[0] + this.left(); }
  private fromPxY(px: number): number { return px * 15 * this.units()[1] + this.top(); }

  /** MouseDown / MouseMove / MouseUp X and Y (twips from the window) in the current scale. */
  mouse(xTwips: number, yTwips: number): [number, number] {
    const [ux, uy] = this.units();
    return [xTwips * ux + this.left(), yTwips * uy + this.top()];
  }

  // -- properties ---------------------------------------------------------------------------------------------

  /** A drawing property's value, or undefined for the others. */
  get(name: string): VBValue | undefined {
    switch (name) {
      case 'CurrentX': case 'CurrentY': return Number(this.p[name] ?? 0);
      case 'ScaleLeft': return this.left();
      case 'ScaleTop': return this.top();
      case 'ScaleWidth': return this.mode() === 0 ? this.sw : this.clientTwips()[0] * this.units()[0];
      case 'ScaleHeight': return this.mode() === 0 ? this.sh : this.clientTwips()[1] * this.units()[1];
      case 'hDC': return 0;
      case 'Image': return this.image();
    }
    return undefined;
  }

  /** Sets a drawing property that needs more than storing; false for the others. */
  set(name: string, value: VBValue): boolean {
    switch (name) {
      case 'CurrentX': case 'CurrentY': this.p[name] = toNumber(value); return true;
      case 'ScaleLeft': case 'ScaleTop': case 'ScaleWidth': case 'ScaleHeight': {
        const v = toNumber(value);
        if ((name === 'ScaleWidth' || name === 'ScaleHeight') && v === 0) throw new VBRuntimeError(380);
        this.toUser();
        if (name === 'ScaleLeft') this.ox = v; else if (name === 'ScaleTop') this.oy = v; else if (name === 'ScaleWidth') this.sw = v; else this.sh = v;
        return true;
      }
      case 'ScaleMode': {
        const m = Number(coerce(value, 'Long'));
        if (m < 0 || m > 7) throw new VBRuntimeError(380);
        if (m === 0) this.toUser(); else this.p.ScaleMode = m;
        return true;
      }
    }
    return false;
  }

  /** Switches to ScaleMode 0 keeping the current scale. */
  private toUser(): void {
    if (this.mode() === 0) return;
    const [w, h] = this.clientTwips(), [ux, uy] = this.units();
    this.ox = 0; this.oy = 0; this.sw = w * ux; this.sh = h * uy;
    this.p.ScaleMode = 0;
  }

  // -- methods ------------------------------------------------------------------------------------------------

  /** A drawing method (Cls, Point, PaintPicture, TextWidth, TextHeight, ScaleX, ScaleY, Scale); undefined for the others. */
  call(l: string, args: VBValue[]): VBValue | undefined {
    const n = (i: number, d?: number): number => {
      const a = args[i];
      if (a === undefined || a === Empty) { if (d === undefined) throw new VBRuntimeError(450); return d; }
      return toNumber(a);
    };
    switch (l) {
      case 'cls': this.cls(); return Empty;
      case 'point': {
        if (args.length !== 2) throw new VBRuntimeError(450);
        return this.point(n(0), n(1));
      }
      case 'textwidth': case 'textheight': {
        if (args.length !== 1) throw new VBRuntimeError(450);
        return l === 'textwidth' ? this.textWidth(toStr(args[0])) : this.textHeight(toStr(args[0]));
      }
      case 'scalex': case 'scaley': {
        if (args.length < 1 || args.length > 3) throw new VBRuntimeError(450);
        return this.scaleXY(l === 'scalex', n(0), n(1, 8), n(2, this.mode()));
      }
      case 'scale': if (args.length) throw new VBRuntimeError(450); this.graphics({ method: 'scale' }); return Empty;
      case 'paintpicture': this.paintPicture(args, n); return Empty;
    }
    return undefined;
  }

  private font(): FontValue {
    const f = this.p.Font;
    return isFont(f) ? f : { name: 'MS Sans Serif', size: 8, bold: false, italic: false, underline: false };
  }
  private lineHeightPx(): number { return Math.max(1, Math.round((this.font().size * 96) / 72 * 1.2)); }
  private textPx(s: string): number { return textWidthPx(s, this.font()); }

  textWidth(s: string): number {
    const w = Math.max(0, ...s.split(/\r\n|\r|\n/).map(l => this.textPx(l)));
    return Math.abs(w * 15 * this.units()[0]);
  }
  textHeight(s: string): number {
    const lines = s.split(/\r\n|\r|\n/).length;
    return Math.abs(lines * this.lineHeightPx() * 15 * this.units()[1]);
  }

  private scaleXY(horizontal: boolean, v: number, from: number, to: number): number {
    const tw = (m: number): number => {   // twips per unit of scale m
      if (m === 0 || m === 9 || m === 10) { const u = this.units(); return Math.abs(1 / (horizontal ? u[0] : u[1])); }   // the container: as this object
      const t = TWIPS_PER_UNIT[m];
      if (!t) throw new VBRuntimeError(5);
      return horizontal ? t[0] : t[1];
    };
    return (v * tw(from)) / tw(to);
  }

  /** Point(x, y): the colour there; -1 outside the surface. */
  point(x: number, y: number): number {
    this.sync();
    const px = this.toPxX(x), py = this.toPxY(y), r = this.mirror.raster;
    if (!r.isDrawn(px, py)) {
      const bg = this.background(), xi = Math.floor(px + 0.5), yi = Math.floor(py + 0.5);
      if (bg && xi >= 0 && yi >= 0 && xi < bg.w && yi < bg.h && xi < r.w && yi < r.h) {
        const s = bg.px[yi * bg.w + xi];
        if (s >>> 24 >= 128) return s & 0xffffff;
      }
    }
    return r.get(px, py);
  }

  /** The Picture, decoded (null: none, or not decoded yet). */
  private background(): Decoded | null {
    const ref = this.p.Picture as PictureRef | null;
    return ref ? this.images.get(ref.asset) ?? null : null;
  }

  /** Image: what the surface shows (BackColor, Picture and the drawing) as a Picture. */
  image(): DrawnPicture {
    this.sync();
    const r = this.mirror.raster;
    return new DrawnPicture(r.w, r.h, r.composite(this.background()));
  }

  private paintPicture(args: VBValue[], n: (i: number, d?: number) => number): void {
    if (args.length < 3 || args.length > 10) throw new VBRuntimeError(450);
    const pic = args[0];
    const ref = hasRef(pic) ? pic.pictureRef : null;
    if (!ref) throw new VBRuntimeError(481);
    const given = (i: number): boolean => args[i] !== undefined && args[i] !== Empty;
    const op: GfxOp = { o: 'pic', src: ref.asset, x: this.toPxX(n(1)), y: this.toPxY(n(2)), rop: given(9) ? n(9) >>> 0 : 0xcc0020 };
    if (given(3)) op.w = this.lenPxX(n(3));
    if (given(4)) op.h = this.lenPxY(n(4));
    if (given(5)) op.sx = this.lenPxX(n(5));
    if (given(6)) op.sy = this.lenPxY(n(6));
    if (given(7)) op.sw = this.lenPxX(n(7));
    if (given(8)) op.sh = this.lenPxY(n(8));
    this.draw(op);
  }

  // -- drawing ------------------------------------------------------------------------------------------------

  /** The window and the copy here get the surface's size and BackColor before the first op that needs them. */
  private sync(): void {
    const ops: GfxOp[] = [];
    const { w, h } = this.o.clientPx();
    if (w !== this.sentW || h !== this.sentH) { ops.push({ o: 'size', w, h }); this.sentW = w; this.sentH = h; }
    const back = bgr(Number(this.p.BackColor ?? 0x8000000f));
    if (back !== this.sentBack) { ops.push({ o: 'back', c: back }); this.sentBack = back; }
    if (ops.length) this.send(ops);
  }

  private send(ops: GfxOp[]): void {
    this.mirror.push(ops);
    this.o.emit(ops.map(op => JSON.stringify(op)));
  }

  private draw(op: GfxOp): void {
    this.sync();
    this.send([op]);
  }

  private pen(color: number | undefined): Pen {
    const p: Pen = {
      c: bgr(color ?? Number(this.p.ForeColor ?? 0)), w: Math.max(1, Math.round(Number(this.p.DrawWidth ?? 1))),
      s: Number(this.p.DrawStyle ?? 0), m: Number(this.p.DrawMode ?? 13),
    };
    if (this.p.FontTransparent === false) p.ob = 1;
    return p;
  }

  cls(): void {
    this.draw({ o: 'cls' });
    this.p.CurrentX = 0;
    this.p.CurrentY = 0;
  }

  /** BackColor set by code: VB6 erases the drawing. */
  backChanged(): void {
    this.sync();
    this.send([{ o: 'cls' }]);
  }

  /** Picture set: the new picture is the background and the drawing starts over (Picture1.Picture = Picture1.Image keeps it). */
  pictureChanged(clear = true): void {
    const ref = this.p.Picture as PictureRef | null;
    if (ref) void this.images.load(ref.asset);
    if (clear && this.mirror.raster.drawn) { this.sync(); this.send([{ o: 'cls' }]); }
  }

  /** AutoRedraw False: the surface is erased before a Paint event that repaints all of it (Refresh). */
  erase(): void {
    this.sync();
    this.send([{ o: 'cls' }]);
  }

  /** The ops that bring a new window to what is drawn now (null: nothing is). */
  snapshot(): string[] | null {
    const r = this.mirror.raster;
    if (!r.drawn && !this.mirror.pending.length) return null;
    const ops: GfxOp[] = [{ o: 'size', w: r.w, h: r.h }, { o: 'back', c: r.back }];
    const bits = r.bitsOp();
    if (bits) ops.push(bits);
    ops.push(...this.mirror.pending);
    return ops.map(op => JSON.stringify(op));
  }

  graphics(call: GraphicsCall): void {
    const cx = (): number => Number(this.p.CurrentX ?? 0), cy = (): number => Number(this.p.CurrentY ?? 0);
    const setCur = (x: number, y: number): void => { this.p.CurrentX = x; this.p.CurrentY = y; };
    switch (call.method) {
      case 'print': this.print(call.pieces, call.newline); return;
      case 'pset': {
        const x = call.at.step ? cx() + call.at.x : call.at.x, y = call.at.step ? cy() + call.at.y : call.at.y;
        this.draw({ o: 'pset', x: this.toPxX(x), y: this.toPxY(y), ...this.pen(call.color) });
        setCur(x, y);
        return;
      }
      case 'line': {
        let x1 = cx(), y1 = cy();
        if (call.from) { x1 = call.from.step ? x1 + call.from.x : call.from.x; y1 = call.from.step ? y1 + call.from.y : call.from.y; }
        const x2 = call.to.step ? x1 + call.to.x : call.to.x, y2 = call.to.step ? y1 + call.to.y : call.to.y;
        const pen = this.pen(call.color);
        const pts = { x1: this.toPxX(x1), y1: this.toPxY(y1), x2: this.toPxX(x2), y2: this.toPxY(y2) };
        if (call.box === '') this.draw({ o: 'line', ...pts, ...pen });
        else this.draw({ o: 'box', ...pts, ...pen, fs: call.box === 'bf' ? -1 : Number(this.p.FillStyle ?? 1), fc: bgr(Number(this.p.FillColor ?? 0)) });
        setCur(x2, y2);
        return;
      }
      case 'circle': {
        const x = call.at.step ? cx() + call.at.x : call.at.x, y = call.at.step ? cy() + call.at.y : call.at.y;
        const r = Math.abs(this.lenPxX(call.radius));
        const aspect = Math.abs(call.aspect ?? 1);
        const [rx, ry] = aspect <= 1 ? [r, r * aspect] : [r / aspect, r];
        for (const a of [call.start, call.end]) if (a !== undefined && Math.abs(a) > TWO_PI + 1e-9) throw new VBRuntimeError(5);
        const op: GfxOp = { o: 'arc', x: this.toPxX(x), y: this.toPxY(y), rx, ry, ...this.pen(call.color), fs: Number(this.p.FillStyle ?? 1), fc: bgr(Number(this.p.FillColor ?? 0)) };
        if (call.start !== undefined || call.end !== undefined) { op.a1 = call.start ?? 0; op.a2 = call.end ?? TWO_PI; }
        this.draw(op);
        setCur(x, y);
        return;
      }
      case 'scale': {
        if (!call.from || !call.to) { this.p.ScaleMode = 1; return; }
        const w = call.to.x - call.from.x, h = call.to.y - call.from.y;
        if (w === 0 || h === 0) throw new VBRuntimeError(5);
        this.ox = call.from.x; this.oy = call.from.y; this.sw = w; this.sh = h;
        this.p.ScaleMode = 0;
        return;
      }
    }
  }

  /** Print: the pieces at CurrentX/Y in the Font; `,` goes to the next 14-column zone (a column is the font's average width). */
  private print(pieces: PrintPiece[], newline: boolean): void {
    let x = this.toPxX(Number(this.p.CurrentX ?? 0)), y = this.toPxY(Number(this.p.CurrentY ?? 0));
    const font = this.font(), css = cssFont(font), lh = this.lineHeightPx();
    const col = Math.max(1, this.textPx(ALPHABET) / ALPHABET.length), zone = col * 14;
    const fore = bgr(Number(this.p.ForeColor ?? 0));
    const nl = (): void => { x = 0; y += lh; };
    for (const piece of pieces) {
      if (typeof piece === 'string') {
        piece.split(/\r\n|\r|\n/).forEach((part, i) => {
          if (i > 0) nl();
          if (part === '') return;
          const op: GfxOp = { o: 'text', x, y, t: part, c: fore, f: css, lh };
          if (font.underline) op.u = 1;
          if (this.p.FontTransparent === false) op.ob = 1;
          this.draw(op);
          x += this.textPx(part);
        });
      } else if ('spc' in piece) x += Math.max(0, piece.spc) * col;
      else if ('tab' in piece) {
        const target = (Math.max(1, piece.tab) - 1) * col;
        if (x > target + 0.5) nl();
        x = target;
      } else x = (Math.floor(x / zone + 1e-9) + 1) * zone;
    }
    if (newline) nl();
    this.p.CurrentX = this.fromPxX(x);
    this.p.CurrentY = this.fromPxY(y);
  }
}
