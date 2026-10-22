// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

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


const flush = async () => { for (let i = 0; i < 10; i++) await tick(); };
const click = async (el: Element) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); await flush(); };

describe('TreeView', () => {
  test('Nodes.Add with the relationships, navigation, Expanded, Remove takes the children along, errors', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  Dim n As MSComctlLib.Node',
      '  Set n = TreeView1.Nodes.Add(, , "root", "Root")',
      '  TreeView1.Nodes.Add "root", tvwChild, "a", "A"',
      '  TreeView1.Nodes.Add "root", tvwChild, "b", "B"',
      '  TreeView1.Nodes.Add "a", tvwChild, "a1", "A1"',
      '  TreeView1.Nodes.Add "a", tvwPrevious, "z", "Z"',
      '  TreeView1.Nodes.Add n, tvwFirst, "f", "First"',
      '  Debug.Print n.Children; n.Child.Key; n.Child.Next.Key; n.Child.Next.Next.Key; n.Child.Next.Next.Parent.Key; TreeView1.Nodes.Count',
      '  Debug.Print TreeView1.Nodes("a").Index; TreeView1.Nodes(1).Text; TreeView1.Nodes("a").Children; TreeView1.Nodes("b").Next Is Nothing',
      '  TreeView1.Nodes("root").Expanded = True',
      '  TreeView1.Nodes.Remove "a"',
      '  Debug.Print TreeView1.Nodes.Count; TreeView1.Nodes("root").Children',
      '  On Error Resume Next',
      '  TreeView1.Nodes.Add "nope", tvwChild',
      '  Debug.Print Err.Number: Err.Clear',
      '  TreeView1.Nodes.Add , , "ROOT"',
      '  Debug.Print Err.Number',
      'End Sub', '',
    ].join('\n'), [['TreeView', 'TreeView1']]);
    expect(r.out[0]).toBe(' 3 zabroot 6 ');
    expect(r.out[1]).toBe(' 2 Root 1 True');
    expect(r.out[2]).toBe(' 4  2 ');
    expect(r.out[3]).toBe(' 35600 ');
    expect(r.out[4]).toBe(' 35602 ');
    const rows = [...r.el('TreeView1').querySelectorAll('.tv-row')].map(x => x.textContent!);
    expect(rows).toEqual(['First', '-Root', 'Z', 'B']);
  });
  test('NodeClick gets the Node, +/- toggles and raises Expand / Collapse', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  TreeView1.Nodes.Add , , "r", "Root"',
      '  TreeView1.Nodes.Add "r", tvwChild, "c1", "Child 1"',
      '  TreeView1.Nodes.Add "c1", tvwChild, "g", "Grand"',
      'End Sub',
      'Private Sub TreeView1_NodeClick(ByVal Node As MSComctlLib.Node)',
      '  Label1.Caption = Node.Key & Node.Children & TreeView1.SelectedItem.Key',
      'End Sub',
      'Private Sub TreeView1_Expand(ByVal Node As MSComctlLib.Node)', '  Debug.Print "expand "; Node.Key; Node.Expanded', 'End Sub',
      'Private Sub TreeView1_Collapse(ByVal Node As Node)', '  Debug.Print "collapse "; Node.Key; Node.Expanded', 'End Sub', '',
    ].join('\n'), [['TreeView', 'TreeView1'], ['Label', 'Label1']]);
    const rows = () => [...r.el('TreeView1').querySelectorAll<HTMLElement>('.tv-row')];
    const texts = () => rows().map(x => x.querySelector('.tv-text')!.textContent);
    expect(texts()).toEqual(['Root']);   // collapsed
    await click(rows()[0].querySelector('.tv-tog')!);
    expect(texts()).toEqual(['Root', 'Child 1']);
    expect(r.out).toEqual(['expand rTrue']);
    await click(rows()[1].querySelector('.tv-text')!);
    expect(r.el('Label1').textContent).toBe('c11c1');
    expect(rows()[1].querySelector('.sel')).not.toBeNull();
    await click(rows()[0].querySelector('.tv-tog')!);
    expect(r.out[1]).toBe('collapse rFalse');
    expect(rows().length).toBe(1);
  });
});

describe('ListView', () => {
  test('Report view: column headers, SubItems, ColumnClick, ItemClick, Sorted', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  ListView1.View = lvwReport',
      '  ListView1.ColumnHeaders.Add , "n", "Name", 1500',
      '  ListView1.ColumnHeaders.Add , "s", "Size", 900, lvwColumnRight',
      '  Dim it As ListItem',
      '  Set it = ListView1.ListItems.Add(, "k2", "pear")',
      '  it.SubItems(1) = "20"',
      '  Set it = ListView1.ListItems.Add(, "k1", "apple")',
      '  it.SubItems(1) = "10"',
      '  Debug.Print ListView1.ListItems.Count; ListView1.ListItems("k2").SubItems(1); ListView1.ListItems(2).Index; ListView1.ColumnHeaders(2).Text',
      'End Sub',
      'Private Sub ListView1_ColumnClick(ByVal ColumnHeader As MSComctlLib.ColumnHeader)',
      '  ListView1.SortKey = ColumnHeader.Index - 1',
      '  ListView1.Sorted = True',
      '  Debug.Print "col "; ColumnHeader.Text; ColumnHeader.Index',
      'End Sub',
      'Private Sub ListView1_ItemClick(ByVal Item As MSComctlLib.ListItem)',
      '  Label1.Caption = Item.Key & Item.SubItems(1) & ListView1.SelectedItem.Text',
      'End Sub', '',
    ].join('\n'), [['ListView', 'ListView1'], ['Label', 'Label1']]);
    expect(r.out[0]).toBe(' 2 20 2 Size');
    const el = r.el('ListView1');
    expect([...el.querySelectorAll('.lv-hcol')].map(x => x.textContent)).toEqual(['Name', 'Size']);
    const cells = () => [...el.querySelectorAll('.lv-row')].map(x => x.textContent);
    expect(cells()).toEqual(['pear20', 'apple10']);
    await click(el.querySelectorAll('.lv-hcol')[0]);
    expect(r.out[1]).toBe('col Name 1 ');
    expect(cells()).toEqual(['apple10', 'pear20']);
    await click(el.querySelectorAll('.lv-row')[0]);
    expect(r.el('Label1').textContent).toBe('k110apple');
  });
});

