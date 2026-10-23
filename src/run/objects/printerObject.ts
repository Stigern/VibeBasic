// The Printer object (Printers is a list of them, session.ts). Printer draws as a Form does (DrawSurface: Print, Line, Circle, PSet,
// PaintPicture, TextWidth, the scale ...) onto pages that are kept as GfxOp lists; EndDoc sends them as one print job (the print
// window shows them and opens the macOS print dialog), KillDoc throws them away.
//
// A page starts with its first drawing; NewPage ends the current page (an empty one too) and the next drawing starts another, so
// EndDoc never prints a trailing empty page. Print that would go past the bottom of the page starts a new page first, as in VB6.

import type { GraphicsCall, VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, coerce, isObject, toBool, toNumber, toStr, type VBValue } from '../../lang/values';
import type { FontValue, PictureRef, PropValue } from '../../model/types';
import { PAPER_TWIPS, PRINT_MARGIN_TWIPS, type PrintJob, type PrintPage, type PrinterInfo } from '../printing';
import { FontObject } from './controlObject';
import { DrawSurface } from './drawSurface';

export interface PrinterHost {
  /** EndDoc: prints the pages (the print window and the print dialog); rejects when nothing can print. */
  print(job: PrintJob): Promise<void>;
  resolveAsset(ref: PictureRef): string | null;
  /** The document name (App.Title). */
  title(): string;
}

const lc = (s: string): string => s.toLowerCase();
const FONT_PARTS: Record<string, keyof FontValue> = { fontname: 'name', fontsize: 'size', fontbold: 'bold', fontitalic: 'italic', fontunderline: 'underline' };
/** The drawing state DrawSurface keeps (CurrentX ..., the scale). */
const SURFACE_PROPS: Record<string, string> = {
  currentx: 'CurrentX', currenty: 'CurrentY', scaleleft: 'ScaleLeft', scaletop: 'ScaleTop', scalewidth: 'ScaleWidth', scaleheight: 'ScaleHeight', scalemode: 'ScaleMode',
};
/** Pen, fill and font settings: a number, or a Boolean (FontTransparent). */
const PEN_PROPS: Record<string, string> = {
  forecolor: 'ForeColor', drawwidth: 'DrawWidth', drawstyle: 'DrawStyle', drawmode: 'DrawMode', fillcolor: 'FillColor', fillstyle: 'FillStyle',
  fonttransparent: 'FontTransparent',
};
/** Settings of the job that are kept but do nothing here (the print dialog has its own); TrackDefault is a Boolean. */
const STORED: Record<string, string> = {
  colormode: 'ColorMode', printquality: 'PrintQuality', duplex: 'Duplex', paperbin: 'PaperBin', zoom: 'Zoom', trackdefault: 'TrackDefault',
  fontstrikethru: 'FontStrikethru', righttoleft: 'RightToLeft',
};
const READ_ONLY = new Set(['page', 'devicename', 'drivername', 'port', 'twipsperpixelx', 'twipsperpixely', 'hdc']);
const METHODS = new Set(['newpage', 'enddoc', 'killdoc', 'paintpicture', 'textwidth', 'textheight', 'scalex', 'scaley', 'scale']);
const FUNCTIONS = new Set(['textwidth', 'textheight', 'scalex', 'scaley']);

export class PrinterObject implements VBObject {
  readonly vbTypeName = 'Printer';
  /** The state DrawSurface reads (BackColor: the paper). */
  readonly props: Record<string, PropValue> = {
    Font: { name: 'Arial', size: 10, bold: false, italic: false, underline: false },
    ForeColor: 0, BackColor: 0xffffff, DrawWidth: 1, DrawStyle: 0, DrawMode: 13, FillColor: 0, FillStyle: 1, FontTransparent: true,
    ScaleMode: 1, CurrentX: 0, CurrentY: 0,
    Orientation: 1, PaperSize: 9, Copies: 1, ColorMode: 2, PrintQuality: -4, Duplex: 1, PaperBin: 7, Zoom: 0, TrackDefault: true,
    FontStrikethru: false, RightToLeft: false,
  };
  private readonly surface: DrawSurface;
  /** The finished pages of the document. */
  private pages: PrintPage[] = [];
  /** The page being drawn (null: the next drawing starts one). */
  private cur: PrintPage | null = null;

