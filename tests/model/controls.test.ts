import { CONTROL_TYPES, TOOLBOX_ORDER, getPropDef, nextDefaultName, newControl, validateName, newProject, newId } from '../../src/model/controls';
import type { ControlType, FormDef } from '../../src/model/types';

test('default names increment', () => { const p = newProject(); const f = p.forms[0];
  f.controls.push(newControl(f, 'CommandButton', { left: 0, top: 0 }, null));
  expect(nextDefaultName(f, 'CommandButton')).toBe('Command2'); });
test('new control defaults', () => { const f = newProject().forms[0]; const c = newControl(f, 'TextBox', { left: 120, top: 240 }, null);
  expect(c).toMatchObject({ name: 'Text1', index: null, props: { Text: 'Text1', Width: 1215, Height: 495, Left: 120, Top: 240 } }); });
test('new project', () => expect(newProject()).toMatchObject({ name: 'Project1', startupForm: 'Form1', forms: [{ name: 'Form1', props: { Caption: 'Form1', Width: 4800, Height: 3600 } }] }));
test('name validation', () => { expect(validateName('cmdOK')).toBe(true); expect(validateName('1abc')).toBe(false); expect(validateName('Dim')).toBe(false); expect(validateName('a'.repeat(41))).toBe(false); });
test('prop lookup case-insensitive', () => expect(getPropDef('TextBox', 'text')?.name).toBe('Text'));
test('every type has its default event', () => { for (const t of Object.values(CONTROL_TYPES)) {
  if (t.events.length) expect(t.events.map(e => e.name)).toContain(t.defaultEvent);
  else expect(t.defaultEvent).toBe('');   // Shape and Line have no events
} });

const ALL = Object.keys(CONTROL_TYPES) as ControlType[];
const NON_FORM = ALL.filter(t => t !== 'Form') as Exclude<ControlType, 'Form'>[];

test('registry has every ControlType keyed by its own type', () => {
  expect(ALL.sort()).toEqual(['CheckBox', 'ComboBox', 'CommandButton', 'Form', 'Frame', 'HScrollBar', 'Image', 'Label', 'ListBox', 'OptionButton', 'PictureBox', 'ProgressBar', 'TextBox', 'Timer', 'VScrollBar', 'Shape', 'Line', 'Slider', 'UpDown', 'StatusBar', 'TabStrip', 'TreeView', 'ListView', 'MSFlexGrid', 'CommonDialog', 'RichTextBox'].sort());
  for (const [k, d] of Object.entries(CONTROL_TYPES)) expect(d.type).toBe(k);
});

test('defaultMember is a property of the type or null', () => {
  for (const t of Object.values(CONTROL_TYPES)) {
    if (t.defaultMember !== null) expect(getPropDef(t.type, t.defaultMember)).toBeDefined();
  }
  expect(CONTROL_TYPES.Form.defaultMember).toBeNull();
  expect(CONTROL_TYPES.CommandButton.defaultMember).toBe('Value');
});

