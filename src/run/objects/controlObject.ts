// Run-time control objects: a ControlObject mirrors one control's properties and queues every change
// as a patch to the form window; a ControlArrayObject is the `Command1(i)` collection.

import type { OutSlot, VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, Nothing, Null, NullT, coerce, isDate, isObject, toBool, toStr, type VBDate, type VBRef, type VBValue } from '../../lang/values';
import { CONTROL_TYPES, getPropDef, type PropDef } from '../../model/controls';
import { decodeRuns, encodeRuns, formatAt, formatRange, replaceRange, runsText, type RtfPatch, type Run } from '../../controls/richText';
import type { DirListing, Volume } from '../../backend/backend';
import { formatValue } from '../../lang/builtins/format';
import { dateParts } from '../../lang/values';
import { clampDate, dayOf, setPart, weekdayOf } from '../../model/dateControls';
import { joinFields } from '../../model/fieldLines';
import { clipText, fitText, fromText, maskedText, parseMask, typeChar } from '../../model/mask';
import { flagOn, syncSSTab } from '../../model/ssTab';
import { baseName, filterIndexFor, type FileDialogRequest } from '../commonDialog';
import type { ControlDef, FontValue, PictureRef, PropValue } from '../../model/types';
import type { PatchQueue } from '../patchQueue';
import { PictureObject, type HasPictureRef } from './appObjects';
import type { ChangeKind, CollectionObject, ItemObject } from './collectionObject';
import { makePanels, makeTabs, panelLine, tabLine } from './commonCollections';
import { DEFAULT_ALIGN, GridData } from './gridData';
import { dirListItem, filterFiles, findVolume, joinPath, normalizePath, resolvePath, subDirs, type FileContext } from './fileControls';
import { columnLine, iconLine, listLine, makeColumns, makeListItems, makeNodes, nodeLines, TreeNode, type NodesCollection, type Picker } from './listCollections';
import { listImageItemLine, makeButtons, makeListImages, toolbarLine } from './imageCollections';
import { parseButton, setPressed } from '../../model/toolbar';
import type { NetSession } from '../net';
import { decodeChart, encodeChart, resizeChart, sampleChart, MAX_CHART_COLS, MAX_CHART_ROWS, type ChartModel } from '../../model/chart';
import { chartFromArray, chartToArray, ChartPlot } from './chartObjects';
import { InetControl, WebBrowserControl, WinsockControl, type NetControl, type NetHost } from './netControls';
import type { OpenedMedia } from '../mediaSource';
import type { RichControl, RichHost } from './richControl';
import { MciControl, MediaPlayerControl } from './mediaControls';
import { AgentControl } from './agentControl';
import { DataControl, type DataConsumer, type DataHost } from '../data/dataControl';
import type { DbSession } from '../data/dbSession';
import { DataGridControl } from '../data/dataGrid';
import { DataListControl } from '../data/dataList';
import { MSCommControl, SysInfoControl } from './commControl';
import { AnimationControl } from './animationControl';
import { CoolBarControl, ImageComboControl } from './comboBands';
import { CalendarControl } from './calendarControl';
import type { CommSession } from '../comm';
import type { SystemApi } from '../../backend/backend';

export interface RunContext {
  resolveAsset(ref: PictureRef): string | null;
  loadPicture(path: string): Promise<VBValue>;
  /** A Timer's Enabled or Interval changed. */
  timerChanged(ctrl: ControlObject): void;
  /** A property was set by code (after the patch is queued); `old` is the value before. VB6 raises events for some (Text1.Text → Change). */
  propChanged?(ctrl: ControlObject, prop: string, old: PropValue): void;
  /** CommonDialog: the dialogs of the form host (file, colour, font). Null result = cancelled. */
  dialogs?: {
    fileDialog(o: FileDialogRequest): Promise<string | null>;
    colorDialog(o: { color: number }): Promise<number | null>;
    fontDialog(o: { font: FontValue }): Promise<FontValue | null>;
  };
  /** DriveListBox, DirListBox, FileListBox: the volumes and folder contents from the backend. */
  files?: FileContext;
  /** A control of the form by name (what `Toolbar1.ImageList` returns). */
  controlByName?(name: string): ControlObject | ControlArrayObject | undefined;
  /** Inet, Winsock, WebBrowser: the run's network (made on first use). Throws when there is none. */
  net?(): NetSession;
  /** Raises an event of the control from outside code (a socket's DataArrival ...); resolves when the handler has finished. */
  raise?(ctrl: ControlObject, event: string, args: VBRef[]): Promise<void>;
  /** MMControl, MediaPlayer: opens a file of the program (relative to App.Path) for the window to play; error 53 when it is missing. */
  openMedia?(path: string, mime: string): Promise<OpenedMedia>;
  /** SetFocus: the control is the form's ActiveControl at once (the window confirms it later). */
  focused?(ctrl: ControlObject): void;
  /** Data control, Adodc: the run's databases (made on first use). */
  db?(): DbSession;
  /** A database path of the program as a full path (relative to App.Path, like Open). */
  resolveDbPath?(path: string): string;
  /** Every control of the form (data binding). */
  controls?(): ControlObject[];
  msgBox?(prompt: string, buttons: number, title: string): Promise<number>;
  /** MSComm: the run's serial ports (made on first use). Throws 8002 when there are none. */
  comm?(): CommSession;
  /** SysInfo: the system's state; null (or absent) when the host cannot tell. */
  system?(): SystemApi | null;
}

/** The property a control shows a bound field in (DataSource / DataField). */
const BOUND_PROP: Record<string, string> = { TextBox: 'Text', Label: 'Caption', CheckBox: 'Value', ComboBox: 'Text', ListBox: 'Text', DTPicker: 'Value', MaskedEdit: 'Text' };
/** The properties that name a data control of the form (`Text1.DataSource`, `DataCombo1.RowSource`). */
const DATA_REFS = new Set(['DataSource', 'RowSource']);
const strProp = (v: PropValue | undefined): string => (typeof v === 'string' ? v : '');

/** RichTextBox: the props that go to the window in order, as RtfOps (see send). */
const RTF_OP_PROPS = new Set(['Text', 'Runs', 'SelStart', 'SelLength', 'SelBold', 'SelItalic', 'SelUnderline', 'SelColor', 'SelFontName', 'SelFontSize']);

/** The properties that name an ImageList of the form (`Toolbar1.ImageList = ImageList1`). */
const IMAGE_REFS = new Set(['ImageList', 'Icons', 'SmallIcons']);

/** Any picture value (what LoadPicture returns, or what `Picture` reads) carries its asset reference. */
export type { HasPictureRef };
const hasPictureRef = (v: unknown): v is HasPictureRef =>
  typeof v === 'object' && v !== null && 'pictureRef' in v;

const FONT_PROPS: Record<string, keyof FontValue> = { name: 'name', size: 'size', bold: 'bold', italic: 'italic', underline: 'underline' };

class FontObject implements VBObject {
  readonly vbTypeName = 'Font';
  constructor(private get: () => FontValue, private set: (f: FontValue) => void) {}
  hasMember(name: string): boolean { return name.toLowerCase() in FONT_PROPS; }
  getMember(name: string): VBValue {
    const k = FONT_PROPS[name.toLowerCase()];
    if (!k) throw new VBRuntimeError(438);
    return this.get()[k];
  }
  setMember(name: string, _args: VBValue[], value: VBValue): void {
    const k = FONT_PROPS[name.toLowerCase()];
    if (!k) throw new VBRuntimeError(438);
    const f = { ...this.get() } as Record<string, string | number | boolean>;
    f[k] = k === 'name' ? toStr(value) : k === 'size' ? Number(coerce(value, 'Double')) : toBool(value);
    this.set(f as unknown as FontValue);
  }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

const isListType = (t: string): boolean => t === 'ListBox' || t === 'ComboBox';
const isBrowserType = (t: string): boolean => t === 'DirListBox' || t === 'FileListBox';
/** DTPicker and MonthView: Value is a date serial (null: no date); Day ... DayOfWeek are parts of it. */
const isDateType = (t: string): boolean => t === 'DTPicker' || t === 'MonthView';
const DATE_PARTS = new Set(['Day', 'Month', 'Year', 'Hour', 'Minute', 'Second', 'DayOfWeek']);
const dateValue = (serial: number): VBDate => ({ kind: 'date', serial });
const num = (v: VBValue): number => coerce(v, 'Long') as number;
/** MaskedEdit.Text = "...": the display string for it; 380 when it does not fit the Mask. */
function fromTextOrFail(mask: string, prompt: string, text: string): string {
  const slots = parseMask(mask);
  if (slots.length === 0) return text;
  const t = fromText(slots, prompt, text);
  if (t === null) throw new VBRuntimeError(380);
  return t;
}
const badIndex = (): VBRuntimeError => new VBRuntimeError(381, 'Invalid property array index');

export class ControlObject implements VBObject, DataConsumer {
  readonly vbTypeName: string;
  readonly defaultMember?: string;
  readonly props: Record<string, PropValue> = {};
  /** Item collections (lower-case property name): StatusBar.Panels, TabStrip.Tabs. */
  private readonly collections = new Map<string, CollectionObject<ItemObject>>();
  /** TreeView node / ListView item that is selected (by click or by code). */
  private selItem: ItemObject | null = null;
  /** MSFlexGrid cells. */
  private grid: GridData | null = null;
  /** RichTextBox: the text with its formats (the window gets it as the prop `Runs`) and the format waiting at the insertion point. */
  private runs: Run[] = [];
  private pendingFmt: RtfPatch | null = null;
  /** DirListBox / FileListBox: the last folder listing, the load in progress (reads of ListCount and List wait for it) and a FileName to select once it is there. */
  private listing: DirListing | null = null;
  private loading: Promise<void> | null = null;
  private loadSeq = 0;
  private pendingName: string | null = null;
  /** The listing read while checking a new Path (the reload that follows uses it instead of reading again). */
  private prefetched: { path: string; listing: DirListing } | null = null;
  /** DriveListBox: the volumes, once known. */
  private volumes: Volume[] | null = null;
  /** Winsock, Inet, WebBrowser: their methods and network state. */
  private ext: NetControl | null = null;
  /** MMControl, MediaPlayer, Agent: their properties, methods and state (see richControl.ts). */
  private rich: RichControl | null = null;
  /** MSChart: the data table (the window gets it as the prop `ChartLines`) and the Plot.Axis(id) titles. */
  private chart: ChartModel | null = null;
  /** A bound control is being filled from its data control (no DataChanged). */
  private filling = false;

