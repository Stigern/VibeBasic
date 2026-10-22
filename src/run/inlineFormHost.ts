// FormHost that shows every form as an absolutely positioned Win98 "window" div inside one container
// (browser, tests). Dialogs are the plan 02 Win98 dialogs in the same document.

import { formMetrics } from '../controls/render';
import { inputBox98, messageBox98, messageContent, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { runtimeErrorContent } from './errorDialog';
import type { FormHost, FormWindow } from './formHost';
import { mountFormWindow } from './formWindow';
import type { FormSnapshot, FromWindow } from './protocol';

export class InlineFormHost implements FormHost {
  private z = 1;
  private cascade = 0;
  private openDialogs = 0;
  private windows = new Set<{ sessionBlocked: boolean; apply(): void }>();

  constructor(private container: HTMLElement) {}

  private get doc(): Document { return this.container.ownerDocument; }

  async openForm(s: FormSnapshot, _o: { modal: boolean }): Promise<FormWindow> {
    const p = s.form.props;
    const m = formMetrics(p);
    const box = this.container.getBoundingClientRect();
    const pos = typeof p.StartUpPosition === 'number' ? p.StartUpPosition : 3;
    let left: number, top: number;
    if (pos === 0) { left = Number(p.Left) / 15 || 0; top = Number(p.Top) / 15 || 0; }
    else if (pos === 1 || pos === 2) { left = Math.max(0, (box.width - m.outerWidth) / 2); top = Math.max(0, (box.height - m.outerHeight) / 2); }
    else { left = top = 16 + 24 * (this.cascade++ % 8); }
    const wrapper = h('div', { class: 'vb-inline-window' });
    wrapper.style.cssText = `position:absolute;left:${Math.round(left)}px;top:${Math.round(top)}px;z-index:${++this.z}`;
    wrapper.addEventListener('mousedown', () => { wrapper.style.zIndex = String(++this.z); }, true);
    this.container.appendChild(wrapper);

    const listeners: ((m: FromWindow) => void)[] = [];
    const early: FromWindow[] = [];
    const mounted = mountFormWindow(wrapper, s, m => {
      if (listeners.length) for (const l of listeners) l(m); else early.push(m);
    });
    // Effective blocked = requested by the session (modal form / break) OR a dialog is open.
    const w = { sessionBlocked: false, apply: () => mounted.receive({ t: 'blocked', blocked: w.sessionBlocked || this.openDialogs > 0 }) };
    this.windows.add(w);
    return {
      send: m => {
        if (m.t === 'blocked') { w.sessionBlocked = m.blocked; w.apply(); } else mounted.receive(m);
      },
      onMessage: cb => {
        listeners.push(cb);
        for (const m of early.splice(0)) cb(m);
      },
      close: async () => { this.windows.delete(w); mounted.dispose(); wrapper.remove(); },
    };
  }

  /** Blocks every form window while a dialog is open; the dialog itself holds keyboard focus. */
  private async withDialog<T>(show: () => Promise<T>): Promise<T> {
    if (this.openDialogs++ === 0) for (const w of this.windows) w.apply();
    try {
      return await show();
    } finally {
      if (--this.openDialogs === 0) for (const w of this.windows) w.apply();
    }
  }

  messageBox(o: { prompt: string; title: string; buttons: number }): Promise<number> {
    return this.withDialog(() => messageBox98(this.doc, o));
  }

  inputBox(o: { prompt: string; title: string; defaultText: string }): Promise<string> {
    return this.withDialog(() => inputBox98(this.doc, o));
  }

  async runtimeErrorBox(o: { number: number; description: string; compile: boolean; mode: 'ide' | 'app'; title: string }): Promise<'end' | 'debug'> {
    const c = runtimeErrorContent(o);
    const defIdx = o.mode === 'ide' && !o.compile ? c.buttons.findIndex(b => b.value === 'debug') : 0;
    const v = await this.withDialog(() => showDialog98(this.doc, {
      title: c.title,
      content: messageContent(c.text, o.compile ? 'exclamation' : undefined),
      buttons: c.buttons.map((b, i) => ({ label: b.label, value: b.value, disabled: b.disabled, default: i === defIdx })),
    }));
    return v === 'debug' ? 'debug' : 'end';
  }
}