describe('MSFlexGrid', () => {
  test('TextMatrix reads and writes, Text follows Row and Col, ColWidth, Rows grows the grid, bad index is 381', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  MSFlexGrid1.Rows = 3: MSFlexGrid1.Cols = 3',
      '  MSFlexGrid1.TextMatrix(0, 1) = "Name"',
      '  MSFlexGrid1.TextMatrix(1, 1) = "Ann"',
      '  MSFlexGrid1.Row = 2: MSFlexGrid1.Col = 2',
      '  MSFlexGrid1.Text = "x"',
      '  MSFlexGrid1.ColWidth(1) = 2000',
      '  Debug.Print MSFlexGrid1.TextMatrix(1, 1); MSFlexGrid1.TextMatrix(2, 2); MSFlexGrid1.Text; MSFlexGrid1.ColWidth(1); MSFlexGrid1.ColWidth(0); MSFlexGrid1.Rows',
      '  MSFlexGrid1.Rows = 4',
      '  Debug.Print MSFlexGrid1.TextMatrix(1, 1); MSFlexGrid1.TextMatrix(3, 1) & "|"',
      '  On Error Resume Next',
      '  Debug.Print MSFlexGrid1.TextMatrix(9, 1)',
      '  Debug.Print Err.Number',
      'End Sub', '',
    ].join('\n'), [['MSFlexGrid', 'MSFlexGrid1']]);
    expect(r.out[0]).toBe('Annxx 2000  975  3 ');
    expect(r.out[1]).toBe('Ann|');
    expect(r.out).toHaveLength(3);
    expect(r.out[2]).toBe(' 381 ');
    const td = [...r.el('MSFlexGrid1').querySelectorAll<HTMLElement>('td')];
    expect(td.length).toBe(12);
    expect(td[1].textContent).toBe('Name'); expect(td[1].classList.contains('fixed')).toBe(true);
    expect(td[3].classList.contains('fixed')).toBe(true);   // first column is fixed
    expect(td[4].textContent).toBe('Ann'); expect(td[4].classList.contains('fixed')).toBe(false);
    expect(r.el('MSFlexGrid1').querySelectorAll('col')[1].style.width).toBe('133px');
  });
  test('a click in a cell sets Row and Col and raises RowColChange once', async () => {
    const r = await run([
      'Private Sub Form_Load()', '  MSFlexGrid1.Cols = 3: MSFlexGrid1.Rows = 3: MSFlexGrid1.TextMatrix(2, 2) = "hit"', 'End Sub',
      'Private Sub MSFlexGrid1_RowColChange()', '  Debug.Print "rc"; MSFlexGrid1.Row; MSFlexGrid1.Col; MSFlexGrid1.Text', 'End Sub',
      'Private Sub MSFlexGrid1_Click()', '  Debug.Print "click"', 'End Sub', '',
    ].join('\n'), [['MSFlexGrid', 'MSFlexGrid1']]);
    const td = () => [...r.el('MSFlexGrid1').querySelectorAll<HTMLElement>('td')];
    await click(td()[0]);   // fixed corner: nothing changes
    expect(r.out).toEqual(['click']);
    r.out.length = 0;
    await click(td()[8]);
    expect(r.out).toEqual(['rc 2  2 hit', 'click']);
    expect(td()[8].classList.contains('sel')).toBe(true);
    r.out.length = 0;
    await click(td()[8]);   // same cell: no RowColChange
    expect(r.out).toEqual(['click']);
  });
});

test('design time: ColumnHeaders lines seed the ListView, constants have the VB6 values', async () => {
  const r = await run([
    'Private Sub Form_Load()',
    '  Debug.Print ListView1.ColumnHeaders.Count; ListView1.ColumnHeaders("b").Width; ListView1.View; tvwChild; lvwReport; lvwDescending; flexAlignCenterCenter; flexAlignGeneral; flexSelectionByRow',
    'End Sub', '',
  ].join('\n'), [['ListView', 'ListView1', { ColumnHeaders: ['A|a|900', 'B|b|1200|1'] }]]);
  expect(r.out[0]).toBe(' 2  1200  0  4  3  1  4  9  1 ');
  expect(r.el('ListView1').classList.contains('vb-ListView')).toBe(true);
});
