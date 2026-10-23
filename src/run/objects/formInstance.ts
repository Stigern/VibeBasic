// A form of the running program (its default instance): properties, controls as members, and the VB6
// life cycle — Initialize → Load → (shown) → Resize → Activate; QueryUnload → Unload; Show [vbModal] / Hide.

import type { GraphicsCall, VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import type { Program } from '../../lang/interp/program';
import { Empty, Nothing, VBArray, VBRef, coerce, toBool, type VBValue } from '../../lang/values';
import { CONTROL_TYPES, getPropDef } from '../../model/controls';
import { dockEdge, formClientTwips, stackDocks, type DockEdge, type Rect } from '../../model/geometry';
import { formEvents, formHasProp, formObjectName, isMdiChild } from '../../model/mdi';
import type { ControlDef, FormDef, PictureRef, PropValue } from '../../model/types';
import type { FormHost, FormWindow } from '../formHost';
import { localMedia } from '../mediaSource';
import type { PatchQueue } from '../patchQueue';
import type { NetSession } from '../net';
import type { CommSession } from '../comm';
import type { SystemApi } from '../../backend/backend';
import type { DbSession } from '../data/dbSession';
import type { FormSnapshot, FromWindow, OleMessage, ToWindow } from '../protocol';
import { ControlArrayObject, ControlObject, type ElementFactory, type RunContext } from './controlObject';
import { ObjectList } from './globalObjects';
import { DataObject } from './dataObject';
import { PictureObject } from './appObjects';

const CF_TEXT = 1, CF_BITMAP = 2, DROP_COPY = 1, DROP_MOVE = 2;
/** The effect of a drop the source allows: a copy with Ctrl, else a move (a copy when the source allows no move). */
const pickEffect = (allowed: number, shift: number): number =>
  (shift & 2 ? allowed & DROP_COPY : allowed & DROP_MOVE || allowed & DROP_COPY);
/** OLEDropMode 2 takes text into a TextBox and a picture into a PictureBox or Image. */
const autoDrop = (c: ControlObject, d: DataObject): boolean =>
  c.def.type === 'TextBox' ? d.text() !== null : (c.def.type === 'PictureBox' || c.def.type === 'Image') && d.picture() !== null;

/** What a form needs from its run session. */
export interface FormSession {
  readonly program: Program;
  readonly queue: PatchQueue;
  readonly formHost: FormHost;
  readonly mode: 'ide' | 'app';
  /** The folder of the project (App.Path): where DirListBox and FileListBox start. */
  readonly appPath: string;
  readonly assets: Record<string, string>;
  readonly ended: boolean;
  resolveAsset(ref: PictureRef): string | null;
  loadPicture(path: string): Promise<VBValue>;
  /** Runs `proc` of `moduleName` if it exists (then flushes and checks for the end of the program). */
  fire(moduleName: string, proc: string, args: VBRef[]): Promise<void>;
  syncTimer(form: FormInstance, timer: ControlObject): void;
  /** The form is being loaded (a `New` instance is held by the session until it unloads). */
  formLoading?(form: FormInstance): void;
  formUnloaded(form: FormInstance): void;
  /** The CSS cursor Screen.MousePointer puts over every form window ('' = none). */
  screenCursor(): string;
  /** The form became the active one (shown, or the user focused it): Screen.ActiveForm; Deactivate on the form that was active,
   *  then Activate on this one (nothing when it already is the active one). */
  formActivated(form: FormInstance): Promise<void>;
  /** The form was hidden or unloaded: when it was the active one, the form below it becomes active. */
  formLeft(form: FormInstance, hidden: boolean): void;
  /** The project's MDI form (null without one); its active child (MDIForm.ActiveForm) and its loaded children (newest first). */
  mdiForm(): FormInstance | null;
  mdiActiveChild(): FormInstance | null;
  mdiChildren(): FormInstance[];
  pushModal(form: FormInstance): void;
  popModal(form: FormInstance): void;
  updateBlocked(): void;
  /** Inet, Winsock, WebBrowser: the run's network (made on first use; throws when the host has none). */
  net(): NetSession;
  /** MMControl and MediaPlayer: a file of the program (relative to App.Path); error 53 when it cannot be read. */
  readFile(path: string): Promise<Uint8Array>;
  /** RichTextBox.LoadFile / SaveFile: a whole file through the file system. */
  loadBytes(path: string): Promise<Uint8Array>;
  saveBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** The full path of a file of the program. */
  resolvePath(path: string): string;
  /** Data control, Adodc: the run's databases (made on first use; throws when the host has none). */
  db(): DbSession;
  /** MSComm: the run's serial ports (made on first use; throws 8002 when the host has none). */
  comm(): CommSession;
  /** SysInfo: the system's state, or null when the host cannot tell. */
  system(): SystemApi | null;
  msgBox(prompt: string, buttons: number, title: string): Promise<number>;
  /** PrintForm: prints the form's client area (as the snapshot shows it) with the Printer's settings. */
  printForm(s: FormSnapshot): Promise<void>;
  /** CommonDialog.ShowPrinter: the printers and the Printer. */
  printSetup(): ReturnType<NonNullable<RunContext['printSetup']>>;
}

interface FormState {
  form: ControlObject;                                       // the form's own properties (id 'form')
  byId: Map<string, ControlObject>;
  byName: Map<string, ControlObject | ControlArrayObject>;   // lower-case name
}

const lc = (s: string): string => s.toLowerCase();
const FORM_METHODS = new Set(['show', 'hide', 'refresh', 'move', 'setfocus', 'zorder', 'validatecontrols', 'popupmenu']);
/** Members every form has besides its registry properties: Controls, ActiveControl and Count (the number of controls). */
const FORM_OBJECTS = new Set(['controls', 'activecontrol', 'count']);
/** What only an MDI form has: ActiveForm (the active child) and Arrange. */
const MDI_MEMBERS = new Set(['activeform', 'arrange']);
let loadCounter = 0;
const copyProps = (p: Record<string, PropValue>): Record<string, PropValue> =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));

