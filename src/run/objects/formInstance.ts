// A form of the running program (its default instance): properties, controls as members, and the VB6
// life cycle — Initialize → Load → (shown) → Resize → Activate; QueryUnload → Unload; Show [vbModal] / Hide.

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import type { Program } from '../../lang/interp/program';
import { Empty, Nothing, VBArray, VBRef, coerce, toBool, type VBValue } from '../../lang/values';
import { formScaleSize } from '../../controls/render';
import { CONTROL_TYPES, getPropDef } from '../../model/controls';
import type { ControlDef, FormDef, PictureRef, PropValue } from '../../model/types';
import type { FormHost, FormWindow } from '../formHost';
import { localMedia } from '../mediaSource';
import type { PatchQueue } from '../patchQueue';
import type { NetSession } from '../net';
import type { FormSnapshot, FromWindow, ToWindow } from '../protocol';
import { ControlArrayObject, ControlObject, type ElementFactory, type RunContext } from './controlObject';
import { ObjectList } from './globalObjects';

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
  formUnloaded(form: FormInstance): void;
  /** The form became the active one (shown, or the user focused it): Screen.ActiveForm. */
  formActivated(form: FormInstance): void;
  pushModal(form: FormInstance): void;
  popModal(form: FormInstance): void;
  updateBlocked(): void;
  /** Inet, Winsock, WebBrowser: the run's network (made on first use; throws when the host has none). */
  net(): NetSession;
  /** MMControl and MediaPlayer: a file of the program (relative to App.Path); error 53 when it cannot be read. */
  readFile(path: string): Promise<Uint8Array>;
  /** The full path of a file of the program. */
  resolvePath(path: string): string;
}

interface FormState {
  form: ControlObject;                                       // the form's own properties (id 'form')
  byId: Map<string, ControlObject>;
  byName: Map<string, ControlObject | ControlArrayObject>;   // lower-case name
}

