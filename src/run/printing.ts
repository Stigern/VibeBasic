// Printing as plain data, so it can go to a print window: a print job (Printer.EndDoc, Form.PrintForm), the printers the system
// knows (Printers) and CommonDialog.ShowPrinter's request and answer. Sizes are CSS px (1/96 inch, 15 twips), the unit the
// drawing layer uses, so a page prints at its real size.

import type { FormSnapshot } from './protocol';

/** A printer of the system (src-tauri/src/printing.rs): the CUPS queue name, its device URI, and whether it is the default. */
export interface PrinterInfo { name: string; port: string; isDefault: boolean }

/** vbPRPSLetter 1, vbPRPSA4 9 (other sizes print on A4). */
export const PAPER_TWIPS: Record<number, [number, number]> = { 1: [12240, 15840], 9: [11906, 16838] };
/** The edge of the paper the printer cannot reach (a quarter inch); ScaleWidth / ScaleHeight are the area inside it. */
export const PRINT_MARGIN_TWIPS = 360;

export interface PrintPage {
  /** The paper as the page is laid out: portrait (Width < Height) or landscape. */
  paperW: number; paperH: number;
  /** The printable area: its top left on the paper, and its size. */
  left: number; top: number; w: number; h: number;
  /** Printer: the drawing on the printable area (GfxOps, one JSON string each). */
  ops?: string[];
  /** PrintForm: the form as its window shows it; its client area is printed. */
  form?: FormSnapshot;
}

export interface PrintJob {
  /** The document name (App.Title). */
  title: string;
  /** Printer.DeviceName ('' when unknown); the user picks the printer in the print dialog. */
  device: string;
  copies: number;
  /** vbPRPSLetter 1 or vbPRPSA4 9: the paper every page prints on (portrait; a landscape page is turned on it). */
  paperSize: number;
  pages: PrintPage[];
  /** The pictures the Printer pages paint (PaintPicture): asset key -> data URL. */
  assets?: Record<string, string>;
}

/** CommonDialog.ShowPrinter: what the dialog starts with. */
export interface PrinterDialogRequest {
  title: string;
  printers: PrinterInfo[];
  /** The printer selected first (DeviceName). */
  device: string;
  copies: number;
  /** cdlPortrait 1, cdlLandscape 2. */
  orientation: number;
  fromPage: number; toPage: number; min: number; max: number;
}

/** What the user chose (null: Cancel); `pageNums`: Pages (FromPage to ToPage) rather than All. */
export interface PrinterDialogResult { device: string; copies: number; orientation: number; pageNums: boolean; fromPage: number; toPage: number }
