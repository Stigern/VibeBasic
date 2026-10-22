// RunSession: the Host of a running VibeBasic program. Owns the Program, the forms (default instances), timers,
// the patch queue and the modal stack, and talks to the windows through a FormHost.

import type { BreakInfo, CodeLocation, Host, VBObject } from '../lang/host';
import { VBRuntimeError } from '../lang/errors';
import { macrotask } from '../lang/interp/driver';
import { Program, type SourceModule } from '../lang/interp/program';
import type { VBRef, VBValue } from '../lang/values';
import type { PictureRef, Project } from '../model/types';
import type { FormHost } from './formHost';
import { PatchQueue } from './patchQueue';
import { AppObject, PictureObject, ScreenObject } from './objects/appObjects';
import type { ControlObject } from './objects/controlObject';
import { FormInstance, type FormSession } from './objects/formInstance';

export interface SessionCallbacks {
  debugPrint(text: string, newline: boolean): void;
  onBreak(info: BreakInfo): Promise<'continue' | 'end'>;   // IDE: yellow line and wait. App: never called
  onEnded(): void;
  readFile(path: string): Promise<Uint8Array>;            // LoadPicture
  appPath: string;
  /** App.EXEName; defaults to the project name (the IDE). Made apps pass the bundle name. */
  appName?: string;
}

