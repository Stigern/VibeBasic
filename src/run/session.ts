// RunSession: the Host of a running VibeBasic program. Owns the Program, the forms (default instances), timers,
// the patch queue and the modal stack, and talks to the windows through a FormHost.

import type { BreakInfo, CodeLocation, Host, VBObject } from '../lang/host';
import { VBRuntimeError } from '../lang/errors';
import { macrotask } from '../lang/interp/driver';
import { Program, type SourceModule } from '../lang/interp/program';
import { Nothing, type VBRef, type VBValue } from '../lang/values';
import type { PictureRef, Project } from '../model/types';
import type { FormHost } from './formHost';
import { NetSession } from './net';
import { DbSession } from './data/dbSession';
import { CommSession } from './comm';
import type { SystemApi } from '../backend/backend';
import { PatchQueue } from './patchQueue';
import { AppObject, PictureObject, ScreenObject } from './objects/appObjects';
import { ClipboardObject, ObjectList } from './objects/globalObjects';
import type { ControlObject } from './objects/controlObject';
import { FormInstance, type FormSession } from './objects/formInstance';
import { DrawnPicture } from './objects/drawSurface';
import { fromBase64 } from '../gfx/raster';
import { PrinterObject, type PrinterHost } from './objects/printerObject';
import type { PrintJob } from './printing';
import type { FormSnapshot } from './protocol';
import { cursorCss } from '../controls/cursor';