  constructor(readonly def: ControlDef, private formKey: string, private queue: PatchQueue, private ctx: RunContext) {
    const td = CONTROL_TYPES[def.type];
    this.vbTypeName = def.type;
    this.defaultMember = td.defaultMember ?? undefined;
    for (const pd of td.props) this.props[pd.name] = Array.isArray(pd.default) ? [...pd.default] : pd.default;
    for (const [k, v] of Object.entries(def.props)) {
      const pd = getPropDef(def.type, k);
      this.props[pd?.name ?? k] = Array.isArray(v) ? [...v] : v;
    }
    if (isListType(def.type)) {
      this.props.ListIndex = -1; this.props.NewIndex = -1;
    }
    if (def.type === 'RichTextBox') {   // the selection starts out with the control's own font and colour
      const f = this.props.Font as FontValue;
      this.runs = decodeRuns(String(this.props.Runs ?? '')) ?? (this.props.Text ? [{ text: String(this.props.Text), fmt: {} }] : []);
      Object.assign(this.props, { SelBold: f.bold, SelItalic: f.italic, SelUnderline: f.underline,
        SelColor: this.props.ForeColor, SelFontName: f.name, SelFontSize: f.size });
    }
    if (isBrowserType(def.type)) {
      this.props.Path = normalizePath(toStr(this.props.Path as string) || this.ctx.files?.defaultPath || '/');
      this.reload();
    } else if (def.type === 'DriveListBox') this.loadVolumes();
    if (def.type === 'SSTab') syncSSTab(this.props, 'Tabs');
    if (def.type === 'Winsock') this.ext = new WinsockControl(this.netHost());
    else if (def.type === 'Inet') this.ext = new InetControl(this.netHost());
    else if (def.type === 'WebBrowser') this.ext = new WebBrowserControl(this.netHost());
    if (def.type === 'MMControl') this.rich = new MciControl(this.richHost());
    else if (def.type === 'MediaPlayer') this.rich = new MediaPlayerControl(this.richHost());
    else if (def.type === 'Agent') this.rich = new AgentControl(this.richHost());
    else if (def.type === 'Animation') this.rich = new AnimationControl(this.richHost());
    else if (def.type === 'ImageCombo') this.rich = new ImageComboControl(this.richHost());
    else if (def.type === 'CoolBar') this.rich = new CoolBarControl(this.richHost());
    else if (def.type === 'Calendar') this.rich = new CalendarControl(this.richHost());
    else if (def.type === 'MSComm') {
      this.rich = new MSCommControl({
        props: this.props, name: this.def.name,
        raise: (event, args) => this.ctx.raise?.(this, event, args) ?? Promise.resolve(),
        comm: () => {
          const c = this.ctx.comm?.();
          if (!c) throw new VBRuntimeError(8002, 'Invalid port number');
          return c;
        },
      });
    } else if (def.type === 'SysInfo') {
      this.rich = new SysInfoControl({
        props: this.props,
        raise: (event, args) => this.ctx.raise?.(this, event, args) ?? Promise.resolve(),
        system: () => this.ctx.system?.() ?? null,
      });
    } else if (def.type === 'Data' || def.type === 'Adodc') this.rich = new DataControl(this.dataHost(), def.type === 'Data' ? 'dao' : 'ado');
    else if (def.type === 'DataGrid') {
      const h = this.dataHost();
      this.rich = new DataGridControl({ ...h, source: () => this.dataControlNamed(this.props.DataSource) });
    } else if (def.type === 'DataList' || def.type === 'DataCombo') {
      const h = this.dataHost();
      this.rich = new DataListControl({ ...h, type: def.type, rowSource: () => this.dataControlNamed(this.props.RowSource) });
    }
    if (def.type === 'MonthView') {   // the selection starts out as the Value
      const v = typeof this.props.Value === 'number' ? dayOf(this.props.Value) : dayOf(Number(CONTROL_TYPES.MonthView.props.find(p => p.name === 'Value')!.default));
      this.props.Value = v;
      this.props.SelStart = v; this.props.SelEnd = v;
    }
    if (def.type === 'MSChart') {
      const rows = Math.max(1, Number(this.props.RowCount) || 5), cols = Math.max(1, Number(this.props.ColumnCount) || 4);
      this.chart = decodeChart(this.lines('ChartLines')) ?? sampleChart(rows, cols);
      this.props.AxisTitles = ['', '', '', ''].map((t, i) => this.lines('AxisTitles')[i] ?? t);
      this.syncChart(false);
    }
    if (def.type === 'MaskedEdit') this.props.Text = fitText(String(this.props.Mask ?? ''), String(this.props.PromptChar ?? '_'), String(this.props.Text ?? ''));
    if (def.type === 'StatusBar') {
      this.collections.set('panels', makePanels(this.lines('Panels'), (k, _i, at) => this.collectionChanged(k, at)));
    } else if (def.type === 'TabStrip') {
      const tabs = makeTabs(this.lines('Tabs'), (k, _i, at) => this.collectionChanged(k, at),
        { get: () => Number(this.props.SelectedTab), set: i => this.selectTab(i) });
      this.collections.set('tabs', tabs);
      const sel = Number(this.props.SelectedTab);
      this.props.SelectedTab = tabs.count === 0 ? 0 : Math.min(tabs.count, Math.max(1, sel || 1));
    } else if (def.type === 'ImageList') {
      this.collections.set('listimages', makeListImages(this.lines('ListImages'), () => this.sendImages()));
    } else if (def.type === 'Toolbar') {
      this.collections.set('buttons', makeButtons(this.lines('Buttons'), (k, i) => this.buttonsChanged(k, i)));
    } else if (def.type === 'TreeView') {
      this.collections.set('nodes', makeNodes(() => this.sendNodes(), this.picker()) as unknown as CollectionObject<ItemObject>);
    } else if (def.type === 'ListView') {
      this.collections.set('columnheaders', makeColumns(this.lines('ColumnHeaders'), () => this.sendColumns()));
      this.collections.set('listitems', makeListItems(() => this.sendItems(), this.picker()));
    } else if (def.type === 'MSFlexGrid') {
      this.grid = new GridData(Number(this.props.Rows), Number(this.props.Cols));
      this.props.Row = Math.min(Number(this.props.Row), this.grid.rows - 1);
      this.props.Col = Math.min(Number(this.props.Col), this.grid.cols - 1);
      this.syncGrid();
    }
  }

  // -- Winsock, Inet and WebBrowser --------------------------------------------------------------------------------

  private netHost(): NetHost {
    return {
      props: this.props, name: this.def.name, self: this,
      raise: (event, args) => this.ctx.raise?.(this, event, args) ?? Promise.resolve(),
      net: () => {
        const n = this.ctx.net?.();
        if (!n) throw new VBRuntimeError(429, 'ActiveX component can\'t create object');
        return n;
      },
      send: p => this.send(p),
    };
  }

  private richHost(): RichHost {
    return {
      props: this.props, name: this.def.name,
      raise: (event, args) => this.ctx.raise?.(this, event, args) ?? Promise.resolve(),
      send: p => this.send(p),
      openMedia: (path, mime) => {
        const o = this.ctx.openMedia;
        return o ? o(path, mime) : Promise.reject(new VBRuntimeError(53));
      },
      controlByName: n => this.ctx.controlByName?.(n),
    };
  }

  private dataHost(): DataHost {
    return {
      props: this.props, name: this.def.name,
      raise: (event, args) => this.ctx.raise?.(this, event, args) ?? Promise.resolve(),
      send: p => this.send(p),
      db: () => {
        const d = this.ctx.db?.();
        if (!d) throw new VBRuntimeError(429, 'ActiveX component can\'t create object');
        return d;
      },
      resolvePath: p => this.ctx.resolveDbPath?.(p) ?? p,
      consumers: () => this.ctx.controls?.() ?? [],
      msgBox: (p, b, t) => this.ctx.msgBox?.(p, b, t) ?? Promise.resolve(1),
    };
  }

  // -- data binding -------------------------------------------------------------------------------------------------

  /** A Data control / Adodc: its data side (recordset, binding); null for other controls. */
  dataSource(): DataControl | null { return this.rich instanceof DataControl ? this.rich : null; }

  /** The data control of the form a DataSource / RowSource names. */
  private dataControlNamed(name: PropValue | undefined): DataControl | null {
    const c = this.ctx.controlByName?.(strProp(name));
    return c instanceof ControlObject ? c.dataSource() : null;
  }