export class FormInstance implements VBObject {
  readonly vbTypeName = 'Form';
  loaded = false;
  visible = false;
  /** Last `blocked` sent to the window. */
  blocked = false;
  private st: FormState | null = null;
  private window: FormWindow | null = null;
  private opening: Promise<void> | null = null;
  private readonly quiet = new Set<ControlObject>();   // an option or ribbon released by its group: no Click
  private early: ToWindow[] | null = null;        // messages queued while the window opens
  private loadDone: Promise<void> | null = null;
  private unloading = false;
  private modalWaiters: (() => void)[] = [];
  /** PopupMenu calls waiting for the window's answer (by request id). */
  private popups = new Map<number, (id: string | null) => void>();
  private popupSeq = 0;
  private readonly controlNames: Set<string>;
  /** The control with the focus (Me.ActiveControl), by id. */
  private activeId: string | null = null;
  /** Order of loading (the Forms collection lists the loaded forms in it). */
  loadOrder = 0;
  private readonly controlList = new ObjectList('Object', () => this.controls(), o => (o as ControlObject).name,
    n => new VBRuntimeError(730, `Control '${n}' not found`));

  /** Show was asked for (an MDI child then does not show itself when its Load ends: AutoShowChildren). */
  private showAsked = false;

  /** `key`: the default instance has the form's name; another one (New Form1) a key of its own ("Form1:2"), which is also the
   *  module its code runs in (Program.addFormInstance). */
  constructor(readonly def: FormDef, private s: FormSession, readonly key: string = def.name) {
    this.controlNames = new Set(def.controls.map(c => lc(c.name)));
  }

  get name(): string { return this.def.name; }
  /** The project's MDI form (MDIForm), and an MDI child (MDIChild = True) shown in its workspace. */
  get isMdi(): boolean { return this.def.mdi === true; }
  get isMdiChild(): boolean { return isMdiChild(this.def); }
  /** The name of the form's own events in its code: Form_Load, MDIForm_Load. */
  private get objName(): string { return formObjectName(this.def); }

  /** The form's window shows a menu bar: a visible top-level menu (an MDI child's menus show on the MDI form's bar). */
  showsMenuBar(): boolean {
    return !this.isMdiChild && !!this.st && [...this.st.byId.values()].some(c => c.def.type === 'Menu' && c.def.parentId === null && c.props.Visible !== false);
  }

  /** Runs `<Form|MDIForm>_<event>` of this instance. */
  fireForm(event: string, args: VBRef[]): Promise<void> {
    return this.s.fire(this.key, `${this.objName}_${event}`, args);
  }

  /** The run-time mirror (built on first use, discarded on Unload: the next use starts from the design-time props). */
  private state(): FormState {
    if (this.st) return this.st;
    const ctx: RunContext = {
      resolveAsset: r => this.s.resolveAsset(r),
      loadPicture: p => this.s.loadPicture(p),
      timerChanged: c => this.s.syncTimer(this, c),
      propChanged: (c, p, old) => this.propChanged(c, p, old),
      dialogs: this.s.formHost,
      printSetup: () => this.s.printSetup(),
      controlByName: n => this.state().byName.get(lc(n)),
      files: { listVolumes: () => this.s.formHost.listVolumes(), listDir: p => this.s.formHost.listDir(p), defaultPath: this.s.appPath },
      net: () => this.s.net(),
      loadBytes: p => this.s.loadBytes(p),
      saveBytes: (p, b) => this.s.saveBytes(p, b),
      // MMControl / MediaPlayer: a window of its own reads the file itself (FormHost.openMedia); the inline host shares this document
      openMedia: async (p, mime) => {
        const host = this.s.formHost;
        if (host.openMedia) return host.openMedia(this.s.resolvePath(p), mime);
        return localMedia(await this.s.readFile(p), mime);
      },
      raise: (c, event, args) => (this.st?.byId.get(c.def.id) === c && !this.s.ended ? this.fireControl(c, event, args) : Promise.resolve()),
      focused: c => this.setActive(c.def.id),
      db: () => this.s.db(),
      comm: () => this.s.comm(),
      system: () => this.s.system(),
      resolveDbPath: p => this.s.program.resolvePath(p),
      controls: () => this.controls(),
      msgBox: (p, b, t) => this.s.msgBox(p, b, t),
      inProgramScope: fn => this.s.program.inScope(fn),
      resized: c => { if (this.visible && this.st?.byId.get(c.def.id) === c) void this.fireControl(c, 'Resize', []).then(() => this.paint(c)); },
      repaint: c => this.paint(c, true).then(() => Empty),
      menuBar: () => this.showsMenuBar(),
      container: c => {
        const st = this.st;
        if (!st) return null;
        if (c.def.parentId === null) return st.form;
        const p = st.byId.get(c.def.parentId);
        return p?.def.type === 'PictureBox' ? p : null;
      },
      workArea: () => {
        if (!this.isMdi || !this.st) return null;
        const r = this.docks().rest;
        return { w: r.width / 15, h: r.height / 15 };
      },
    };
    // Load Name(i) / Unload Name(i). A control without a view (Winsock, Timer ...) starts from the design-time properties
    // of the lowest element; a visible one from its current properties, hidden (Visible = False) and last in the tab
    // order, and the form window gets it as a new control.
    const elements: ElementFactory = {
      spawn: (t, index) => {
        const invisible = CONTROL_TYPES[t.def.type].invisibleAtRuntime;
        const props = copyProps(invisible ? t.def.props : t.props);
        if (!invisible && t.def.type !== 'Menu') {   // a menu element keeps the lowest one's Visible (the MRU list shows at once)
          props.Visible = false;
          if ('TabIndex' in props) props.TabIndex = Math.max(-1, ...[...this.state().byId.values()].map(o => Number(o.props.TabIndex ?? -1))) + 1;
        }
        const def: ControlDef = { ...t.def, id: `${t.def.id}~${index}`, index, props };
        const c = new ControlObject(def, this.key, this.s.queue, ctx);
        if (!invisible) c.copyItemData(t);
        this.state().byId.set(def.id, c);
        if (def.type === 'Timer') this.s.syncTimer(this, c);
        if (!invisible) this.s.queue.send(this.key, { t: 'addControl', def: { ...def, props: copyProps(c.props) }, handled: this.handledEvents(def) });
        return c;
      },
      drop: c => {
        c.dispose();
        this.st?.byId.delete(c.def.id);
        if (this.activeId === c.def.id) this.activeId = null;
        if (c.def.type === 'Timer') { c.props.Enabled = false; this.s.syncTimer(this, c); }
        if (!CONTROL_TYPES[c.def.type].invisibleAtRuntime) this.s.queue.send(this.key, { t: 'removeControl', id: c.def.id });
      },
    };
    const formDef = { id: 'form', type: 'Form', name: this.def.name, index: null, parentId: null, props: this.def.props } as unknown as ControlDef;
    const st: FormState = { form: new ControlObject(formDef, this.key, this.s.queue, ctx), byId: new Map(), byName: new Map() };
    for (const d of this.def.controls) {
      const c = new ControlObject(d, this.key, this.s.queue, ctx);
      st.byId.set(d.id, c);
      if (d.index === null) st.byName.set(lc(d.name), c);
      else {
        let arr = st.byName.get(lc(d.name));
        if (!(arr instanceof ControlArrayObject)) st.byName.set(lc(d.name), arr = new ControlArrayObject(d.name, [], elements));
        arr.add(c);
      }
    }
    this.st = st;
    this.layoutDocks(false);
    return st;
  }