  constructor(private host: PrinterHost, readonly info: PrinterInfo = { name: '', port: '', isDefault: false }) {
    this.surface = new DrawSurface({
      props: this.props,
      clientPx: () => { const [w, h] = this.paperTwips(); return { w: (w - 2 * PRINT_MARGIN_TWIPS) / 15, h: (h - 2 * PRINT_MARGIN_TWIPS) / 15 }; },
      emit: ops => (this.cur ??= this.startPage()).ops!.push(...ops),
      resolveAsset: r => host.resolveAsset(r),
    });
  }

  get deviceName(): string { return this.info.name; }

  /** The paper in twips as the pages are laid out (Width, Height): A4 or Letter, turned for landscape. */
  private paperTwips(): [number, number] {
    const [w, h] = PAPER_TWIPS[Number(this.props.PaperSize)] ?? PAPER_TWIPS[9];
    return Number(this.props.Orientation) === 2 ? [h, w] : [w, h];
  }

  /** A page as the settings lay it out now (no drawing yet): PrintForm prints on one. */
  layout(): PrintPage {
    const [w, h] = this.paperTwips(), m = PRINT_MARGIN_TWIPS;
    return { paperW: w / 15, paperH: h / 15, left: m / 15, top: m / 15, w: (w - 2 * m) / 15, h: (h - 2 * m) / 15 };
  }

  /** The settings of a job of this printer. */
  job(pages: PrintPage[]): PrintJob {
    return { title: this.host.title(), device: this.info.name, copies: Number(this.props.Copies), paperSize: Number(this.props.PaperSize), pages };
  }

  private startPage(): PrintPage { return { ...this.layout(), ops: [] }; }

  /** Copies the settings the user picked in CommonDialog.ShowPrinter (PrinterDefault = True). */
  applyDialog(o: { copies: number; orientation: number }): void {
    this.props.Copies = o.copies;
    this.props.Orientation = o.orientation === 2 ? 2 : 1;
  }

  // -- members --------------------------------------------------------------------------------------------------