  /** The property whose change marks a bound control's record changed (DataChanged). */
  private dirtyProp(): string | null {
    if (strProp(this.props.DataSource) === '') return null;
    return this.def.type === 'ListBox' ? 'ListIndex' : BOUND_PROP[this.def.type] ?? null;
  }

  isBound(): boolean {
    return (this.rich?.showBound !== undefined || BOUND_PROP[this.def.type] !== undefined)
      && strProp(this.props.DataSource) !== '' && strProp(this.props.DataField) !== '';
  }

  /** The value to save in the bound field: the text, a CheckBox's True / False (Grayed: Null), a DTPicker's date or Null. */
  boundValue(): VBValue {
    if (this.rich?.boundValue) return this.rich.boundValue();
    switch (this.def.type) {
      case 'CheckBox': { const n = Number(this.props.Value); return n === 2 ? Null : n === 1; }
      case 'DTPicker': return typeof this.props.Value === 'number' ? dateValue(this.props.Value) : Null;
      case 'ListBox': case 'MaskedEdit': return this.read(this.propDef('Text')) as string;
      default: return toStr(this.props[BOUND_PROP[this.def.type]] as string);
    }
  }

  /** Shows a field's value (null: no current record); the Change / Click events follow as for code. DataChanged becomes False. */
  showBound(v: VBValue | null): void {
    const none = v === null || v instanceof NullT;
    try {
      this.filling = true;
      if (this.rich?.showBound) this.rich.showBound(v);
      else switch (this.def.type) {
        case 'CheckBox': this.setMember('Value', [], none ? 0 : toBool(v) ? 1 : 0); break;
        case 'DTPicker':
          if (!none) void this.setMember('Value', [], v);
          else if (this.props.CheckBox === true) void this.setMember('Value', [], Null);
          break;
        case 'ListBox': {
          const t = none ? '' : toStr(v);
          this.write(this.propDef('ListIndex'), this.list().findIndex(x => x === t));
          break;
        }
        default: {
          const prop = BOUND_PROP[this.def.type];
          if (prop) void this.setMember(prop, [], none || (isObject(v) && !isDate(v)) ? '' : toStr(v));
        }
      }
    } catch {
      // a value the control cannot show (a MaskedEdit mask, a date out of range) is left out
    } finally {
      this.filling = false;
      this.props.DataChanged = false;
    }
  }

  dataNotify(src: DataControl, kind: 'reposition' | 'rows'): void { this.rich?.dataNotify?.(src, kind); }

  /** Form_Load has finished: a Data control opens its recordset. */
  formLoaded(): Promise<void> { return this.rich?.formLoaded?.() ?? Promise.resolve(); }
  /** The form is about to unload: a Data control saves the bound controls' changes. */
  beforeUnload(): Promise<void> { return this.rich?.formUnloading?.() ?? Promise.resolve(); }

  /** The form unloads or the program ends: sockets close, requests are aborted, media stops. */
  dispose(): void { this.ext?.dispose(); this.rich?.dispose(); }

  /** Winsock GetData / PeekData write to their first argument. */
  byRefArgs(name: string): readonly number[] | undefined { return this.ext?.byRef?.[name.toLowerCase()]; }

  // -- MSChart ----------------------------------------------------------------------------------------------------

  /** The counts, the current Row / Column and the data are in step with the table; with `send` the window gets them. */
  private syncChart(send = true): void {
    const m = this.chart!, p = this.props;
    p.RowCount = m.rows; p.ColumnCount = m.cols;
    p.Row = Math.min(m.rows, Math.max(1, Number(p.Row) || 1)); p.Column = Math.min(m.cols, Math.max(1, Number(p.Column) || 1));
    p.ChartLines = encodeChart(m);
    if (send) this.send({ RowCount: m.rows, ColumnCount: m.cols, Row: p.Row, Column: p.Column, ChartLines: p.ChartLines });
  }

  /** Data, RowLabel, ColumnLabel, ChartData and Plot; undefined = an ordinary property. */
  private chartGet(pd: PropDef, args: VBValue[]): VBValue | undefined {
    const m = this.chart!, r = Number(this.props.Row) - 1, c = Number(this.props.Column) - 1;
    switch (pd.name) {
      case 'Data': case 'RowLabel': case 'ColumnLabel': case 'ChartData': case 'Plot':
        if (args.length) throw new VBRuntimeError(450);
    }
    switch (pd.name) {
      case 'Data': return m.values[r][c];
      case 'RowLabel': return m.rowLabels[r];
      case 'ColumnLabel': return m.colLabels[c];
      case 'ChartData': return chartToArray(m);
      case 'Plot': return new ChartPlot({ get: id => this.axisTitles()[id] ?? '', set: (id, t) => this.setAxisTitle(id, t) });
    }
    return undefined;
  }

  private axisTitles(): string[] { return this.lines('AxisTitles'); }
  private setAxisTitle(id: number, text: string): void {
    const t = this.axisTitles();
    while (t.length < 4) t.push('');
    t[id] = text;
    this.props.AxisTitles = t;
    this.send({ AxisTitles: t });
  }

  /** RowCount, ColumnCount, Row, Column, Data, RowLabel, ColumnLabel and ChartData are set here; false for every other property. */
  private chartSet(pd: PropDef, args: VBValue[], value: VBValue): boolean {
    const m = this.chart!;
    const known = ['RowCount', 'ColumnCount', 'Row', 'Column', 'Data', 'RowLabel', 'ColumnLabel', 'ChartData'];
    if (!known.includes(pd.name)) return false;
    if (args.length) throw new VBRuntimeError(450);
    const v = this.plain(value);
    const r = Number(this.props.Row) - 1, c = Number(this.props.Column) - 1;
    switch (pd.name) {
      case 'RowCount': case 'ColumnCount': {
        const n = num(v), isRow = pd.name === 'RowCount';
        if (n < 1 || n > (isRow ? MAX_CHART_ROWS : MAX_CHART_COLS)) throw new VBRuntimeError(380);
        this.chart = isRow ? resizeChart(m, n, m.cols) : resizeChart(m, m.rows, n);
        this.syncChart();
        return true;
      }
      case 'Row': case 'Column': {
        const n = num(v);
        if (n < 1 || n > (pd.name === 'Row' ? m.rows : m.cols)) throw new VBRuntimeError(380);
        this.write(pd, n);
        return true;
      }
      case 'Data': m.values[r][c] = coerce(v, 'Double') as number; break;
      case 'RowLabel': m.rowLabels[r] = toStr(v); break;
      case 'ColumnLabel': m.colLabels[c] = toStr(v); break;
      case 'ChartData': this.chart = chartFromArray(value); break;
    }
    this.syncChart();
    return true;
  }

  // -- DriveListBox, DirListBox and FileListBox ----------------------------------------------------------------

  private loadVolumes(): void {
    this.ctx.files?.listVolumes().then(v => {
      if (!v.length) return;
      this.volumes = v;
      this.props.Drives = v.map(x => joinFields([x.path, x.name]));
      this.send({ Drives: this.props.Drives });
    }).catch(() => { /* the default drive "/" stays */ });
  }

  /** Reads the folder in `Path`; the lists follow when it is there (an unreadable folder is an empty list). */
  private reload(): void {
    const files = this.ctx.files;
    if (!files) return;
    const seq = ++this.loadSeq, path = String(this.props.Path);
    const pre = this.prefetched;
    this.prefetched = null;
    const p: Promise<void> = new Promise<DirListing>(r => r(pre?.path === path ? pre.listing : files.listDir(path)))
      .catch((): DirListing => ({ dirs: [], files: [] }))
      .then(l => {
        if (seq !== this.loadSeq) return;
        this.listing = l;
        this.send(this.listProps());
      })
      .finally(() => { if (this.loading === p) this.loading = null; });
    this.loading = p;
  }

  /** Resolves when no folder is being read (a newer read replaces an older one). */
  private settled(): Promise<void> {
    const p = this.loading;
    return p ? p.then(() => this.settled()) : Promise.resolve();
  }

  /** List and ListIndex from the listing and the current Path / Pattern / Hidden / Normal / Archive; stored here, the caller sends them. */
  private listProps(): Record<string, PropValue> {
    const p = this.props, l = this.listing;
    const list = !l ? [] : this.def.type === 'DirListBox' ? subDirs(String(p.Path), l.dirs)
      : filterFiles(l.files, { pattern: toStr(p.Pattern as string), hidden: p.Hidden === true, normal: p.Normal === true, archive: p.Archive === true });
    let index = -1;
    if (this.pendingName !== null) { const n = this.pendingName.toLowerCase(); index = list.findIndex(x => x.toLowerCase() === n); this.pendingName = null; }
    p.List = list;
    p.ListIndex = index;
    return { List: list, ListIndex: index };
  }

  /**
   * DirListBox / FileListBox.Path = "x": the folder is read first (the statement waits for it); error 76 when it does not
   * exist. A folder that exists but cannot be read (no permission) is accepted and lists nothing.
   */
  private async setPath(value: string): Promise<void> {
    const path = resolvePath(String(this.props.Path), value);
    let listing: DirListing;
    try {
      listing = await this.ctx.files!.listDir(path);
    } catch (e) {
      if (!/permission denied|not permitted/i.test(String(e instanceof Error ? e.message : e))) throw new VBRuntimeError(76);
      listing = { dirs: [], files: [] };
    }
    this.prefetched = { path, listing };
    this.write(this.propDef('Path'), path);
    this.prefetched = null;   // used by the reload in write(); left over when the Path did not change
  }

