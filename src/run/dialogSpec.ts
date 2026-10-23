// A run-time dialog (MsgBox, InputBox, run-time error) as plain data, so it can be sent to a dialog window,
// and the one renderer for it (Win98 dialogs). Shared by the inline and the Tauri host.

import { showColorDialog, showFontDialog } from '../ide/propertyEditors';
import type { FontValue } from '../model/types';
import { inputBox98, messageBox98, messageContent, showDialog98 } from '../ui98/dialogs';
import { runtimeErrorContent, type RuntimeErrorInfo } from './errorDialog';
import { printerDialog98 } from './printDialog';
import type { PrinterDialogRequest } from './printing';

export type DialogSpec =
  | { kind: 'msgbox'; prompt: string; title: string; buttons: number }
  | { kind: 'input'; prompt: string; title: string; defaultText: string }
  | { kind: 'color'; color: number }
  | { kind: 'font'; font: FontValue }
  | { kind: 'printer'; req: PrinterDialogRequest }
  | { kind: 'error'; info: RuntimeErrorInfo };

/** msgbox -> vbOK..vbNo, input -> text ('' on Cancel), color -> the colour as text ('' on Cancel), font -> the FontValue as JSON ('' on Cancel), printer -> the PrinterDialogResult as JSON ('' on Cancel), error -> 'end' | 'debug' | 'ai'. */
export async function runDialog(doc: Document, spec: DialogSpec): Promise<number | string> {
  if (spec.kind === 'msgbox') return messageBox98(doc, spec);
  if (spec.kind === 'input') return inputBox98(doc, spec);
  if (spec.kind === 'color') { const c = await showColorDialog(doc, spec.color); return c === null ? '' : String(c); }
  if (spec.kind === 'font') { const f = await showFontDialog(doc, spec.font); return f === null ? '' : JSON.stringify(f); }
  if (spec.kind === 'printer') { const r = await printerDialog98(doc, spec.req); return r === null ? '' : JSON.stringify(r); }
  const o = spec.info;
  const c = runtimeErrorContent(o);
  const defIdx = o.mode === 'ide' && !o.compile ? c.buttons.findIndex(b => b.value === 'debug') : 0;
  const v = await showDialog98(doc, {
    title: c.title,
    content: messageContent(c.text, o.compile ? 'exclamation' : undefined),
    buttons: c.buttons.map((b, i) => ({ label: b.label, value: b.value, disabled: b.disabled, default: i === defIdx })),
  });
  return v === 'debug' || v === 'ai' ? v : 'end';
}
