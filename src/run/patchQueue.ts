// Collects property patches per form and control, and sends them coalesced on flush().

import type { PropValue } from '../model/types';
import type { ToWindow } from './protocol';

/** Props whose queued values are appended, not replaced: an ordered list of changes the window replays (RichTextBox: see
 *  ControlObject.send; GfxOps: the drawing of a Form or PictureBox, see DrawSurface). */
const APPEND_PROPS = new Set(['RtfOps', 'GfxOps']);

export class PatchQueue {
  private forms = new Map<string, Map<string, Record<string, PropValue>>>();

  constructor(private sendFn: (formKey: string, m: ToWindow) => void) {}

  get pending(): boolean { return this.forms.size > 0; }

  set(formKey: string, id: string | 'form', props: Record<string, PropValue>): void {
    let form = this.forms.get(formKey);
    if (!form) this.forms.set(formKey, form = new Map());
    const cur = form.get(id);
    // the queue owns the lists it appends to (copied in, then pushed to: a loop of 10000 PSet stays linear)
    const own = (k: string, v: PropValue): PropValue => (APPEND_PROPS.has(k) && Array.isArray(v) ? [...v] : v);
    if (!cur) {
      const copy: Record<string, PropValue> = {};
      for (const [k, v] of Object.entries(props)) copy[k] = own(k, v);
      form.set(id, copy);
      return;
    }
    for (const [k, v] of Object.entries(props)) {
      const was = cur[k];
      if (APPEND_PROPS.has(k) && Array.isArray(was) && Array.isArray(v)) for (const x of v as string[]) (was as string[]).push(x);   // no push(...v): 100k+
      else cur[k] = own(k, v);
    }
  }

  /** Send a non-patch message; patches queued before it go first so the window sees them in order. */
  send(formKey: string, m: ToWindow): void {
    this.flush();
    this.sendFn(formKey, m);
  }

  flush(): void {
    if (!this.forms.size) return;
    const forms = this.forms;
    this.forms = new Map();
    // one message per form (one IPC call for a whole DoEvents flush)
    for (const [key, ids] of forms) {
      const items = [...ids].map(([id, props]) => ({ id, props }));
      this.sendFn(key, items.length === 1 ? { t: 'patch', ...items[0] } : { t: 'patches', items });
    }
  }
}