/** Patches are sent at the latest 16 ms after they were queued. */
class TimedPatchQueue extends PatchQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  override set(...a: Parameters<PatchQueue['set']>): void {
    super.set(...a);
    this.timer ??= setTimeout(() => { this.timer = null; this.flush(); }, 16);
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Minimum time between two DoEvents calls that really give the event loop a turn. */
const DOEVENTS_MS = 8;

const MIME: Record<string, string> = {
  bmp: 'image/bmp', dib: 'image/bmp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  ico: 'image/x-icon', cur: 'image/x-icon', wmf: 'image/wmf', emf: 'image/emf', svg: 'image/svg+xml', webp: 'image/webp',
};

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class RunSession implements Host, FormSession {
  readonly program: Program;
  readonly queue: TimedPatchQueue;
  readonly assets: Record<string, string> = {};
  private _state: 'running' | 'break' | 'ended' = 'running';
  private readonly forms = new Map<string, FormInstance>();   // lower-case name
  private readonly app: AppObject;
  private readonly screen = new ScreenObject();
  private readonly title: string;
  private modalStack: FormInstance[] = [];
  private timers = new Map<ControlObject, ReturnType<typeof setInterval>>();
  private timerBusy = new Set<ControlObject>();
  private lastYield = -Infinity;   // performance.now() of the last real DoEvents yield

  constructor(private project: Project, readonly formHost: FormHost, private cb: SessionCallbacks, readonly mode: 'ide' | 'app') {
    for (const [k, a] of Object.entries(project.assets)) this.assets[k] = `data:${a.mime};base64,${a.dataBase64}`;
    this.queue = new TimedPatchQueue((key, m) => this.forms.get(key.toLowerCase())?.deliver(m));
    for (const f of project.forms) this.forms.set(f.name.toLowerCase(), new FormInstance(f, this));
    this.title = project.title || project.name;
    this.app = new AppObject(this.title, cb.appPath, cb.appName || project.name);
    const modules: SourceModule[] = [
      ...project.forms.map(f => ({ name: f.name, kind: 'form' as const, source: f.code })),
      ...project.modules.map(m => ({ name: m.name, kind: 'module' as const, source: m.code })),
    ];
    this.program = new Program(modules, this, { appTitle: this.title });
  }

  get state(): 'running' | 'break' | 'ended' { return this._state; }
  get ended(): boolean { return this._state === 'ended'; }

  /** Loads and shows the startup form. */
  async start(): Promise<void> {
    const f = this.forms.get(this.project.startupForm.toLowerCase()) ?? [...this.forms.values()][0];
    if (!f) { this.end(); return; }
    await f.show(false);
    this.maybeEnd();
  }

  end(): void { this.program.end(); }
  pause(): void { this.program.requestPause(); }

  async immediate(text: string): Promise<string> {
    const r = await this.program.immediate(text);
    this.queue.flush();
    return r;
  }

  // -- FormSession ----------------------------------------------------------------------------------------------

  async fire(moduleName: string, proc: string, args: VBRef[]): Promise<void> {
    if (this.ended || !this.program.hasProcedure(moduleName, proc)) return;
    await this.program.runEvent(moduleName, proc, args);
    this.queue.flush();
    this.maybeEnd();
  }

  /** The program ends when no form is loaded and no code runs. */
  private maybeEnd(): void {
    if (this.ended || this.program.state === 'running' || this.program.state === 'break') return;
    for (const f of this.forms.values()) if (f.loaded) return;
    this.program.end();
  }

  resolveAsset(ref: PictureRef): string | null {
    return this.assets[ref.asset] ?? (ref.asset.startsWith('data:') ? ref.asset : null);
  }

  syncTimer(form: FormInstance, t: ControlObject): void {
    const old = this.timers.get(t);
    if (old !== undefined) { clearInterval(old); this.timers.delete(t); }
    const interval = Number(t.props.Interval);
    if (this.ended || !form.loaded || t.props.Enabled !== true || !(interval > 0)) return;
    this.timers.set(t, setInterval(() => {
      if (this.timerBusy.has(t)) return;   // the previous Timer event is still running: drop this one
      this.timerBusy.add(t);
      void form.fireControl(t, 'Timer', []).finally(() => this.timerBusy.delete(t));
    }, interval));
  }

  formUnloaded(_form: FormInstance): void {
    this.updateBlocked();
    this.maybeEnd();
  }

  pushModal(form: FormInstance): void {
    if (!this.modalStack.includes(form)) this.modalStack.push(form);
    this.updateBlocked();
  }

  popModal(form: FormInstance): void {
    const i = this.modalStack.indexOf(form);
    if (i < 0) return;
    this.modalStack.splice(i, 1);
    this.updateBlocked();
  }

  /** Windows ignore input in break mode and while another form is shown modally. */
  updateBlocked(): void {
    const top = this.modalStack[this.modalStack.length - 1];
    for (const f of this.forms.values()) {
      if (!f.hasWindow()) continue;
      const b = this._state === 'break' || (top !== undefined && f !== top);
      if (b === f.blocked) continue;
      f.blocked = b;
      this.queue.send(f.key, { t: 'blocked', blocked: b });
    }
  }

  // -- Host -----------------------------------------------------------------------------------------------------

  resolveName(moduleName: string, name: string): VBObject | undefined {
    const l = name.toLowerCase();
    const own = this.forms.get(moduleName.toLowerCase());
    if (own) {
      if (l === 'me') return own;
      const c = own.control(name);
      if (c) return c;
    }
    const f = this.forms.get(l);
    if (f) return f;
    if (l === 'app') return this.app;
    if (l === 'screen') return this.screen;
    return undefined;
  }

  msgBox(prompt: string, buttons: number, title: string): Promise<number> {
    this.queue.flush();
    return this.formHost.messageBox({ prompt, buttons, title: title || this.title });
  }

  inputBox(prompt: string, title: string, defaultText: string): Promise<string> {
    this.queue.flush();
    return this.formHost.inputBox({ prompt, title: title || this.title, defaultText });
  }

  debugPrint(text: string, newline: boolean): void { this.cb.debugPrint(text, newline); }

  /**
   * DoEvents. Queued VB events are pumped by the driver on every await; the window (UI, timers, IPC) gets a real
   * macrotask at most every DOEVENTS_MS, so `For i = 1 To 20000: DoEvents: Next` does not take 20000 timer turns.
   */
  async doEvents(): Promise<void> {
    const t = performance.now();
    if (t - this.lastYield < DOEVENTS_MS) return;
    this.queue.flush();
    await macrotask();
    this.lastYield = performance.now();
  }

  async loadPicture(path: string): Promise<VBValue> {
    if (path === '') return new PictureObject(null);
    const p = path.replace(/\\/g, '/');   // VB code builds Windows paths: App.Path & "\pic.bmp"
    const full = p.startsWith('/') || /^[A-Za-z]:\//.test(p) ? p : `${this.cb.appPath.replace(/\\/g, '/').replace(/\/+$/, '')}/${p}`;
    let bytes: Uint8Array;
    try {
      bytes = await this.cb.readFile(full);
    } catch {
      throw new VBRuntimeError(53);
    }
    const ext = /\.([^./]+)$/.exec(full)?.[1]?.toLowerCase() ?? '';
    return new PictureObject({ asset: `data:${MIME[ext] ?? 'application/octet-stream'};base64,${base64(bytes)}` });
  }

  onRuntimeError(err: VBRuntimeError, _at: CodeLocation): Promise<'end' | 'debug'> {
    this.queue.flush();
    return this.formHost.runtimeErrorBox({ number: err.number, description: err.description, compile: err.compile, mode: this.mode, title: this.title });
  }

  async onBreak(info: BreakInfo): Promise<'continue' | 'end'> {
    this.queue.flush();
    if (this.mode === 'app') return 'end';
    this._state = 'break';
    this.updateBlocked();
    try {
      return await this.cb.onBreak(info);
    } finally {
      if (this._state === 'break') {
        this._state = 'running';
        this.updateBlocked();
      }
    }
  }

  onEnd(): void {
    if (this.ended) return;
    this._state = 'ended';
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.queue.stop();
    this.modalStack = [];
    for (const f of this.forms.values()) if (f.loaded || f.hasWindow()) f.teardown();
    this.cb.onEnded();
  }
}