export interface SessionCallbacks {
  debugPrint(text: string, newline: boolean): void;
  /** IDE: yellow line and wait. App: never called. `askAi`: the error dialog's Ask AI was pressed (break mode, then the AI flow). */
  onBreak(info: BreakInfo & { askAi?: boolean }): Promise<'continue' | 'end'>;
  onEnded(): void;
  readFile(path: string): Promise<Uint8Array>;            // LoadPicture, MMControl and MediaPlayer files
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
  /** The form activated last (Screen.ActiveForm); null when no form is shown. */
  private activeForm: FormInstance | null = null;
  /** The shown forms in the order they were last activated (the next one to activate when the active form goes). */
  private activation: FormInstance[] = [];
  private readonly screen = new ScreenObject({
    form: () => this.activeForm ?? Nothing,
    control: () => this.activeForm?.activeControl() ?? Nothing,
  }, (pointer, icon) => this.setScreenPointer(pointer, icon));
  /** Screen.MousePointer and MouseIcon: they win over the cursor of every control in every form window, until the program ends. */
  private screenPointer = 0;
  private screenIcon: PictureRef | null = null;
  /** Forms: the loaded forms in the order they were loaded. */
  private readonly formList = new ObjectList('Object',
    () => [...this.forms.values()].filter(f => f.loaded).sort((a, b) => a.loadOrder - b.loadOrder), o => (o as FormInstance).name,
    () => new VBRuntimeError(9));
  private readonly clipboard = new ClipboardObject(() => this.formHost.clipboard?.());
  private readonly title: string;
  private modalStack: FormInstance[] = [];
  private audio?: AudioContext;
  private timers = new Map<ControlObject, ReturnType<typeof setInterval>>();
  private timerBusy = new Set<ControlObject>();
  private lastYield = -Infinity;   // performance.now() of the last real DoEvents yield
  private askAiOnBreak = false;    // the error dialog answered 'ai': the next onBreak (on that error) starts the AI flow
  private netSession: NetSession | null = null;
  private dbSession: DbSession | null = null;
  private commSession: CommSession | null = null;
  private readonly printerHost: PrinterHost = {
    print: job => this.printJob(job), resolveAsset: r => this.resolveAsset(r), title: () => this.app.title,
  };
  /** Printer: the default printer (Set Printer = Printers(i) replaces it). */
  private printer: PrinterObject;
  /** Printers: read from the system before the program starts, when its code uses Printer or Printers. */
  private printerList: PrinterObject[] = [];
  private readonly printers = new ObjectList('Printers', () => this.printerList, o => (o as PrinterObject).deviceName, () => new VBRuntimeError(9));
  private readonly usesPrinters: boolean;

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
    this.program = new Program(modules, this, { appTitle: this.title, appPath: cb.appPath });
    this.printer = new PrinterObject(this.printerHost);
    this.usesPrinters = modules.some(m => /\bprinters?\b/i.test(m.source));
  }

  get appPath(): string { return this.cb.appPath; }
  get state(): 'running' | 'break' | 'ended' { return this._state; }
  get ended(): boolean { return this._state === 'ended'; }

  /** Loads and shows the startup form. */
  async start(): Promise<void> {
    if (this.usesPrinters) await this.loadPrinters();
    const f = this.forms.get(this.project.startupForm.toLowerCase()) ?? [...this.forms.values()][0];
    if (!f) { this.end(); return; }
    await f.show(false);
    this.maybeEnd();
  }

  end(): void { this.program.end(); }

  /** Printers and the default Printer from the host (none when it cannot tell within a few seconds). */
  private async loadPrinters(): Promise<void> {
    const list = this.formHost.listPrinters;
    if (!list) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<[]>(r => { timer = setTimeout(() => r([]), 3000); });
    const infos = await Promise.race([list.call(this.formHost).catch(() => []), late]);
    clearTimeout(timer);
    this.printerList = infos.map(i => new PrinterObject(this.printerHost, i));
    this.printer = this.printerList.find((_, i) => infos[i].isDefault) ?? this.printerList[0] ?? this.printer;
  }

  /** CommonDialog.ShowPrinter: the printers to choose from and the Printer the choice goes to (PrinterDefault). */
  printSetup(): { printers: PrinterObject[]; printer: PrinterObject; select(name: string): void } {
    return {
      printers: this.printerList, printer: this.printer,
      select: name => { const p = this.printerList.find(x => x.deviceName === name); if (p) this.printer = p; },
    };
  }

  private async printJob(job: PrintJob): Promise<void> {
    this.queue.flush();
    if (!this.formHost.printPages) throw new VBRuntimeError(482);
    const assets: Record<string, string> = {};
    for (const p of job.pages) {
      for (const op of p.ops ?? []) {
        const src = op.startsWith('{"o":"pic"') ? (JSON.parse(op) as { src: string }).src : null;
        const url = src && !src.startsWith('data:') ? this.assets[src] : undefined;
        if (url) assets[src!] = url;
      }
    }
    try {
      await this.formHost.printPages({ ...job, assets });
    } catch (e) {
      throw e instanceof VBRuntimeError ? e : new VBRuntimeError(482);   // Printer error
    }
  }

  /** PrintForm: the form's client area on one page, at its size on the screen, with the Printer's settings. */
  printForm(s: FormSnapshot): Promise<void> {
    return this.printJob(this.printer.job([{ ...this.printer.layout(), form: s }]));
  }

  /** The CSS cursor of Screen.MousePointer ('' = none). */
  screenCursor(): string { return cursorCss(this.screenPointer, this.screenIcon ? this.resolveAsset(this.screenIcon) : null); }

  private setScreenPointer(pointer: number, icon: PictureRef | null): void {
    this.screenPointer = pointer;
    this.screenIcon = icon;
    const css = this.screenCursor();
    for (const f of this.forms.values()) f.deliver({ t: 'cursor', css });
  }

  /** Resolves when the files left open at the end are written and closed. */
  get filesClosed(): Promise<void> { return this.program.filesClosed; }

  /**
   * The app is asked to quit (Cmd+Q): as when Windows closes a VB6 app, every loaded form gets QueryUnload with UnloadMode
   * vbAppWindows (2), newest first, then each one unloads, and the program ends. False when a form cancelled (the app stays).
   */
  async quit(): Promise<boolean> {
    if (this.ended) return true;
    const loaded = () => [...this.forms.values()].filter(f => f.loaded).sort((a, b) => b.loadOrder - a.loadOrder);
    for (const f of loaded()) if (!(await f.queryUnload(2))) return this.ended;
    for (const f of loaded()) if (!(await f.unload(2, true))) return this.ended;
    this.end();
    return true;
  }
  pause(): void { this.program.requestPause(); }

  // Debugging (IDE only: a made app never breaks on a breakpoint or a step)
  setBreakpoints(moduleName: string, lines: number[]): void { if (this.mode === 'ide') this.program.setBreakpoints(moduleName, lines); }
  step(mode: 'into' | 'over' | 'out'): void { if (this.mode === 'ide') this.program.step(mode); }
  runToLine(moduleName: string, line: number): void { if (this.mode === 'ide') this.program.runToLine(moduleName, line); }

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

  /** Inet, Winsock, WebBrowser: made when the first such control is created; closed at the end of the program. */
  net(): NetSession {
    if (this.netSession) return this.netSession;
    const api = this.formHost.net?.();
    if (!api) throw new VBRuntimeError(429, 'ActiveX component can\'t create object');
    return this.netSession = new NetSession(api);
  }

  /** Data control, Adodc: made when the first database opens; every connection is closed at the end of the program. */
  db(): DbSession {
    if (this.dbSession) return this.dbSession;
    const api = this.formHost.database?.();
    if (!api) throw new VBRuntimeError(429, 'ActiveX component can\'t create object');
    return this.dbSession = new DbSession(api);
  }

  /** MSComm: made when the first port opens; every port is closed at the end of the program. */
  comm(): CommSession {
    if (this.commSession) return this.commSession;
    const api = this.formHost.serial?.();
    if (!api) throw new VBRuntimeError(8002, 'Invalid port number');
    return this.commSession = new CommSession(api);
  }

  /** SysInfo: the OS version, work area and power state (null: none here, the values are unknown). */
  system(): SystemApi | null { return this.formHost.system?.() ?? null; }

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

  formUnloaded(form: FormInstance): void {
    this.formLeft(form, false);
    this.updateBlocked();
    this.maybeEnd();
  }

  async formActivated(form: FormInstance): Promise<void> {
    if (this.activeForm === form || this.ended) return;
    const old = this.activeForm;
    this.activeForm = form;
    this.activation = [...this.activation.filter(f => f !== form), form];
    if (old?.loaded) await this.fire(old.name, 'Form_Deactivate', []);
    if (form.loaded && this.activeForm === form) await this.fire(form.name, 'Form_Activate', []);
  }

  /** Hide raises Deactivate (Unload does not, as in VB6); the modal form on top, or else the form active before, is activated. */
  formLeft(form: FormInstance, hidden: boolean): void {
    this.activation = this.activation.filter(f => f !== form);
    if (this.activeForm !== form || this.ended) return;
    this.activeForm = null;
    if (hidden && form.loaded) void this.fire(form.name, 'Form_Deactivate', []);
    const top = this.modalStack[this.modalStack.length - 1];
    const next = top?.visible ? top : [...this.activation].reverse().find(f => f.loaded && f.visible);
    if (next) void this.formActivated(next);
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
      if (c) { own.autoLoad(); return c; }   // the form's own code touches a control: VB6 loads the form (again, after Unload Me)
    }
    const f = this.forms.get(l);
    if (f) return f;
    if (l === 'app') return this.app;
    if (l === 'screen') return this.screen;
    if (l === 'forms') return this.formList;
    if (l === 'clipboard') return this.clipboard;
    if (l === 'printer') return this.printer;
    if (l === 'printers') return this.printers;
    return undefined;
  }

  /** `Set Printer = Printers(i)`: the printer the program prints on. */
  setGlobalObject(name: string, value: VBValue): boolean {
    if (name.toLowerCase() !== 'printer') return false;
    if (!(value instanceof PrinterObject)) throw new VBRuntimeError(13);
    this.printer = value;
    return true;
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

  /** Open, Kill, Dir, SaveSetting ...: through the form host (the main window's backend). */
  fileSystem() { return this.formHost.fileSystem?.(); }

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

  /** Beep: a short tone through Web Audio; silent when there is no audio (never throws). One AudioContext per session, closed at the end. */
  beep(): void {
    if (this.ended) return;
    try {
      const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!Ctx) return;
      this.audio ??= new Ctx();
      const osc = this.audio.createOscillator();
      const gain = this.audio.createGain();
      osc.frequency.value = 800;
      gain.gain.value = 0.1;
      osc.connect(gain).connect(this.audio.destination);
      osc.start();
      osc.stop(this.audio.currentTime + 0.15);
    } catch { /* no sound */ }
  }

  /** A file of the program, found as Open finds it (relative paths are from CurDir, which starts as App.Path; `\` separators and
   *  a drive letter are fine: App.Path & "\pic.bmp", "C:\pics\a.bmp"). 53 when it cannot be read, 7 when it is too big (the
   *  rejection's `vbNumber`). */
  async readFile(path: string): Promise<Uint8Array> {
    const full = this.resolvePath(path);
    try {
      return await this.cb.readFile(full);
    } catch (e) {
      const n = (e as { vbNumber?: unknown } | null)?.vbNumber;
      throw new VBRuntimeError(n === 7 ? 7 : 53);
    }
  }

  /** The full path of a file of the program, as Open resolves it (CurDir; the drive letter dropped). */
  resolvePath(path: string): string { return this.program.resolvePath(path); }

  async loadPicture(path: string): Promise<VBValue> {
    if (path === '') return new PictureObject(null);
    const full = path.replace(/\\/g, '/');
    const bytes = await this.readFile(path);
    const ext = /\.([^./]+)$/.exec(full)?.[1]?.toLowerCase() ?? '';
    return new PictureObject({ asset: `data:${MIME[ext] ?? 'application/octet-stream'};base64,${base64(bytes)}` });
  }

  /** SavePicture: an Image (drawn pixels) as BMP or PNG by the extension; a loaded or design-time picture as its own bytes. */
  pictureBytes(picture: VBValue, ext: string): Uint8Array {
    if (picture instanceof DrawnPicture) return picture.fileBytes(ext);
    const ref = picture instanceof PictureObject ? picture.pictureRef : null;
    const url = ref ? this.resolveAsset(ref) : null;
    const m = url ? /^data:[^,]*;base64,(.*)$/s.exec(url) : null;
    if (!m) throw new VBRuntimeError(481);
    return fromBase64(m[1]);
  }

  /** 'ai' (Ask AI) is 'debug' for the program; the break that follows tells the IDE to start the AI flow. */
  async onRuntimeError(err: VBRuntimeError, _at: CodeLocation): Promise<'end' | 'debug'> {
    this.queue.flush();
    const r = await this.formHost.runtimeErrorBox({ number: err.number, description: err.description, compile: err.compile, mode: this.mode, title: this.title });
    this.askAiOnBreak = r === 'ai' && this.mode === 'ide';
    return r === 'end' ? 'end' : 'debug';
  }

  /** Local and module variables of the frame stopped in break mode (empty otherwise). */
  variables(): { name: string; value: string }[] { return this.program.snapshotVariables(); }

  async onBreak(info: BreakInfo): Promise<'continue' | 'end'> {
    this.queue.flush();
    if (this.mode === 'app') return 'end';
    this._state = 'break';
    this.updateBlocked();
    const askAi = this.askAiOnBreak && info.reason === 'error';
    this.askAiOnBreak = false;
    try {
      return await this.cb.onBreak(askAi ? { ...info, askAi } : info);
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
    this.screenPointer = 0;   // Screen.MousePointer is back to the default at the end
    this.screenIcon = null;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.queue.stop();
    this.modalStack = [];
    for (const f of this.forms.values()) if (f.loaded || f.hasWindow()) f.teardown();
    this.netSession?.shutdown();   // every socket closed, every Inet request aborted
    this.dbSession?.shutdown();    // every database connection closed
    this.commSession?.shutdown();  // every serial port closed
    if (this.audio) { this.audio.close().catch(() => { /* already closed */ }); this.audio = undefined; }
    this.cb.onEnded();
  }
}
