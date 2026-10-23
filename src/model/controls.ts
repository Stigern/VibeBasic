// Control registry: every control type with its design-time/run-time properties, events, methods and defaults,
// plus the helpers that create controls and projects. Used by the designer, Properties window, code window,
// run session and AI context.

import { KEYWORDS } from '../lang/tokens';
import { syncSSTab } from './ssTab';
import { MAX_DATE, MIN_DATE, nowSerial, systemStartOfWeek } from './dateControls';
import { fitText } from './mask';
import { CHART_TYPE_NAMES } from './chart';
import type { ControlDef, ControlType, FontValue, FormDef, PropValue, Project } from './types';

export type PropKind = 'string' | 'text' | 'int' | 'bool' | 'color' | 'enum' | 'font' | 'picture' | 'list'
  | 'date';   // a date serial (number; Null = null) shown as text in the Properties window
export interface PropDef { name: string; kind: PropKind; default: PropValue; enumValues?: { value: number; label: string }[];
  designTime: boolean; runtime: 'rw' | 'ro' | 'none'; min?: number; max?: number }
export interface EventDef { name: string; params: string }          // e.g. { name: 'KeyPress', params: 'KeyAscii As Integer' }
export interface MethodDef { name: string; params: string }
export interface ControlTypeDef { type: ControlType; namePrefix: string; defaultWidth: number; defaultHeight: number;
  props: PropDef[]; events: EventDef[]; methods: MethodDef[]; defaultEvent: string; defaultMember: string | null;
  isContainer: boolean; invisibleAtRuntime: boolean; toolboxTooltip: string;
  /** The component (OCX file name, see components.ts) the control belongs to; absent for the intrinsic controls. */
  component?: string;
  /** Called after a property was set (designer and AI) to keep linked properties in step (SSTab Caption / TabCaption). */
  onPropSet?(props: Record<string, PropValue>, name: string): void }

// ---------------------------------------------------------------------------------------------------------------
// Property builders

/** System colours are stored as the signed VB6 value, exactly what the interpreter produces for `&H8000000F`. */
const sys = (code: number): number => code | 0;
const BTN_FACE = sys(0x8000000f);
const WIN_TEXT = sys(0x80000008);
const WIN_BG = sys(0x80000005);
const BTN_TEXT = sys(0x80000012);

const DEFAULT_FONT: FontValue = { name: 'MS Sans Serif', size: 8, bold: false, italic: false, underline: false };

const enumVals = (...labels: string[]): { value: number; label: string }[] =>
  labels.map((l, i) => ({ value: i, label: `${i} - ${l}` }));

type Opts = Partial<Pick<PropDef, 'designTime' | 'runtime' | 'min' | 'max' | 'enumValues'>>;
const p = (name: string, kind: PropKind, def: PropValue, o: Opts = {}): PropDef =>
  ({ name, kind, default: def, designTime: true, runtime: 'rw', ...o });
const str = (name: string, def = '', o?: Opts) => p(name, 'string', def, o);
const txt = (name: string, def = '', o?: Opts) => p(name, 'text', def, o);
const int = (name: string, def: number, o?: Opts) => p(name, 'int', def, o);
const bool = (name: string, def: boolean, o?: Opts) => p(name, 'bool', def, o);
const color = (name: string, def: number, o?: Opts) => p(name, 'color', def, o);
const en = (name: string, def: number, labels: string[], o?: Opts) => p(name, 'enum', def, { ...o, enumValues: enumVals(...labels) });
const font = () => p('Font', 'font', DEFAULT_FONT);
const picture = (name = 'Picture') => p(name, 'picture', null);
const list = () => p('List', 'list', []);
/** Run-time-only property: not in the Properties window. */
const rt = (name: string, kind: PropKind, def: PropValue, runtime: 'rw' | 'ro' = 'rw'): PropDef =>
  ({ name, kind, default: def, designTime: false, runtime });

/** Data binding (Data control / Adodc): DataSource names the data control, DataField the field; DataChanged is set by an edit. */
const dataBind = (): PropDef[] => [str('DataSource'), str('DataField'), rt('DataChanged', 'bool', false)];

/** Left Top Width Height Visible Enabled TabIndex TabStop Tag ToolTipText */
const common = (): PropDef[] => [
  int('Left', 0), int('Top', 0), int('Width', 0), int('Height', 0),
  bool('Visible', true), bool('Enabled', true),
  int('TabIndex', 0, { min: 0 }), bool('TabStop', true),
  str('Tag'), str('ToolTipText'),
];

// ---------------------------------------------------------------------------------------------------------------
// Events and methods

const MOUSE = 'Button As Integer, Shift As Integer, X As Single, Y As Single';
const KEYS = 'KeyCode As Integer, Shift As Integer';
const ev = (name: string, params = ''): EventDef => ({ name, params });
const evClick = () => ev('Click');
const evDbl = () => ev('DblClick');
const evChange = () => ev('Change');
const evFocus = () => [ev('GotFocus'), ev('LostFocus')];
const evKeys = () => [ev('KeyPress', 'KeyAscii As Integer'), ev('KeyDown', KEYS), ev('KeyUp', KEYS)];
const evMouse = () => [ev('MouseDown', MOUSE), ev('MouseMove', MOUSE), ev('MouseUp', MOUSE)];

const MOVE = 'Left As Single, [Top], [Width], [Height]';
const baseMethods = (): MethodDef[] => [
  { name: 'Move', params: MOVE }, { name: 'SetFocus', params: '' }, { name: 'Refresh', params: '' }, { name: 'ZOrder', params: '[Position]' },
];
const listMethods = (): MethodDef[] => [
  { name: 'AddItem', params: 'Item As String, [Index]' }, { name: 'RemoveItem', params: 'Index As Integer' }, { name: 'Clear', params: '' },
];

// ---------------------------------------------------------------------------------------------------------------
// The registry

const scrollProps = (): PropDef[] => [
  ...common(),
  int('Min', 0, { min: -32768, max: 32767 }), int('Max', 32767, { min: -32768, max: 32767 }),
  int('Value', 0, { min: -32768, max: 32767 }),
  int('SmallChange', 1, { min: 1, max: 32767 }), int('LargeChange', 1, { min: 1, max: 32767 }),
];
const scrollEvents = (): EventDef[] => [evChange(), ev('Scroll'), ...evFocus(), ...evKeys()];

/** Shape and Line have no focus and no Enabled/TabIndex: Left Top Width Height Visible Tag. */
const geoCommon = (): PropDef[] => [int('Left', 0), int('Top', 0), int('Width', 0), int('Height', 0), bool('Visible', true), str('Tag')];
const BORDER_STYLES = ['Transparent', 'Solid', 'Dash', 'Dot', 'Dash-Dot', 'Dash-Dot-Dot', 'Inside Solid'];
const SHAPE_ONLY_METHODS = (): MethodDef[] => [
  { name: 'Move', params: MOVE }, { name: 'Refresh', params: '' }, { name: 'ZOrder', params: '[Position]' },
];

/** MMControl's buttons, left to right (each has <Name>Enabled, <Name>Visible, <Name>Click and <Name>Completed). */
export const MCI_BUTTONS = ['Prev', 'Next', 'Play', 'Pause', 'Back', 'Step', 'Stop', 'Record', 'Eject'] as const;
const AGENT_MOUSE = 'ByVal CharacterID As String, ByVal Button As Integer, ByVal Shift As Integer, ByVal x As Integer, ByVal y As Integer';


const SS_ALIGNMENTS = ['Left Top', 'Left Middle', 'Left Bottom', 'Right Top', 'Right Middle', 'Right Bottom', 'Center Top', 'Center Middle', 'Center Bottom'];
const SS_BEVELS = ['None', 'Inset', 'Raised'];
const SS_FONT3D = ['None', 'Raised with light shading', 'Raised with heavy shading', 'Inset with light shading', 'Inset with heavy shading'];

const def = (d: Omit<ControlTypeDef, 'methods' | 'isContainer' | 'invisibleAtRuntime'> &
  Partial<Pick<ControlTypeDef, 'methods' | 'isContainer' | 'invisibleAtRuntime'>>): ControlTypeDef =>
  ({ methods: baseMethods(), isContainer: false, invisibleAtRuntime: false, ...d });