  hasMember(name: string): boolean {
    const l = lc(name);
    return l === 'font' || l in FONT_PARTS || l in SURFACE_PROPS || l in PEN_PROPS || l in STORED || READ_ONLY.has(l) || METHODS.has(l)
      || ['orientation', 'papersize', 'copies', 'width', 'height'].includes(l);
  }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = lc(name);
    if (FUNCTIONS.has(l)) return this.callMethod(name, args) as VBValue;
    if (args.length) throw new VBRuntimeError(450);
    const p = this.props;
    if (l in SURFACE_PROPS) return this.surface.get(SURFACE_PROPS[l])!;
    if (l === 'font') return new FontObject(() => p.Font as FontValue, f => { p.Font = f; });
    if (l in FONT_PARTS) return (p.Font as FontValue)[FONT_PARTS[l]] ?? false;
    if (l in PEN_PROPS) return p[PEN_PROPS[l]] as VBValue;
    if (l in STORED) return p[STORED[l]] as VBValue;
    switch (l) {
      case 'orientation': return Number(p.Orientation);
      case 'papersize': return Number(p.PaperSize);
      case 'copies': return Number(p.Copies);
      case 'width': return this.paperTwips()[0];
      case 'height': return this.paperTwips()[1];
      case 'page': return this.pages.length + 1;
      case 'devicename': return this.info.name;
      case 'drivername': return this.info.name ? 'CUPS' : '';
      case 'port': return this.info.port;
      case 'twipsperpixelx': case 'twipsperpixely': return 15;
      case 'hdc': return 0;
    }
    throw new VBRuntimeError(438);
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    const l = lc(name), p = this.props;
    if (args.length) throw new VBRuntimeError(450);
    const int = (min: number, max: number): number => {
      const n = Number(coerce(value, 'Long'));
      if (n < min || n > max) throw new VBRuntimeError(380);
      return n;
    };
    if (l in SURFACE_PROPS) { this.surface.set(SURFACE_PROPS[l], value); return; }
    if (l === 'font') {
      if (!isObject(value)) throw new VBRuntimeError(424);
      const f = { ...(p.Font as FontValue) } as Record<string, PropValue>;
      for (const k of ['name', 'size', 'bold', 'italic', 'underline']) if (value.hasMember(k)) f[k] = value.getMember(k, []) as PropValue;
      p.Font = f as unknown as FontValue;
      return;
    }
    if (l in FONT_PARTS) {
      const k = FONT_PARTS[l];
      p.Font = { ...(p.Font as FontValue), [k]: k === 'name' ? toStr(value) : k === 'size' ? Number(coerce(value, 'Double')) : toBool(value) };
      return;
    }
    if (l === 'fonttransparent') { p.FontTransparent = toBool(value); return; }
    if (l === 'drawwidth') { p.DrawWidth = int(1, 32767); return; }
    if (l === 'drawmode') { p.DrawMode = int(1, 16); return; }
    if (l === 'drawstyle') { p.DrawStyle = int(0, 6); return; }
    if (l === 'fillstyle') { p.FillStyle = int(0, 7); return; }
    if (l in PEN_PROPS) { p[PEN_PROPS[l]] = toNumber(value); return; }
    if (l === 'trackdefault' || l === 'fontstrikethru' || l === 'righttoleft') { p[STORED[l]] = toBool(value); return; }
    if (l in STORED) { p[STORED[l]] = Number(coerce(value, 'Long')); return; }
    switch (l) {
      case 'orientation': p.Orientation = int(1, 2); return;
      case 'papersize': p.PaperSize = int(1, 256); return;
      case 'copies': p.Copies = int(1, 9999); return;
      case 'width': case 'height': return;   // the paper is A4 or Letter (PaperSize)
    }
    if (READ_ONLY.has(l)) throw new VBRuntimeError(383);
    throw new VBRuntimeError(438);
  }

  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const l = lc(name);
    switch (l) {
      case 'newpage':
        if (args.length) throw new VBRuntimeError(450);
        this.newPage();
        return Empty;
      case 'enddoc':
        if (args.length) throw new VBRuntimeError(450);
        return this.endDoc().then(() => Empty);
      case 'killdoc':
        if (args.length) throw new VBRuntimeError(450);
        this.reset();
        return Empty;
    }
    if (!METHODS.has(l)) throw new VBRuntimeError(438);
    return this.surface.call(l, args) ?? Empty;
  }

  graphics(call: GraphicsCall): void {
    if (call.method === 'print' && this.cur) {   // past the bottom of the page: the text goes on the next one
      const y = Number(this.props.CurrentY), top = Number(this.surface.get('ScaleTop')), sh = Number(this.surface.get('ScaleHeight'));
      if (sh > 0 && y > top && y + this.surface.textHeight('X') > top + sh) this.newPage();
    }
    this.surface.graphics(call);
  }

  private newPage(): void {
    this.pages.push(this.cur ?? this.startPage());
    this.cur = null;
    this.props.CurrentX = 0;
    this.props.CurrentY = 0;
  }

  private reset(): void {
    this.pages = [];
    this.cur = null;
    this.props.CurrentX = 0;
    this.props.CurrentY = 0;
  }

  private async endDoc(): Promise<void> {
    const pages = this.cur ? [...this.pages, this.cur] : this.pages;
    this.reset();
    if (!pages.length) return;
    await this.host.print(this.job(pages));   // error 482 when it cannot print
  }
}