const lc = (s: string): string => s.toLowerCase();
const FORM_METHODS = new Set(['show', 'hide', 'refresh', 'move', 'setfocus', 'zorder']);
/** Members every form has besides its registry properties: Controls, ActiveControl and Count (the number of controls). */
const FORM_OBJECTS = new Set(['controls', 'activecontrol', 'count']);
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
  private early: ToWindow[] | null = null;        // messages queued while the window opens
  private loadDone: Promise<void> | null = null;
  private unloading = false;
  private modalWaiters: (() => void)[] = [];
  private readonly controlNames: Set<string>;
  /** The control with the focus (Me.ActiveControl), by id. */
  private activeId: string | null = null;
  /** Order of loading (the Forms collection lists the loaded forms in it). */
  loadOrder = 0;
  private readonly controlList = new ObjectList('Object', () => this.controls(), o => (o as ControlObject).name,
    n => new VBRuntimeError(730, `Control '${n}' not found`));

  constructor(readonly def: FormDef, private s: FormSession) {
    this.controlNames = new Set(def.controls.map(c => lc(c.name)));
  }

  get name(): string { return this.def.name; }
  get key(): string { return this.def.name; }

  /** The run-time mirror (built on first use, discarded on Unload: the next use starts from the design-time props). */
  private state(): FormState {
    if (this.st) return this.st;
    const ctx: RunContext = {
      resolveAsset: r => this.s.resolveAsset(r),
      loadPicture: p => this.s.loadPicture(p),
      timerChanged: c => this.s.syncTimer(this, c),
      propChanged: (c, p, old) => this.propChanged(c, p, old),
      dialogs: this.s.formHost,
      controlByName: n => this.state().byName.get(lc(n)),
      files: { listVolumes: () => this.s.formHost.listVolumes(), listDir: p => this.s.formHost.listDir(p), defaultPath: this.s.appPath },
      net: () => this.s.net(),
      // MMControl / MediaPlayer: a window of its own reads the file itself (FormHost.openMedia); the inline host shares this document
      openMedia: async (p, mime) => {
        const host = this.s.formHost;
        if (host.openMedia) return host.openMedia(this.s.resolvePath(p), mime);
        return localMedia(await this.s.readFile(p), mime);
      },
      raise: (c, event, args) => (this.st?.byId.get(c.def.id) === c && !this.s.ended ? this.fireControl(c, event, args) : Promise.resolve()),
      focused: c => this.setActive(c.def.id),
    };
    // Load Name(i) / Unload Name(i). A control without a view (Winsock, Timer ...) starts from the design-time properties
    // of the lowest element; a visible one from its current properties, hidden (Visible = False) and last in the tab
    // order, and the form window gets it as a new control.
    const elements: ElementFactory = {
      spawn: (t, index) => {
        const invisible = CONTROL_TYPES[t.def.type].invisibleAtRuntime;
        const props = copyProps(invisible ? t.def.props : t.props);
        if (!invisible) {
          props.Visible = false;
          if ('TabIndex' in props) props.TabIndex = Math.max(-1, ...[...this.state().byId.values()].map(o => Number(o.props.TabIndex ?? -1))) + 1;
        }
        const def: ControlDef = { ...t.def, id: `${t.def.id}~${index}`, index, props };
        const c = new ControlObject(def, this.key, this.s.queue, ctx);
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
    return this.st = st;
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
    if (this.visible) this.s.formActivated(this);
  }

  timers(): ControlObject[] {
    return this.st ? [...this.st.byId.values()].filter(c => c.def.type === 'Timer') : [];
  }

  // -- life cycle ---------------------------------------------------------------------------------------------

  /** Load: Form_Initialize then Form_Load. */
  load(): Promise<void> {
    if (this.loaded) return this.loadDone ?? Promise.resolve();
    this.loaded = true;
    this.loadOrder = ++loadCounter;
    const st = this.state();
    st.form.props.Visible = false;
    for (const t of this.timers()) this.s.syncTimer(this, t);
    // Form_Load starts once Form_Initialize has finished; without an Initialize handler it starts at once,
    // so a member access that loads the form runs Load nested in the accessing statement.
    const runLoad = (): Promise<void> => (this.loaded && !this.s.ended ? this.s.fire(this.name, 'Form_Load', []) : Promise.resolve());
    return this.loadDone = this.s.program.hasProcedure(this.name, 'Form_Initialize')
      ? this.s.fire(this.name, 'Form_Initialize', []).then(runLoad)
      : runLoad();
  }

  private autoLoad(): void {
    if (!this.loaded && !this.s.ended) void this.load();
  }

  async show(modal: boolean): Promise<void> {
    if (!this.loaded) await this.load();
    if (!this.loaded || this.s.ended) return;
    if (modal && this.visible) throw new VBRuntimeError(400, 'Form already displayed; can\'t show modally');
    const wasVisible = this.visible;
    this.visible = true;
    this.state().form.props.Visible = true;
    if (!this.window) {
      this.opening ??= this.open(modal);
      await this.opening;
      if (!this.window) return;
      if (modal) this.s.pushModal(this);
      await this.s.fire(this.name, 'Form_Resize', []);
    } else {
      if (!wasVisible) this.deliver({ t: 'show' });
      if (modal) this.s.pushModal(this);
    }
    if (!wasVisible && this.loaded) {
      this.s.formActivated(this);
      await this.s.fire(this.name, 'Form_Activate', []);
    }
    if (modal && this.visible && this.loaded) await new Promise<void>(r => this.modalWaiters.push(r));
  }

  private async open(modal: boolean): Promise<void> {
    this.early = [];
    const w = await this.s.formHost.openForm(this.snapshot(), { modal });
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
  }

  /** QueryUnload(Cancel, UnloadMode) then Unload(Cancel); false when cancelled. */
  async unload(mode: 0 | 1): Promise<boolean> {
    if (!this.loaded || this.unloading) return true;
    this.unloading = true;
    try {
      const cancel = new VBRef(0);
      await this.s.fire(this.name, 'Form_QueryUnload', [cancel, new VBRef(mode)]);
      if (this.s.ended || toBool(cancel.value)) return false;
      const cancel2 = new VBRef(0);
      await this.s.fire(this.name, 'Form_Unload', [cancel2]);
      if (this.s.ended || toBool(cancel2.value)) return false;
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
    return CONTROL_TYPES[d.type].events.map(e => e.name).filter(e => this.s.program.hasProcedure(this.name, `${d.name}_${e}`));
  }

  snapshot(): FormSnapshot {
    const st = this.state();
    const handled: Record<string, string[]> = {};
    handled.form = CONTROL_TYPES.Form.events.map(e => e.name).filter(e => this.s.program.hasProcedure(this.name, `Form_${e}`));
    // the design-time controls and the visible elements made by Load (those without a view stay in the session)
    const design = new Set(this.def.controls.map(d => d.id));
    const controls = [...st.byId.values()].filter(c => design.has(c.def.id) || !CONTROL_TYPES[c.def.type].invisibleAtRuntime);
    for (const c of controls) handled[c.def.id] = this.handledEvents(c.def);
    const form: FormDef = {
      id: this.def.id, name: this.def.name, code: '',
      props: { ...copyProps(st.form.props), Visible: true },
      controls: controls.map(c => ({ ...c.def, props: copyProps(c.props) })),
    };
    return { key: this.key, form, assets: this.s.assets, handled, mode: this.s.mode };
  }

  private onMessage(m: FromWindow): void {
    const st = this.st;
    if (!st) return;
    switch (m.t) {
      case 'ready': this.s.queue.flush(); break;
      case 'focused': this.setActive(m.id); break;
      case 'state': st.byId.get(m.id)?.applyState(m.props); break;
      case 'resized':
        st.form.applyState({ Width: m.width, Height: m.height });
        void this.s.fire(this.name, 'Form_Resize', []);
        break;
      case 'closeRequest': void this.unload(0); break;
      case 'event': {
        const target = m.id === 'form' ? st.form : st.byId.get(m.id);
        if (!target) return;
        if (m.state) target.applyState(m.state);
        if (m.event === 'GotFocus' && m.id !== 'form') this.setActive(m.id);
        const args = (m.id === 'form' ? m.args : target.eventArgs(m.event, m.args)).map(a => new VBRef(a));
        const done = m.id === 'form' ? this.s.fire(this.name, `Form_${m.event}`, args) : this.fireControl(target, m.event, args);
        if (m.requestId !== undefined) {
          const requestId = m.requestId, ref = args[args.length - 1];
          void done.then(() => this.deliver({ t: 'keyResult', requestId, keyAscii: Number(coerce(ref.value, 'Long')) }));
        }
        break;
      }
    }
  }

  /** `<Name>_<Event>`; a control array element gets its Index as the first argument. */
  fireControl(c: ControlObject, event: string, args: VBRef[]): Promise<void> {
    const all = c.index !== null ? [new VBRef(c.index), ...args] : args;
    return this.s.fire(this.name, `${c.name}_${event}`, all);
  }

  /** VB6 raises some events when code sets a value (Text1.Text → Change, Check1.Value → Click …). */
  private propChanged(c: ControlObject, prop: string, old: PropValue): void {
    const v = c.props[prop];
    const changed = v !== old;
    if (c.def.id === 'form') {
      if ((prop === 'Width' || prop === 'Height') && changed && this.visible) void this.s.fire(this.name, 'Form_Resize', []);
      return;
    }
    let ev: string | null = null;
    switch (c.def.type) {
      case 'TextBox': case 'MaskedEdit': if (prop === 'Text' && changed) ev = 'Change'; break;
      case 'DTPicker': if (prop === 'Value' && changed) ev = 'Change'; break;
      case 'ComboBox':
        if (prop === 'Text' && changed) ev = 'Change';
        else if (prop === 'ListIndex' && changed) ev = 'Click';
        break;
      case 'ListBox': if (prop === 'ListIndex' && changed) ev = 'Click'; break;
      case 'HScrollBar': case 'VScrollBar': if (prop === 'Value' && changed) ev = 'Change'; break;
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
      case 'CommandButton':
        if (prop === 'Value' && v === true) { c.props.Value = false; ev = 'Click'; }
        break;
    }
    if (ev) void this.fireControl(c, ev, []);
  }

  // -- VBObject -----------------------------------------------------------------------------------------------

  hasMember(name: string): boolean {
    const l = lc(name);
    if (this.controlNames.has(l) || l === 'scalewidth' || l === 'scaleheight' || l === 'name' || FORM_METHODS.has(l) || FORM_OBJECTS.has(l)) return true;
    const pd = getPropDef('Form', name);
    if (pd) return pd.runtime !== 'none';
    // Public variables are properties; Public Subs/Functions go through callMethod (they may wait)
    return this.publicMember(name) === 'var';
  }

  /** A Public variable or procedure of the form's code (not hiding the form's own properties and controls). */
  private publicMember(name: string): 'proc' | 'var' | null {
    return this.s.program.hasPublicMember(this.name, name);
  }

  private callPublic(name: string, args: VBValue[]): Promise<VBValue> {
    this.autoLoad();
    return this.s.program.callPublic(this.name, name, args);
  }

  getMember(name: string, args: VBValue[]): VBValue {
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
    if (l === 'scalewidth' || l === 'scaleheight') {
      const sz = formScaleSize(st.form.props);
      return l === 'scalewidth' ? sz.width : sz.height;
    }
    if (l === 'visible') return this.visible;
    if (FORM_METHODS.has(l)) return this.callSync(l, args);
    if (FORM_OBJECTS.has(l) && !getPropDef('Form', name)) {
      if (l === 'controls') return args.length ? this.controlList.getMember('Item', args) : this.controlList;
      if (args.length) throw new VBRuntimeError(450);
      return l === 'count' ? this.controls().length : this.activeControl();
    }
    if (!getPropDef('Form', name)) {
      const pm = this.publicMember(name);
      if (pm === 'var') {
        const v = this.s.program.getPublicVar(this.name, name);
        return args.length && v instanceof VBArray ? v.get(args.map(a => Number(coerce(a, 'Long')))) : v;
      }
      // `x = Form2.GetCount` (no parentheses): the interpreter awaits a Promise from getMember
      if (pm === 'proc') return this.callPublic(name, args) as unknown as VBValue;
    }
    return st.form.getMember(name, args);
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
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
    if (l === 'scalewidth' || l === 'scaleheight' || (FORM_OBJECTS.has(l) && !getPropDef('Form', name))) throw new VBRuntimeError(383);
    if (l === 'visible') {
      if (toBool(value)) void this.show(false); else this.hide();
      return;
    }
    if (!getPropDef('Form', name) && this.publicMember(name) === 'var') {
      if (args.length) {
        const arr = this.s.program.getPublicVar(this.name, name);
        if (!(arr instanceof VBArray)) throw new VBRuntimeError(13);
        arr.set(args.map(a => Number(coerce(a, 'Long'))), value);
      } else this.s.program.setPublicVar(this.name, name, value);
      return;
    }
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
    }
    if (!FORM_METHODS.has(l) && !getPropDef('Form', name) && this.publicMember(name) === 'proc') return this.callPublic(name, args);
    return this.callSync(l, args);
  }

  private callSync(l: string, args: VBValue[]): VBValue {
    this.autoLoad();
    switch (l) {
      case 'hide': this.hide(); return Empty;
      case 'setfocus': case 'zorder': case 'refresh': return Empty;
      case 'show': void this.show(false); return Empty;
    }
    return this.state().form.callMethod(l, args) as VBValue;   // the form's own object has no async methods
  }
}