  /** FileListBox.FileName = "x" selects the file; "folder/x" also changes Path. */
  private setFileName(name: string): void {
    const slash = name.lastIndexOf('/');
    if (slash >= 0) this.write(this.propDef('Path'), name.slice(0, slash) || '/');
    this.pendingName = slash >= 0 ? name.slice(slash + 1) : name;
    if (this.loading) return;
    this.send(this.listProps());
  }

  /** Drive = "x": the volume it names (or holds); error 68 when there is none. */
  private driveValue(v: string): string {
    if (!this.volumes) return v;
    const vol = findVolume(this.volumes, v);
    if (!vol) throw new VBRuntimeError(68);
    return vol.path;
  }

  // -- TreeView, ListView and MSFlexGrid: what the window gets ---------------------------------------------------

  private picker(): Picker { return { is: i => this.selItem === i, pick: i => this.select(i) }; }
  private selectedIndex(): number { return this.selItem?.owner ? this.selItem.index : 0; }
  private selProp(): string { return this.def.type === 'TreeView' ? 'SelectedNode' : 'SelectedIndex'; }

  /** Selects a node / list item by code (no NodeClick / ItemClick, as in VB6). */
  private select(i: ItemObject | null): void {
    this.selItem = i;
    this.props[this.selProp()] = this.selectedIndex();
    this.send({ [this.selProp()]: this.selectedIndex() });
  }

  private sendNodes(): void {
    const nodes = this.collections.get('nodes') as unknown as NodesCollection;
    const lines = nodeLines(nodes.roots);
    this.props.Nodes = lines;
    this.props.SelectedNode = this.selectedIndex();
    this.send({ Nodes: lines, SelectedNode: this.selectedIndex() });
  }
  private sendItems(): void {
    const items = this.collections.get('listitems')!.items();
    const lines = items.map(listLine), icons = items.map(iconLine);
    this.props.ListItems = lines;
    this.props.ListIcons = icons;
    this.props.SelectedIndex = this.selectedIndex();
    this.send({ ListItems: lines, ListIcons: icons, SelectedIndex: this.selectedIndex() });
  }

  // -- ImageList and Toolbar ---------------------------------------------------------------------------------------

  private sendImages(): void {
    const lines = this.collections.get('listimages')!.items().map(listImageItemLine);
    this.props.ListImages = lines;
    this.send({ ListImages: lines });
  }

  /** The window's button lines carry the pressed state: the items take it over. */
  private syncButtons(lines: readonly string[]): void {
    this.collections.get('buttons')?.items().forEach((b, i) => { if (lines[i] !== undefined) b.setRaw('Value', parseButton(lines[i]).value); });
  }

  /** A Buttons collection or button changed: pressing a tbrButtonGroup button releases its group, then the lines go to the window. */
  private buttonsChanged(kind: ChangeKind, item: ItemObject | null): void {
    let lines = this.collections.get('buttons')!.items().map(toolbarLine);
    if (kind === 'item' && item && parseButton(toolbarLine(item)).value) {
      lines = setPressed(lines, item.index, true);
      this.syncButtons(lines);
    }
    this.props.Buttons = lines;
    this.send({ Buttons: lines });
  }
  private sendColumns(): void {
    const lines = this.collections.get('columnheaders')!.items().map(columnLine);
    this.props.ColumnHeaders = lines;
    this.send({ ColumnHeaders: lines });
  }

  /** The grid arrays as window props (`cells` is shared, not copied; see gridData.ts). */
  private gridProps(all: boolean): Record<string, PropValue> {
    const g = this.grid!;
    const p: Record<string, PropValue> = { Cells: g.cells };
    if (all) Object.assign(p, { ColWidths: g.colWidth.map(String), RowHeights: g.rowHeight.map(String), ColAligns: g.colAlign.map(String) });
    return p;
  }
  private syncGrid(send = false): void {
    Object.assign(this.props, this.gridProps(true));
    if (send) this.send(this.gridProps(true));
  }
  /** Rows / Cols / FixedRows / FixedCols were set: resize the cells and keep Row / Col inside. */
  private gridResized(): void {
    const g = this.grid!;
    g.resize(Number(this.props.Rows), Number(this.props.Cols));
    this.props.Row = Math.min(Number(this.props.Row), g.rows - 1);
    this.props.Col = Math.min(Number(this.props.Col), g.cols - 1);
    this.syncGrid();
    this.send({ ...this.gridProps(true), Row: this.props.Row, Col: this.props.Col });
  }
  private gridIndex(args: VBValue[], n: number): number[] {
    if (args.length !== n) throw new VBRuntimeError(450);
    return args.map(a => num(this.plain(a)));
  }
  /** TextMatrix, Text, ColWidth, RowHeight, ColAlignment (get); undefined = an ordinary property. */
  private gridGet(l: string, args: VBValue[]): VBValue | undefined {
    const g = this.grid!;
    switch (l) {
      case 'textmatrix': { const [r, c] = this.gridIndex(args, 2); if (!g.has(r, c)) throw badIndex(); return g.get(r, c); }
      case 'text': if (args.length) throw new VBRuntimeError(450); return g.get(Number(this.props.Row), Number(this.props.Col));
      case 'colwidth': { const [c] = this.gridIndex(args, 1); if (!g.has(0, c)) throw badIndex(); return g.colWidth[c]; }
      case 'rowheight': { const [r] = this.gridIndex(args, 1); if (!g.has(r, 0)) throw badIndex(); return g.rowHeight[r]; }
      case 'colalignment': { const [c] = this.gridIndex(args, 1); if (!g.has(0, c)) throw badIndex(); return g.colAlign[c] ?? DEFAULT_ALIGN; }
    }
    return undefined;
  }
  private gridSet(l: string, args: VBValue[], value: VBValue): boolean {
    const g = this.grid!;
    switch (l) {
      case 'textmatrix': case 'text': {
        const [r, c] = l === 'text' ? [Number(this.props.Row), Number(this.props.Col)] : this.gridIndex(args, 2);
        if (l === 'text' && args.length) throw new VBRuntimeError(450);
        if (!g.has(r, c)) throw badIndex();
        g.set(r, c, toStr(this.plain(value)));
        this.send({ Cells: g.cells });
        return true;
      }
      case 'colwidth': case 'rowheight': case 'colalignment': {
        const [i] = this.gridIndex(args, 1), n = num(this.plain(value));
        if (l === 'rowheight' ? !g.has(i, 0) : !g.has(0, i)) throw badIndex();
        if (n < (l === 'colalignment' ? 0 : -1) || (l === 'colalignment' && n > 9)) throw new VBRuntimeError(380);
        if (l === 'colwidth') g.colWidth[i] = n; else if (l === 'rowheight') g.rowHeight[i] = n; else g.colAlign[i] = n;
        this.syncGrid(true);
        return true;
      }
    }
    return false;
  }

  private lines(prop: string): string[] { return Array.isArray(this.props[prop]) ? [...(this.props[prop] as string[])] : []; }

  /** A Panels/Tabs collection changed: keep the selected tab on the same tab, then send the lines to the window. */
  private collectionChanged(kind: ChangeKind, at: number): void {
    if (this.def.type === 'StatusBar') {
      const lines = this.collections.get('panels')!.items().map(panelLine);
      this.props.Panels = lines;
      this.send({ Panels: lines });
      return;
    }
    const tabs = this.collections.get('tabs')!;
    let sel = Number(this.props.SelectedTab);
    if (kind === 'clear') sel = 0;
    else if (kind === 'add') sel = tabs.count === 1 ? 1 : at <= sel ? sel + 1 : sel;
    else if (kind === 'remove') sel = at < sel ? sel - 1 : Math.min(sel, tabs.count);
    const lines = tabs.items().map(tabLine);
    this.props.Tabs = lines;
    this.props.SelectedTab = sel;
    this.send({ Tabs: lines, SelectedTab: sel });
  }

  /** TabStrip: select tab `i` by code (Tab.Selected = True, SelectedItem = …); raises Click like a click on the tab. */
  private selectTab(i: number): void {
    const old = this.props.SelectedTab;
    if (i === old) return;
    this.props.SelectedTab = i;
    this.send({ SelectedTab: i });
    this.ctx.propChanged?.(this, 'SelectedTab', old);
  }

  /** The arguments an event handler receives: object arguments (PanelClick's Panel) replace the index the window sent. */
  eventArgs(event: string, args: (number | string)[]): VBValue[] {
    const object = (collection: string): VBValue[] => [this.collections.get(collection)?.find(args[0]) ?? Nothing];
    switch (event) {
      case 'PanelClick': return object('panels');
      case 'NodeClick': case 'Expand': case 'Collapse': return object('nodes');
      case 'ItemClick': return object('listitems');
      case 'ColumnClick': return object('columnheaders');
      case 'ButtonClick': return object('buttons');
      case 'DateClick': case 'DateDblClick': return args.map(a => dateValue(Number(a)));
      case 'SelChange': if (this.def.type === 'MonthView') return args.map(a => dateValue(Number(a))); break;
      case 'Click': case 'DblClick': if ((this.def.type === 'DataList' || this.def.type === 'DataCombo') && !args.length) return [2]; break;   // dbcAreaList
    }
    return args;
  }

  get name(): string { return this.def.name; }
  get index(): number | null { return this.def.index; }