test('property names are unique (case-insensitive) per type and never Name/Index', () => {
  for (const t of Object.values(CONTROL_TYPES)) {
    const names = t.props.map(p => p.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('name');
    expect(names).not.toContain('index');
  }
});

test('event and method names are unique per type', () => {
  for (const t of Object.values(CONTROL_TYPES)) {
    const e = t.events.map(x => x.name); expect(new Set(e).size).toBe(e.length);
    const m = t.methods.map(x => x.name); expect(new Set(m).size).toBe(m.length);
  }
});

test('common properties on every type except Timer; Timer has exactly its five', () => {
  for (const t of NON_FORM.filter(x => x !== 'Timer' && x !== 'CommonDialog' && x !== 'Shape' && x !== 'Line' && x !== 'StatusBar')) {   // StatusBar: no TabIndex/TabStop (VB6)
    for (const p of ['Left', 'Top', 'Width', 'Height', 'Visible', 'Enabled', 'TabIndex', 'TabStop', 'Tag', 'ToolTipText'])
      expect(getPropDef(t, p), `${t}.${p}`).toBeDefined();
  }
  expect(CONTROL_TYPES.Timer.props.map(p => p.name).sort()).toEqual(['Enabled', 'Interval', 'Left', 'Tag', 'Top']);
  expect(CONTROL_TYPES.CommonDialog.props.map(p => p.name)).not.toContain('Width');   // invisible at run time, like the Timer
  for (const p of ['Left', 'Top', 'Width', 'Height', 'Visible', 'Enabled', 'Tag']) expect(getPropDef('Form', p), `Form.${p}`).toBeDefined();
});

test('defaults from the control table', () => {
  const d = CONTROL_TYPES;
  const size = (t: ControlType) => [d[t].namePrefix, d[t].defaultWidth, d[t].defaultHeight];
  expect(size('Form')).toEqual(['Form', 4800, 3600]);
  expect(size('CommandButton')).toEqual(['Command', 1215, 495]);
  expect(size('Label')).toEqual(['Label', 1215, 255]);
  expect(size('TextBox')).toEqual(['Text', 1215, 495]);
  expect(size('CheckBox')).toEqual(['Check', 1215, 495]);
  expect(size('OptionButton')).toEqual(['Option', 1215, 495]);
  expect(size('Frame')).toEqual(['Frame', 1815, 1335]);
  expect(size('ListBox')).toEqual(['List', 1215, 1035]);
  expect(size('ComboBox')).toEqual(['Combo', 1215, 315]);
  expect(size('PictureBox')).toEqual(['Picture', 1215, 1215]);
  expect(size('Image')).toEqual(['Image', 1215, 1215]);
  expect(size('Timer')).toEqual(['Timer', 420, 420]);
  expect(size('HScrollBar')).toEqual(['HScroll', 1215, 255]);
  expect(size('VScrollBar')).toEqual(['VScroll', 255, 1215]);
  expect(size('ProgressBar')).toEqual(['ProgressBar', 1935, 255]);
  expect([d.CommandButton.defaultEvent, d.TextBox.defaultEvent, d.Timer.defaultEvent, d.Form.defaultEvent, d.ComboBox.defaultEvent, d.HScrollBar.defaultEvent])
    .toEqual(['Click', 'Change', 'Timer', 'Load', 'Change', 'Change']);
  expect(getPropDef('Form', 'BackColor')?.default).toBe(0x8000000f | 0);
  expect(getPropDef('Form', 'ForeColor')?.default).toBe(0x80000012 | 0);
  expect(getPropDef('TextBox', 'BackColor')?.default).toBe(0x80000005 | 0);
  expect(getPropDef('TextBox', 'ForeColor')?.default).toBe(0x80000008 | 0);
  expect(getPropDef('Form', 'BorderStyle')?.default).toBe(2);
  expect(getPropDef('Form', 'StartUpPosition')?.default).toBe(3);
  expect(getPropDef('HScrollBar', 'Max')?.default).toBe(32767);
  expect(getPropDef('ProgressBar', 'Max')?.default).toBe(100);
  expect(getPropDef('ProgressBar', 'Appearance')?.default).toBe(1);
  expect(getPropDef('Timer', 'Enabled')?.default).toBe(true);
  expect(getPropDef('Timer', 'Interval')?.default).toBe(0);
  expect(getPropDef('ListBox', 'List')?.kind).toBe('list');
  expect(getPropDef('TextBox', 'Font')?.default).toEqual({ name: 'MS Sans Serif', size: 8, bold: false, italic: false, underline: false });
});

test('flags: containers, invisible at runtime, tooltips', () => {
  for (const t of ALL) {
    expect(CONTROL_TYPES[t].isContainer).toBe(t === 'Form' || t === 'Frame' || t === 'PictureBox');
    expect(CONTROL_TYPES[t].invisibleAtRuntime).toBe(t === 'Timer' || t === 'CommonDialog');
    expect(CONTROL_TYPES[t].toolboxTooltip.length).toBeGreaterThan(0);
  }
});

test('runtime-only props are not design-time; read-only props flagged', () => {
  for (const [t, n] of [['TextBox', 'SelStart'], ['TextBox', 'SelLength'], ['TextBox', 'SelText'], ['ListBox', 'ListIndex'], ['ListBox', 'ListCount'],
    ['ListBox', 'Text'], ['ListBox', 'Selected'], ['ListBox', 'NewIndex'], ['ComboBox', 'ListIndex'], ['ComboBox', 'ListCount'], ['ComboBox', 'NewIndex']] as const) {
    const p = getPropDef(t, n); expect(p, `${t}.${n}`).toBeDefined(); expect(p!.designTime).toBe(false); expect(p!.runtime).not.toBe('none');
  }
  expect(getPropDef('TextBox', 'SelStart')?.runtime).toBe('rw');
  expect(getPropDef('ListBox', 'ListCount')?.runtime).toBe('ro');
  expect(getPropDef('Form', 'Caption')?.designTime).toBe(true);
  expect(getPropDef('Form', 'Caption')?.runtime).toBe('rw');
});

test('enum props have enumValues containing their default', () => {
  for (const t of Object.values(CONTROL_TYPES)) for (const p of t.props) {
    if (p.kind === 'enum') { expect(p.enumValues?.length, `${t.type}.${p.name}`).toBeGreaterThan(0); expect(p.enumValues!.map(e => e.value)).toContain(p.default); }
  }
  expect(getPropDef('Form', 'BorderStyle')?.enumValues).toEqual([
    { value: 0, label: '0 - None' }, { value: 1, label: '1 - Fixed Single' }, { value: 2, label: '2 - Sizable' },
    { value: 3, label: '3 - Fixed Dialog' }, { value: 4, label: '4 - Fixed ToolWindow' }, { value: 5, label: '5 - Sizable ToolWindow' }]);
});

test('event signatures are exact VB6 strings', () => {
  const ev = (t: ControlType, n: string) => CONTROL_TYPES[t].events.find(e => e.name === n)?.params;
  expect(ev('TextBox', 'KeyPress')).toBe('KeyAscii As Integer');
  expect(ev('TextBox', 'KeyDown')).toBe('KeyCode As Integer, Shift As Integer');
  expect(ev('TextBox', 'KeyUp')).toBe('KeyCode As Integer, Shift As Integer');
  expect(ev('PictureBox', 'MouseDown')).toBe('Button As Integer, Shift As Integer, X As Single, Y As Single');
  expect(ev('PictureBox', 'MouseMove')).toBe('Button As Integer, Shift As Integer, X As Single, Y As Single');
  expect(ev('PictureBox', 'MouseUp')).toBe('Button As Integer, Shift As Integer, X As Single, Y As Single');
  expect(ev('Form', 'Unload')).toBe('Cancel As Integer');
  expect(ev('Form', 'QueryUnload')).toBe('Cancel As Integer, UnloadMode As Integer');
  for (const n of ['Load', 'Activate', 'Deactivate', 'Resize', 'Initialize', 'Click', 'DblClick']) expect(ev('Form', n)).toBe('');
  expect(ev('CommandButton', 'Click')).toBe('');
  expect(ev('TextBox', 'Change')).toBe('');
  expect(ev('Timer', 'Timer')).toBe('');
  expect(CONTROL_TYPES.Timer.events.map(e => e.name)).toEqual(['Timer']);
  expect(ev('HScrollBar', 'Scroll')).toBe('');
  expect(ev('ComboBox', 'DropDown')).toBe('');
});

test('event coverage per type', () => {
  const names = (t: ControlType) => CONTROL_TYPES[t].events.map(e => e.name);
  expect(names('CommandButton')).toEqual(expect.arrayContaining(['Click', 'GotFocus', 'LostFocus', 'KeyPress', 'KeyDown', 'KeyUp', 'MouseDown', 'MouseMove', 'MouseUp']));
  expect(names('TextBox')).toEqual(expect.arrayContaining(['Change', 'Click', 'DblClick', 'GotFocus', 'LostFocus', 'KeyPress']));
  expect(names('Frame')).toEqual(expect.arrayContaining(['Click', 'DblClick', 'MouseDown', 'MouseMove', 'MouseUp']));
  expect(names('ProgressBar')).toEqual(['Click', 'MouseDown', 'MouseMove', 'MouseUp']);
  expect(names('VScrollBar')).toEqual(expect.arrayContaining(['Change', 'Scroll']));
  expect(names('Form')).toEqual(expect.arrayContaining(['Load', 'Unload', 'QueryUnload', 'Activate', 'Deactivate', 'Resize', 'Initialize']));
});

test('methods', () => {
  const m = (t: ControlType, n: string) => CONTROL_TYPES[t].methods.find(x => x.name === n);
  for (const t of NON_FORM.filter(x => !['Timer', 'CommonDialog', 'Shape', 'Line'].includes(x))) for (const n of ['Move', 'SetFocus', 'Refresh', 'ZOrder']) expect(m(t, n), `${t}.${n}`).toBeDefined();
  expect(m('CommandButton', 'Move')?.params).toBe('Left As Single, [Top], [Width], [Height]');
  expect(m('CommandButton', 'ZOrder')?.params).toBe('[Position]');
  expect(m('ListBox', 'AddItem')?.params).toBe('Item As String, [Index]');
  expect(m('ComboBox', 'RemoveItem')?.params).toBe('Index As Integer');
  expect(m('ComboBox', 'Clear')).toBeDefined();
  expect(m('TextBox', 'AddItem')).toBeUndefined();
  expect(CONTROL_TYPES.Form.methods.map(x => x.name).sort()).toEqual(['Hide', 'Move', 'Refresh', 'Show']);
  expect(m('Form', 'Show')?.params).toBe('[Modal], [OwnerForm]');
});

test('toolbox order follows VB6', () => {
  expect(TOOLBOX_ORDER).toEqual(['Pointer', 'PictureBox', 'Label', 'TextBox', 'Frame', 'CommandButton', 'CheckBox', 'OptionButton',
    'ComboBox', 'ListBox', 'HScrollBar', 'VScrollBar', 'Timer', 'Shape', 'Line', 'Image', 'ProgressBar', 'Slider', 'UpDown', 'StatusBar', 'TabStrip', 'TreeView', 'ListView', 'MSFlexGrid', 'CommonDialog', 'RichTextBox']);
});

test('getPropDef is case-insensitive and returns undefined for unknown', () => {
  expect(getPropDef('Form', 'STARTUPPOSITION')?.name).toBe('StartUpPosition');
  expect(getPropDef('Form', 'nonexistent')).toBeUndefined();
  expect(getPropDef('Timer', 'Caption')).toBeUndefined();
});

test('nextDefaultName skips used numbers, including control-array members and gaps', () => {
  const f = newProject().forms[0];
  const mk = (name: string, index: number | null = null) => { const c = newControl(f, 'CommandButton', { left: 0, top: 0 }, null); c.name = name; c.index = index; f.controls.push(c); };
  expect(nextDefaultName(f, 'CommandButton')).toBe('Command1');
  mk('Command1'); mk('Command3');
  expect(nextDefaultName(f, 'CommandButton')).toBe('Command2');
  mk('Command2');
  expect(nextDefaultName(f, 'CommandButton')).toBe('Command4');
  mk('Command4', 0); mk('Command4', 1);               // control array
  expect(nextDefaultName(f, 'CommandButton')).toBe('Command5');
  mk('command5');                                       // VB names are case-insensitive
  expect(nextDefaultName(f, 'CommandButton')).toBe('Command6');
  expect(nextDefaultName(f, 'TextBox')).toBe('Text1');   // other prefix unaffected
});

test('nextDefaultName does not collide with the form name', () => {
  const f = newProject().forms[0];
  expect(nextDefaultName(f, 'Frame')).toBe('Frame1');
});

test('newControl inside a container records parentId; Left/Top as given', () => {
  const f = newProject().forms[0];
  const fr = newControl(f, 'Frame', { left: 600, top: 600, width: 2000, height: 1500 }, null);
  f.controls.push(fr);
  const b = newControl(f, 'CommandButton', { left: 120, top: 240 }, fr.id);
  expect(b.parentId).toBe(fr.id);
  expect(b.props.Left).toBe(120); expect(b.props.Top).toBe(240);
  expect(fr.props).toMatchObject({ Left: 600, Top: 600, Width: 2000, Height: 1500, Caption: 'Frame1' });
  expect(fr.parentId).toBeNull();
});

test('newControl: ids unique, props never contain Name/Index, runtime-only props omitted, lists/fonts not shared', () => {
  const f = newProject().forms[0];
  const a = newControl(f, 'ListBox', { left: 0, top: 0 }, null);
  const b = newControl(f, 'ListBox', { left: 0, top: 0 }, null);
  expect(a.id).not.toBe(b.id);
  for (const t of NON_FORM) { const c = newControl(f, t, { left: 0, top: 0 }, null); expect(c.props).not.toHaveProperty('Name'); expect(c.props).not.toHaveProperty('Index'); }
  expect(a.props).not.toHaveProperty('ListCount');
  expect(a.props.List).toEqual([]);
  (a.props.List as string[]).push('x');
  expect(b.props.List).toEqual([]);
  const t1 = newControl(f, 'Label', { left: 0, top: 0 }, null), t2 = newControl(f, 'Label', { left: 0, top: 0 }, null);
  expect(t1.props.Font).toEqual(t2.props.Font); expect(t1.props.Font).not.toBe(t2.props.Font);
  expect(newControl(f, 'Label', { left: 0, top: 0 }, null).props.Caption).toBe('Label1');
});

test('newControl uses rect width/height when given, otherwise defaults; Timer keeps fixed size', () => {
  const f = newProject().forms[0];
  expect(newControl(f, 'CommandButton', { left: 0, top: 0, width: 3000, height: 900 }, null).props).toMatchObject({ Width: 3000, Height: 900 });
  expect(newControl(f, 'CommandButton', { left: 0, top: 0 }, null).props).toMatchObject({ Width: 1215, Height: 495 });
  const t = newControl(f, 'Timer', { left: 10, top: 20, width: 999, height: 999 }, null);
  expect(t.props).toMatchObject({ Left: 10, Top: 20, Interval: 0, Enabled: true });
  expect(t.props).not.toHaveProperty('Width');
});

test('caption/text defaults to the control name for types that have them', () => {
  const f = newProject().forms[0];
  expect(newControl(f, 'CommandButton', { left: 0, top: 0 }, null).props.Caption).toBe('Command1');
  expect(newControl(f, 'CheckBox', { left: 0, top: 0 }, null).props.Caption).toBe('Check1');
  expect(newControl(f, 'OptionButton', { left: 0, top: 0 }, null).props.Caption).toBe('Option1');
  expect(newControl(f, 'ComboBox', { left: 0, top: 0 }, null).props.Text).toBe('Combo1');
  expect(newControl(f, 'PictureBox', { left: 0, top: 0 }, null).props).not.toHaveProperty('Caption');
});

test('name validation: more cases', () => {
  for (const ok of ['a', 'Form1', 'cmd_OK', 'A'.repeat(40)]) expect(validateName(ok), ok).toBe(true);
  for (const bad of ['', '_x', 'a b', 'a-b', 'æble', 'a'.repeat(41), 'If', 'END', 'string', 'Me', 'Nothing']) expect(validateName(bad), bad).toBe(false);
  expect(validateName('MsgBox')).toBe(true);   // built-in function, not a keyword
});

test('newProject shape', () => {
  const p = newProject();
  expect(p).toMatchObject({ name: 'Project1', title: '', startupForm: 'Form1', modules: [], assets: {}, iconAsset: null });
  expect(p.forms).toHaveLength(1);
  const f: FormDef = p.forms[0];
  expect(f.code).toBe(''); expect(f.controls).toEqual([]); expect(typeof f.id).toBe('string');
  expect(f.props).not.toHaveProperty('Name');
  expect(f.props).toMatchObject({ BackColor: 0x8000000f | 0, BorderStyle: 2, StartUpPosition: 3, ControlBox: true, WindowState: 0, KeyPreview: false, Picture: null, Icon: null });
  expect(newProject().forms[0].id).not.toBe(f.id);
});

test('newId looks like a UUID and is unique', () => {
  const a = newId(), b = newId();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
});

test('Shape, Line, Slider, UpDown: events, defaults, geometry', async () => {
  const names = (t: ControlType) => CONTROL_TYPES[t].events.map(e => e.name);
  expect(names('Shape')).toEqual([]); expect(names('Line')).toEqual([]);
  expect(CONTROL_TYPES.Slider.defaultEvent).toBe('Change'); expect(names('Slider')).toEqual(expect.arrayContaining(['Change', 'Scroll']));
  expect(CONTROL_TYPES.UpDown.defaultEvent).toBe('Change'); expect(names('UpDown')).toEqual(expect.arrayContaining(['Change', 'UpClick', 'DownClick']));
  expect(getPropDef('Shape', 'Shape')?.enumValues).toHaveLength(6);
  expect(getPropDef('Shape', 'FillStyle')?.enumValues).toHaveLength(8);
  expect(getPropDef('Shape', 'Enabled')).toBeUndefined();
  expect(getPropDef('Line', 'Left')).toBeUndefined();
  const f = newProject().forms[0];
  const line = newControl(f, 'Line', { left: 100, top: 200 }, null);
  expect(line).toMatchObject({ name: 'Line1', props: { X1: 100, Y1: 200, X2: 1315, Y2: 1415 } });
  expect(line.props).not.toHaveProperty('Left'); expect(line.props).not.toHaveProperty('TabIndex');
  expect(newControl(f, 'Shape', { left: 0, top: 0 }, null).props).toMatchObject({ Shape: 0, FillStyle: 1, BorderWidth: 1, Width: 1215 });
  // a project with the new controls survives a save and load
  const { serializeProject, parseProject } = await import('../../src/model/serialize');
  const p = newProject();
  for (const t of ['Shape', 'Line', 'Slider', 'UpDown'] as const) p.forms[0].controls.push(newControl(p.forms[0], t, { left: 0, top: 0 }, null));
  expect(parseProject(serializeProject(p)).forms[0].controls.map(c => c.type)).toEqual(['Shape', 'Line', 'Slider', 'UpDown']);
});

test('StatusBar and TabStrip: defaults, Panels/Tabs are list props that survive a save and load, no focus props on StatusBar', async () => {
  const { serializeProject, parseProject } = await import('../../src/model/serialize');
  const p = newProject();
  const sb = newControl(p.forms[0], 'StatusBar', { left: 0, top: 0 }, null), ts = newControl(p.forms[0], 'TabStrip', { left: 0, top: 0 }, null);
  expect(sb.name).toBe('StatusBar1'); expect(sb.props).toMatchObject({ Height: 315, Style: 0, Panels: [''] });
  expect(ts.props).toMatchObject({ Tabs: ['Tab 1'] });
  sb.props.Panels = ['Ready|main|0|0', 'a\\|b']; ts.props.Tabs = ['One|a', 'Two'];
  p.forms[0].controls.push(sb, ts);
  const back = parseProject(serializeProject(p)).forms[0].controls;
  expect(back[0].props.Panels).toEqual(['Ready|main|0|0', 'a\\|b']);
  expect(back[1].props.Tabs).toEqual(['One|a', 'Two']);
  expect(CONTROL_TYPES.StatusBar.events.map(e => e.name)).toEqual(expect.arrayContaining(['PanelClick', 'Click']));
  expect(CONTROL_TYPES.TabStrip.defaultEvent).toBe('Click');
  expect(getPropDef('StatusBar', 'TabIndex')).toBeUndefined();
});