  /** The docked controls (an aligned PictureBox, a Toolbar, StatusBar or CoolBar) as the window lays them out (render.ts dock): in
   *  z-order each takes its edge of what the ones before it leave; `rest` is what is left (an MDI form's workspace). Twips. */
  private docks(): { rects: Map<ControlObject, Rect>; edges: Map<ControlObject, DockEdge>; rest: Rect } {
    const st = this.st!;
    const client = formClientTwips(st.form.props, this.showsMenuBar());
    const items: { key: ControlObject; edge: DockEdge; size: number }[] = [];
    const edges = new Map<ControlObject, DockEdge>();
    for (const c of st.byId.values()) {
      const edge = dockEdge({ type: c.def.type, parentId: c.def.parentId, props: c.props });
      if (!edge) continue;
      edges.set(c, edge);
      const across = edge === 'left' || edge === 'right';
      items.push({ key: c, edge, size: c.props.Visible === false ? 0 : Number(across ? c.props.Width : c.props.Height) || 0 });
    }
    return { ...stackDocks(items, client.width, client.height), edges };
  }

  /** The docked controls get the place the window gives them (Left, Top and their length along the edge, VB6: Picture1.Width is the
   *  form's ScaleWidth). With `raise`, a PictureBox whose size changed gets its Resize (and Paint) once the form is shown. */
  private layoutDocks(raise: boolean): void {
    const { rects, edges } = this.docks();
    for (const [c, r] of rects) {
      if (c.props.Visible === false) continue;   // a hidden one keeps its own size
      const across = edges.get(c) === 'left' || edges.get(c) === 'right';
      const before = [c.props.Width, c.props.Height];
      c.props.Left = r.left; c.props.Top = r.top;
      if (across) c.props.Height = r.height; else c.props.Width = r.width;
      if (raise && c.def.type === 'PictureBox' && (c.props.Width !== before[0] || c.props.Height !== before[1]) && this.visible) {
        void this.fireControl(c, 'Resize', []).then(() => this.paint(c));
      }
    }
  }

  /** A control (or control array) of this form by name; undefined for other names. */
  control(name: string): ControlObject | ControlArrayObject | undefined {
    return this.controlNames.has(lc(name)) ? this.state().byName.get(lc(name)) : undefined;
  }

  /** Every control of the form (control array elements too, loaded ones last): Me.Controls. */
  controls(): ControlObject[] {
    return [...this.state().byId.values()];
  }

  /** The control with the focus, Nothing when none has it. */
  activeControl(): VBValue {
    return (this.activeId !== null ? this.st?.byId.get(this.activeId) : undefined) ?? Nothing;
  }

  private setActive(id: string | null): void {
    this.activeId = id;
    if (this.visible) void this.s.formActivated(this);
  }

  timers(): ControlObject[] {
    return this.st ? [...this.st.byId.values()].filter(c => c.def.type === 'Timer') : [];
  }

  // -- life cycle ---------------------------------------------------------------------------------------------

  /** Load: Form_Initialize then Form_Load. An MDI child loads the MDI form first (error 366 without one) and, when the MDI form's
   *  AutoShowChildren is True, shows itself once loaded. */
  load(): Promise<void> {
    if (this.loaded) return this.loadDone ?? Promise.resolve();
    const parent = this.isMdiChild ? this.s.mdiForm() : null;
    if (this.isMdiChild && !parent) throw new VBRuntimeError(366);
    this.loaded = true;
    this.loadOrder = ++loadCounter;
    this.s.formLoading?.(this);
    const st = this.state();
    st.form.props.Visible = false;
    for (const t of this.timers()) this.s.syncTimer(this, t);
    // Form_Load starts once Form_Initialize has finished; without an Initialize handler it starts at once,
    // so a member access that loads the form runs Load nested in the accessing statement.
    // after Form_Load the Data controls open their recordsets (not waited for: the form shows meanwhile)
    const dataLoad = (): void => { if (this.loaded && !this.s.ended) for (const c of this.controls()) void c.formLoaded(); };
    const runLoad = (): Promise<void> => (this.loaded && !this.s.ended ? this.fireForm('Load', []).then(dataLoad) : Promise.resolve());
    const start = (): Promise<void> => (this.s.program.hasProcedure(this.key, `${this.objName}_Initialize`)
      ? this.fireForm('Initialize', []).then(runLoad)
      : runLoad());
    if (!parent) return this.loadDone = start();
    const done = (parent.loaded ? start() : parent.load().then(start)).then(() => {
      if (this.loaded && !this.visible && !this.showAsked && !this.s.ended && parent.formProp('AutoShowChildren') !== false) void this.show(false);
    });
    return this.loadDone = done;
  }

  /** A property of the form as the program sees it now (the design-time value before Load). */
  formProp(name: string): PropValue | undefined {
    return (this.st?.form.props ?? this.def.props)[name];
  }

  /** VB6 loads a form when code touches one of its properties or controls (not its Public variables and procedures). */
  autoLoad(): void {
    if (!this.loaded && !this.s.ended) void this.load();
  }