  /** State reported by the window (user input). Updates the mirror without sending a patch back. */
  applyState(props: Record<string, PropValue>): void {
    const oldPath = this.props.Path;
    const dirty = this.dirtyProp(), before = dirty ? this.props[dirty] : undefined;
    for (const [k, v] of Object.entries(props)) {
      if (k === 'SelectedNode' || k === 'SelectedIndex') this.selItem = this.collections.get(k === 'SelectedNode' ? 'nodes' : 'listitems')?.find(Number(v)) ?? null;
      else if (k === 'Toggled') {   // 'index|0 or 1': a node was expanded / collapsed by a click on the +/- box
        const [i, on] = String(v).split('|');
        this.collections.get('nodes')?.find(Number(i))?.setRaw('Expanded', on === '1');
        const nodes = this.collections.get('nodes') as unknown as NodesCollection | undefined;
        if (nodes) this.props.Nodes = nodeLines(nodes.roots);
        continue;
      }
      else if (k === 'Buttons' && Array.isArray(v)) this.syncButtons(v);   // the user pressed a check or group button
      this.props[getPropDef(this.def.type, k)?.name ?? k] = v;
    }
    if (isBrowserType(this.def.type) && 'Path' in props && this.props.Path !== oldPath) this.reload();   // a folder opened by a double click
    if (dirty && dirty in props && this.props[dirty] !== before) this.props.DataChanged = true;   // the user edited a bound control
    this.ext?.applyState?.(props);
    this.rich?.applyState?.(props);
    if (this.def.type === 'RichTextBox') {   // the user typed, or moved the selection
      if ('Runs' in props) this.runs = decodeRuns(String(props.Runs ?? '')) ?? (this.props.Text ? [{ text: String(this.props.Text), fmt: {} }] : []);
      if ('SelStart' in props || 'SelLength' in props) this.pendingFmt = null;
    }
  }

  // -- VBObject ---------------------------------------------------------------------------------------------

  hasMember(name: string): boolean {
    const l = name.toLowerCase();
    if (l === 'name') return true;
    if (l === 'index') return this.def.index !== null;
    const pd = getPropDef(this.def.type, name);
    if (pd) return pd.runtime !== 'none';
    return CONTROL_TYPES[this.def.type].methods.some(m => m.name.toLowerCase() === l);
  }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (l === 'name') return this.def.name;
    if (l === 'index') {
      if (this.def.index === null) throw new VBRuntimeError(343, 'Object not an array');
      return this.def.index;
    }
    // a method used as a function: `s = Inet1.OpenURL(url)` (the interpreter waits for a Promise)
    if (this.ext && !getPropDef(this.def.type, name) && CONTROL_TYPES[this.def.type].methods.some(m => m.name.toLowerCase() === l)) return this.callMethod(name, args) as VBValue;
    const pd = this.propDef(name);
    if (this.rich?.get) { const v = this.rich.get(pd.name, args); if (v !== undefined) return v; }
    if (this.chart) { const v = this.chartGet(pd, args); if (v !== undefined) return v; }
    const col = this.collections.get(l);
    if (col) return args.length ? col.getMember('Item', args) : col;
    if (pd.name === 'SelectedItem') {
      if (args.length) throw new VBRuntimeError(450);
      if (this.def.type === 'TabStrip') return this.collections.get('tabs')?.find(Number(this.props.SelectedTab)) ?? Nothing;
      return this.selItem?.owner ? this.selItem : Nothing;
    }
    if (this.grid) { const v = this.gridGet(l, args); if (v !== undefined) return v; }
    if (isBrowserType(this.def.type) && this.loading && (pd.name === 'List' || pd.name === 'ListCount')) {
      return this.settled().then(() => this.getMember(name, args)) as unknown as VBValue;   // the interpreter waits for a Promise
    }
    if (this.def.type === 'DirListBox' && pd.name === 'List') {
      if (args.length !== 1) throw new VBRuntimeError(450);
      const v = dirListItem(String(this.props.Path), this.list(), num(args[0]));
      if (v === undefined) throw badIndex();
      return v;
    }
    if (this.def.type === 'SSTab') { const v = this.ssTabGet(pd, args); if (v !== undefined) return v; }
    if (pd.kind === 'list') return this.getListItem(args);
    if (pd.name === 'Selected') return this.selected(args);
    if (args.length) throw new VBRuntimeError(450);
    if (IMAGE_REFS.has(pd.name) || DATA_REFS.has(pd.name)) {   // the ImageList / data control itself (its name when the form cannot be asked)
      const name = String(this.props[pd.name] ?? '');
      return name === '' ? Nothing : (this.ctx.controlByName?.(name) as VBValue | undefined) ?? name;
    }
    const v = this.read(pd);
    if (pd.kind === 'font') return new FontObject(() => this.props.Font as FontValue, f => this.write(this.propDef('Font'), f));
    if (pd.kind === 'picture') return v ? new PictureObject(v as PictureRef) : Nothing;
    if (pd.kind === 'date') return typeof v === 'number' ? dateValue(v) : Null;
    if (v === null && isDateType(this.def.type)) return Null;   // Day ... of a DTPicker without a Value
    return v as VBValue;
  }

  setMember(name: string, args: VBValue[], value: VBValue): void | Promise<void> {
    const pd = this.propDef(name);
    if (pd.runtime === 'ro' || name.toLowerCase() === 'name' || name.toLowerCase() === 'index') throw new VBRuntimeError(383);
    if (this.rich?.set) {
      if (args.length) throw new VBRuntimeError(450);
      // the object itself, not its default member: the ImageList a control names, the ComboItem SelectedItem becomes
      const r = this.rich.set(pd.name, IMAGE_REFS.has(pd.name) || pd.name === 'SelectedItem' ? value : this.plain(value));
      if (r !== false) return r === true ? undefined : r;
    }
    if (this.chart && this.chartSet(pd, args, value)) return;
    if (pd.name === 'SelectedItem') {
      if (args.length) throw new VBRuntimeError(450);
      if (value === Nothing) throw new VBRuntimeError(91);
      if (this.def.type !== 'TabStrip') {   // TreeView / ListView: a Node / ListItem of this control
        const item = this.collections.get(this.def.type === 'TreeView' ? 'nodes' : 'listitems')?.items().find(t => t === value);
        if (!item) throw new VBRuntimeError(5);
        this.select(item);
        return;
      }
      const tab = this.collections.get('tabs')?.items().find(t => t === value);
      if (!tab) throw new VBRuntimeError(5);
      this.selectTab(tab.index);
      return;
    }
    if (pd.name === 'Path' && isBrowserType(this.def.type) && this.ctx.files) {
      if (args.length) throw new VBRuntimeError(450);
      return this.setPath(toStr(this.plain(value)));
    }
    if (pd.name === 'FileName' && this.def.type === 'FileListBox') {
      if (args.length) throw new VBRuntimeError(450);
      this.setFileName(toStr(this.plain(value)));
      return;
    }
    if (this.def.type === 'SSTab' && this.ssTabSet(pd, args, value)) return;
    if (this.grid && this.gridSet(name.toLowerCase(), args, value)) return;
    if (this.grid && (pd.name === 'Row' || pd.name === 'Col')) {
      const n = num(this.plain(value));
      if (n < 0 || n >= (pd.name === 'Row' ? this.grid.rows : this.grid.cols)) throw new VBRuntimeError(380);
    }
    if (pd.kind === 'list') {
      if (args.length !== 1) throw new VBRuntimeError(450);
      const i = num(args[0]);
      const list = this.list();
      if (i < 0 || i >= list.length) throw badIndex();
      list[i] = toStr(this.plain(value));
      this.send({ List: [...list] });
      return;
    }
    if (pd.name === 'Selected') {
      if (args.length !== 1) throw new VBRuntimeError(450);
      const i = num(args[0]);
      if (i < 0 || i >= this.list().length) throw badIndex();
      if (toBool(this.plain(value))) this.write(this.propDef('ListIndex'), i);
      else if (this.props.ListIndex === i) this.write(this.propDef('ListIndex'), -1);
      return;
    }
    if (args.length) throw new VBRuntimeError(450);
    if (this.def.type === 'MaskedEdit' && pd.name === 'SelText' && String(this.props.Mask ?? '') !== '') { this.maskSelText(toStr(this.plain(value))); return; }
    if (isDateType(this.def.type) && DATE_PARTS.has(pd.name)) { this.setDatePart(pd.name, num(this.plain(value))); return; }
    const v = this.convert(pd, value);
    if (this.ext?.set?.(pd.name, v)) return;
    this.write(pd, v);
  }

  /** MaskedEdit.SelText = "x" with a Mask: the characters are typed over the selection (those that do not fit are left out). */
  private maskSelText(text: string): void {
    const slots = parseMask(String(this.props.Mask)), prompt = String(this.props.PromptChar ?? '_').charAt(0) || '_';
    let t = String(this.props.Text ?? ''), pos = Number(this.props.SelStart), len = Number(this.props.SelLength);
    for (const ch of text) {
      const r = typeChar(slots, t, prompt, pos, len, ch, this.props.AllowPrompt === true);
      if (!r.error) { t = r.text; pos = r.caret; len = 0; }
    }
    this.write(this.propDef('Text'), t);
    this.write(this.propDef('SelStart'), pos);
    this.write(this.propDef('SelLength'), 0);
  }

  /** DTPicker / MonthView Day, Month, Year, Hour, Minute, Second, DayOfWeek: changes that part of Value (380 when it does not fit). */
  private setDatePart(name: string, n: number): void {
    const cur = this.props.Value;
    if (typeof cur !== 'number') throw new VBRuntimeError(94);
    let next: number | null;
    if (name === 'DayOfWeek') next = n >= 1 && n <= 7 ? cur + (n - weekdayOf(cur)) : null;
    else next = setPart(cur, name as 'Day', n);
    if (next === null) throw new VBRuntimeError(380);
    this.write(this.propDef('Value'), this.clampToRange(next));
  }

