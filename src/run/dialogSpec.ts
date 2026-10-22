// A run-time dialog (MsgBox, InputBox, run-time error) as plain data, so it can be sent to a dialog window,
// and the one renderer for it (Win98 dialogs). Shared by the inline and the Tauri host.

import { inputBox98, messageBox98, messageContent, showDialog98 } from '../ui98/dialogs';
import { runtimeErrorContent, type RuntimeErrorInfo } from './errorDialog';

export type DialogSpec =
  | { kind: 'msgbox'; prompt: string; title: string; buttons: number }
  | { kind: 'input'; prompt: string; title: string; defaultText: string }
  | { kind: 'error'; info: RuntimeErrorInfo };

/** msgbox -> vbOK..vbNo, input -> text ('' on Cancel), error -> 'end' | 'debug'. */
export async function runDialog(doc: Document, spec: DialogSpec): Promise<number | string> {
  if (spec.kind === 'msgbox') return messageBox98(doc, spec);
  if (spec.kind === 'input') return inputBox98(doc, spec);
  const o = spec.info;
  const c = runtimeErrorContent(o);
  const defIdx = o.mode === 'ide' && !o.compile ? c.buttons.findIndex(b => b.value === 'debug') : 0;
  const v = await showDialog98(doc, {
    title: c.title,
    content: messageContent(c.text, o.compile ? 'exclamation' : undefined),
    buttons: c.buttons.map((b, i) => ({ label: b.label, value: b.value, disabled: b.disabled, default: i === defIdx })),
  });
  return v === 'debug' ? 'debug' : 'end';
}