  async show(modal: boolean): Promise<void> {
    if (modal && (this.isMdi || this.isMdiChild)) throw new VBRuntimeError(403);   // MDI forms cannot be shown modally
    this.showAsked = true;
    if (!this.loaded) await this.load();
    if (!this.loaded || this.s.ended) return;
    if (modal && this.visible) throw new VBRuntimeError(400, 'Form already displayed; can\'t show modally');
    if (this.isMdiChild) {   // the MDI form shows first: the child shows in its workspace
      const parent = this.s.mdiForm();
      if (parent && (!parent.visible || !parent.hasWindow())) await parent.showForChild();
      if (!parent?.hasWindow() || !this.loaded || this.s.ended) return;
    }
    const wasVisible = this.visible;
    this.visible = true;
    this.state().form.props.Visible = true;
    if (!this.window) {
      this.opening ??= this.open(modal);
      await this.opening;
      if (!this.window) return;
      if (modal) this.s.pushModal(this);
      await this.fireForm('Resize', []);
    } else {
      if (!wasVisible) this.deliver({ t: 'show' });
      if (modal) this.s.pushModal(this);
    }
    if (this.loaded && this.visible) await this.s.formActivated(this);
    if (!wasVisible && this.loaded && this.visible) {
      this.deliver({ t: 'focusInitial' });
      await this.paintAll();
    }
    if (modal && this.visible && this.loaded) await new Promise<void>(r => this.modalWaiters.push(r));
  }

  /** The MDI form shows for a child (once, whatever the children waiting): resolves when its window is open (the child goes in
   *  there), not after its Resize and Activate, so children show in the order they were asked to. */
  async showForChild(): Promise<void> {
    if (this.window) return;
    if (!this.opening) void this.show(false);   // a loaded form sets `opening` at once
    await this.opening;
  }