  /** A date inside MinDate and MaxDate (MonthView: a whole day). */
  private clampToRange(serial: number): number {
    const s = this.def.type === 'MonthView' ? dayOf(serial) : serial;
    return clampDate(s, Number(this.props.MinDate), Number(this.props.MaxDate));
  }

  callMethod(name: string, args: VBValue[], refs?: (OutSlot | undefined)[]): VBValue | Promise<VBValue> {
    const l = name.toLowerCase();
    if (!CONTROL_TYPES[this.def.type].methods.some(m => m.name.toLowerCase() === l)) throw new VBRuntimeError(438);
    if (this.ext) { const r = this.ext.call(l, args, refs); if (r !== undefined) return r; }
    if (this.rich?.call) { const r = this.rich.call(l, args, refs); if (r !== undefined) return r; }
    switch (l) {
      case 'move': return this.move(args);
      case 'setfocus': this.queue.send(this.formKey, { t: 'focus', id: this.def.id }); this.ctx.focused?.(this); return Empty;
      case 'additem': return this.addItem(args);
      case 'removeitem': return this.removeItem(args);
      case 'clear': return this.clear();
      case 'showopen': case 'showsave': return this.showFile(l === 'showopen');
      case 'showcolor': return this.showColor();
      case 'showfont': return this.showFont();
      case 'refresh':
        if (!isBrowserType(this.def.type)) return Empty;
        this.reload();
        return this.settled().then(() => Empty);
      default: return Empty;   // Refresh, ZOrder: nothing to do in the renderer
    }
  }

  // -- properties -------------------------------------------------------------------------------------------

  private propDef(name: string): PropDef {
    const pd = getPropDef(this.def.type, name);
    if (!pd || pd.runtime === 'none') {
      const l = name.toLowerCase();
      if (l === 'name') return { name: 'Name', kind: 'string', default: '', designTime: false, runtime: 'ro' };
      if (l === 'index') return { name: 'Index', kind: 'int', default: 0, designTime: false, runtime: 'ro' };
      throw new VBRuntimeError(438);
    }
    return pd;
  }

  private list(): string[] { return this.props.List as string[]; }

  /** Current value of a property, including the computed ones. */
  private read(pd: PropDef): PropValue {
    switch (pd.name) {
      case 'ListCount': return this.list().length;
      case 'Text':
        if (this.def.type === 'ListBox') {
          const i = this.props.ListIndex as number;
          return i >= 0 ? this.list()[i] ?? '' : '';
        }
        if (this.def.type === 'MaskedEdit') return this.maskValue('text');
        break;
      case 'ClipText': case 'FormattedText': return this.maskValue(pd.name === 'ClipText' ? 'clip' : 'formatted');
      case 'Day': case 'Month': case 'Year': case 'Hour': case 'Minute': case 'Second': case 'DayOfWeek': {
        if (!isDateType(this.def.type)) break;
        const v = this.props.Value;
        if (typeof v !== 'number') return null;
        if (pd.name === 'DayOfWeek') return weekdayOf(v);
        const p = dateParts(v);
        return ({ Day: p.d, Month: p.m, Year: p.y, Hour: p.h, Minute: p.n, Second: p.s } as Record<string, number>)[pd.name];
      }
      case 'SelText': {
        const t = String(this.props.Text ?? ''), s = Number(this.props.SelStart), n = Number(this.props.SelLength);
        return t.substr(s, n);
      }
      case 'Name': return this.def.name;
      case 'Caption':
        if (this.def.type === 'SSTab') return (this.props.TabCaption as string[])[Number(this.props.Tab)] ?? '';
        break;
      case 'FileName':
        if (this.def.type === 'FileListBox') { const i = this.props.ListIndex as number; return i >= 0 ? this.list()[i] ?? '' : ''; }
        break;
    }
    return this.props[pd.name];
  }

  private selected(args: VBValue[]): VBValue {
    if (args.length !== 1) throw new VBRuntimeError(450);
    const i = num(args[0]);
    if (i < 0 || i >= this.list().length) throw badIndex();
    return this.props.ListIndex === i;
  }

  private getListItem(args: VBValue[]): VBValue {
    if (args.length !== 1) throw new VBRuntimeError(450);
    const i = num(args[0]);
    const list = this.list();
    if (i < 0 || i >= list.length) throw badIndex();
    return list[i];
  }

  /** An object value becomes its default member's value (`Form1.Text1 = Text2`). */
  private plain(v: VBValue): VBValue {
    for (let n = 0; n < 4 && isObject(v) && !hasPictureRef(v); n++) {
      if (!v.defaultMember) throw new VBRuntimeError(13);
      v = v.getMember(v.defaultMember, []);
    }
    return v;
  }

  private convert(pd: PropDef, value: VBValue): PropValue {
    if (pd.kind === 'picture') {
      if (value === Nothing || value === Empty) return null;
      const v = this.plain(value);
      if (hasPictureRef(v)) return v.pictureRef;
      if (v === Nothing || v === Empty) return null;
      throw new VBRuntimeError(13);
    }
    if (pd.kind === 'font') throw new VBRuntimeError(13);
    if (IMAGE_REFS.has(pd.name)) {
      if (value === Nothing || value === Empty) return '';
      if (value instanceof ControlObject && value.def.type === 'ImageList') return value.def.name;
    }
    if (DATA_REFS.has(pd.name)) {   // Set Text1.DataSource = Adodc1
      if (value === Nothing || value === Empty) return '';
      if (value instanceof ControlObject && value.dataSource()) return value.def.name;
    }
    const v = this.plain(value);
    switch (pd.kind) {
      case 'date': {
        if (v instanceof NullT) {   // only a DTPicker with a CheckBox can be without a date
          if (this.def.type === 'DTPicker' && pd.name === 'Value' && this.props.CheckBox === true) return null;
          throw new VBRuntimeError(94);
        }
        const serial = (coerce(v, 'Date') as VBDate).serial;
        if (pd.name === 'MinDate' && serial > Number(this.props.MaxDate)) throw new VBRuntimeError(380);
        if (pd.name === 'MaxDate' && serial < Number(this.props.MinDate)) throw new VBRuntimeError(380);
        if (pd.name === 'MinDate' || pd.name === 'MaxDate') return serial;
        const day = this.clampToRange(serial);
        if (pd.name === 'SelEnd' && this.props.MultiSelect === true && Math.abs(day - Number(this.props.SelStart)) + 1 > Number(this.props.MaxSelCount)) {
          throw new VBRuntimeError(380);   // a range of at most MaxSelCount days
        }
        return day;
      }
      case 'string': case 'text':
        if (this.def.type === 'MaskedEdit' && pd.name === 'Text') {   // the whole text with its literals, or just the entries
          return fromTextOrFail(String(this.props.Mask ?? ''), String(this.props.PromptChar ?? '_'), toStr(v));
        }
        return toStr(v);
      case 'bool': return toBool(v);
      case 'color': return num(v);
      case 'enum': {
        const n = num(v);
        if (!pd.enumValues?.some(e => e.value === n)) throw new VBRuntimeError(380);
        return n;
      }
      case 'int': {
        const n = num(v);
        if (this.def.type === 'TextBox' && (pd.name === 'SelStart' || pd.name === 'SelLength')) {   // 380 below 0; at most the text
          if (n < 0) throw new VBRuntimeError(380);
          const len = String(this.props.Text ?? '').length;
          return pd.name === 'SelStart' ? Math.min(n, len) : Math.min(n, len - Math.min(Number(this.props.SelStart) || 0, len));
        }
        if (pd.min !== undefined && n < pd.min) throw new VBRuntimeError(380);
        if (pd.max !== undefined && n > pd.max) throw new VBRuntimeError(380);
        if (this.def.type === 'FlatScrollBar' && pd.name === 'Value') {   // the FlatScrollBar clamps a Value outside Min .. Max
          const lo = Math.min(Number(this.props.Min), Number(this.props.Max)), hi = Math.max(Number(this.props.Min), Number(this.props.Max));
          return Math.min(hi, Math.max(lo, n));
        }
        if (pd.name === 'Value' && 'Min' in this.props && 'Max' in this.props
          && (n < Number(this.props.Min) || n > Number(this.props.Max))) throw new VBRuntimeError(380);
        if (pd.name === 'ListIndex' && (n < -1 || n > this.list().length - 1)) throw new VBRuntimeError(380);
        return n;
      }
    }
    throw new VBRuntimeError(13);
  }

