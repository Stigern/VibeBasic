// FormHost that shows every running form as its own Tauri window (form.html#<key>, label vbform-<key>) and every
// MsgBox / InputBox / error dialog as a separate always-on-top window (form.html#dialog-<n>, label vbdialog-<n>).
//
// Wire protocol (main <-> window), all Tauri events:
//   window -> main  'vb:hello'    key                      the page is listening; main answers:
//   main -> window  'vb:snapshot' FormSnapshot             (form)   or   'vb:dialog' DialogSpec (dialog)
//   main -> window  'vb:to'       ToWindow                 emitTo(label), in order (queued until hello)
//   window -> main  'vb:from'     { key, m: FromWindow }   or   { key, result } when a dialog closes
// Listeners live only while a window is open; close()/dispose() destroy windows and unlisten.

import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DialogSpec } from './dialogSpec';
import type { RuntimeErrorInfo } from './errorDialog';
import type { FormHost, FormWindow } from './formHost';
import type { FormSnapshot, FromWindow, ToWindow } from './protocol';
import { windowOptionsFor } from './windowOptions';

export interface FromPayload { key: string; m?: FromWindow; result?: number | string }

export interface WindowCreateOptions {
  url: string; title: string; width: number; height: number; x?: number; y?: number; center: boolean;
  resizable: boolean; minimizable: boolean; maximizable: boolean;
  decorations: false; visible: false; alwaysOnTop: boolean; focus: boolean;
}

/** The few Tauri calls the host needs; replaced by a fake in tests. */
export interface TauriGlue {
  createWindow(label: string, o: WindowCreateOptions): Promise<{ destroy(): Promise<void> }>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
  emitTo(label: string, event: string, payload: unknown): Promise<void>;
}

export const tauriGlue: TauriGlue = {
  async createWindow(label, o) {
    const stale = await WebviewWindow.getByLabel(label);
    if (stale) await stale.destroy().catch(() => {});
    const w = new WebviewWindow(label, o);
    await new Promise<void>((resolve, reject) => {
      void w.once('tauri://created', () => resolve());
      void w.once('tauri://error', e => reject(new Error(`Could not open window ${label}: ${String(e.payload)}`)));
    });
    return { destroy: () => w.destroy() };
  },
  listen: (event, cb) => listen(event, e => cb(e.payload as never)),
  emitTo: (label, event, payload) => emitTo(label, event, payload),
};

interface Entry { hello(): void; from(p: FromPayload): void }

export class TauriFormHost implements FormHost {
  private entries = new Map<string, Entry>();                 // by key ('Form1', 'dialog-3')
  private listening: Promise<(() => void)[]> | null = null;
  private closing = new Map<string, Promise<void>>();         // label -> destroy in progress
  private closers = new Set<() => Promise<void>>();
  private forms = new Set<{ apply(): void }>();
  private cascade = 0;
  private dialogSeq = 0;
  private openDialogs = 0;

  constructor(private glue: TauriGlue = tauriGlue) {}

  private ensureListening(): Promise<unknown> {
    this.listening ??= Promise.all([
      this.glue.listen<string>('vb:hello', key => this.entries.get(key)?.hello()),
      this.glue.listen<FromPayload>('vb:from', p => { if (p && typeof p.key === 'string') this.entries.get(p.key)?.from(p); }),
    ]);
    return this.listening;
  }

  private async releaseIfIdle(): Promise<void> {
    if (this.entries.size > 0 || !this.listening) return;
    const l = this.listening;
    this.listening = null;
    for (const un of await l) un();
  }

  /** Sends in order (one IPC call at a time) once the window said hello. */
  private channel(label: string) {
    let ready = false, chain = Promise.resolve();
    const queue: [string, unknown][] = [];
    const push = (event: string, payload: unknown) => {
      chain = chain.then(() => this.glue.emitTo(label, event, payload)).catch(() => {});
    };
    return {
      post(event: string, payload: unknown) { if (ready) push(event, payload); else queue.push([event, payload]); },
      /** hello: first `first` (snapshot / dialog spec), then whatever was queued. */
      open(first: [string, unknown]) {
        push(...first);
        ready = true;
        for (const q of queue.splice(0)) push(...q);
      },
    };
  }

