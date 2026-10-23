// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { Empty, Nothing } from '../../src/lang/values';
import type { ControlDef, ControlType, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { CollectionObject, ItemObject, optString, optPosition } from '../../src/run/objects/collectionObject';
import { ControlObject, type RunContext } from '../../src/run/objects/controlObject';
import { PatchQueue } from '../../src/run/patchQueue';
import type { ToWindow } from '../../src/run/protocol';
import { RunSession } from '../../src/run/session';

const err = (n: number) => expect.objectContaining({ number: n });
const thing = (Key: string, Text = ''): ItemObject => new ItemObject('Thing', 'Text', [{ name: 'Text', kind: 'string' }, { name: 'Key', kind: 'string' }], { Key, Text });
const make = () => {
  const log: string[] = [];
  const col = new CollectionObject<ItemObject>('Things', a => ({ item: thing(optString(a[1]), optString(a[2])), at: optPosition(a[0]) }),
    (k, i, at) => log.push(`${k}:${i?.key ?? ''}@${at}`));
  return { col, log };
};
const U = undefined as never;

describe('CollectionObject', () => {
  test('Add, Item by index and key (case-insensitive), Count, default member Item', () => {
    const { col } = make();
    const a = col.callMethod('Add', [U, 'A', 'one']) as ItemObject;
    col.callMethod('Add', [U, 'B', 'two']);
    expect(col.getMember('Count', [])).toBe(2);
    expect(col.defaultMember).toBe('Item');
    expect(col.getMember('Item', [1])).toBe(a);
    expect(col.getMember('Item', ['b'])).toBe(col.getMember('Item', [2]));
    expect(a.getMember('Index', [])).toBe(1);
    expect(col.items().map(i => i.key)).toEqual(['A', 'B']);
  });
  test('35600 for unknown index or key, 35602 for a key that exists', () => {
    const { col } = make();
    col.callMethod('Add', [U, 'A']);
    for (const bad of [0, 2, 'zzz', '']) expect(() => col.getMember('Item', [bad])).toThrow(err(35600));
    expect(() => col.callMethod('Add', [U, 'a'])).toThrow(err(35602));
    expect(() => col.callMethod('Remove', ['nope'])).toThrow(err(35600));
    expect(col.count).toBe(1);
    col.callMethod('Add', [U, '']); col.callMethod('Add', [U, '']);   // empty keys may repeat
    expect(col.count).toBe(3);
  });
  test('Add at a position renumbers; Remove by index or key; Clear', () => {
    const { col, log } = make();
    col.callMethod('Add', [U, 'A']); col.callMethod('Add', [U, 'C']);
    col.callMethod('Add', [2, 'B']);
    expect(col.items().map(i => `${i.index}${i.key}`)).toEqual(['1A', '2B', '3C']);
    expect(() => col.callMethod('Add', [9, 'X'])).toThrow(err(35600));
    col.callMethod('Remove', ['b']);
    expect(col.items().map(i => `${i.index}${i.key}`)).toEqual(['1A', '2C']);
    col.callMethod('Remove', [1]);
    expect(col.items().map(i => i.key)).toEqual(['C']);
    expect(col.callMethod('Clear', [])).toBe(Empty);
    expect(col.count).toBe(0);
    expect(log).toEqual(['add:A@1', 'add:C@2', 'add:B@2', 'remove:B@2', 'remove:A@1', 'clear:@0']);
  });
  test('item fields: default member, change notification, duplicate Key is 35602, Index read-only', () => {
    const { col, log } = make();
    const a = col.callMethod('Add', [U, 'A', 'x']) as ItemObject;
    col.callMethod('Add', [U, 'B']);
    a.setMember('Text', [], 'y');
    expect(a.getMember(a.defaultMember, [])).toBe('y');
    expect(log.at(-1)).toBe('item:A@1');
    expect(() => a.setMember('Key', [], 'b')).toThrow(err(35602));
    expect(() => a.setMember('Index', [], 5)).toThrow(err(383));
    expect(() => a.getMember('Nope', [])).toThrow(err(438));
  });
});

// --- Panels and Tabs through the ControlObject ---

function fakeQueue() {
  const sent: [string, ToWindow][] = [];
  return Object.assign(new PatchQueue((k, m) => { sent.push([k, m]); }), { sent });
}
const ctx = (): RunContext => ({ resolveAsset: () => null, loadPicture: async () => Nothing, timerChanged: () => {} });
let n = 0;
function ctl(type: Exclude<ControlType, 'Form'>, q: PatchQueue, props: Record<string, PropValue> = {}, c = ctx()) {
  const def: ControlDef = { id: `id${++n}`, type, name: `${type}1`, index: null, parentId: null, props };
  return new ControlObject(def, 'f1', q, c);
}
const panelsOf = (c: ControlObject) => c.getMember('Panels', []) as CollectionObject<ItemObject>;

describe('StatusBar and TabStrip objects', () => {
  test('Panels are seeded from the design-time lines; setting a Panel property queues a patch', () => {
    const q = fakeQueue();
    const sb = ctl('StatusBar', q, { Panels: ['Ready|main|0|0', 'Line 1|pos|1440|2'] });
    const p = sb.getMember('Panels', [2]) as ItemObject;
    expect(p.getMember('Text', [])).toBe('Line 1');
    expect(p.getMember('Width', [])).toBe(1440);
    expect(p.getMember('Alignment', [])).toBe(2);
    expect((sb.getMember('Panels', ['MAIN']) as ItemObject).getMember('Index', [])).toBe(1);
    (sb.getMember('Panels', [1]) as ItemObject).setMember('Text', [], 'x'); q.flush();
    expect(q.sent).toEqual([['f1', { t: 'patch', id: sb.def.id, props: { Panels: ['x|main', 'Line 1|pos|1440|2'] } }]]);
    expect(() => sb.setMember('Panels', [], 1)).toThrow(err(383));
    expect(() => sb.getMember('Panels', [3])).toThrow(err(35600));
  });
  test('Panels.Add / Remove / Clear patch the lines; a design-time default panel exists', () => {
    const q = fakeQueue();
    const sb = ctl('StatusBar', q, {});
    expect(panelsOf(sb).count).toBe(1);
    const added = panelsOf(sb).callMethod('Add', [U, 'k', 'a|b']) as ItemObject;
    added.setMember('Alignment', [], 1); q.flush();
    expect((q.sent.at(-1)![1] as { props: Record<string, PropValue> }).props.Panels).toEqual(['', 'a\\|b|k||1']);
    panelsOf(sb).callMethod('Remove', [1]); panelsOf(sb).callMethod('Clear', []); q.flush();
    expect(sb.props.Panels).toEqual([]);
  });
  test('PanelClick gets the Panel object', () => {
    const sb = ctl('StatusBar', fakeQueue(), { Panels: ['a', 'b'] });
    expect(sb.eventArgs('PanelClick', [2])).toEqual([panelsOf(sb).get(2)]);
    expect(sb.eventArgs('PanelClick', [9])).toEqual([Nothing]);
    expect(sb.eventArgs('Click', [])).toEqual([]);
  });
  test('TabStrip: SelectedItem, Selected, Tabs.Add keeps the selection, Remove moves it', () => {
    const q = fakeQueue();
    const ts = ctl('TabStrip', q, { Tabs: ['One|a', 'Two|b', 'Three'] });
    const tabs = ts.getMember('Tabs', []) as CollectionObject<ItemObject>;
    expect((ts.getMember('SelectedItem', []) as ItemObject).getMember('Caption', [])).toBe('One');
    const two = tabs.get('b');
    two.setMember('Selected', [], true);
    expect(ts.getMember('SelectedItem', [])).toBe(two);
    expect(two.getMember('Selected', [])).toBe(true);
    expect(tabs.get(1).getMember('Selected', [])).toBe(false);
    tabs.callMethod('Add', [1, 'z', 'Zero']);                 // before the selected tab: it stays selected
    expect(ts.getMember('SelectedItem', [])).toBe(two);
    expect(two.getMember('Index', [])).toBe(3);
    tabs.callMethod('Remove', ['z']);
    expect(two.getMember('Index', [])).toBe(2);
    ts.setMember('SelectedItem', [], tabs.get(3));
    expect(ts.props.SelectedTab).toBe(3);
    expect(() => ts.setMember('SelectedItem', [], thing('q'))).toThrow(err(5));
    tabs.callMethod('Clear', []);
    expect(ts.getMember('SelectedItem', [])).toBe(Nothing);
  });
});

// --- a whole program ---

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = () => new Promise(r => setTimeout(r, 0));

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][]): Promise<{ p: Project; out: string[]; el(name: string): HTMLElement }> {
  const p = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  for (const [type, name, props] of controls) {
    const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    p.forms[0].controls.push(c);
  }
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  for (let i = 0; i < 20; i++) await tick();
  const el = (name: string) => container.querySelector<HTMLElement>(`[data-control-id="${p.forms[0].controls.find(c => c.name === name)!.id}"]`)!;
  return { p, out, el };
}