  /** Store a converted value, apply side effects, queue the patch and notify the timer owner. */
  private write(pd: PropDef, v: PropValue): void {
    const patch: Record<string, PropValue> = {};
    const name = pd.name;
    const old = this.props[name === 'SelText' ? 'Text' : name];
    if (name === 'Path' && isBrowserType(this.def.type)) v = resolvePath(String(old), String(v));
    else if (name === 'Drive' && this.def.type === 'DriveListBox') v = this.driveValue(String(v));
    if (this.def.type === 'RichTextBox' && this.writeRich(pd, v, patch)) {
      // handled: the text with its formats is kept here, the window gets it as Runs
    } else if (name === 'SelText') {
      const t = String(this.props.Text ?? ''), s = Math.min(Number(this.props.SelStart) || 0, t.length), n = Math.max(0, Number(this.props.SelLength) || 0);
      const ins = String(v);
      this.props.Text = t.slice(0, s) + ins + t.slice(s + n);
      this.props.SelStart = s + ins.length; this.props.SelLength = 0;
      Object.assign(patch, { Text: this.props.Text, SelStart: this.props.SelStart, SelLength: 0 });
    } else {
      this.props[name] = v;
      patch[name] = v;
      if (isDateType(this.def.type)) this.syncDates(name, patch);
      else if (this.def.type === 'MaskedEdit' && (name === 'Mask' || name === 'PromptChar')) {   // a new mask starts out empty
        this.props.Text = fitText(String(this.props.Mask ?? ''), String(this.props.PromptChar ?? '_'), '');
        patch.Text = this.props.Text;
      }
      if (isBrowserType(this.def.type) && v !== old) {
        if (name === 'Path') { Object.assign(patch, { List: [], ListIndex: -1 }); Object.assign(this.props, { List: [], ListIndex: -1 }); this.reload(); }
        else if (this.def.type === 'FileListBox' && (name === 'Pattern' || name === 'Hidden' || name === 'Normal' || name === 'Archive')) Object.assign(patch, this.listProps());
      }
      if (this.def.type === 'TextBox' && (name === 'SelStart' || name === 'Text')) {
        // VB6: a new SelStart is an insertion point; a new Text puts it at the start. The window gets both, so it selects
        // without a SelStart / SelLength of its own (the user's selection reaches the mirror as state)
        if (name === 'Text') this.props.SelStart = 0;
        this.props.SelLength = 0;
        Object.assign(patch, { SelStart: this.props.SelStart, SelLength: 0 });
      } else if (this.def.type === 'TextBox' && name === 'SelLength') patch.SelStart = this.props.SelStart;
      if (name === 'ListIndex') {
        const i = v as number;
        if (this.def.type === 'ComboBox') { this.props.Text = i >= 0 ? this.list()[i] : ''; patch.Text = this.props.Text; }
      } else if (name === 'Text' && this.def.type === 'ComboBox') {
        const i = this.list().findIndex(s => s === v);
        this.props.ListIndex = i; patch.ListIndex = i;
      }
    }
    if (this.def.type === 'RichTextBox' && (name === 'SelStart' || name === 'SelLength' || name === 'SelText' || name === 'Text')) this.refreshSelFormat();
    this.send(patch);
    if (this.grid && (name === 'Rows' || name === 'Cols' || name === 'FixedRows' || name === 'FixedCols')) this.gridResized();
    if (this.def.type === 'Timer' && (name === 'Enabled' || name === 'Interval')) this.ctx.timerChanged(this);
    const changed = name === 'SelText' ? 'Text' : name;
    if (!this.filling && changed === this.dirtyProp() && this.props[changed] !== old) this.props.DataChanged = true;
    if (DATA_REFS.has(name) || (name === 'DataField' && v !== old)) this.rebind();
    this.ctx.propChanged?.(this, changed, old);
  }

  /** DataSource / DataField set by code: show the field of the data control's current record. */
  private rebind(): void {
    const src = this.ctx.controlByName?.(strProp(this.props.DataSource));
    const rs = src instanceof ControlObject ? src.dataSource()?.recordset() : null;
    if (!rs) return;
    if (this.rich?.dataNotify && src instanceof ControlObject) this.rich.dataNotify(src.dataSource()!, 'rows');
    if (!this.isBound()) return;
    let v: VBValue | null = null;
    try { if (rs.hasCurrent || rs.mode === 2) v = rs.fieldValue(rs.fieldIndex(strProp(this.props.DataField))); } catch { v = null; }
    this.showBound(v);
  }

  /** DTPicker / MonthView: a date property was set; Value, SelStart and SelEnd stay in step and inside MinDate .. MaxDate. */
  private syncDates(name: string, patch: Record<string, PropValue>): void {
    const p = this.props;
    const set = (k: string, v: PropValue) => { p[k] = v; patch[k] = v; };
    const clampProp = (k: string) => { const v = p[k]; if (typeof v === 'number' && this.clampToRange(v) !== v) set(k, this.clampToRange(v)); };
    if (name === 'MinDate' || name === 'MaxDate') {
      clampProp('Value');
      if (this.def.type === 'MonthView') { clampProp('SelStart'); clampProp('SelEnd'); }
      return;
    }
    if (this.def.type !== 'MonthView') return;
    const multi = p.MultiSelect === true;
    if (name === 'Value') { set('SelStart', p.Value); set('SelEnd', p.Value); }
    else if (name === 'SelStart') {   // the end stays when it still makes a range of at most MaxSelCount days
      const span = Number(p.SelEnd) - Number(p.SelStart) + 1;
      if (!multi || span < 1 || span > Number(p.MaxSelCount)) set('SelEnd', p.SelStart);
      set('Value', p.SelStart);
    }
    else if (name === 'SelEnd') { if (!multi || Number(p.SelEnd) < Number(p.SelStart)) set('SelStart', p.SelEnd); set('Value', p.SelStart); }
    else if (name === 'MultiSelect' && !multi) set('SelEnd', p.SelStart);
  }

  /** MaskedEdit: Text (with PromptInclude), ClipText (entries only) and FormattedText (the display, or the Format applied to the entries). */
  private maskValue(kind: 'text' | 'clip' | 'formatted'): string {
    const mask = String(this.props.Mask ?? ''), prompt = String(this.props.PromptChar ?? '_').charAt(0) || '_', shown = String(this.props.Text ?? '');
    const slots = parseMask(mask);
    if (slots.length === 0) return kind === 'clip' ? shown : kind === 'formatted' ? this.formatted(shown) : shown;
    if (kind === 'clip') return clipText(slots, shown, prompt);
    if (kind === 'formatted') return this.formatted(shown, clipText(slots, shown, prompt));
    return maskedText(slots, shown, prompt, this.props.PromptInclude !== false);
  }
  private formatted(shown: string, entries = shown): string {
    const fmt = String(this.props.Format ?? '');
    return fmt === '' ? shown : formatValue(entries, fmt, Intl.DateTimeFormat().resolvedOptions().locale);
  }

  /** RichTextBox: SelBold ... describe the selection as it is now. */
  private refreshSelFormat(): void {
    const p = this.props, f = p.Font as FontValue;
    const fmt = { bold: f.bold, italic: f.italic, underline: f.underline, color: p.ForeColor, fontName: f.name, fontSize: f.size,
      ...formatAt(this.runs, Number(p.SelStart), Number(p.SelLength)), ...(Number(p.SelLength) === 0 ? this.pendingFmt : null) };
    Object.assign(p, { SelBold: fmt.bold, SelItalic: fmt.italic, SelUnderline: fmt.underline, SelColor: fmt.color, SelFontName: fmt.fontName, SelFontSize: fmt.fontSize });
  }

  /** RichTextBox: SelText, Text and the Sel<Format> properties work on the runs. False for every other property. */
  private writeRich(pd: PropDef, v: PropValue, patch: Record<string, PropValue>): boolean {
    const name = pd.name, p = this.props;
    const s = Math.min(Number(p.SelStart), runsText(this.runs).length), n = Number(p.SelLength);
    const FMT: Record<string, keyof RtfPatch> = { SelBold: 'bold', SelItalic: 'italic', SelUnderline: 'underline', SelColor: 'color', SelFontName: 'fontName', SelFontSize: 'fontSize' };
    if (name === 'SelText') {
      const ins = String(v);
      const fmt = this.pendingFmt ? { ...formatAt(this.runs, s, n), ...this.pendingFmt } : null;
      this.runs = replaceRange(this.runs, s, n, ins, fmt);
      this.pendingFmt = null;
      p.SelStart = s + ins.length; p.SelLength = 0;
      Object.assign(patch, { SelStart: p.SelStart, SelLength: 0 });
    } else if (name === 'Text') {
      this.runs = v === '' ? [] : [{ text: String(v), fmt: {} }];
      this.pendingFmt = null;
    } else if (FMT[name]) {
      p[name] = v;
      patch[name] = v;
      if (n > 0) this.runs = formatRange(this.runs, s, n, { [FMT[name]]: v } as RtfPatch);
      else this.pendingFmt = { ...this.pendingFmt, [FMT[name]]: v } as RtfPatch;
    } else {
      if (name === 'SelStart' || name === 'SelLength') this.pendingFmt = null;
      return false;
    }
    p.Text = runsText(this.runs);
    p.Runs = encodeRuns(this.runs);
    Object.assign(patch, { Text: p.Text, Runs: p.Runs });
    return true;
  }

  private send(props: Record<string, PropValue>): void {
    if (this.def.type === 'Timer' || this.def.type === 'CommonDialog' || this.def.type === 'Inet' || this.def.type === 'Winsock'
      || this.def.type === 'MSComm' || this.def.type === 'SysInfo') return;   // no view
    if (this.def.type === 'RichTextBox') {
      // a RichTextBox applies each change at the selection as it is then (SelStart = 3: SelBold = True: SelStart = 9 must not merge
      // into one patch): the text and selection changes queue as an ordered list (RtfOps) that the window replays, so a loop that
      // colours many words still goes out in the normal coalesced flush
      const op: Record<string, PropValue> = {}, rest: Record<string, PropValue> = {};
      for (const [k, v] of Object.entries(props)) (RTF_OP_PROPS.has(k) ? op : rest)[k] = v;
      if (Object.keys(rest).length) this.queue.set(this.formKey, this.def.id, rest);
      if (Object.keys(op).length) this.queue.set(this.formKey, this.def.id, { RtfOps: [JSON.stringify(op)] });
      return;
    }
    this.queue.set(this.formKey, this.def.id, props);
  }