  private async destroy(label: string, handle: Promise<{ destroy(): Promise<void> }>): Promise<void> {
    const p = handle.then(h => h.destroy()).catch(() => {});
    this.closing.set(label, p);
    await p;
    if (this.closing.get(label) === p) this.closing.delete(label);
  }

  async openForm(s: FormSnapshot, o: { modal: boolean }): Promise<FormWindow> {
    const label = `vbform-${s.key}`;
    await this.closing.get(label);
    await this.ensureListening();
    const ch = this.channel(label);
    const listeners: ((m: FromWindow) => void)[] = [];
    const early: FromWindow[] = [];
    let sessionBlocked = false, closed = false;
    const w = { apply: () => ch.post('vb:to', { t: 'blocked', blocked: sessionBlocked || this.openDialogs > 0 } satisfies ToWindow) };
    this.entries.set(s.key, {
      hello: () => ch.open(['vb:snapshot', s]),
      from: p => {
        if (!p.m) return;
        if (listeners.length) for (const l of listeners) l(p.m); else early.push(p.m);
      },
    });
    this.forms.add(w);
    const close = async () => {
      if (closed) return;
      closed = true;
      this.entries.delete(s.key);
      this.forms.delete(w);
      this.closers.delete(close);
      await this.destroy(label, handle);
      await this.releaseIfIdle();
    };
    this.closers.add(close);
    const handle = this.glue.createWindow(label, {
      ...windowOptionsFor(s.form, this.cascade++),
      url: `form.html#${encodeURIComponent(s.key)}`, title: String(s.form.props.Caption ?? s.form.name),
      decorations: false, visible: false, alwaysOnTop: o.modal, focus: true,
    });
    try { await handle; } catch (e) { await close(); throw e; }
    if (this.openDialogs > 0) w.apply();
    return {
      send: m => {
        if (closed) return;
        if (m.t === 'blocked') { sessionBlocked = m.blocked; w.apply(); } else ch.post('vb:to', m);
      },
      onMessage: cb => { listeners.push(cb); for (const m of early.splice(0)) cb(m); },
      close,
    };
  }

  /** One dialog window; every form window is blocked while any dialog is open. */
  private async dialog(spec: DialogSpec, cancelled: number | string): Promise<number | string> {
    const n = ++this.dialogSeq;
    const key = `dialog-${n}`, label = `vbdialog-${n}`;
    await this.ensureListening();
    if (this.openDialogs++ === 0) for (const f of this.forms) f.apply();
    const ch = this.channel(label);
    let done!: (v: number | string) => void;
    const result = new Promise<number | string>(r => { done = r; });
    this.entries.set(key, { hello: () => ch.open(['vb:dialog', spec]), from: p => { if (p.result !== undefined) done(p.result); } });
    const cancel = async () => done(cancelled);
    this.closers.add(cancel);
    const title = spec.kind === 'error' ? spec.info.title : spec.title;
    const handle = this.glue.createWindow(label, {
      url: `form.html#${key}`, title, width: 420, height: 160, center: true,
      resizable: false, minimizable: false, maximizable: false,
      decorations: false, visible: false, alwaysOnTop: true, focus: true,
    });
    try {
      return await Promise.race([result, handle.then(() => result)]);
    } finally {
      this.closers.delete(cancel);
      this.entries.delete(key);
      await this.destroy(label, handle);
      if (--this.openDialogs === 0) for (const f of this.forms) f.apply();
      await this.releaseIfIdle();
    }
  }

  async messageBox(o: { prompt: string; title: string; buttons: number }): Promise<number> {
    return Number(await this.dialog({ kind: 'msgbox', ...o }, 2));
  }

  async inputBox(o: { prompt: string; title: string; defaultText: string }): Promise<string> {
    return String(await this.dialog({ kind: 'input', ...o }, ''));
  }

  async runtimeErrorBox(o: RuntimeErrorInfo): Promise<'end' | 'debug'> {
    return (await this.dialog({ kind: 'error', info: o }, 'end')) === 'debug' ? 'debug' : 'end';
  }

  /** End of the run: closes every form and dialog window and drops the event listeners. */
  async dispose(): Promise<void> {
    await Promise.all([...this.closers].map(c => c()));
    await Promise.all(this.closing.values());
    await this.releaseIfIdle();
  }
}
