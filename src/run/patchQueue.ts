// Collects property patches per form and control, and sends them coalesced on flush().

import type { PropValue } from '../model/types';
import type { ToWindow } from './protocol';

export class PatchQueue {
  private forms = new Map<string, Map<string, Record<string, PropValue>>>();

  constructor(private sendFn: (formKey: string, m: ToWindow) => void) {}

  get pending(): boolean { return this.forms.size > 0; }

  set(formKey: string, id: string | 'form', props: Record<string, PropValue>): void {
    let form = this.forms.get(formKey);
    if (!form) this.forms.set(formKey, form = new Map());
    const cur = form.get(id);
    if (cur) Object.assign(cur, props); else form.set(id, { ...props });
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
    for (const [key, ids] of forms) for (const [id, props] of ids) this.sendFn(key, { t: 'patch', id, props });
  }
}