  // -- SSTab ------------------------------------------------------------------------------------------------

  /** TabCaption(i) / TabEnabled(i) / TabVisible(i): i is 0-based, below Tabs. */
  private ssTabIndex(args: VBValue[]): number {
    if (args.length !== 1) throw new VBRuntimeError(450);
    const i = num(args[0]);
    if (i < 0 || i >= Number(this.props.Tabs)) throw new VBRuntimeError(380);
    return i;
  }

  private ssTabGet(pd: PropDef, args: VBValue[]): VBValue | undefined {
    if (pd.name === 'TabCaption') return this.lines('TabCaption')[this.ssTabIndex(args)] ?? '';
    if (pd.name === 'TabEnabled' || pd.name === 'TabVisible') return flagOn(this.props[pd.name], this.ssTabIndex(args));
    return undefined;
  }

  /** The SSTab properties with side effects; false for the others. Setting Tab raises Click(PreviousTab) (formInstance). */
  private ssTabSet(pd: PropDef, args: VBValue[], value: VBValue): boolean {
    const name = pd.name;
    if (name === 'TabCaption' || name === 'TabEnabled' || name === 'TabVisible') {
      const i = this.ssTabIndex(args), l = this.lines(name);
      if (name === 'TabCaption') l[i] = toStr(this.plain(value));
      else { while (l.length <= i) l.push('1'); l[i] = toBool(this.plain(value)) ? '1' : '0'; }
      this.props[name] = l;
      if (name === 'TabCaption') syncSSTab(this.props, 'Tabs');
      this.send({ [name]: l, Caption: this.props.Caption });
      return true;
    }
    if (args.length) return false;
    if (name === 'Tab') {
      const n = num(this.plain(value));
      if (n < 0 || n >= Number(this.props.Tabs)) throw new VBRuntimeError(380);
      this.write(pd, n);
      this.props.Caption = this.lines('TabCaption')[n] ?? '';
      return true;
    }
    if (name === 'Caption' || name === 'Tabs') {
      const old = this.props.Tab;
      this.props[name] = this.convert(pd, value);
      syncSSTab(this.props, name);
      const p = this.props;
      this.send({ Tabs: p.Tabs, TabCaption: p.TabCaption, Tab: p.Tab, Caption: p.Caption });
      if (p.Tab !== old) this.ctx.propChanged?.(this, 'Tab', old);
      return true;
    }
    return false;
  }

  // -- CommonDialog -----------------------------------------------------------------------------------------

  private dialogs(): NonNullable<RunContext['dialogs']> {
    if (!this.ctx.dialogs) throw new VBRuntimeError(438);
    return this.ctx.dialogs;
  }

  /** Cancel: error 32755 with CancelError = True, otherwise the call just returns and the properties stay. */
  private cancelled(): VBValue {
    if (this.props.CancelError === true) throw new VBRuntimeError(32755);
    return Empty;
  }

  private async showFile(open: boolean): Promise<VBValue> {
    const dialogs = this.dialogs();
    this.queue.flush();
    const p = this.props;
    const path = await dialogs.fileDialog({
      kind: open ? 'open' : 'save', filter: toStr(p.Filter as string), filterIndex: Number(p.FilterIndex),
      title: toStr(p.DialogTitle as string), initDir: toStr(p.InitDir as string), fileName: toStr(p.FileName as string),
    });
    if (path === null) return this.cancelled();
    p.FileName = path;
    p.FileTitle = baseName(path);
    p.FilterIndex = filterIndexFor(toStr(p.Filter as string), Number(p.FilterIndex), path);
    return Empty;
  }

  private async showColor(): Promise<VBValue> {
    const dialogs = this.dialogs();
    this.queue.flush();
    const c = await dialogs.colorDialog({ color: Number(this.props.Color) });
    if (c === null) return this.cancelled();
    this.props.Color = c;
    return Empty;
  }

  private async showFont(): Promise<VBValue> {
    const dialogs = this.dialogs();
    this.queue.flush();
    const p = this.props;
    const f = await dialogs.fontDialog({ font: { name: toStr(p.FontName as string), size: Number(p.FontSize), bold: p.FontBold === true, italic: p.FontItalic === true, underline: p.FontUnderline === true } });
    if (f === null) return this.cancelled();
    Object.assign(p, { FontName: f.name, FontSize: f.size, FontBold: f.bold, FontItalic: f.italic, FontUnderline: f.underline });
    return Empty;
  }

  // -- methods ----------------------------------------------------------------------------------------------

  private move(args: VBValue[]): VBValue {
    if (args.length < 1 || args.length > 4) throw new VBRuntimeError(450);
    const patch: Record<string, PropValue> = {};
    ['Left', 'Top', 'Width', 'Height'].forEach((k, i) => {
      const a = args[i];
      if (a === undefined || a === Empty) return;
      patch[k] = this.props[k] = num(this.plain(a));
    });
    this.send(patch);
    return Empty;
  }

  private addItem(args: VBValue[]): VBValue {
    if (args.length < 1 || args.length > 2) throw new VBRuntimeError(450);
    const item = toStr(this.plain(args[0]));
    const list = this.list();
    let at = list.length;
    if (this.props.Sorted) {
      const key = item.toLowerCase();
      at = list.findIndex(s => s.toLowerCase() > key);
      if (at < 0) at = list.length;
    } else if (args.length === 2) {
      at = num(this.plain(args[1]));
      if (at < 0 || at > list.length) throw new VBRuntimeError(5);
    }
    list.splice(at, 0, item);
    this.props.NewIndex = at;
    const patch: Record<string, PropValue> = { List: [...list] };
    const li = this.props.ListIndex as number;
    if (li >= at) { this.props.ListIndex = li + 1; patch.ListIndex = li + 1; }
    this.send(patch);
    return Empty;
  }

  private removeItem(args: VBValue[]): VBValue {
    if (args.length !== 1) throw new VBRuntimeError(450);
    const i = num(this.plain(args[0]));
    const list = this.list();
    if (i < 0 || i >= list.length) throw new VBRuntimeError(5);
    list.splice(i, 1);
    const patch: Record<string, PropValue> = { List: [...list] };
    const li = this.props.ListIndex as number;
    if (li === i) { this.props.ListIndex = -1; patch.ListIndex = -1; }
    else if (li > i) { this.props.ListIndex = li - 1; patch.ListIndex = li - 1; }
    this.send(patch);
    return Empty;
  }

  private clear(): VBValue {
    this.props.List = [];
    this.props.ListIndex = -1;
    this.props.NewIndex = -1;
    const patch: Record<string, PropValue> = { List: [], ListIndex: -1 };
    if (this.def.type === 'ComboBox') { this.props.Text = ''; patch.Text = ''; }
    this.send(patch);
    return Empty;
  }
}

/** `Command1(i)`: the controls sharing one name, addressed by Index. */
/** Load / Unload of control array elements at run time (the form makes and drops them). */
export interface ElementFactory {
  spawn(template: ControlObject, index: number): ControlObject;
  drop(c: ControlObject): void;
}

export class ControlArrayObject implements VBObject {
  readonly vbTypeName = 'Object';
  private members = new Map<number, ControlObject>();
  /** The elements made by `Load Name(i)` (only those can be unloaded). */
  private loaded = new Set<ControlObject>();

  constructor(readonly name: string, controls: ControlObject[] = [], private factory?: ElementFactory) {
    for (const c of controls) this.add(c);
  }

  /** `Load Name(i)`: a new element with the design-time properties of the lowest one. 360 when it exists. */
  loadElement(index: number): void {
    if (!this.factory) throw new VBRuntimeError(438);
    if (this.members.has(index)) throw new VBRuntimeError(360, 'Object already loaded');
    if (index < 0 || index > 32767) throw new VBRuntimeError(340, `Control array element '${index}' doesn't exist`);
    const c = this.factory.spawn(this.sorted()[0], index);
    this.add(c);
    this.loaded.add(c);
  }

  /** `Unload Name(i)`: only an element made by Load (362 for one made at design time). */
  unloadElement(index: number): void {
    const c = this.item(index);
    if (!this.loaded.has(c) || !this.factory) throw new VBRuntimeError(362, 'Can\'t unload controls created at design time');
    this.loaded.delete(c);
    this.remove(index);
    this.factory.drop(c);
  }

  add(c: ControlObject): void { this.members.set(c.index ?? 0, c); }
  remove(index: number): void { this.members.delete(index); }

  private sorted(): ControlObject[] { return [...this.members.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]); }

  item(i: number): ControlObject {
    const c = this.members.get(i);
    if (!c) throw new VBRuntimeError(340, `Control array element '${i}' doesn't exist`);
    return c;
  }

  items(): VBObject[] { return this.sorted(); }

  hasMember(name: string): boolean { return ['count', 'lbound', 'ubound'].includes(name.toLowerCase()); }

  getMember(name: string, args: VBValue[]): VBValue {
    if (args.length) throw new VBRuntimeError(450);
    const idx = [...this.members.keys()];
    switch (name.toLowerCase()) {
      case 'count': return idx.length;
      case 'lbound': return idx.length ? Math.min(...idx) : 0;
      case 'ubound': return idx.length ? Math.max(...idx) : -1;
    }
    throw new VBRuntimeError(438);
  }

  setMember(name: string): void {
    if (this.hasMember(name)) throw new VBRuntimeError(383);
    throw new VBRuntimeError(438);
  }

  callMethod(): VBValue { throw new VBRuntimeError(438); }
}
