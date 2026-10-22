// FormHost that shows every form as an absolutely positioned Win98 "window" div inside one container
// (browser, tests). Dialogs are the plan 02 Win98 dialogs in the same document.

import { formMetrics } from '../controls/render';
import { inputBox98, messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import type { FormHost, FormWindow } from './formHost';
import { mountFormWindow } from './formWindow';
import type { FormSnapshot, FromWindow } from './protocol';

export class InlineFormHost implements FormHost {
  private z = 1;
  private cascade = 0;

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
    return {
      send: m => mounted.receive(m),
      onMessage: cb => {
        listeners.push(cb);
        for (const m of early.splice(0)) cb(m);
      },
      close: async () => { mounted.dispose(); wrapper.remove(); },
    };
  }

  messageBox(o: { prompt: string; title: string; buttons: number }): Promise<number> {
    return messageBox98(this.doc, o);
  }

  inputBox(o: { prompt: string; title: string; defaultText: string }): Promise<string> {
    return inputBox98(this.doc, o);
  }

  /** Placeholder until the VB6-style run-time error dialog (oppgave 4). */
  async runtimeErrorBox(o: { number: number; description: string; compile: boolean; mode: 'ide' | 'app'; title: string }): Promise<'end' | 'debug'> {
    const text = o.compile ? `Compile error:\n\n${o.description}` : `Run-time error '${o.number}':\n\n${o.description}`;
    const content = h('div', { class: 'dlg98-text' }, text);
    content.style.whiteSpace = 'pre-wrap';
    const buttons = o.mode === 'ide'
      ? [{ label: 'End', value: 'end', cancel: true }, { label: 'Debug', value: 'debug', default: true }]
      : [{ label: 'OK', value: 'end', default: true, cancel: true }];
    const v = await showDialog98(this.doc, { title: o.mode === 'ide' ? 'Microsoft Visual Basic' : o.title, content, buttons });
    return v === 'debug' ? 'debug' : 'end';
  }
}