  private async open(modal: boolean): Promise<void> {
    this.s.queue.flush();   // what was queued before is in the snapshot (drawings too: GfxOps must not be drawn twice)
    this.early = [];
    const cursor = this.s.screenCursor();
    const parent = this.isMdiChild ? this.s.mdiForm() : null;
    const snap = { ...this.snapshot(), ...(cursor ? { cursor } : {}) };
    const w = await this.s.formHost.openForm(snap, parent ? { modal, mdiParent: parent.key } : { modal });
    const early = this.early;
    this.early = null;
    this.opening = null;
    if (!this.loaded || this.s.ended) { await w.close(); return; }
    this.window = w;
    w.onMessage(m => this.onMessage(m));
    for (const m of early) w.send(m);
    this.s.updateBlocked();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.st) this.st.form.props.Visible = false;
    this.deliver({ t: 'hide' });
    this.releaseModal();
    this.s.formLeft(this, true);
  }

  /** QueryUnload(Cancel, UnloadMode); false when cancelled (or the program ended meanwhile). */
  async queryUnload(mode: number): Promise<boolean> {
    if (!this.loaded) return true;
    const cancel = new VBRef(0);
    await this.fireForm('QueryUnload', [cancel, new VBRef(mode)]);
    return !this.s.ended && !toBool(cancel.value);
  }

  /** QueryUnload(Cancel, UnloadMode) (unless `queried`: the app is quitting and asked every form first) then Unload(Cancel);
   *  false when cancelled. UnloadMode: vbFormControlMenu 0, vbFormCode 1, vbAppWindows 2, vbFormMDIForm 4 (an MDI child whose MDI
   *  form unloads: the MDI form's QueryUnload, the children's QueryUnload, their Unload, then the MDI form's Unload, as in VB6). */
  async unload(mode: number, queried = false): Promise<boolean> {
    if (!this.loaded || this.unloading) return true;
    this.unloading = true;
    try {
      if (!queried && !(await this.queryUnload(mode))) return false;
      if (this.isMdi) {   // the children first: every QueryUnload (UnloadMode vbFormMDIForm 4), then every Unload
        const kids = this.s.mdiChildren();
        for (const k of kids) if (!(await k.queryUnload(4))) return false;
        for (const k of kids) if (!(await k.unload(4, true))) return false;
      }
      const cancel2 = new VBRef(0);
      await this.fireForm('Unload', [cancel2]);
      if (this.s.ended || toBool(cancel2.value)) return false;
      if (this.st) await Promise.all(this.controls().map(c => c.beforeUnload()));   // Data controls save the bound changes
    } finally {
      this.unloading = false;
    }
    if (!this.loaded) return true;
    this.teardown();
    this.s.formUnloaded(this);
    return true;
  }

  /** Drops the window and the run-time state (Unload, or the end of the program). */
  teardown(): void {
    const timers = this.timers();
    this.loaded = false;
    this.visible = false;
    this.blocked = false;
    this.loadDone = null;
    this.activeId = null;
    for (const t of timers) this.s.syncTimer(this, t);
    for (const c of this.st?.byId.values() ?? []) c.dispose();   // sockets close, requests stop
    this.st = null;
    for (const done of [...this.popups.values()]) done(null);   // a PopupMenu of the closed window returns
    this.popups.clear();
    const w = this.window;
    this.window = null;
    if (w) void w.close();
    this.releaseModal();
  }

  private releaseModal(): void {
    this.s.popModal(this);
    const waiters = this.modalWaiters.splice(0);
    for (const w of waiters) w();
  }

  // -- window -------------------------------------------------------------------------------------------------

  /** A message for the window (from the patch queue or the session); dropped while the form has none. */
  deliver(m: ToWindow): void {
    if (this.window) this.window.send(m);
    else if (this.early) this.early.push(m);
  }

  hasWindow(): boolean { return this.window !== null; }

  /** The events of a control that have code. */
  private handledEvents(d: ControlDef): string[] {
    return CONTROL_TYPES[d.type].events.map(e => e.name).filter(e => this.s.program.hasProcedure(this.key, `${d.name}_${e}`));
  }

  snapshot(): FormSnapshot {
    const st = this.state();
    const handled: Record<string, string[]> = {};
    handled.form = formEvents(this.def).map(e => e.name).filter(e => this.s.program.hasProcedure(this.key, `${this.objName}_${e}`));
    // the design-time controls and the visible elements made by Load (those without a view stay in the session)
    const design = new Set(this.def.controls.map(d => d.id));
    const controls = [...st.byId.values()].filter(c => design.has(c.def.id) || !CONTROL_TYPES[c.def.type].invisibleAtRuntime);
    for (const c of controls) handled[c.def.id] = this.handledEvents(c.def);
    const gfx: Record<string, string[]> = {};
    for (const c of [st.form, ...controls]) { const ops = c.gfx?.snapshot(); if (ops) gfx[c.def.id] = ops; }
    const form: FormDef = {
      id: this.def.id, name: this.def.name, code: '',
      props: { ...copyProps(st.form.props), Visible: true },
      controls: controls.map(c => ({ ...c.def, props: copyProps(c.props) })),
      ...(this.isMdi ? { mdi: true } : {}),
    };
    return { key: this.key, form, assets: this.s.assets, handled, mode: this.s.mode, ...(Object.keys(gfx).length ? { gfx } : {}) };
  }

  private onMessage(m: FromWindow): void {
    const st = this.st;
    if (!st) return;
    switch (m.t) {
      case 'ready': this.s.queue.flush(); break;
      case 'focused': this.setActive(m.id); break;
      case 'activated': if (this.visible && !this.blocked) void this.s.formActivated(this); break;
      case 'state': (m.id === 'form' ? st.form : st.byId.get(m.id))?.applyState(m.props); break;   // 'form': an MDI child's WindowState
      case 'moved': st.form.applyState({ Left: m.left, Top: m.top }); break;
      case 'resized':
        st.form.applyState({ Width: m.width, Height: m.height });
        this.layoutDocks(true);
        void this.fireForm('Resize', []).then(() => this.paint(st.form));
        break;
      case 'closeRequest': void this.unload(0); break;
      case 'ole': this.oleQueue = this.oleQueue.then(() => this.oleMessage(m)).catch(() => { /* an error was reported by the program */ }); break;
      case 'event': {
        const target = m.id === 'form' ? st.form : st.byId.get(m.id);
        if (!target) return;
        if (m.state) target.applyState(m.state);
        if (m.event === 'GotFocus' && m.id !== 'form') this.setActive(m.id);
        const raw = target.eventArgs(m.event, m.args);
        if (m.event === 'DragDrop' || m.event === 'DragOver') raw[0] = st.byId.get(String(raw[0])) ?? Nothing;   // Source As Control
        const args = raw.map(a => new VBRef(a));
        const done = m.id === 'form' ? this.fireForm(m.event, args) : this.fireControl(target, m.event, args);
        if (m.requestId !== undefined) {
          const requestId = m.requestId, ref = args[args.length - 1];
          // KeyPress answers with the KeyAscii the code left, Validate with its Cancel; a menu's Click before it opens just says it has run
          void done.then(() => (m.event === 'Validate' ? this.deliver({ t: 'validated', requestId, cancel: toBool(ref.value) })
            : m.event === 'KeyPress' && ref ? this.deliver({ t: 'keyResult', requestId, keyAscii: Number(coerce(ref.value, 'Long')) })
              : this.s.queue.send(this.key, { t: 'eventDone', requestId })));
        }
        break;
      }
      case 'popupDone': {
        const done = this.popups.get(m.requestId);
        this.popups.delete(m.requestId);
        done?.(m.id);
        break;
      }
    }
  }

  // -- OLE drag and drop -----------------------------------------------------------------------------------------

  /** One OLE drag: its data, the source control (null: files from Finder), the effects the source allows and the target's last one. */
  private ole: { data: DataObject; source: ControlObject | null; auto: boolean; allowed: number; effect: number; text: string | null; sel?: [number, number] } | null = null;
  /** The OLE messages run one after the other (the data that OLEStartDrag fills is there for OLEDragOver and OLEDragDrop). */
  private oleQueue: Promise<void> = Promise.resolve();

  private raise(c: ControlObject, event: string, args: VBRef[]): Promise<void> {
    return c.def.id === 'form' ? this.fireForm(event, args) : this.fireControl(c, event, args);
  }

  private async oleMessage(m: OleMessage): Promise<void> {
    const st = this.st;
    if (!st || this.s.ended) return;
    const ctl = (id: string | null): ControlObject | null => (id === null ? null : id === 'form' ? st.form : st.byId.get(id) ?? null);
    if (m.phase === 'start') {
      const source = ctl(m.id);
      const data: DataObject = new DataObject(f => (source ? this.raise(source, 'OLESetData', [new VBRef(data), new VBRef(f)]) : Promise.resolve()));
      if (m.files) data.files.list = [...m.files];
      if (m.text !== undefined) data.set(m.text, CF_TEXT);
      const pic = source?.props.Picture;
      if (m.auto && pic && (source!.def.type === 'PictureBox' || source!.def.type === 'Image')) data.set(new PictureObject(pic as PictureRef), CF_BITMAP);
      // a control allows copy and move; Finder's files are copied (the drop is a copy for macOS)
      const allowed = new VBRef(source ? DROP_COPY | DROP_MOVE : DROP_COPY);
      const o = this.ole = { data, source, auto: m.auto === true, allowed: Number(allowed.value), effect: -1, text: m.text ?? null, sel: m.sel };
      if (source) {
        await this.raise(source, 'OLEStartDrag', [new VBRef(data), allowed]);
        o.allowed = Number(coerce(allowed.value, 'Long'));
      }
      return;
    }
    const o = this.ole;
    if (!o) return;
    const target = ctl(m.id);
    const [x, y] = target ? target.scalePoint(m.x, m.y) : [0, 0];
    const mode = Number(target?.props.OLEDropMode ?? 0);
    if (m.phase === 'over') {
      if (!target) return;
      let effect = 0;
      if (mode === 1) {
        const eff = new VBRef(o.allowed);
        await this.raise(target, 'OLEDragOver', [new VBRef(o.data), eff, new VBRef(m.button), new VBRef(m.shift), new VBRef(x), new VBRef(y), new VBRef(m.state)]);
        effect = Number(coerce(eff.value, 'Long'));
      } else if (mode === 2 && autoDrop(target, o.data)) effect = pickEffect(o.allowed, m.shift);
      if (m.state !== 1 && effect !== o.effect) { o.effect = effect; this.deliver({ t: 'oleEffect', effect }); }
      return;
    }
    // drop: the target's OLEDragDrop (or the automatic drop), then the source's OLECompleteDrag with the Effect
    this.ole = null;
    let effect = 0;
    if (target && mode === 1) {
      const eff = new VBRef(o.effect >= 0 ? o.effect : pickEffect(o.allowed, m.shift));
      await this.raise(target, 'OLEDragDrop', [new VBRef(o.data), eff, new VBRef(m.button), new VBRef(m.shift), new VBRef(x), new VBRef(y)]);
      effect = Number(coerce(eff.value, 'Long'));
    } else if (target && mode === 2 && autoDrop(target, o.data)) {
      effect = pickEffect(o.allowed, m.shift);
      if (effect && !this.dropInto(target, o, m.at, effect)) effect = 0;
    }
    const src = o.source;
    if (!src || this.st !== st) return;
    // an automatic TextBox drag that was moved: the text leaves the source (unless the program changed it meanwhile)
    if (o.auto && src.def.type === 'TextBox' && (effect & DROP_MOVE) && o.sel && o.text !== null && !(target === src && mode === 2)) {
      const t = String(src.props.Text ?? ''), [a, n] = o.sel;
      if (t.slice(a, a + n) === o.text) { src.setMember('Text', [], t.slice(0, a) + t.slice(a + n)); src.setMember('SelStart', [], a); }
    }
    await this.raise(src, 'OLECompleteDrag', [new VBRef(effect)]);
  }

  /** OLEDropMode 2: a TextBox takes the text at the character it was dropped on (a move inside the same box moves it), a PictureBox or
   *  Image the picture. False when nothing happened (dropped onto the dragged text itself). */
  private dropInto(target: ControlObject, o: NonNullable<FormInstance['ole']>, at: number | undefined, effect: number): boolean {
    if (target.def.type !== 'TextBox') { target.setMember('Picture', [], o.data.picture()!); return true; }
    const text = o.data.text()!;
    let t = String(target.props.Text ?? ''), pos = Math.min(at ?? Number(target.props.SelStart ?? t.length), t.length);
    if (o.source === target && o.auto && o.sel && effect & DROP_MOVE) {
      const [a, n] = o.sel;
      if (pos >= a && pos <= a + n) return false;
      if (t.slice(a, a + n) === text) { t = t.slice(0, a) + t.slice(a + n); if (pos > a) pos -= n; }
    }
    target.setMember('Text', [], t.slice(0, pos) + text + t.slice(pos));
    target.setMember('SelStart', [], pos);
    target.setMember('SelLength', [], text.length);
    return true;
  }

  /** `<Name>_<Event>`; a control array element gets its Index as the first argument. */
  fireControl(c: ControlObject, event: string, args: VBRef[]): Promise<void> {
    const all = c.index !== null ? [new VBRef(c.index), ...args] : args;
    return this.s.fire(this.key, `${c.name}_${event}`, all);
  }

  /** VB6 raises some events when code sets a value (Text1.Text → Change, Check1.Value → Click …). */
  private propChanged(c: ControlObject, prop: string, old: PropValue): void {
    const v = c.props[prop];
    const changed = v !== old;
    if (c.def.id === 'form') {
      if ((prop === 'Width' || prop === 'Height') && changed) {
        this.layoutDocks(true);
        if (this.visible) void this.fireForm('Resize', []).then(() => this.paint(c));
      }
      return;
    }
    if (changed && (prop === 'Align' || prop === 'Visible' || prop === 'Width' || prop === 'Height') && c.def.parentId === null
      && (c.def.type === 'PictureBox' || c.def.type === 'Toolbar' || c.def.type === 'StatusBar' || c.def.type === 'CoolBar')) this.layoutDocks(true);
    let ev: string | null = null;
    switch (c.def.type) {
      case 'TextBox': case 'MaskedEdit': if (prop === 'Text' && changed) ev = 'Change'; break;
      case 'DTPicker': if (prop === 'Value' && changed) ev = 'Change'; break;
      case 'ComboBox':
        if (prop === 'Text' && changed) ev = 'Change';
        else if (prop === 'ListIndex' && changed) ev = 'Click';
        break;
      case 'ListBox': if ((prop === 'ListIndex' || prop === 'SelFlags') && changed) ev = 'Click'; break;
      case 'HScrollBar': case 'VScrollBar': case 'FlatScrollBar': if (prop === 'Value' && changed) ev = 'Change'; break;
      case 'RichTextBox':
        if (prop === 'Text' && changed) ev = 'Change';
        else if ((prop === 'SelStart' || prop === 'SelLength') && changed) ev = 'SelChange';
        break;
      case 'DriveListBox': if (prop === 'Drive' && changed) ev = 'Change'; break;
      case 'DirListBox': if (prop === 'Path' && changed) ev = 'Change'; break;
      case 'FileListBox':
        if (prop === 'Path' && changed) ev = 'PathChange';
        else if (prop === 'Pattern' && changed) ev = 'PatternChange';
        else if (prop === 'ListIndex' && changed) ev = 'Click';
        break;
      case 'MSFlexGrid': if ((prop === 'Row' || prop === 'Col') && changed) ev = 'RowColChange'; break;
      case 'TabStrip': if (prop === 'SelectedTab' && changed) ev = 'Click'; break;
      case 'SSTab': if (prop === 'Tab' && changed) { void this.fireControl(c, 'Click', [new VBRef(old as number)]); return; } break;
      case 'CheckBox': if (prop === 'Value' && changed) ev = 'Click'; break;
      case 'Label': if (prop === 'Caption' && changed) ev = 'Change'; break;
      case 'OptionButton':
        if (prop === 'Value' && v === true) {
          for (const o of this.st?.byId.values() ?? []) {
            if (o !== c && o.def.type === 'OptionButton' && o.def.parentId === c.def.parentId && o.props.Value === true) o.setMember('Value', [], false);
          }
          if (changed) ev = 'Click';
        }
        break;
      case 'CommandButton': case 'SSCommand':
        if (prop === 'Value' && v === true) { c.props.Value = false; ev = 'Click'; }
        break;
      // Sheridan 3D: Click(Value As Integer) gets the new Value (True = -1). Option and ribbon groups release the others silently.
      case 'SSCheck': if (prop === 'Value' && changed) { void this.fireControl(c, 'Click', [new VBRef(v === true ? -1 : 0)]); return; } break;
      case 'SSOption': case 'SSRibbon': {
        const group = (o: ControlObject): boolean => o !== c && o.def.type === c.def.type && o.def.parentId === c.def.parentId && o.props.Value === true
          && (c.def.type === 'SSOption' || (Number(o.props.GroupNumber) || 0) === (Number(c.props.GroupNumber) || 0));
        if (prop === 'Value' && v === true && (c.def.type === 'SSOption' || Number(c.props.GroupNumber) > 0)) {
          for (const o of this.st?.byId.values() ?? []) if (group(o)) { this.quiet.add(o); o.setMember('Value', [], false); this.quiet.delete(o); }
        }
        if (prop === 'Value' && changed && !this.quiet.has(c) && (v === true || c.def.type === 'SSRibbon')) {
          void this.fireControl(c, 'Click', [new VBRef(v === true ? -1 : 0)]);
        }
        return;
      }
    }
    if (ev) void this.fireControl(c, ev, []);
  }

  // -- VBObject -----------------------------------------------------------------------------------------------

  /** `TypeOf f Is Form` / `Is Form1` (`strict`); a variable of any object type may hold the form, as before. */
  asType(typeName: string, strict?: boolean): VBObject | undefined {
    const k = lc(typeName.slice(typeName.lastIndexOf('.') + 1));
    return !strict || k === 'object' || k === (this.isMdi ? 'mdiform' : 'form') || k === lc(this.name) ? this : undefined;
  }

  hasMember(name: string): boolean {
    const l = lc(name);
    if (this.controlNames.has(l) || l === 'name' || FORM_METHODS.has(l) || FORM_OBJECTS.has(l)) return true;
    if (this.isMdi && MDI_MEMBERS.has(l)) return true;
    const pd = getPropDef('Form', name);
    if (pd) return pd.runtime !== 'none' && formHasProp(this.def, name);
    // Public variables and Property procedures are properties; Public Subs/Functions go through callMethod (they may wait)
    const pm = this.publicMember(name);
    return pm === 'var' || pm === 'prop';
  }

  /** A Public Property Let/Set of the form's code: an assignment calls it without reading the property first. */
  codeProperty(name: string): boolean { return this.codeMember(name) === 'prop'; }

  /** A Public variable, procedure or property of the form's code (not hiding the form's own properties and controls). */
  private publicMember(name: string): 'proc' | 'var' | 'prop' | null {
    return this.s.program.hasPublicMember(this.key, name);
  }

  /** A Public member of the form's code that no property, control or built-in member of the form hides. Using one does not
   *  load the form (its module-level values live on after Unload, as in VB6): `frmLogin.OK` after the dialog has closed. */
  private codeMember(name: string): 'proc' | 'var' | 'prop' | null {
    const l = lc(name);
    if (this.controlNames.has(l) || l === 'visible' || FORM_METHODS.has(l) || FORM_OBJECTS.has(l)
      || getPropDef('Form', name) || (this.isMdi && MDI_MEMBERS.has(l))) return null;
    return this.publicMember(name);
  }

  private callPublic(name: string, args: VBValue[]): Promise<VBValue> {
    return this.s.program.callPublic(this.key, name, args);
  }

  getMember(name: string, args: VBValue[]): VBValue {
    const pm = this.codeMember(name);
    if (pm === 'var') {
      const v = this.s.program.getPublicVar(this.key, name);
      return args.length && v instanceof VBArray ? v.get(args.map(a => Number(coerce(a, 'Long')))) : v;
    }
    // `x = Form2.GetCount` (no parentheses): the interpreter awaits a Promise from getMember
    if (pm === 'proc') return this.callPublic(name, args) as unknown as VBValue;
    if (pm === 'prop') return this.s.program.callProperty(this.key, name, args) as unknown as VBValue;
    this.autoLoad();
    const st = this.state();
    const l = lc(name);
    const c = this.control(name);
    if (c) {
      if (args.length) {
        if (!(c instanceof ControlArrayObject)) throw new VBRuntimeError(343);
        return c.item(Number(coerce(args[0], 'Long')));
      }
      return c;
    }
    if (this.isMdi && l === 'activeform') {
      if (args.length) throw new VBRuntimeError(450);
      return this.s.mdiActiveChild() ?? Nothing;
    }
    if (this.isMdi && l === 'arrange') return this.callSync(l, args);
    if (l === 'visible') return this.visible;
    if (l === 'validatecontrols') return this.validateControls(args) as unknown as VBValue;   // awaited by the interpreter
    if (FORM_METHODS.has(l)) return this.callSync(l, args);
    if (FORM_OBJECTS.has(l) && !getPropDef('Form', name)) {
      if (l === 'controls') return args.length ? this.controlList.getMember('Item', args) : this.controlList;
      if (args.length) throw new VBRuntimeError(450);
      return l === 'count' ? this.controls().length : this.activeControl();
    }
    if (!formHasProp(this.def, name) && getPropDef('Form', name)) throw new VBRuntimeError(438);   // ScrollBars on a Form, KeyPreview on an MDIForm
    return st.form.getMember(name, args);
  }

  setMember(name: string, args: VBValue[], value: VBValue): void | Promise<void> {
    const pm = this.codeMember(name);
    if (pm === 'prop') return this.s.program.callProperty(this.key, name, args, value).then(() => {});
    if (pm === 'var') {
      if (args.length) {
        const arr = this.s.program.getPublicVar(this.key, name);
        if (!(arr instanceof VBArray)) throw new VBRuntimeError(13);
        arr.set(args.map(a => Number(coerce(a, 'Long'))), value);
      } else this.s.program.setPublicVar(this.key, name, value);
      return;
    }
    this.autoLoad();
    const st = this.state();
    const l = lc(name);
    const c = this.control(name);
    if (c) {
      const target = c instanceof ControlArrayObject ? (args.length ? c.item(Number(coerce(args[0], 'Long'))) : null) : c;
      if (!target?.defaultMember) throw new VBRuntimeError(c instanceof ControlArrayObject ? 450 : 438);
      target.setMember(target.defaultMember, [], value);
      return;
    }
    if (FORM_OBJECTS.has(l) && !getPropDef('Form', name)) throw new VBRuntimeError(383);
    if (l === 'visible') {
      if (toBool(value)) void this.show(false); else this.hide();
      return;
    }
    if (this.isMdi && (l === 'activeform' || l === 'scalewidth' || l === 'scaleheight')) throw new VBRuntimeError(383);   // the workspace's size
    if (!formHasProp(this.def, name) && getPropDef('Form', name)) throw new VBRuntimeError(438);
    st.form.setMember(name, args, value);
  }

  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const l = lc(name);
    switch (l) {
      case 'show': {
        const modal = args.length > 0 && args[0] !== Empty && Number(coerce(args[0], 'Long')) === 1;
        return this.show(modal).then(() => Empty);
      }
      case 'load': return this.load().then(() => Empty);
      case 'unload': return this.unload(1).then(() => Empty);
      case 'refresh': this.autoLoad(); return this.paint(this.state().form, true).then(() => Empty);
      case 'validatecontrols': return this.validateControls(args);
      case 'printform':
        if (args.length) throw new VBRuntimeError(450);
        this.autoLoad();
        this.s.queue.flush();
        return this.s.printForm(this.snapshot()).then(() => Empty);
      case 'popupmenu': return this.popupMenu(args);
    }
    if (this.codeMember(name) === 'proc') return this.callPublic(name, args);
    return this.callSync(l, args);
  }

  /** ValidateControls: the Validate event of the control with the focus; Cancel = True in it is run-time error 380 (as in VB6). */
  private async validateControls(args: VBValue[]): Promise<VBValue> {
    if (args.length) throw new VBRuntimeError(450);
    this.autoLoad();
    const c = this.activeId !== null ? this.st?.byId.get(this.activeId) : undefined;
    if (c && this.s.program.hasProcedure(this.key, `${c.name}_Validate`)) {
      const cancel = new VBRef(0);
      await this.fireControl(c, 'Validate', [cancel]);
      if (toBool(cancel.value)) throw new VBRuntimeError(380);
    }
    return Empty;
  }

  /** Print, PSet, Line, Circle, Scale on the form. */
  graphics(call: GraphicsCall): void {
    this.autoLoad();
    this.state().form.graphics(call);
  }

  /** The Paint event of the form or a PictureBox, when its AutoRedraw is False and it is shown; `erase` (Refresh) clears it first.
   *  A Refresh inside its own Paint event raises no other. */
  private async paint(c: ControlObject, erase = false): Promise<void> {
    const g = c.gfx;
    if (!g || g.painting || c.props.AutoRedraw === true || !this.visible || this.s.ended) return;
    const isForm = c.def.id === 'form';
    if (!this.s.program.hasProcedure(this.key, isForm ? `${this.objName}_Paint` : `${c.name}_Paint`)) return;
    if (erase) g.erase();
    g.painting = true;
    try {
      await (isForm ? this.fireForm('Paint', []) : this.fireControl(c, 'Paint', []));
    } finally {
      g.painting = false;
    }
  }

  /** Shown: the form's Paint, then each visible PictureBox's (VB6 paints the parent first). */
  private async paintAll(): Promise<void> {
    const st = this.st;
    if (!st) return;
    await this.paint(st.form);
    for (const c of [...st.byId.values()]) if (c.def.type === 'PictureBox' && c.props.Visible !== false && this.st === st) await this.paint(c);
  }

  /** PopupMenu menu, [flags], [x], [y], [boldcommand]: the menu's items as a context menu at the mouse (or at x, y in the client
   *  area, in the form's ScaleMode). The menu's Click runs first (VB6: its items are initialised); PopupMenu returns once an item was chosen and its
   *  Click has run, or the menu was closed. Flags: vbPopupMenuCenterAlign 4 / RightAlign 8 (x is the centre / right edge),
   *  vbPopupMenuRightButton 2 (the right button chooses too). */
  private async popupMenu(args: VBValue[]): Promise<VBValue> {
    this.autoLoad();
    const st = this.state();
    const isOwnMenu = (v: VBValue | undefined): v is ControlObject => v instanceof ControlObject && v.def.type === 'Menu' && st.byId.get(v.def.id) === v;
    const menu = args[0];
    if (!isOwnMenu(menu)) throw new VBRuntimeError(menu instanceof ControlObject ? 5 : 13);
    const opt = (v: VBValue | undefined): number | null => (v === undefined || v === Empty ? null : Number(coerce(v, 'Double')));
    const flags = opt(args[1]) ?? 0, sx = opt(args[2]), sy = opt(args[3]);
    // X and Y are in the form's ScaleMode; the window wants client twips
    const [tx, ty] = st.form.gfx ? st.form.gfx.twips(sx ?? 0, sy ?? 0) : [sx ?? 0, sy ?? 0];
    const x = sx === null ? null : tx, y = sy === null ? null : ty;
    const bold = isOwnMenu(args[4]) ? args[4].def.id : null;
    if (!this.visible || !this.window) return Empty;
    await this.fireControl(menu, 'Click', []);
    if (!this.loaded || this.s.ended || !this.window || this.st !== st) return Empty;
    const requestId = ++this.popupSeq;
    const chosen = await new Promise<string | null>(resolve => {
      this.popups.set(requestId, resolve);
      this.s.queue.send(this.key, { t: 'popup', requestId, id: menu.def.id, flags, x, y, bold });
    });
    const item = chosen !== null && this.st === st ? st.byId.get(chosen) : undefined;
    if (item && item.props.Enabled !== false && !this.s.ended) await this.fireControl(item, 'Click', []);
    return Empty;
  }

  private callSync(l: string, args: VBValue[]): VBValue {
    this.autoLoad();
    switch (l) {
      case 'hide': this.hide(); return Empty;
      case 'arrange': {   // vbCascade 0, vbTileHorizontal 1, vbTileVertical 2, vbArrangeIcons 3
        if (!this.isMdi) break;
        const how = Number(coerce(args[0] ?? Empty, 'Long'));
        if (how < 0 || how > 3) throw new VBRuntimeError(5);
        this.s.queue.flush();
        this.deliver({ t: 'mdiArrange', arrangement: how });
        return Empty;
      }
      case 'setfocus': case 'zorder': return Empty;
      case 'refresh': void this.paint(this.state().form, true); return Empty;
      case 'show': void this.show(false); return Empty;
      case 'popupmenu': void this.popupMenu(args); return Empty;
    }
    return this.state().form.callMethod(l, args) as VBValue;   // the form's own object has no async methods
  }
}
