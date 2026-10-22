// Control registry: every control type with its design-time/run-time properties, events, methods and defaults,
// plus the helpers that create controls and projects. Used by the designer, Properties window, code window,
// run session and AI context.

import { KEYWORDS } from '../lang/tokens';
import type { ControlDef, ControlType, FontValue, FormDef, PropValue, Project } from './types';

export type PropKind = 'string' | 'text' | 'int' | 'bool' | 'color' | 'enum' | 'font' | 'picture' | 'list';
export interface PropDef { name: string; kind: PropKind; default: PropValue; enumValues?: { value: number; label: string }[];
  designTime: boolean; runtime: 'rw' | 'ro' | 'none'; min?: number; max?: number }
export interface EventDef { name: string; params: string }          // e.g. { name: 'KeyPress', params: 'KeyAscii As Integer' }
export interface MethodDef { name: string; params: string }
export interface ControlTypeDef { type: ControlType; namePrefix: string; defaultWidth: number; defaultHeight: number;
  props: PropDef[]; events: EventDef[]; methods: MethodDef[]; defaultEvent: string; defaultMember: string | null;
  isContainer: boolean; invisibleAtRuntime: boolean; toolboxTooltip: string }

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
      en('BorderStyle', 0, ['None', 'Fixed Single']), bool('WordWrap', false), font(),
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
      rt('SelStart', 'int', 0), rt('SelLength', 'int', 0), rt('SelText', 'string', ''),
    ],
    events: [evChange(), evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  CheckBox: def({
    type: 'CheckBox', namePrefix: 'Check', defaultWidth: 1215, defaultHeight: 495, toolboxTooltip: 'CheckBox',
    defaultEvent: 'Click', defaultMember: 'Value',
    props: [
      ...common(), str('Caption'), en('Value', 0, ['Unchecked', 'Checked', 'Grayed']),
      en('Alignment', 0, ['Left Justify', 'Right Justify'], { runtime: 'ro' }),
      color('BackColor', BTN_FACE), color('ForeColor', BTN_TEXT), font(),
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
      rt('Selected', 'bool', false), rt('NewIndex', 'int', -1, 'ro'),
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
      rt('ListIndex', 'int', -1), rt('ListCount', 'int', 0, 'ro'), rt('NewIndex', 'int', -1, 'ro'),
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
    type: 'ProgressBar', namePrefix: 'ProgressBar', defaultWidth: 1935, defaultHeight: 255, toolboxTooltip: 'ProgressBar',
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
    type: 'Slider', namePrefix: 'Slider', defaultWidth: 2055, defaultHeight: 495, toolboxTooltip: 'Slider',
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
    type: 'UpDown', namePrefix: 'UpDown', defaultWidth: 255, defaultHeight: 495, toolboxTooltip: 'UpDown',
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
    type: 'StatusBar', namePrefix: 'StatusBar', defaultWidth: 4800, defaultHeight: 315, toolboxTooltip: 'StatusBar',
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
    type: 'TabStrip', namePrefix: 'TabStrip', defaultWidth: 3600, defaultHeight: 2400, toolboxTooltip: 'TabStrip',
    defaultEvent: 'Click', defaultMember: null,
    props: [
      ...common(), font(),
      p('Tabs', 'list', ['Tab 1'], { runtime: 'ro' }),
      rt('SelectedItem', 'string', ''),
      p('SelectedTab', 'int', 1, { designTime: false, runtime: 'none' }),   // 1-based index of the selected tab (window state)
    ],
    events: [evClick(), evDbl(), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // Nodes / ListItems are run-time only; ColumnHeaders are lines 'Text|Key|Width|Alignment'. SelectedNode / SelectedIndex are window state.
  TreeView: def({
    type: 'TreeView', namePrefix: 'TreeView', defaultWidth: 2400, defaultHeight: 2400, toolboxTooltip: 'TreeView',
    defaultEvent: 'NodeClick', defaultMember: null,
    props: [
      ...common(), font(),
      en('LineStyle', 0, ['tvwTreeLines', 'tvwRootLines']), int('Indentation', 285, { min: 0 }),
      p('Nodes', 'list', [], { designTime: false, runtime: 'ro' }),
      rt('SelectedItem', 'string', ''),
      p('SelectedNode', 'int', 0, { designTime: false, runtime: 'none' }),
    ],
    events: [evClick(), evDbl(), ev('NodeClick', 'ByVal Node As MSComctlLib.Node'), ev('Expand', 'ByVal Node As MSComctlLib.Node'),
      ev('Collapse', 'ByVal Node As MSComctlLib.Node'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  ListView: def({
    type: 'ListView', namePrefix: 'ListView', defaultWidth: 3600, defaultHeight: 2400, toolboxTooltip: 'ListView',
    defaultEvent: 'ItemClick', defaultMember: null,
    props: [
      ...common(), font(),
      en('View', 0, ['lvwIcon', 'lvwSmallIcon', 'lvwList', 'lvwReport']),
      bool('FullRowSelect', false), bool('GridLines', false), bool('Sorted', false),
      int('SortKey', 0, { min: 0 }), en('SortOrder', 0, ['lvwAscending', 'lvwDescending']),
      p('ColumnHeaders', 'list', [], { runtime: 'ro' }),
      p('ListItems', 'list', [], { designTime: false, runtime: 'ro' }),
      rt('SelectedItem', 'string', ''),
      p('SelectedIndex', 'int', 0, { designTime: false, runtime: 'none' }),
    ],
    events: [evClick(), evDbl(), ev('ItemClick', 'ByVal Item As MSComctlLib.ListItem'),
      ev('ColumnClick', 'ByVal ColumnHeader As MSComctlLib.ColumnHeader'), ...evFocus(), ...evKeys(), ...evMouse()],
  }),

  // The cells live in the run-time mirror (TextMatrix), not in the properties.
  MSFlexGrid: def({
    type: 'MSFlexGrid', namePrefix: 'MSFlexGrid', defaultWidth: 3600, defaultHeight: 2400, toolboxTooltip: 'MSFlexGrid',
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
};

/** VB6 toolbox order. */
export const TOOLBOX_ORDER: (ControlType | 'Pointer')[] = [
  'Pointer', 'PictureBox', 'Label', 'TextBox', 'Frame', 'CommandButton', 'CheckBox', 'OptionButton',
  'ComboBox', 'ListBox', 'HScrollBar', 'VScrollBar', 'Timer', 'Shape', 'Line', 'Image', 'ProgressBar', 'Slider', 'UpDown', 'StatusBar', 'TabStrip',
  'TreeView', 'ListView', 'MSFlexGrid',
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
  if ('Caption' in props) props.Caption = name;
  if (type === 'TextBox' || type === 'ComboBox') props.Text = name;
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
    modules: [], assets: {}, iconAsset: null,
  };
}