export const CONTROL_TYPES: Record<ControlType, ControlTypeDef> = {
  // Form is not a "real" control: it has no TabIndex/TabStop/ToolTipText, so only the applicable common props.
  Form: def({
    type: 'Form', namePrefix: 'Form', defaultWidth: 4800, defaultHeight: 3600, isContainer: true,
    toolboxTooltip: 'Form', defaultEvent: 'Load', defaultMember: null,
    props: [
      int('Left', 0), int('Top', 0), int('Width', 4800), int('Height', 3600),
      bool('Visible', true), bool('Enabled', true), str('Tag'),
      str('Caption', ''),   // newControl/newProject fills in the form name
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT),
      en('BorderStyle', 2, ['None', 'Fixed Single', 'Sizable', 'Fixed Dialog', 'Fixed ToolWindow', 'Sizable ToolWindow'], { runtime: 'ro' }),
      en('StartUpPosition', 3, ['Manual', 'CenterOwner', 'CenterScreen', 'Windows Default']),
      bool('ControlBox', true, { runtime: 'ro' }), bool('MaxButton', true, { runtime: 'ro' }), bool('MinButton', true, { runtime: 'ro' }),
      en('WindowState', 0, ['Normal', 'Minimized', 'Maximized']),
      bool('KeyPreview', false),
      font(), picture(), picture('Icon'),
    ],
    events: [
      ev('Load'), ev('Unload', 'Cancel As Integer'), ev('QueryUnload', 'Cancel As Integer, UnloadMode As Integer'),
      ev('Activate'), ev('Deactivate'), ev('Resize'), ev('Initialize'),
      evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse(),
    ],
    methods: [
      { name: 'Show', params: '[Modal], [OwnerForm]' }, { name: 'Hide', params: '' },
      { name: 'Refresh', params: '' }, { name: 'Move', params: MOVE },
    ],
  }),

  CommandButton: def({
    type: 'CommandButton', namePrefix: 'Command', defaultWidth: 1215, defaultHeight: 495, toolboxTooltip: 'CommandButton',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(), str('Caption'), color('BackColor', BTN_FACE),
      bool('Default', false), bool('Cancel', false),
      en('Style', 0, ['Standard', 'Graphical'], { runtime: 'ro' }), picture(), font(),
      rt('Value', 'bool', false),
    ],
    events: [evClick(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  Label: def({
    type: 'Label', namePrefix: 'Label', defaultWidth: 1215, defaultHeight: 255, toolboxTooltip: 'Label',
    defaultEvent: 'Click', defaultMember: 'Caption',
    props: [
      ...common(), str('Caption'),
      en('Alignment', 0, ['Left Justify', 'Right Justify', 'Center']),
      bool('AutoSize', false), en('BackStyle', 1, ['Transparent', 'Opaque']),
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT),
      en('BorderStyle', 0, ['None', 'Fixed Single']), bool('WordWrap', false), font(), ...dataBind(),
    ],
    events: [evClick(), evDbl(), evChange(), ...evMouse()],
  }),

  TextBox: def({
    type: 'TextBox', namePrefix: 'Text', defaultWidth: 1215, defaultHeight: 495, toolboxTooltip: 'TextBox',
    defaultEvent: 'Change', defaultMember: 'Text',
    props: [
      ...common(), txt('Text'), bool('MultiLine', false, { runtime: 'ro' }),
      en('ScrollBars', 0, ['None', 'Horizontal', 'Vertical', 'Both'], { runtime: 'ro' }),
      str('PasswordChar', ''), int('MaxLength', 0, { min: 0 }), bool('Locked', false),
      en('Alignment', 0, ['Left Justify', 'Right Justify', 'Center'], { runtime: 'ro' }),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT),
      en('BorderStyle', 1, ['None', 'Fixed Single'], { runtime: 'ro' }), font(),
      rt('SelStart', 'int', 0), rt('SelLength', 'int', 0), rt('SelText', 'string', ''), ...dataBind(),
    ],
    events: [evChange(), evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  CheckBox: def({
    type: 'CheckBox', namePrefix: 'Check', defaultWidth: 1215, defaultHeight: 495, toolboxTooltip: 'CheckBox',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(), str('Caption'), en('Value', 0, ['Unchecked', 'Checked', 'Grayed']),
      en('Alignment', 0, ['Left Justify', 'Right Justify'], { runtime: 'ro' }),
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT), font(), ...dataBind(),
    ],
    events: [evClick(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  OptionButton: def({
    type: 'OptionButton', namePrefix: 'Option', defaultWidth: 1215, defaultHeight: 495, toolboxTooltip: 'OptionButton',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(), str('Caption'), bool('Value', false),
      en('Alignment', 0, ['Left Justify', 'Right Justify'], { runtime: 'ro' }),
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT), font(),
    ],
    events: [evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  Frame: def({
    type: 'Frame', namePrefix: 'Frame', defaultWidth: 1815, defaultHeight: 1335, isContainer: true, toolboxTooltip: 'Frame',
    defaultEvent: 'Click', defaultMember: 'Caption',
    props: [
      ...common(), str('Caption'), color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT),
      en('BorderStyle', 1, ['None', 'Fixed Single'], { runtime: 'ro' }), font(),
    ],
    events: [evClick(), evDbl(), ...evMouse()],
  }),

  ListBox: def({
    type: 'ListBox', namePrefix: 'List', defaultWidth: 1215, defaultHeight: 1035, toolboxTooltip: 'ListBox',
    defaultEvent: 'Click', defaultMember: 'Text',
    props: [
      ...common(), list(), bool('Sorted', false, { runtime: 'ro' }),
      en('MultiSelect', 0, ['None', 'Simple', 'Extended'], { runtime: 'ro' }),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), font(),
      rt('ListIndex', 'int', -1), rt('ListCount', 'int', 0, 'ro'), rt('Text', 'string', '', 'ro'),
      rt('Selected', 'bool', false), rt('NewIndex', 'int', -1, 'ro'), ...dataBind(),
    ],
    events: [evClick(), evDbl(), ev('Scroll'), ...evFocus(), ...evKeys(), ...evMouse()],
    methods: [...baseMethods(), ...listMethods()],
  }),

  ComboBox: def({
    type: 'ComboBox', namePrefix: 'Combo', defaultWidth: 1215, defaultHeight: 315, toolboxTooltip: 'ComboBox',
    defaultEvent: 'Change', defaultMember: 'Text',
    props: [
      ...common(), txt('Text'), en('Style', 0, ['Dropdown Combo', 'Simple Combo', 'Dropdown List'], { runtime: 'ro' }),
      list(), bool('Sorted', false, { runtime: 'ro' }),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), font(),
      rt('ListIndex', 'int', -1), rt('ListCount', 'int', 0, 'ro'), rt('NewIndex', 'int', -1, 'ro'), ...dataBind(),
    ],
    events: [evChange(), evClick(), evDbl(), ev('DropDown'), ...evFocus(), ...evKeys()],
    methods: [...baseMethods(), ...listMethods()],
  }),

  PictureBox: def({
    type: 'PictureBox', namePrefix: 'Picture', defaultWidth: 1215, defaultHeight: 1215, isContainer: true, toolboxTooltip: 'PictureBox',
    defaultEvent: 'Click', defaultMember: 'Picture',
    props: [
      ...common(), picture(), bool('AutoSize', false), en('BorderStyle', 1, ['None', 'Fixed Single']), color('BackColor', BTN_FACE),
    ],
    events: [evChange(), evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  Image: def({
    type: 'Image', namePrefix: 'Image', defaultWidth: 1215, defaultHeight: 1215, toolboxTooltip: 'Image',
    defaultEvent: 'Click', defaultMember: 'Picture',
    props: [...common(), picture(), bool('Stretch', false), en('BorderStyle', 0, ['None', 'Fixed Single'])],
    events: [evClick(), evDbl(), ...evMouse()],
  }),

  // Timer: fixed 420x420 icon in the designer, invisible at run time, no methods.
  Timer: def({
    type: 'Timer', namePrefix: 'Timer', defaultWidth: 420, defaultHeight: 420, invisibleAtRuntime: true, toolboxTooltip: 'Timer',
    defaultEvent: 'Timer', defaultMember: 'Enabled',
    props: [int('Left', 0), int('Top', 0), bool('Enabled', true), int('Interval', 0, { min: 0, max: 65535 }), str('Tag')],
    events: [ev('Timer')],
    methods: [],
  }),

  HScrollBar: def({
    type: 'HScrollBar', namePrefix: 'HScroll', defaultWidth: 1215, defaultHeight: 255, toolboxTooltip: 'HScrollBar',
    defaultEvent: 'Change', defaultMember: 'Value', props: scrollProps(), events: scrollEvents(),
  }),

  VScrollBar: def({
    type: 'VScrollBar', namePrefix: 'VScroll', defaultWidth: 255, defaultHeight: 1215, toolboxTooltip: 'VScrollBar',
    defaultEvent: 'Change', defaultMember: 'Value', props: scrollProps(), events: scrollEvents(),
  }),

  ProgressBar: def({
    type: 'ProgressBar', component: 'MSCOMCTL.OCX', namePrefix: 'ProgressBar', defaultWidth: 1935, defaultHeight: 255, toolboxTooltip: 'ProgressBar',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(), int('Min', 0), int('Max', 100), int('Value', 0),
      en('Scrolling', 0, ['ccScrollingStandard', 'ccScrollingSmooth']),
      en('Orientation', 0, ['ccOrientationHorizontal', 'ccOrientationVertical']),
      en('Appearance', 1, ['ccFlat', 'cc3D']), en('BorderStyle', 0, ['ccNone', 'ccFixedSingle']),
    ],
    events: [evClick(), ...evMouse()],
  }),

  Shape: def({
    type: 'Shape', namePrefix: 'Shape', defaultWidth: 1215, defaultHeight: 1215, toolboxTooltip: 'Shape',
    defaultEvent: '', defaultMember: null,
    props: [
      ...geoCommon(),
      en('Shape', 0, ['Rectangle', 'Square', 'Oval', 'Circle', 'Rounded Rectangle', 'Rounded Square']),
      en('BackStyle', 0, ['Transparent', 'Opaque']), color('BackColor', BTN_FACE),
      color('FillColor', 0), en('FillStyle', 1, ['Solid', 'Transparent', 'Horizontal Line', 'Vertical Line', 'Upward Diagonal', 'Downward Diagonal', 'Cross', 'Diagonal Cross']),
      color('BorderColor', WIN_TEXT), en('BorderStyle', 1, BORDER_STYLES), int('BorderWidth', 1, { min: 0, max: 8192 }),
    ],
    events: [], methods: SHAPE_ONLY_METHODS(),
  }),

  // Line has no Left/Top/Width/Height: X1, Y1, X2, Y2 (twips, relative to the parent) are its geometry.
  Line: def({
    type: 'Line', namePrefix: 'Line', defaultWidth: 1215, defaultHeight: 1215, toolboxTooltip: 'Line',
    defaultEvent: '', defaultMember: null,
    props: [
      int('X1', 0), int('Y1', 0), int('X2', 0), int('Y2', 0), bool('Visible', true), str('Tag'),
      color('BorderColor', WIN_TEXT), en('BorderStyle', 1, BORDER_STYLES), int('BorderWidth', 1, { min: 1, max: 8192 }),
    ],
    events: [], methods: [{ name: 'Refresh', params: '' }, { name: 'ZOrder', params: '[Position]' }],
  }),

  Slider: def({
    type: 'Slider', component: 'MSCOMCTL.OCX', namePrefix: 'Slider', defaultWidth: 2055, defaultHeight: 495, toolboxTooltip: 'Slider',
    defaultEvent: 'Change', defaultMember: 'Value',
    props: [
      ...common(), int('Min', 0, { min: -32768, max: 32767 }), int('Max', 10, { min: -32768, max: 32767 }), int('Value', 0),
      int('SmallChange', 1, { min: 1, max: 32767 }), int('LargeChange', 5, { min: 1, max: 32767 }),
      int('TickFrequency', 1, { min: 1, max: 32767 }),
      en('TickStyle', 0, ['sldBottomRight', 'sldTopLeft', 'sldBoth', 'sldNoTicks']),
      en('Orientation', 0, ['ccOrientationHorizontal', 'ccOrientationVertical']),
    ],
    events: [evChange(), ev('Scroll'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  UpDown: def({
    type: 'UpDown', component: 'MSCOMCT2.OCX', namePrefix: 'UpDown', defaultWidth: 255, defaultHeight: 495, toolboxTooltip: 'UpDown',
    defaultEvent: 'Change', defaultMember: 'Value',
    props: [
      ...common(), int('Min', 0, { min: -32768, max: 32767 }), int('Max', 10, { min: -32768, max: 32767 }), int('Value', 0),
      int('Increment', 1, { min: 1, max: 32767 }), bool('Wrap', false),
      en('Orientation', 0, ['cc2OrientationVertical', 'cc2OrientationHorizontal']),
    ],
    events: [evChange(), ev('UpClick'), ev('DownClick'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // Panels / Tabs are one line per item, 'field|field|…' (see fieldLines.ts); at run time they seed the collections.
  StatusBar: def({
    type: 'StatusBar', component: 'MSCOMCTL.OCX', namePrefix: 'StatusBar', defaultWidth: 4800, defaultHeight: 315, toolboxTooltip: 'StatusBar',
    defaultEvent: 'PanelClick', defaultMember: null,
    props: [
      int('Left', 0), int('Top', 0), int('Width', 0), int('Height', 0), bool('Visible', true), bool('Enabled', true),
      str('Tag'), str('ToolTipText'), font(),
      en('Style', 0, ['sbrNormal', 'sbrSimple']), str('SimpleText'),
      p('Panels', 'list', [''], { runtime: 'ro' }),
    ],
    events: [evClick(), evDbl(), ev('PanelClick', 'ByVal Panel As Panel'), ...evMouse()],
  }),

  TabStrip: def({
    type: 'TabStrip', component: 'MSCOMCTL.OCX', namePrefix: 'TabStrip', defaultWidth: 3600, defaultHeight: 2400, toolboxTooltip: 'TabStrip',
    defaultEvent: 'Click', defaultMember: null,
    props: [
      ...common(), font(), str('ImageList'),
      p('Tabs', 'list', ['Tab 1'], { runtime: 'ro' }),
      rt('SelectedItem', 'string', ''),
      p('SelectedTab', 'int', 1, { designTime: false, runtime: 'none' }),   // 1-based index of the selected tab (window state)
    ],
    events: [evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // Nodes / ListItems are run-time only; ColumnHeaders are lines 'Text|Key|Width|Alignment'. SelectedNode / SelectedIndex are window state.
  TreeView: def({
    type: 'TreeView', component: 'MSCOMCTL.OCX', namePrefix: 'TreeView', defaultWidth: 2400, defaultHeight: 2400, toolboxTooltip: 'TreeView',
    defaultEvent: 'NodeClick', defaultMember: null,
    props: [
      ...common(), font(), str('ImageList'),
      en('LineStyle', 0, ['tvwTreeLines', 'tvwRootLines']), int('Indentation', 285, { min: 0 }),
      p('Nodes', 'list', [], { designTime: false, runtime: 'ro' }),
      rt('SelectedItem', 'string', ''),
      p('SelectedNode', 'int', 0, { designTime: false, runtime: 'none' }),
    ],
    events: [evClick(), evDbl(), ev('NodeClick', 'ByVal Node As MSComctlLib.Node'), ev('Expand', 'ByVal Node As MSComctlLib.Node'),
      ev('Collapse', 'ByVal Node As MSComctlLib.Node'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  ListView: def({
    type: 'ListView', component: 'MSCOMCTL.OCX', namePrefix: 'ListView', defaultWidth: 3600, defaultHeight: 2400, toolboxTooltip: 'ListView',
    defaultEvent: 'ItemClick', defaultMember: null,
    props: [
      ...common(), font(), str('Icons'), str('SmallIcons'),
      en('View', 0, ['lvwIcon', 'lvwSmallIcon', 'lvwList', 'lvwReport']),
      bool('FullRowSelect', false), bool('GridLines', false), bool('Sorted', false),
      int('SortKey', 0, { min: 0 }), en('SortOrder', 0, ['lvwAscending', 'lvwDescending']),
      p('ColumnHeaders', 'list', [], { runtime: 'ro' }),
      p('ListItems', 'list', [], { designTime: false, runtime: 'ro' }),
      p('ListIcons', 'list', [], { designTime: false, runtime: 'none' }),   // 'Icon|SmallIcon' per list item, in collection order (window state)
      rt('SelectedItem', 'string', ''),
      p('SelectedIndex', 'int', 0, { designTime: false, runtime: 'none' }),
    ],
    events: [evClick(), evDbl(), ev('ItemClick', 'ByVal Item As MSComctlLib.ListItem'),
      ev('ColumnClick', 'ByVal ColumnHeader As MSComctlLib.ColumnHeader'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // The cells live in the run-time mirror (TextMatrix), not in the properties.
  MSFlexGrid: def({
    type: 'MSFlexGrid', component: 'MSFLXGRD.OCX', namePrefix: 'MSFlexGrid', defaultWidth: 3600, defaultHeight: 2400, toolboxTooltip: 'MSFlexGrid',
    defaultEvent: 'Click', defaultMember: null,
    props: [
      ...common(), font(),
      int('Rows', 2, { min: 1 }), int('Cols', 2, { min: 1 }), int('FixedRows', 1, { min: 0 }), int('FixedCols', 1, { min: 0 }),
      en('GridLines', 1, ['flexGridNone', 'flexGridFlat', 'flexGridInset', 'flexGridRaised']),
      en('SelectionMode', 0, ['flexSelectionFree', 'flexSelectionByRow', 'flexSelectionByColumn']),
      rt('Row', 'int', 1), rt('Col', 'int', 1), rt('Text', 'string', ''),
      rt('TextMatrix', 'string', ''), rt('ColWidth', 'int', 975), rt('RowHeight', 'int', 240), rt('ColAlignment', 'int', 1),
    ],
    events: [evClick(), evDbl(), ev('RowColChange'), ev('SelChange'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),
  // Invisible at run time, like Timer (Left and Top only). ShowOpen / ShowSave / ShowColor / ShowFont are run by the run session;
  // ShowPrinter and ShowHelp are not supported (438). FileTitle is run-time only.
  CommonDialog: def({
    type: 'CommonDialog', component: 'COMDLG32.OCX', namePrefix: 'CommonDialog', defaultWidth: 480, defaultHeight: 480, invisibleAtRuntime: true, toolboxTooltip: 'CommonDialog',
    defaultEvent: '', defaultMember: null,
    props: [
      int('Left', 0), int('Top', 0), str('Tag'),
      str('FileName'), rt('FileTitle', 'string', ''), str('Filter'), int('FilterIndex', 1, { min: 0 }),
      str('DialogTitle'), str('InitDir'), int('Flags', 0),
      color('Color', 0), str('FontName', 'MS Sans Serif'), int('FontSize', 8, { min: 1, max: 999 }),
      bool('FontBold', false), bool('FontItalic', false), bool('FontUnderline', false),
      bool('CancelError', false),
    ],
    events: [],
    methods: [
      { name: 'ShowOpen', params: '' }, { name: 'ShowSave', params: '' }, { name: 'ShowColor', params: '' }, { name: 'ShowFont', params: '' },
    ],
  }),

  // Text is plain text; the formatting of the selection is run-time only (SelBold ...). The window reports SelStart, SelLength and the Sel* format.
  RichTextBox: def({
    type: 'RichTextBox', component: 'RICHTX32.OCX', namePrefix: 'RichTextBox', defaultWidth: 2415, defaultHeight: 975, toolboxTooltip: 'RichTextBox',
    defaultEvent: 'Change', defaultMember: 'Text',
    props: [
      ...common(), txt('Text'), bool('Locked', false), bool('MultiLine', true, { runtime: 'ro' }),
      en('ScrollBars', 0, ['rtfNone', 'rtfHorizontal', 'rtfVertical', 'rtfBoth'], { runtime: 'ro' }),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), font(),
      rt('SelStart', 'int', 0), rt('SelLength', 'int', 0), rt('SelText', 'string', ''),
      rt('SelBold', 'bool', false), rt('SelItalic', 'bool', false), rt('SelUnderline', 'bool', false),
      rt('SelColor', 'color', WIN_TEXT), rt('SelFontName', 'string', 'MS Sans Serif'), rt('SelFontSize', 'int', 8),
    ],
    events: [evChange(), ev('SelChange'), evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),
  // The drives, folders and files come from the backend at run time. Drive is the path of a volume ("/" is the startup disk);
  // Drives ('path|name' lines), and a folder / file list (the full paths of the sub-folders, the file names) are the window's data.
  DriveListBox: def({
    type: 'DriveListBox', namePrefix: 'Drive', defaultWidth: 1215, defaultHeight: 315, toolboxTooltip: 'DriveListBox',
    defaultEvent: 'Change', defaultMember: 'Drive',
    props: [
      ...common(), color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), font(),
      rt('Drive', 'string', '/'), p('Drives', 'list', ['/|/'], { designTime: false, runtime: 'none' }),
    ],
    events: [evChange(), ev('DropDown'), ...evFocus(), ...evKeys()],
  }),

  // List(i): i >= 0 the sub-folders (full paths), -1 the current folder, -2 its parent ...; ListCount counts the sub-folders.
  DirListBox: def({
    type: 'DirListBox', namePrefix: 'Dir', defaultWidth: 1215, defaultHeight: 1935, toolboxTooltip: 'DirListBox',
    defaultEvent: 'Change', defaultMember: 'Path',
    props: [
      ...common(), color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), font(),
      rt('Path', 'string', ''), p('List', 'list', [], { designTime: false, runtime: 'ro' }),
      rt('ListCount', 'int', 0, 'ro'), rt('ListIndex', 'int', -1),
    ],
    events: [evChange(), evClick(), ev('Scroll'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // Pattern: "*.*" or several patterns separated by ";". Archive is the same as Normal (an ordinary file).
  FileListBox: def({
    type: 'FileListBox', namePrefix: 'File', defaultWidth: 1215, defaultHeight: 1935, toolboxTooltip: 'FileListBox',
    defaultEvent: 'Click', defaultMember: 'FileName',
    props: [
      ...common(), str('Pattern', '*.*'), bool('Archive', true), bool('Hidden', false), bool('Normal', true),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), font(),
      rt('Path', 'string', ''), rt('FileName', 'string', ''), p('List', 'list', [], { designTime: false, runtime: 'ro' }),
      rt('ListCount', 'int', 0, 'ro'), rt('ListIndex', 'int', -1),
    ],
    events: [evClick(), evDbl(), ev('PathChange'), ev('PatternChange'), ev('Scroll'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // A container: every child sits on one tab (ControlDef.tab) and only the current tab's children show. TabCaption holds all the
  // captions, Caption is the current tab's (see ssTab.ts). TabEnabled / TabVisible are run-time lists, '0' = False.
  SSTab: def({
    type: 'SSTab', component: 'TABCTL32.OCX', namePrefix: 'SSTab', defaultWidth: 4335, defaultHeight: 2895, isContainer: true, toolboxTooltip: 'SSTab',
    defaultEvent: 'Click', defaultMember: null,
    props: [
      ...common(), font(),
      int('Tabs', 3, { min: 1, max: 999 }), int('Tab', 0, { min: 0 }), int('TabsPerRow', 3, { min: 1, max: 999 }),
      en('Style', 0, ['ssStyleTabbedDialog', 'ssStylePropertyPage']), int('TabHeight', 520, { min: 0 }),
      str('Caption', 'Tab 0'), p('TabCaption', 'list', ['Tab 0', 'Tab 1', 'Tab 2']),
      rt('TabEnabled', 'list', []), rt('TabVisible', 'list', []),
    ],
    events: [ev('Click', 'PreviousTab As Integer'), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
    onPropSet: syncSSTab,
  }),

  // Invisible at run time, like the CommonDialog (Left and Top only). ListImages are lines 'Key|asset|Tag' (see imageList.ts); the
  // (Custom) editor in the Properties window adds the pictures. ImageWidth / ImageHeight are in pixels.
  ImageList: def({
    type: 'ImageList', component: 'MSCOMCTL.OCX', namePrefix: 'ImageList', defaultWidth: 480, defaultHeight: 480, invisibleAtRuntime: true,
    toolboxTooltip: 'ImageList', defaultEvent: '', defaultMember: null,
    props: [
      int('Left', 0), int('Top', 0), str('Tag'),
      int('ImageWidth', 16, { min: 1, max: 32767 }), int('ImageHeight', 16, { min: 1, max: 32767 }),
      color('MaskColor', 0xc0c0c0), bool('UseMaskColor', true),
      p('ListImages', 'list', [], { runtime: 'ro' }),
    ],
    events: [], methods: [],
  }),

  // Align top by default (full width at the top of the form; nothing is pushed down). Buttons are lines 'Caption|Key|Style|Image|ToolTipText'
  // (see toolbar.ts); at run time they seed the Buttons collection. ButtonHeight / ButtonWidth are in twips.
  Toolbar: def({
    type: 'Toolbar', component: 'MSCOMCTL.OCX', namePrefix: 'Toolbar', defaultWidth: 4800, defaultHeight: 390, toolboxTooltip: 'Toolbar',
    defaultEvent: 'ButtonClick', defaultMember: null,
    props: [
      int('Left', 0), int('Top', 0), int('Width', 0), int('Height', 0), bool('Visible', true), bool('Enabled', true),
      str('Tag'), str('ToolTipText'), font(),
      en('Align', 1, ['vbAlignNone', 'vbAlignTop', 'vbAlignBottom']),
      str('ImageList'), en('Style', 0, ['tbrStandard', 'tbrFlat']),
      int('ButtonHeight', 330, { min: 1 }), int('ButtonWidth', 345, { min: 1 }),
      bool('ShowTips', true), bool('Wrappable', true),
      p('Buttons', 'list', [], { runtime: 'ro' }),
    ],
    events: [evClick(), evDbl(), ev('ButtonClick', 'ByVal Button As MSComctlLib.Button'), ...evMouse()],
  }),

  // MSCOMCTL.OCX. A combo box whose items carry pictures of an ImageList. ComboItems are lines 'Text|Key|Image|SelImage|Indentation'
  // (see model/imageCombo.ts); at run time they seed the collection. SelectedIndex (1-based, 0 = none) is window state.
  ImageCombo: def({
    type: 'ImageCombo', component: 'MSCOMCTL.OCX', namePrefix: 'ImageCombo', defaultWidth: 2415, defaultHeight: 315, toolboxTooltip: 'ImageCombo',
    defaultEvent: 'Click', defaultMember: 'Text',
    props: [
      ...common(), font(), str('ImageList'), str('Text'), bool('Locked', false),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT),
      p('ComboItems', 'list', [], { runtime: 'ro' }),
      rt('SelectedItem', 'string', ''),
      p('SelectedIndex', 'int', 0, { designTime: false, runtime: 'none' }),
    ],
    events: [evChange(), evClick(), evDbl(), ev('Dropdown'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // COMCT332.OCX. A rebar: the bands are lines 'Caption|Key|Image|NewRow|Style|Child|MinWidth|Width|Visible' (see model/coolbar.ts); Child names a
  // control of the form that the band hosts. Docks like a Toolbar (Align top by default); its Height follows the rows of bands at run time.
  CoolBar: def({
    type: 'CoolBar', component: 'COMCT332.OCX', namePrefix: 'CoolBar', defaultWidth: 4800, defaultHeight: 390, toolboxTooltip: 'CoolBar',
    defaultEvent: 'HeightChanged', defaultMember: null,
    props: [
      int('Left', 0), int('Top', 0), int('Width', 0), int('Height', 0), bool('Visible', true), bool('Enabled', true),
      str('Tag'), str('ToolTipText'),
      en('Align', 1, ['vbAlignNone', 'vbAlignTop', 'vbAlignBottom']),
      str('ImageList'), bool('BandBorders', true), bool('FixedOrder', false), bool('VariantHeight', true),
      color('BackColor', BTN_FACE),
      p('Bands', 'list', [], { runtime: 'ro' }),
    ],
    events: [evClick(), evDbl(), ev('HeightChanged', 'ByVal NewHeight As Single'), ...evMouse()],
  }),

  // MSCOMCT2.OCX. Value and the other dates are OLE serials (Null = null; only a CheckBox DTPicker may have no Value). Day ... DayOfWeek
  // are derived from Value at run time. Format: dtpLongDate 0, dtpShortDate 1, dtpTime 2, dtpCustom 3 (CustomFormat).
  DTPicker: def({
    type: 'DTPicker', component: 'MSCOMCT2.OCX', namePrefix: 'DTPicker', defaultWidth: 2415, defaultHeight: 315, toolboxTooltip: 'DTPicker',
    defaultEvent: 'Change', defaultMember: 'Value',
    props: [
      ...common(), font(),
      p('Value', 'date', nowSerial()),
      en('Format', 0, ['dtpLongDate', 'dtpShortDate', 'dtpTime', 'dtpCustom']), str('CustomFormat'),
      p('MinDate', 'date', MIN_DATE), p('MaxDate', 'date', MAX_DATE),
      bool('CheckBox', false), bool('UpDown', false),
      rt('Day', 'int', 0), rt('Month', 'int', 0), rt('Year', 'int', 0), rt('Hour', 'int', 0), rt('Minute', 'int', 0), rt('Second', 'int', 0),
      rt('DayOfWeek', 'int', 0), ...dataBind(),
    ],
    events: [evChange(), ev('CloseUp'), ev('DropDown'), evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // StartOfWeek: mvwSunday 1 ... mvwSaturday 7 (the default is the system's). SelStart / SelEnd are the selected range (Value is SelStart).
  MonthView: def({
    type: 'MonthView', component: 'MSCOMCT2.OCX', namePrefix: 'MonthView', defaultWidth: 2415, defaultHeight: 2340, toolboxTooltip: 'MonthView',
    defaultEvent: 'DateClick', defaultMember: 'Value',
    props: [
      ...common(), font(),
      p('Value', 'date', nowSerial(true)),
      p('MinDate', 'date', MIN_DATE), p('MaxDate', 'date', MAX_DATE),
      bool('ShowToday', true), bool('ShowWeekNumbers', false),
      p('StartOfWeek', 'enum', systemStartOfWeek(Intl.DateTimeFormat().resolvedOptions().locale), {
        enumValues: ['mvwSunday', 'mvwMonday', 'mvwTuesday', 'mvwWednesday', 'mvwThursday', 'mvwFriday', 'mvwSaturday'].map((l, i) => ({ value: i + 1, label: `${i + 1} - ${l}` })) }),
      bool('MultiSelect', false), int('MaxSelCount', 7, { min: 1, max: 366 }),
      int('MonthRows', 1, { min: 1, max: 12 }), int('MonthColumns', 1, { min: 1, max: 12 }),
      rt('SelStart', 'date', null), rt('SelEnd', 'date', null),
      rt('Day', 'int', 0), rt('Month', 'int', 0), rt('Year', 'int', 0), rt('DayOfWeek', 'int', 0),
    ],
    events: [
      ev('DateClick', 'ByVal DateClicked As Date'), ev('DateDblClick', 'ByVal DateDblClicked As Date'),
      ev('SelChange', 'StartDate As Date, EndDate As Date'), ...evFocus(), ...evKeys(), ...evMouse(),
    ],
  }),

  // MSCOMCT2.OCX. Like HScrollBar / VScrollBar (Orientation chooses), flat or 3-D. A Value outside Min .. Max is clamped.
  FlatScrollBar: def({
    type: 'FlatScrollBar', component: 'MSCOMCT2.OCX', namePrefix: 'FlatScrollBar', defaultWidth: 2415, defaultHeight: 255, toolboxTooltip: 'FlatScrollBar',
    defaultEvent: 'Change', defaultMember: 'Value',
    props: [
      ...common(),
      int('Min', 0, { min: -2147483647, max: 2147483647 }), int('Max', 32767, { min: -2147483647, max: 2147483647 }),
      int('Value', 0, { min: -2147483647, max: 2147483647 }),
      int('SmallChange', 1, { min: 1, max: 2147483647 }), int('LargeChange', 1, { min: 1, max: 2147483647 }),
      en('Orientation', 1, ['cc2OrientationVertical', 'cc2OrientationHorizontal']),
      en('Appearance', 0, ['fsb3D', 'fsbFlat', 'fsbTrack3D']),
      en('Arrows', 0, ['fsbBoth', 'fsbLeftUp', 'fsbRightDown']),
    ],
    events: [evChange(), ev('Scroll'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // MSCOMCT2.OCX. Plays an animated GIF, APNG, WebP or a short MP4 / WebM (no sound); AVI files give error 35752. Open reads the file through the
  // media path of MMControl (see run/objects/animationControl.ts); MediaSrc and MediaCmd are what the window gets. Frames are numbered from 0.
  Animation: def({
    type: 'Animation', component: 'MSCOMCT2.OCX', namePrefix: 'Animation', defaultWidth: 1935, defaultHeight: 1455, toolboxTooltip: 'Animation',
    defaultEvent: 'Click', defaultMember: null,
    props: [
      ...common(),
      bool('AutoPlay', false), bool('Center', false),
      en('BackStyle', 1, ['cc2BackstyleTransparent', 'cc2BackstyleOpaque']), color('BackColor', BTN_FACE),
      p('MediaSrc', 'string', '', { designTime: false, runtime: 'none' }), p('MediaCmd', 'string', '', { designTime: false, runtime: 'none' }),
    ],
    events: [evClick(), evDbl(), ev('Start'), ev('Stop'), ...evMouse()],
    methods: [...baseMethods(), { name: 'Open', params: 'bstrFilename As String' }, { name: 'Play', params: '[Repeat], [Start], [End]' },
      { name: 'Stop', params: '' }, { name: 'Close', params: '' }],
  }),

  // MSMASK32.OCX. Text holds the display string of the mask (literals and a PromptChar for every empty position); the run-time
  // Text, ClipText and FormattedText are worked out from it (model/mask.ts). Without a Mask the control is a plain text field.
  MaskedEdit: def({
    type: 'MaskedEdit', component: 'MSMASK32.OCX', namePrefix: 'MaskEdBox', defaultWidth: 1215, defaultHeight: 315, toolboxTooltip: 'MaskedEdit',
    defaultEvent: 'Change', defaultMember: 'Text',
    props: [
      ...common(), font(),
      str('Mask'), str('PromptChar', '_'), bool('PromptInclude', true), bool('AllowPrompt', false), txt('Text'),
      int('MaxLength', 64, { min: 0, max: 64 }), str('Format'), bool('AutoTab', false), bool('HideSelection', true),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT),
      en('BorderStyle', 1, ['None', 'Fixed Single'], { runtime: 'ro' }),
      rt('ClipText', 'string', '', 'ro'), rt('FormattedText', 'string', '', 'ro'),
      rt('SelStart', 'int', 0), rt('SelLength', 'int', 0), rt('SelText', 'string', ''), ...dataBind(),
    ],
    events: [evChange(), ev('ValidationError', 'InvalidText As String, StartPosition As Integer'), evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
    onPropSet: (props, name) => {
      if (name === 'Mask' || name === 'PromptChar') props.Text = fitText(String(props.Mask ?? ''), String(props.PromptChar ?? '_'), '');
      else if (name === 'Text') props.Text = fitText(String(props.Mask ?? ''), String(props.PromptChar ?? '_'), String(props.Text ?? ''));
    },
  }),

  // SHDOCVW.DLL. An iframe in the form window; LocationURL / LocationName / Busy are kept by the run session (sites that forbid framing
  // with X-Frame-Options or a CSP show an empty page). Navigate accepts http, https and about:blank.
  WebBrowser: def({
    type: 'WebBrowser', component: 'SHDOCVW.DLL', namePrefix: 'WebBrowser', defaultWidth: 4815, defaultHeight: 3615, toolboxTooltip: 'WebBrowser',
    defaultEvent: 'StatusTextChange', defaultMember: null,
    props: [
      ...common(),
      rt('LocationURL', 'string', '', 'ro'), rt('LocationName', 'string', '', 'ro'), rt('Busy', 'bool', false, 'ro'),
    ],
    events: [
      ev('BeforeNavigate2', 'ByVal pDisp As Object, URL As Variant, Flags As Variant, TargetFrameName As Variant, PostData As Variant, Headers As Variant, Cancel As Boolean'),
      ev('NavigateComplete2', 'ByVal pDisp As Object, URL As Variant'), ev('DocumentComplete', 'ByVal pDisp As Object, URL As Variant'),
      ev('TitleChange', 'ByVal Text As String'), ev('StatusTextChange', 'ByVal Text As String'), ...evFocus(),
    ],
    methods: [
      ...baseMethods(),
      { name: 'Navigate', params: 'URL As String, [Flags], [TargetFrameName], [PostData], [Headers]' },
      { name: 'Navigate2', params: 'URL, [Flags], [TargetFrameName], [PostData], [Headers]' },
      { name: 'GoBack', params: '' }, { name: 'GoForward', params: '' }, { name: 'GoHome', params: '' }, { name: 'Stop', params: '' },
    ],
  }),

  // MSINET.OCX. Invisible at run time. The requests are made by the Rust side (reqwest): http and https only. OpenURL waits for the answer;
  // Execute returns at once and raises StateChanged with icResponseCompleted (12) or icError (11, ResponseCode / ResponseInfo).
  Inet: def({
    type: 'Inet', component: 'MSINET.OCX', namePrefix: 'Inet', defaultWidth: 480, defaultHeight: 480, invisibleAtRuntime: true, toolboxTooltip: 'Inet',
    defaultEvent: 'StateChanged', defaultMember: 'URL',
    props: [
      int('Left', 0), int('Top', 0), str('Tag'),
      en('AccessType', 0, ['icUseDefault', 'icDirect', 'icNamedProxy']),
      en('Protocol', 4, ['icUnknown', 'icDefault', 'icFTP', 'icReserved', 'icHTTP', 'icHTTPS']),
      str('URL'), str('RemoteHost'), int('RemotePort', 80, { min: 0, max: 65535 }), str('Document'),
      str('UserName'), str('Password'), str('Proxy'),
      int('RequestTimeout', 60, { min: 0 }),
      rt('ResponseCode', 'int', 0, 'ro'), rt('ResponseInfo', 'string', '', 'ro'), rt('StillExecuting', 'bool', false, 'ro'), rt('hInternet', 'int', 0, 'ro'),
    ],
    events: [ev('StateChanged', 'ByVal State As Integer')],
    methods: [
      { name: 'OpenURL', params: '[URL], [DataType]' }, { name: 'Execute', params: '[URL], [Operation], [InputData], [InputHdrs]' },
      { name: 'GetChunk', params: 'Size As Long, [DataType]' }, { name: 'GetHeader', params: '[HdrName]' }, { name: 'Cancel', params: '' },
    ],
  }),

  // MSWINSCK.OCX. Invisible at run time. TCP (client and server) and UDP sockets of the Rust side (tokio); State has the sck* values.
  // Strings are sent and received one byte per character (characters above 255 become "?").
  Winsock: def({
    type: 'Winsock', component: 'MSWINSCK.OCX', namePrefix: 'Winsock', defaultWidth: 480, defaultHeight: 480, invisibleAtRuntime: true, toolboxTooltip: 'Winsock',
    defaultEvent: 'Error', defaultMember: null,
    props: [
      int('Left', 0), int('Top', 0), str('Tag'),
      en('Protocol', 0, ['sckTCPProtocol', 'sckUDPProtocol']),
      str('RemoteHost'), int('RemotePort', 0, { min: 0, max: 65535 }), int('LocalPort', 0, { min: 0, max: 65535 }),
      rt('LocalIP', 'string', '127.0.0.1', 'ro'), rt('RemoteHostIP', 'string', '', 'ro'),
      rt('State', 'int', 0, 'ro'), rt('BytesReceived', 'int', 0, 'ro'), rt('SocketHandle', 'int', -1, 'ro'),
    ],
    events: [
      ev('Close'), ev('Connect'), ev('ConnectionRequest', 'ByVal requestID As Long'), ev('DataArrival', 'ByVal bytesTotal As Long'),
      ev('Error', 'ByVal Number As Integer, Description As String, ByVal Scode As Long, ByVal Source As String, ByVal HelpFile As String, ByVal HelpContext As Long, CancelDisplay As Boolean'),
      ev('SendComplete'), ev('SendProgress', 'ByVal bytesSent As Long, ByVal bytesRemaining As Long'),
    ],
    methods: [
      { name: 'Accept', params: 'requestID As Long' }, { name: 'Bind', params: '[LocalPort], [LocalIP]' }, { name: 'Close', params: '' },
      { name: 'Connect', params: '[RemoteHost], [RemotePort]' }, { name: 'GetData', params: 'data, [type], [maxLen]' }, { name: 'Listen', params: '' },
      { name: 'PeekData', params: 'data, [type], [maxLen]' }, { name: 'SendData', params: 'data' },
    ],
  }),

  // MSCOMM32.OCX. Invisible at run time. The serial ports of the Rust side (serialport crate). CommPort n is the n-th of the sorted
  // /dev/cu.* devices; PortName (a VibeBasic extension) names the device itself ("/dev/cu.usbmodem1101") and wins when it is set.
  // Settings "baud,parity,data,stop". OnComm sets CommEvent (comEvReceive once InBufferCount reaches RThreshold, comEvSend, comEvCTS ...).
  MSComm: def({
    type: 'MSComm', component: 'MSCOMM32.OCX', namePrefix: 'MSComm', defaultWidth: 480, defaultHeight: 480, invisibleAtRuntime: true, toolboxTooltip: 'MSComm',
    defaultEvent: 'OnComm', defaultMember: null, methods: [],
    props: [
      int('Left', 0), int('Top', 0), str('Tag'),
      int('CommPort', 1, { min: 1, max: 255 }), str('PortName'), str('Settings', '9600,n,8,1'),
      en('Handshaking', 0, ['comNone', 'comXOnXoff', 'comRTS', 'comRTSXOnXOff']),
      bool('DTREnable', true), bool('RTSEnable', false), bool('EOFEnable', false), bool('NullDiscard', false),
      int('InBufferSize', 1024, { min: 1, max: 32767 }), int('OutBufferSize', 512, { min: 1, max: 32767 }),
      int('InputLen', 0, { min: 0 }), en('InputMode', 0, ['comInputModeText', 'comInputModeBinary']), str('ParityReplace', '?'),
      int('RThreshold', 0, { min: 0 }), int('SThreshold', 0, { min: 0 }),
      rt('PortOpen', 'bool', false), rt('Input', 'string', '', 'ro'), rt('Output', 'string', ''),
      rt('InBufferCount', 'int', 0), rt('OutBufferCount', 'int', 0), rt('CommEvent', 'int', 0, 'ro'), rt('CommID', 'int', 0, 'ro'),
      rt('CDHolding', 'bool', false, 'ro'), rt('CTSHolding', 'bool', false, 'ro'), rt('DSRHolding', 'bool', false, 'ro'), rt('Break', 'bool', false),
    ],
    events: [ev('OnComm')],
  }),

  // SYSINFO.OCX. Invisible at run time. OSPlatform 2 (the NT family), OSVersion / OSBuild the macOS version, WorkArea* the main screen's
  // visible frame in twips, the power state from the Rust side (pmset; 255 / -1 when unknown). Only DisplayChanged is raised.
  SysInfo: def({
    type: 'SysInfo', component: 'SYSINFO.OCX', namePrefix: 'SysInfo', defaultWidth: 480, defaultHeight: 480, invisibleAtRuntime: true, toolboxTooltip: 'SysInfo',
    defaultEvent: 'DisplayChanged', defaultMember: null, methods: [],
    props: [
      int('Left', 0), int('Top', 0), str('Tag'),
      rt('OSPlatform', 'int', 2, 'ro'), rt('OSVersion', 'string', '', 'ro'), rt('OSBuild', 'string', '', 'ro'), rt('ScrollBarSize', 'int', 240, 'ro'),
      rt('WorkAreaLeft', 'int', 0, 'ro'), rt('WorkAreaTop', 'int', 0, 'ro'), rt('WorkAreaWidth', 'int', 0, 'ro'), rt('WorkAreaHeight', 'int', 0, 'ro'),
      rt('ACStatus', 'int', 255, 'ro'), rt('BatteryFullTime', 'int', -1, 'ro'), rt('BatteryLifePercent', 'int', 255, 'ro'),
      rt('BatteryLifeTime', 'int', -1, 'ro'), rt('BatteryStatus', 'int', 255, 'ro'),
    ],
    events: [
      ev('ConfigChangeCancelled'), ev('ConfigChanged', 'ByVal OldConfigNum As Long, ByVal NewConfigNum As Long'),
      ev('DeviceArrival', 'ByVal DeviceType As Long, ByVal DeviceID As Long, ByVal DeviceName As String, ByVal DeviceData As Long'),
      ev('DeviceOtherEvent', 'ByVal DeviceType As Long, ByVal EventName As String, ByVal DataPointer As Long'),
      ev('DeviceQueryRemove', 'ByVal DeviceType As Long, ByVal DeviceID As Long, ByVal DeviceName As String, ByVal DeviceData As Long, Cancel As Boolean'),
      ev('DeviceQueryRemoveFailed', 'ByVal DeviceType As Long, ByVal DeviceID As Long, ByVal DeviceName As String, ByVal DeviceData As Long'),
      ev('DeviceRemoveComplete', 'ByVal DeviceType As Long, ByVal DeviceID As Long, ByVal DeviceName As String, ByVal DeviceData As Long'),
      ev('DeviceRemovePending', 'ByVal DeviceType As Long, ByVal DeviceID As Long, ByVal DeviceName As String, ByVal DeviceData As Long'),
      ev('DevModeChanged'), ev('DisplayChanged'), ev('PowerQuerySuspend', 'Cancel As Boolean'), ev('PowerResume'), ev('PowerStatusChanged'),
      ev('PowerSuspend'), ev('QueryChangeConfig', 'Cancel As Boolean'), ev('SettingChanged', 'ByVal Item As Integer'), ev('SysColorsChanged'), ev('TimeChanged'),
    ],
  }),

  // The Data control (intrinsic, DAO): the arrow bar |< < Caption > >|. DatabaseName is a SQLite file (.db), relative to App.Path;
  // RecordSource a table name or a SELECT. Recordset and Database are objects at run time (run/data/). The controls whose
  // DataSource names it show the current record.
  Data: def({
    type: 'Data', namePrefix: 'Data', defaultWidth: 1935, defaultHeight: 345, toolboxTooltip: 'Data',
    defaultEvent: 'Validate', defaultMember: 'Caption',
    props: [
      int('Left', 0), int('Top', 0), int('Width', 0), int('Height', 0), bool('Visible', true), bool('Enabled', true), str('Tag'), str('ToolTipText'),
      str('Caption'), str('DatabaseName'), str('RecordSource'), str('Connect', 'Access'),
      en('RecordsetType', 1, ['Table', 'Dynaset', 'Snapshot']), bool('ReadOnly', false), bool('Exclusive', false), int('Options', 0),
      en('BOFAction', 0, ['Move First', 'BOF']), en('EOFAction', 0, ['Move Last', 'EOF', 'Add New']),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), font(),
      rt('Recordset', 'string', '', 'ro'), rt('Database', 'string', '', 'ro'), rt('EditMode', 'int', 0, 'ro'),
    ],
    events: [ev('Validate', 'Action As Integer, Save As Integer'), ev('Reposition'), ev('Error', 'DataErr As Integer, Response As Integer'), ...evMouse()],
    methods: [
      { name: 'Move', params: MOVE }, { name: 'Refresh', params: '' }, { name: 'ZOrder', params: '[Position]' },
      { name: 'UpdateControls', params: '' }, { name: 'UpdateRecord', params: '' },
    ],
  }),

  // MSADODC.OCX. The same arrow bar; ConnectionString is "Provider=...;Data Source=file.db" (the Data Source is a SQLite file, relative
  // to App.Path). Recordset is an ADO recordset (ActiveConnection.Execute runs SQL).
  Adodc: def({
    type: 'Adodc', component: 'MSADODC.OCX', namePrefix: 'Adodc', defaultWidth: 2400, defaultHeight: 330, toolboxTooltip: 'Adodc',
    defaultEvent: 'WillMove', defaultMember: null,
    props: [
      int('Left', 0), int('Top', 0), int('Width', 0), int('Height', 0), bool('Visible', true), bool('Enabled', true), str('Tag'), str('ToolTipText'),
      str('Caption'), str('ConnectionString'), str('RecordSource'),
      p('CommandType', 'enum', 8, { enumValues: [[1, 'adCmdText'], [2, 'adCmdTable'], [4, 'adCmdStoredProc'], [8, 'adCmdUnknown']].map(([value, l]) => ({ value: value as number, label: `${value} - ${l}` })) }),
      en('BOFAction', 0, ['adDoMoveFirst', 'adStayBOF']), en('EOFAction', 0, ['adDoMoveLast', 'adStayEOF', 'adDoAddNew']),
      p('CursorLocation', 'enum', 3, { enumValues: [{ value: 2, label: '2 - adUseServer' }, { value: 3, label: '3 - adUseClient' }] }),
      en('CursorType', 3, ['adOpenForwardOnly', 'adOpenKeyset', 'adOpenDynamic', 'adOpenStatic']),
      p('LockType', 'enum', 3, { enumValues: [[1, 'adLockReadOnly'], [2, 'adLockPessimistic'], [3, 'adLockOptimistic'], [4, 'adLockBatchOptimistic']].map(([value, l]) => ({ value: value as number, label: `${value} - ${l}` })) }),
      int('MaxRecords', 0, { min: 0 }), int('CommandTimeout', 30, { min: 0 }), int('ConnectionTimeout', 15, { min: 0 }),
      str('UserName'), str('Password'),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), font(),
      rt('Recordset', 'string', '', 'ro'),
    ],
    events: [
      ev('WillMove', 'ByVal adReason As ADODB.EventReasonEnum, adStatus As ADODB.EventStatusEnum, ByVal pRecordset As ADODB.Recordset'),
      ev('MoveComplete', 'ByVal adReason As ADODB.EventReasonEnum, ByVal pError As ADODB.Error, adStatus As ADODB.EventStatusEnum, ByVal pRecordset As ADODB.Recordset'),
      ev('Error', 'ByVal ErrorNumber As Long, Description As String, ByVal Scode As Long, ByVal Source As String, ByVal HelpFile As String, ByVal HelpContext As Long, fCancelDisplay As Boolean'),
      ...evMouse(),
    ],
    methods: [{ name: 'Move', params: MOVE }, { name: 'Refresh', params: '' }, { name: 'ZOrder', params: '[Position]' }],
  }),

  // MSDATGRD.OCX. The records of the DataSource (a Data control or Adodc) with column headers and a record selector column; the
  // current row is the recordset's current record. Columns(i) (0-based) has Caption, Width, DataField, Visible, Alignment, Locked,
  // NumberFormat and Value. GridCols / GridRows / GridRow / GridCol / GridEdit are what the window shows (run/data/dataGrid.ts).
  DataGrid: def({
    type: 'DataGrid', component: 'MSDATGRD.OCX', namePrefix: 'DataGrid', defaultWidth: 4815, defaultHeight: 2415, toolboxTooltip: 'DataGrid',
    defaultEvent: 'Click', defaultMember: null,
    props: [
      ...common(), font(), str('DataSource'), str('Caption'),
      bool('AllowUpdate', true), bool('AllowAddNew', false), bool('AllowDelete', false),
      bool('ColumnHeaders', true), bool('RecordSelectors', true), int('HeadLines', 1, { min: 0, max: 10 }), int('DefColWidth', 0, { min: 0 }),
      en('BorderStyle', 1, ['dbgNoBorder', 'dbgFixedSingle']), color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT),
      rt('Row', 'int', 0), rt('Col', 'int', 0), rt('Text', 'string', ''), rt('Columns', 'string', '', 'ro'), rt('Bookmark', 'int', 0, 'ro'),
      rt('ApproxCount', 'int', 0, 'ro'), rt('VisibleRows', 'int', 0, 'ro'), rt('VisibleCols', 'int', 0, 'ro'),
      p('GridCols', 'list', [], { designTime: false, runtime: 'none' }), p('GridRows', 'list', [], { designTime: false, runtime: 'none' }),
      p('GridRow', 'int', -1, { designTime: false, runtime: 'none' }), p('GridCol', 'int', 0, { designTime: false, runtime: 'none' }),
      p('GridEdit', 'string', '', { designTime: false, runtime: 'none' }),
    ],
    events: [
      ev('RowColChange', 'LastRow As Variant, ByVal LastCol As Integer'), ev('AfterColUpdate', 'ByVal ColIndex As Integer'),
      ev('BeforeColUpdate', 'ByVal ColIndex As Integer, OldValue As Variant, Cancel As Integer'), ev('BeforeUpdate', 'Cancel As Integer'), ev('AfterUpdate'),
      ev('AfterInsert'), ev('BeforeDelete', 'Cancel As Integer'), ev('AfterDelete'), ev('HeadClick', 'ByVal ColIndex As Integer'),
      ev('Error', 'ByVal DataError As Integer, Response As Integer'), evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse(),
    ],
    methods: [...baseMethods(), { name: 'ReBind', params: '' }],
  }),

  // MSDATLST.OCX. The list is the ListField of the RowSource's records; BoundText is the BoundColumn of the chosen one (the ListField
  // when BoundColumn is empty). DataSource / DataField bind BoundText to a field. List / ListIndex are what the window shows.
  DataList: def({
    type: 'DataList', component: 'MSDATLST.OCX', namePrefix: 'DataList', defaultWidth: 1935, defaultHeight: 1425, toolboxTooltip: 'DataList',
    defaultEvent: 'Click', defaultMember: 'BoundText',
    props: [
      ...common(), font(), color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT),
      str('RowSource'), str('ListField'), str('BoundColumn'), str('DataSource'), str('DataField'),
      en('MatchEntry', 0, ['dblBasicMatching', 'dblExtendedMatching']), bool('Locked', false),
      rt('BoundText', 'string', ''), rt('Text', 'string', ''), rt('SelectedItem', 'string', '', 'ro'), rt('MatchedWithList', 'bool', false, 'ro'),
      rt('VisibleCount', 'int', 0, 'ro'), rt('DataChanged', 'bool', false),
      p('List', 'list', [], { designTime: false, runtime: 'none' }), p('ListIndex', 'int', -1, { designTime: false, runtime: 'none' }),
    ],
    events: [ev('Click', 'Area As Integer'), ev('DblClick', 'Area As Integer'), ...evFocus(), ...evKeys(), ...evMouse()],
    methods: [...baseMethods(), { name: 'ReFill', params: '' }],
  }),

  DataCombo: def({
    type: 'DataCombo', component: 'MSDATLST.OCX', namePrefix: 'DataCombo', defaultWidth: 1935, defaultHeight: 315, toolboxTooltip: 'DataCombo',
    defaultEvent: 'Click', defaultMember: 'Text',
    props: [
      ...common(), font(), color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), txt('Text'),
      en('Style', 0, ['dbcDropdownCombo', 'dbcSimpleCombo', 'dbcDropdownList'], { runtime: 'ro' }),
      str('RowSource'), str('ListField'), str('BoundColumn'), str('DataSource'), str('DataField'),
      en('MatchEntry', 0, ['dblBasicMatching', 'dblExtendedMatching']), bool('Locked', false),
      rt('BoundText', 'string', ''), rt('SelectedItem', 'string', '', 'ro'), rt('MatchedWithList', 'bool', false, 'ro'),
      rt('VisibleCount', 'int', 0, 'ro'), rt('DataChanged', 'bool', false),
      p('List', 'list', [], { designTime: false, runtime: 'none' }), p('ListIndex', 'int', -1, { designTime: false, runtime: 'none' }),
    ],
    events: [evChange(), ev('Click', 'Area As Integer'), ev('DblClick', 'Area As Integer'), ...evFocus(), ...evKeys(), ...evMouse()],
    methods: [...baseMethods(), { name: 'ReFill', params: '' }],
  }),

  // THREED32.OCX (Sheridan 3D Controls). All six draw Win98 bevels (model/sheridan.ts); Font3D is a one-pixel light / dark text shadow.
  // SSPanel is a container like Frame. FloodType / FloodPercent fill the panel like a progress bar (FloodShowPct writes the percentage).
  SSPanel: def({
    type: 'SSPanel', component: 'THREED32.OCX', namePrefix: 'SSPanel', defaultWidth: 1815, defaultHeight: 855, isContainer: true,
    toolboxTooltip: 'SSPanel', defaultEvent: 'Click', defaultMember: 'Caption',
    props: [
      ...common(), str('Caption'), en('Alignment', 7, SS_ALIGNMENTS),
      en('BevelOuter', 2, SS_BEVELS), en('BevelInner', 0, SS_BEVELS), int('BevelWidth', 1, { min: 1, max: 10 }), int('BorderWidth', 0, { min: 0, max: 30 }),
      en('Font3D', 0, SS_FONT3D),
      en('FloodType', 0, ['None', 'Left to Right', 'Right to Left', 'Top to Bottom', 'Bottom to Top', 'Widening Circle']),
      int('FloodPercent', 0, { min: 0, max: 100 }), color('FloodColor', 0x800000), bool('FloodShowPct', true),
      en('AutoSize', 0, ['None', 'Width To Caption', 'Height To Caption']), bool('RoundedCorners', true), bool('Outline', false),
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT), font(),
    ],
    events: [evClick(), evDbl(), ...evMouse()],
  }),

  SSCommand: def({
    type: 'SSCommand', component: 'THREED32.OCX', namePrefix: 'SSCommand', defaultWidth: 1215, defaultHeight: 495, toolboxTooltip: 'SSCommand',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(), str('Caption'), picture(), en('AutoSize', 0, ['None', 'Adjust Picture To Button', 'Adjust Button To Picture']),
      int('BevelWidth', 2, { min: 1, max: 10 }), en('Font3D', 0, SS_FONT3D), bool('Outline', false), bool('RoundedCorners', true),
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT), font(), rt('Value', 'bool', false),
    ],
    events: [evClick(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  SSCheck: def({
    type: 'SSCheck', component: 'THREED32.OCX', namePrefix: 'SSCheck', defaultWidth: 1215, defaultHeight: 255, toolboxTooltip: 'SSCheck',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(), str('Caption'), bool('Value', false), en('Alignment', 0, ['Left Justify', 'Right Justify']), en('Font3D', 0, SS_FONT3D),
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT), font(),
    ],
    events: [ev('Click', 'Value As Integer'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  SSOption: def({
    type: 'SSOption', component: 'THREED32.OCX', namePrefix: 'SSOption', defaultWidth: 1215, defaultHeight: 255, toolboxTooltip: 'SSOption',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(), str('Caption'), bool('Value', false), en('Alignment', 0, ['Left Justify', 'Right Justify']), en('Font3D', 0, SS_FONT3D),
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT), font(),
    ],
    events: [ev('Click', 'Value As Integer'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  SSFrame: def({
    type: 'SSFrame', component: 'THREED32.OCX', namePrefix: 'SSFrame', defaultWidth: 1815, defaultHeight: 1335, isContainer: true,
    toolboxTooltip: 'SSFrame', defaultEvent: 'Click', defaultMember: 'Caption',
    props: [
      ...common(), str('Caption'), en('Alignment', 0, ['Left Justify', 'Right Justify', 'Center']), en('ShadowStyle', 0, ['Inset', 'Raised']),
      en('Font3D', 0, SS_FONT3D), color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT), font(),
    ],
    events: [evClick(), evDbl(), ...evMouse()],
  }),

  // A toggle button: Value is True while it is down. Ribbons of one container with the same GroupNumber (above 0) work like option
  // buttons; GroupAllowAllUp lets a click on the one that is down release it.
  SSRibbon: def({
    type: 'SSRibbon', component: 'THREED32.OCX', namePrefix: 'SSRibbon', defaultWidth: 495, defaultHeight: 495, toolboxTooltip: 'SSRibbon',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(), str('Caption'), bool('Value', false), int('GroupNumber', 0, { min: 0, max: 32767 }), bool('GroupAllowAllUp', true),
      picture('PictureUp'), picture('PictureDn'), int('BevelWidth', 1, { min: 1, max: 10 }), en('Font3D', 0, SS_FONT3D),
      bool('Outline', false), bool('RoundedCorners', true),
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT), font(),
    ],
    events: [ev('Click', 'Value As Integer'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // MSCHRT20.OCX. A table of RowCount x ColumnCount numbers: a column is a series, a row a data point (as MSChart's default). Row and Column
  // (from 1) pick the cell that Data, RowLabel and ColumnLabel work on; ChartData takes a 2-D array whose first row / column may be labels.
  // ChartLines is the data as the window gets it (see model/chart.ts); AxisTitles holds the Plot.Axis(id).AxisTitle.Text of the four axes.
  MSChart: def({
    type: 'MSChart', component: 'MSCHRT20.OCX', namePrefix: 'MSChart', defaultWidth: 3615, defaultHeight: 2415, toolboxTooltip: 'MSChart',
    defaultEvent: 'PointSelected', defaultMember: null,
    props: [
      ...common(),
      p('chartType', 'enum', 1, { enumValues: CHART_TYPE_NAMES.map(([value, l]) => ({ value, label: `${value} - ${l}` })) }),
      int('RowCount', 5, { min: 1, max: 4096 }), int('ColumnCount', 4, { min: 1, max: 256 }),
      int('Row', 1, { designTime: false, min: 1 }), int('Column', 1, { designTime: false, min: 1 }),
      bool('ShowLegend', true), str('TitleText'), bool('Stacking', false), bool('AllowSelections', true),
      rt('Data', 'int', 0), rt('RowLabel', 'string', ''), rt('ColumnLabel', 'string', ''), rt('ChartData', 'string', ''),
      rt('Plot', 'string', '', 'ro'),
      p('ChartLines', 'list', [], { designTime: false, runtime: 'none' }),
      p('AxisTitles', 'list', [], { designTime: false, runtime: 'none' }),
    ],
    events: [ev('PointSelected', 'Series As Integer, DataPoint As Integer, MouseFlags As Integer, Cancel As Integer'), evClick(), evDbl(), ...evMouse()],
  }),
  // MCI32.OCX. The row of buttons Prev Next Play Pause Back Step Stop Record Eject. Command = "Open" / "Play" ... drives the device; the file is
  // read by the backend and played by an HTML media element in the form window, while the run session keeps Mode and Position by its own clock
  // (see run/objects/mediaControls.ts). Mode, Position, Length, From and To are in milliseconds (TimeFormat mciFormatMilliseconds; Hms and Msf
  // are packed as in MCI). MediaSrc and MediaCmd are what the window gets.
  MMControl: def({
    type: 'MMControl', component: 'MCI32.OCX', namePrefix: 'MMControl', defaultWidth: 3540, defaultHeight: 330, toolboxTooltip: 'MMControl',
    defaultEvent: 'Done', defaultMember: null,
    props: [
      ...common(),
      bool('AutoEnable', true), en('BorderStyle', 1, ['mciBorderNone', 'mciFixedSingle']),
      str('DeviceType'), str('FileName'),
      en('Orientation', 0, ['mciOrientHorz', 'mciOrientVert']), en('RecordMode', 0, ['mciRecordInsert', 'mciRecordOverwrite']),
      bool('Shareable', false), bool('Silent', false), int('UpdateInterval', 1000, { min: 0, max: 65535 }), int('Frames', 1, { designTime: false, min: 0 }),
      ...MCI_BUTTONS.map(b => bool(`${b}Enabled`, false)), ...MCI_BUTTONS.map(b => bool(`${b}Visible`, true)),
      rt('Command', 'string', ''), rt('Mode', 'int', 524, 'ro'), rt('Position', 'int', 0, 'ro'), rt('Length', 'int', 0, 'ro'), rt('Start', 'int', 0, 'ro'),
      rt('From', 'int', 0), rt('To', 'int', 0), rt('Wait', 'bool', false), rt('Notify', 'bool', false), rt('TimeFormat', 'int', 0),
      rt('Error', 'int', 0, 'ro'), rt('ErrorMessage', 'string', '', 'ro'), rt('NotifyValue', 'int', 0, 'ro'), rt('DeviceID', 'int', 0, 'ro'),
      rt('CanPlay', 'bool', false, 'ro'), rt('CanEject', 'bool', false, 'ro'), rt('CanRecord', 'bool', false, 'ro'), rt('CanStep', 'bool', false, 'ro'),
      rt('Tracks', 'int', 0, 'ro'), rt('Track', 'int', 1), rt('TrackLength', 'int', 0, 'ro'), rt('TrackPosition', 'int', 0, 'ro'), rt('UsesWindows', 'bool', false, 'ro'),
      p('MediaSrc', 'string', '', { designTime: false, runtime: 'none' }), p('MediaCmd', 'string', '', { designTime: false, runtime: 'none' }),
    ],
    events: [
      ...MCI_BUTTONS.flatMap(b => [ev(`${b}Click`, 'Cancel As Integer'), ev(`${b}Completed`, 'Errorcode As Long')]),
      ev('Done', 'NotifyCode As Integer'), ev('StatusUpdate'),
    ],
  }),

  // MSDXM.OCX (Windows Media Player 6.4): a display area (video) with the play/pause/stop buttons, a seek bar and a status line.
  // CurrentPosition and Duration are seconds (Double); Volume is hundredths of a dB (-10000 silent .. 0 loudest).
  MediaPlayer: def({
    type: 'MediaPlayer', component: 'MSDXM.OCX', namePrefix: 'MediaPlayer', defaultWidth: 4200, defaultHeight: 3240, toolboxTooltip: 'MediaPlayer',
    defaultEvent: 'PlayStateChange', defaultMember: null,
    props: [
      ...common(),
      str('FileName'), bool('AutoStart', true), bool('AutoRewind', true), int('PlayCount', 1, { min: 0 }),
      bool('ShowControls', true), bool('ShowPositionControls', true), bool('ShowTracker', true), bool('ShowStatusBar', false),
      int('Volume', -600, { min: -10000, max: 0 }), bool('Mute', false),
      rt('CurrentPosition', 'int', 0), rt('Duration', 'int', 0, 'ro'), rt('PlayState', 'int', 0, 'ro'), rt('ReadyState', 'int', 0, 'ro'),
      p('MediaSrc', 'string', '', { designTime: false, runtime: 'none' }), p('MediaCmd', 'string', '', { designTime: false, runtime: 'none' }),
    ],
    events: [
      ev('PlayStateChange', 'ByVal OldState As Long, ByVal NewState As Long'), ev('EndOfStream', 'ByVal Result As Long'),
      ev('PositionChange', 'ByVal oldPosition As Double, ByVal newPosition As Double'),
    ],
    methods: [...baseMethods(), { name: 'Play', params: '' }, { name: 'Pause', params: '' }, { name: 'Stop', params: '' }, { name: 'Open', params: 'bstrFileName As String' }],
  }),

  // AGENTCTL.DLL (Microsoft Agent 2.0). Invisible: code loads characters (Characters.Load "Robby" or "Wizard", original pixel figures drawn
  // in controls/agentArt.ts) that float over the form. Their Show / Hide / Speak / Play / MoveTo / GestureAt requests queue per character
  // (run/objects/agentControl.ts). AgentChars is what the window draws: one JSON line per loaded character.
  Agent: def({
    type: 'Agent', component: 'AGENTCTL.DLL', namePrefix: 'Agent', defaultWidth: 480, defaultHeight: 480, invisibleAtRuntime: true, toolboxTooltip: 'Agent',
    defaultEvent: 'Click', defaultMember: null, methods: [],
    props: [
      int('Left', 0), int('Top', 0), str('Tag'), bool('RaiseRequestErrors', true),
      rt('Characters', 'string', '', 'ro'), rt('Connected', 'bool', true),
      p('AgentChars', 'list', [], { designTime: false, runtime: 'none' }),
    ],
    events: [
      ev('Click', AGENT_MOUSE), ev('DblClick', AGENT_MOUSE), ev('DragStart', AGENT_MOUSE), ev('DragComplete', AGENT_MOUSE),
      ev('RequestStart', 'ByVal Request As Object'), ev('RequestComplete', 'ByVal Request As Object'),
      ev('Show', 'ByVal CharacterID As String, ByVal Cause As Integer'), ev('Hide', 'ByVal CharacterID As String, ByVal Cause As Integer'),
      ev('Move', 'ByVal CharacterID As String, ByVal x As Integer, ByVal y As Integer, ByVal Cause As Integer'),
      ev('BalloonShow', 'ByVal CharacterID As String'), ev('BalloonHide', 'ByVal CharacterID As String'),
    ],
  }),

  // MSCAL.OCX (Calendar Control 8.0, the Access calendar): a grid of the days of one month. Value is an OLE serial; Day, Month and Year are parts of
  // it. DayLength / MonthLength: 1 short, 2 medium, 3 long names. FirstDay 1 (Sunday) ... 7 (the default is the system's). GridCellEffect: 0 flat,
  // 1 raised, 2 sunken. BeforeUpdate(Cancel) comes before every change of Value (user or code), then AfterUpdate; NewMonth / NewYear when the
  // month / year of Value changed.
  Calendar: def({
    type: 'Calendar', component: 'MSCAL.OCX', namePrefix: 'Calendar', defaultWidth: 4800, defaultHeight: 3600, toolboxTooltip: 'Calendar',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(),
      p('Value', 'date', nowSerial(true)),
      p('DayLength', 'enum', 2, { enumValues: ['Short', 'Medium', 'Long'].map((l, i) => ({ value: i + 1, label: `${i + 1} - ${l}` })) }),
      p('MonthLength', 'enum', 3, { enumValues: ['Short', 'Medium', 'Long'].map((l, i) => ({ value: i + 1, label: `${i + 1} - ${l}` })) }),
      p('FirstDay', 'enum', systemStartOfWeek(Intl.DateTimeFormat().resolvedOptions().locale), {
        enumValues: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((l, i) => ({ value: i + 1, label: `${i + 1} - ${l}` })) }),
      en('GridCellEffect', 1, ['Flat', 'Raised', 'Sunken']),
      bool('ShowDateSelectors', true), bool('ShowDays', true), bool('ShowHorizontalGrid', true), bool('ShowTitle', true), bool('ShowVerticalGrid', true),
      color('BackColor', WIN_BG), color('ForeColor', WIN_TEXT), color('GridLinesColor', sys(0x80000010)),
      color('DayFontColor', WIN_TEXT), color('TitleFontColor', WIN_TEXT),
      p('TitleFont', 'font', { ...DEFAULT_FONT, bold: true }), p('DayFont', 'font', DEFAULT_FONT), p('GridFont', 'font', DEFAULT_FONT),
      rt('Day', 'int', 0), rt('Month', 'int', 0), rt('Year', 'int', 0),
    ],
    events: [
      evClick(), evDbl(), ev('AfterUpdate'), ev('BeforeUpdate', 'Cancel As Integer'), ev('NewMonth'), ev('NewYear'), ...evFocus(), ...evKeys(),
    ],
    methods: [...baseMethods(), ...['Next', 'Previous'].flatMap(d => ['Day', 'Week', 'Month', 'Year'].map(u => ({ name: `${d}${u}`, params: '' }))),
      { name: 'Today', params: '' }],
  }),
};

/** VB6 toolbox order: every control type. The Toolbox shows the intrinsic ones, then the checked components' ones
 *  (components.ts toolboxTools), each in this order. */
export const TOOLBOX_ORDER: (ControlType | 'Pointer')[] = [
  'Pointer', 'PictureBox', 'Label', 'TextBox', 'Frame', 'CommandButton', 'CheckBox', 'OptionButton',
  'ComboBox', 'ListBox', 'HScrollBar', 'VScrollBar', 'Timer', 'DriveListBox', 'DirListBox', 'FileListBox', 'Shape', 'Line', 'Image', 'Data', 'ProgressBar', 'Slider', 'UpDown', 'StatusBar', 'TabStrip', 'Toolbar',
  'TreeView', 'ListView', 'ImageList', 'ImageCombo', 'CoolBar', 'MSFlexGrid', 'CommonDialog', 'RichTextBox', 'SSTab', 'DTPicker', 'MonthView', 'FlatScrollBar', 'Animation', 'MaskedEdit', 'Calendar',
  'WebBrowser', 'Inet', 'Winsock', 'MSComm', 'SysInfo', 'MSChart', 'MMControl', 'MediaPlayer', 'Agent', 'Adodc', 'DataGrid', 'DataList', 'DataCombo',
  'SSPanel', 'SSCommand', 'SSCheck', 'SSOption', 'SSFrame', 'SSRibbon',
];

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const PROP_INDEX: Record<string, Map<string, PropDef>> = {};
for (const t of Object.values(CONTROL_TYPES)) {
  const m = new Map<string, PropDef>();
  for (const pd of t.props) m.set(pd.name.toLowerCase(), pd);
  PROP_INDEX[t.type] = m;
}

/** Case-insensitive property lookup. */
export function getPropDef(type: ControlType, name: string): PropDef | undefined {
  return PROP_INDEX[type]?.get(name.toLowerCase());
}

/** "Command1", "Command2", ...: the lowest number not used by any control name on the form (case-insensitive,
 *  so every member of a control array, which shares one name, counts as used). */
export function nextDefaultName(form: FormDef, type: ControlType): string {
  const prefix = CONTROL_TYPES[type].namePrefix;
  const used = new Set(form.controls.map(c => c.name.toLowerCase()));
  let n = 1;
  while (used.has(`${prefix}${n}`.toLowerCase())) n++;
  return `${prefix}${n}`;
}

const clonePropValue = (v: PropValue): PropValue =>
  Array.isArray(v) ? v.slice() : v !== null && typeof v === 'object' ? { ...v } : v;

/** Design-time props of `type` at their default values (run-time-only props are left out; arrays/objects are fresh copies). */
function defaultProps(type: ControlType): Record<string, PropValue> {
  const props: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES[type].props) if (pd.designTime) props[pd.name] = clonePropValue(pd.default);
  return props;
}

export function newId(): string { return crypto.randomUUID(); }

/** Creates (does not add) a control with default properties. Left/Top are relative to the parent, in twips.
 *  Timer ignores width/height (fixed size, no Width/Height props). TabIndex continues after the form's existing controls. */
export function newControl(form: FormDef, type: Exclude<ControlType, 'Form'>,
  rect: { left: number; top: number; width?: number; height?: number }, parentId: string | null): ControlDef {
  const td = CONTROL_TYPES[type];
  const name = nextDefaultName(form, type);
  const props = defaultProps(type);
  if (type === 'Line') {
    props.X1 = rect.left; props.Y1 = rect.top;
    props.X2 = rect.left + (rect.width ?? td.defaultWidth); props.Y2 = rect.top + (rect.height ?? td.defaultHeight);
  } else { props.Left = rect.left; props.Top = rect.top; }
  if ('Width' in props) {
    props.Width = rect.width ?? td.defaultWidth;
    props.Height = rect.height ?? td.defaultHeight;
  }
  if ('Caption' in props && type !== 'SSTab') props.Caption = name;   // an SSTab's Caption is its first tab's
  if (type === 'TextBox' || type === 'ComboBox' || type === 'DataCombo' || type === 'ImageCombo') props.Text = name;
  if ('TabIndex' in props) props.TabIndex = form.controls.filter(c => 'TabIndex' in c.props).length;
  return { id: newId(), type, name, index: null, parentId, props };
}

/** VB identifier: letter first, then letters/digits/underscore, at most 40 chars, not a keyword. */
export function validateName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) && !KEYWORDS.has(name.toLowerCase());
}

/** A blank form with default properties; Caption = name (VB6). */
export function newForm(name: string, code = ''): FormDef {
  const props = defaultProps('Form');
  props.Caption = name;
  return { id: newId(), name, props, controls: [], code };
}

export function newProject(): Project {
  return {
    name: 'Project1', title: '', startupForm: 'Form1',
    forms: [newForm('Form1')],
    modules: [], assets: {}, iconAsset: null, components: [],
  };
}