describe('StatusBar and TabStrip in a running program', () => {
  test('Panels from code, PanelClick(Panel), For Each, constants', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  StatusBar1.Panels(1).Text = "Hi"',
      '  StatusBar1.Panels.Add , "pos", "Ln 1"',
      '  StatusBar1.Panels("pos").Alignment = sbrRight',
      '  Dim p As Panel, s As String',
      '  For Each p In StatusBar1.Panels',
      '    s = s & p.Index & p.Text & ";"',
      '  Next',
      '  Debug.Print s; StatusBar1.Panels.Count; sbrSimple; sbrCenter',
      '  On Error Resume Next',
      '  StatusBar1.Panels.Add , "POS", "dup"',
      '  Debug.Print Err.Number; Err.Description',
      '  Err.Clear',
      '  Debug.Print StatusBar1.Panels(7).Text',
      '  Debug.Print Err.Number',
      'End Sub',
      'Private Sub StatusBar1_PanelClick(ByVal Panel As Panel)',
      '  Label1.Caption = Panel.Text & Panel.Key',
      'End Sub', '',
    ].join('\n'), [['StatusBar', 'StatusBar1', { Panels: [''] }], ['Label', 'Label1']]);
    expect(r.out[0]).toBe('1Hi;2Ln 1; 2  1  1 ');
    expect(r.out[1]).toBe(' 35602 Key is not unique in collection');
    expect(r.out[2]).toBe(' 35600 ');
    const panels = r.el('StatusBar1').querySelectorAll<HTMLElement>('.stb-panel');
    expect([...panels].map(p => p.textContent)).toEqual(['Hi', 'Ln 1']);
    expect(panels[1].style.textAlign).toBe('right');
    panels[1].dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    for (let i = 0; i < 10; i++) await tick();
    expect(r.el('Label1').textContent).toBe('Ln 1pos');
  });

  test('clicking the second tab sets SelectedItem.Index to 2 and raises Click', async () => {
    const r = await run([
      'Private Sub TabStrip1_Click()',
      '  Label1.Caption = TabStrip1.SelectedItem.Index & TabStrip1.SelectedItem.Caption',
      'End Sub',
      'Private Sub Form_Load()',
      '  Debug.Print TabStrip1.SelectedItem.Index; TabStrip1.Tabs.Count',
      '  TabStrip1.Tabs.Add , "c", "Third"',
      'End Sub', '',
    ].join('\n'), [['TabStrip', 'TabStrip1', { Tabs: ['First|a', 'Second|b'] }], ['Label', 'Label1']]);
    expect(r.out[0]).toBe(' 1  2 ');
    const tabs = r.el('TabStrip1').querySelectorAll<HTMLElement>('.ts-tab');
    expect([...tabs].map(t => t.textContent)).toEqual(['First', 'Second', 'Third']);
    tabs[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    for (let i = 0; i < 10; i++) await tick();
    expect(r.el('Label1').textContent).toBe('2Second');
    expect(tabs[1].classList.contains('selected')).toBe(true);
  });

  test('setting SelectedItem from code selects the tab and raises Click', async () => {
    const r = await run([
      'Private Sub TabStrip1_Click()', '  Debug.Print "click"; TabStrip1.SelectedItem.Key', 'End Sub',
      'Private Sub Form_Load()', '  Set TabStrip1.SelectedItem = TabStrip1.Tabs("b")', 'End Sub', '',
    ].join('\n'), [['TabStrip', 'TabStrip1', { Tabs: ['First|a', 'Second|b'] }]]);
    expect(r.out).toEqual(['clickb']);
    expect(r.el('TabStrip1').querySelectorAll('.ts-tab')[1].classList.contains('selected')).toBe(true);
  });
});
