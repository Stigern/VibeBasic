// FormHost that shows every form as an absolutely positioned Win98 "window" div inside one container
// (browser, tests). Dialogs are the plan 02 Win98 dialogs in the same document.

import { getBackend, type Backend, type DirListing, type NetApi, type Volume } from '../backend/backend';
import type { FileSystemApi } from '../lang/fileio/fsApi';
import { formMetrics } from '../controls/render';
import type { FontValue } from '../model/types';
import { h } from '../ui98/dom';
import { runFileDialog, type FileDialogRequest } from './commonDialog';
import { runDialog } from './dialogSpec';
import type { RuntimeErrorInfo } from './errorDialog';
import type { FormHost, FormWindow } from './formHost';
import type { ClipboardApi } from './objects/globalObjects';
import { mountFormWindow } from './formWindow';
import type { FormSnapshot, FromWindow } from './protocol';

export class InlineFormHost implements FormHost {
  private z = 1;
  private cascade = 0;
  private openDialogs = 0;
  private dialogs = new Set<Element>();
  private windows = new Set<{ sessionBlocked: boolean; apply(): void }>();

  /** `backend` shows the file dialogs (CommonDialog); default: the app's backend. */
  constructor(private container: HTMLElement, private backend?: Backend) {}

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
    const before = new Set(this.doc.querySelectorAll('.dlg98-overlay'));
    try {
      const p = show();
      for (const o of this.doc.querySelectorAll('.dlg98-overlay')) if (!before.has(o)) this.dialogs.add(o);
      return await p;
    } finally {
      if (--this.openDialogs === 0) for (const w of this.windows) w.apply();
    }
  }

  messageBox(o: { prompt: string; title: string; buttons: number }): Promise<number> {
    return this.withDialog(() => runDialog(this.doc, { kind: 'msgbox', ...o })) as Promise<number>;
  }

  inputBox(o: { prompt: string; title: string; defaultText: string }): Promise<string> {
    return this.withDialog(() => runDialog(this.doc, { kind: 'input', ...o })) as Promise<string>;
  }

  fileDialog(o: FileDialogRequest): Promise<string | null> {
    return this.withDialog(() => runFileDialog(this.backend ?? getBackend(), o));
  }

  listVolumes(): Promise<Volume[]> { return (this.backend ?? getBackend()).listVolumes(); }
  listDir(path: string): Promise<DirListing> { return (this.backend ?? getBackend()).listDir(path); }
  net(): NetApi { return this.backend ?? getBackend(); }
  fileSystem(): FileSystemApi { return this.backend ?? getBackend(); }
  clipboard(): ClipboardApi {
    const b = this.backend ?? getBackend();
    return { getText: () => b.clipboardGetText(), setText: t => b.clipboardSetText(t) };
  }

  async colorDialog(o: { color: number }): Promise<number | null> {
    const r = await this.withDialog(() => runDialog(this.doc, { kind: 'color', ...o }));
    return r === '' ? null : Number(r);
  }

  async fontDialog(o: { font: FontValue }): Promise<FontValue | null> {
    const r = await this.withDialog(() => runDialog(this.doc, { kind: 'font', ...o }));
    return r === '' ? null : JSON.parse(String(r)) as FontValue;
  }

  /** Closes dialogs this host opened that are still on screen (End during a MsgBox / error dialog). */
  dispose(): void {
    for (const o of this.dialogs) o.dispatchEvent(new Event('dlg98-abort'));
    this.dialogs.clear();
  }

  runtimeErrorBox(o: RuntimeErrorInfo): Promise<'end' | 'debug' | 'ai'> {
    return this.withDialog(() => runDialog(this.doc, { kind: 'error', info: o })) as Promise<'end' | 'debug' | 'ai'>;
  }
}
