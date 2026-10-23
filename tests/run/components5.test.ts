// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { dateFrom } from '../../src/lang/values';
import { VBRuntimeError } from '../../src/lang/errors';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { frameDelays } from '../../src/model/animation';
import type { ControlType, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

const serial = (y: number, m: number, d: number) => dateFrom(y, m, d).serial;
const PIC_A = 'data:image/png;base64,QUFB';

/** A GIF of `n` frames of `cs` centiseconds each (the image data is not a real picture: only the block structure is read). */
function gif(n: number, cs: number): Uint8Array {
  const b = [...'GIF89a'].map(c => c.charCodeAt(0)).concat([1, 0, 1, 0, 0, 0, 0]);
  for (let i = 0; i < n; i++) b.push(0x21, 0xf9, 4, 0, cs, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0);
  b.push(0x3b);
  return new Uint8Array(b);
}

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][], wait = 0) {
  const p: Project = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  p.assets = { a1: { mime: 'image/png', dataBase64: 'QUFB' } };
  for (const [type, name, props] of controls) {
    const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    p.forms[0].controls.push(c);
  }
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async path => { if (/missing/.test(path)) throw new VBRuntimeError(53); if (/\.gif$/.test(path)) return gif(2, 3); throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  if (wait) await tick(wait);
  const el = (name: string) => container.querySelector<HTMLElement>(`[data-control-id="${p.forms[0].controls.find(c => c.name === name)!.id}"]`)!;
  return { out, el };
}

describe('Animation', () => {
  test('Open of an .avi raises 35752; a GIF opens, Play raises Start and, after Repeat passes, Stop', async () => {
    const r = await run([
      'Private Sub Animation1_Start()', '  Debug.Print "start"', 'End Sub',
      'Private Sub Animation1_Stop()', '  Debug.Print "stop"', 'End Sub',
      'Private Sub Form_Load()',
      '  On Error Resume Next',
      '  Animation1.Open "clip.avi"',
      '  Debug.Print CStr(Err.Number); ": "; Err.Description: Err.Clear',
      '  Animation1.Open "missing.gif"',
      '  Debug.Print CStr(Err.Number): Err.Clear',
      '  Animation1.Open "spin.gif"',
      '  Debug.Print CStr(Err.Number)',
      '  Animation1.Play 2',
      '  Debug.Print CStr(Err.Number)',
      'End Sub', '',
    ].join('\n'), [['Animation', 'Animation1']], 250);
    expect(r.out).toEqual(['35752: Unable to open AVI file', '53', '0', 'start', '0', 'stop']);
    const img = r.el('Animation1').querySelector<HTMLImageElement>('img.anim-pic')!;
    expect(img.getAttribute('src')).toMatch(/^(blob:|data:image\/gif)/);   // the window shows the file it was handed
  });

  test('frame delays of a GIF; Start and End frames that do not fit are 380; Close of a playing animation raises Stop', async () => {
    expect(frameDelays(gif(3, 5), 'image')).toEqual([50, 50, 50]);
    expect(frameDelays(gif(1, 0), 'image')).toEqual([100]);
    const r = await run([
      'Private Sub Animation1_Stop()', '  Debug.Print "stop"', 'End Sub',
      'Private Sub Form_Load()',
      '  On Error Resume Next',
      '  Animation1.Open "spin.gif"',
      '  Animation1.Play 1, 0, 5',
      '  Debug.Print CStr(Err.Number): Err.Clear',
      '  Animation1.Play 1, 1, 0',
      '  Debug.Print CStr(Err.Number): Err.Clear',
      '  Animation1.Play',
      '  Animation1.Close',
      '  Debug.Print CStr(Err.Number)',
      'End Sub', '',
    ].join('\n'), [['Animation', 'Animation1']]);
    expect(r.out).toEqual(['380', '380', 'stop', '0']);
    expect(r.el('Animation1').querySelector('img.anim-pic')!.getAttribute('src')).toBeNull();
  });
});

describe('ImageCombo', () => {
  test('ComboItems with images: Add(Index, Key, Text, Image, SelImage, Indentation), SelectedItem, Text, Click, and the list shows the pictures', async () => {
    const r = await run([
      'Private Sub ImageCombo1_Click()', '  Debug.Print "click "; ImageCombo1.SelectedItem.Key; " "; ImageCombo1.Text', 'End Sub',
      'Private Sub ImageCombo1_Change()', '  Debug.Print "change "; ImageCombo1.Text', 'End Sub',
      'Private Sub Form_Load()',
      '  Dim it As ComboItem',
      '  Set it = ImageCombo1.ComboItems.Add(, "one", "First", "pic", , 0)',
      '  ImageCombo1.ComboItems.Add , "two", "Second", 1, , 2',
      '  Debug.Print ImageCombo1.ComboItems.Count; it.Text; it.Index; it.Image; it.Indentation; ImageCombo1.ComboItems("two").Indentation',
      '  Set ImageCombo1.SelectedItem = ImageCombo1.ComboItems(2)',
      '  Debug.Print ImageCombo1.Text; ImageCombo1.ComboItems(2).Selected; ImageCombo1.ComboItems(1).Selected',
      '  ImageCombo1.Text = "x"',
      '  Debug.Print TypeName(ImageCombo1.SelectedItem)',
      '  On Error Resume Next',
      '  ImageCombo1.ComboItems.Add , "one", "Dup"',
      '  Debug.Print Err.Number: Err.Clear',
      '  Debug.Print ImageCombo1.ComboItems(9).Text',
      '  Debug.Print Err.Number',
      'End Sub', '',
    ].join('\n'), [['ImageList', 'ImageList1', { ListImages: ['pic|a1'] }], ['ImageCombo', 'ImageCombo1', { ImageList: 'ImageList1', ComboItems: ['Zero|zero|pic'] }]]);
    expect(r.out).toEqual([' 3 First 2 pic 0  2 ', 'FirstTrueFalse', 'change x', 'Nothing', ' 35602 ', ' 35600 ']);
    // the drop-down list: a row per item, each with its picture of the ImageList, indented by Indentation
    const rows = [...r.el('ImageCombo1').querySelectorAll<HTMLElement>('.icb-row')];
    expect(rows.map(x => x.textContent)).toEqual(['Zero', 'First', 'Second']);
    expect(rows.map(x => x.querySelector('img')?.getAttribute('src') ?? null)).toEqual([PIC_A, PIC_A, PIC_A]);   // 'pic', 'pic', and image 1 is the same picture
    expect(rows[2].style.paddingLeft).toBe('22px');
  });
});

describe('the user\'s part', () => {
  test('a pick in the ImageCombo list raises Change and Click with the item; an arrow of the FlatScrollBar raises Scroll and Change, but not a disabled arrow', async () => {
    const r = await run([
      'Private Sub ImageCombo1_Change()', '  Debug.Print "change "; ImageCombo1.Text', 'End Sub',
      'Private Sub ImageCombo1_Click()', '  Debug.Print "click "; ImageCombo1.SelectedItem.Key', 'End Sub',
      'Private Sub ImageCombo1_Dropdown()', '  Debug.Print "dropdown"', 'End Sub',
      'Private Sub FlatScrollBar1_Scroll()', '  Debug.Print "scroll "; CStr(FlatScrollBar1.Value)', 'End Sub',
      'Private Sub FlatScrollBar1_Change()', '  Debug.Print "fchange "; CStr(FlatScrollBar1.Value)', 'End Sub',
      'Private Sub Form_Load()', '  Debug.Print "ready"', 'End Sub', '',
    ].join('\n'), [
      ['ImageCombo', 'ImageCombo1', { ComboItems: ['One|a', 'Two|b'] }],
      ['FlatScrollBar', 'FlatScrollBar1', { Max: 10 }],
      ['FlatScrollBar', 'FlatScrollBar2', { Max: 10, Arrows: 1 }],
    ]);
    const combo = r.el('ImageCombo1');
    combo.querySelector('.vb-combo-btn')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    combo.querySelectorAll('.vb-item')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await settle();
    expect(r.out.slice(1)).toEqual(['dropdown', 'change Two', 'click b']);
    const press = (name: string, sel: string) => {
      r.el(name).querySelector(sel)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    press('FlatScrollBar2', '.vb-sb-btn.inc');   // Arrows = fsbLeftUp: only the left / up arrow works
    await settle();
    expect(r.out.slice(4)).toEqual([]);
    press('FlatScrollBar1', '.vb-sb-btn.inc');
    await settle();
    expect(r.out.slice(4)).toEqual(['scroll 1', 'fchange 1']);
  });

  test('dragging the gripper of a band moves the edge to the band before it; the new widths come back as the Bands lines', async () => {
    const r = await run('Private Sub Form_Load()\n  Debug.Print CoolBar1.Bands(1).Width; CoolBar1.Bands(2).Width\nEnd Sub\n', [
      ['CoolBar', 'CoolBar1', { Bands: ['One|a|||||600|3000', 'Two|b|||||600|3000'] }],
    ]);
    expect(r.out).toEqual([' 3000  3000 ']);
    const bar = r.el('CoolBar1');
    const grip = bar.querySelectorAll<HTMLElement>('.cbr-band')[1].querySelector('.cbr-grip')!;
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 200 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 260 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await settle();
    expect(bar.querySelectorAll<HTMLElement>('.cbr-band')[0].style.width).toBe('260px');   // 200 px + 60 px
  });
});

describe('FlatScrollBar', () => {
  test('Value is clamped to Min .. Max and raises Change', async () => {
    const r = await run([
      'Private Sub FlatScrollBar1_Change()', '  Debug.Print "change "; CStr(FlatScrollBar1.Value)', 'End Sub',
      'Private Sub Form_Load()',
      '  FlatScrollBar1.Min = 10: FlatScrollBar1.Max = 50',
      '  FlatScrollBar1.Value = 80',
      '  Debug.Print CStr(FlatScrollBar1.Value)',
      '  FlatScrollBar1.Value = 0',
      '  Debug.Print CStr(FlatScrollBar1.Value); fsbFlat; cc2OrientationHorizontal',
      'End Sub', '',
    ].join('\n'), [['FlatScrollBar', 'FlatScrollBar1']]);
    expect(r.out).toEqual(['change 50', '50', 'change 10', '10 1  1 ']);
  });
});

describe('Calendar', () => {
  test('NextMonth raises BeforeUpdate, AfterUpdate and NewMonth; PreviousYear also NewYear; Cancel keeps the date', async () => {
    const r = await run([
      'Dim blocked As Boolean',
      'Private Sub Calendar1_BeforeUpdate(Cancel As Integer)', '  If blocked Then Cancel = True', '  Debug.Print "before "; Format(Calendar1.Value, "yyyy-mm-dd")', 'End Sub',
      'Private Sub Calendar1_AfterUpdate()', '  Debug.Print "after "; Format(Calendar1.Value, "yyyy-mm-dd")', 'End Sub',
      'Private Sub Calendar1_NewMonth()', '  Debug.Print "newmonth "; CStr(Calendar1.Month)', 'End Sub',
      'Private Sub Calendar1_NewYear()', '  Debug.Print "newyear "; CStr(Calendar1.Year)', 'End Sub',
      'Private Sub Form_Load()',
      '  Calendar1.Value = DateSerial(2026, 1, 31)',
      '  Calendar1.NextMonth',
      '  Calendar1.PreviousYear',
      '  Calendar1.NextDay',
      '  blocked = True',
      '  Calendar1.NextWeek',
      '  Debug.Print Format(Calendar1.Value, "yyyy-mm-dd"); Calendar1.Day',
      '  On Error Resume Next',
      '  Calendar1.Month = 13',
      '  Debug.Print CStr(Err.Number)',
      'End Sub', '',
    ].join('\n'), [['Calendar', 'Calendar1', { Value: serial(2026, 6, 15) }]]);
    expect(r.out).toEqual([
      'before 2026-06-15', 'after 2026-01-31', 'newmonth 1', 'before 2026-01-31', 'after 2026-02-28', 'newmonth 2',
      'before 2026-02-28', 'after 2025-02-28', 'newyear 2025', 'newmonth 2',
      'before 2025-02-28', 'after 2025-03-01', 'newmonth 3', 'before 2025-03-01', '2025-03-01 1 ', '380',
    ]);
  });

  test('a click on a day is the user\'s update: BeforeUpdate, AfterUpdate, then Click; the grid follows the Value', async () => {
    const r = await run([
      'Private Sub Calendar1_AfterUpdate()', '  Debug.Print "after "; Format(Calendar1.Value, "yyyy-mm-dd")', 'End Sub',
      'Private Sub Calendar1_Click()', '  Debug.Print "click"', 'End Sub',
      'Private Sub Form_Load()', '  Debug.Print Calendar1.Month; Calendar1.Year', 'End Sub', '',
    ].join('\n'), [['Calendar', 'Calendar1', { Value: serial(2026, 10, 22), FirstDay: 2 }]]);
    const cal = r.el('Calendar1');
    expect(cal.querySelector('.mc-title')!.textContent).toMatch(/2026$/);
    expect(cal.querySelectorAll('.mc-d').length).toBe(42);
    const day = cal.querySelector<HTMLElement>(`.mc-d[data-serial="${serial(2026, 10, 15)}"]`)!;
    day.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    await settle();
    expect(r.out.slice(1)).toEqual(['after 2026-10-15', 'click']);
    expect(cal.querySelector('.mc-d.sel')!.getAttribute('data-serial')).toBe(String(serial(2026, 10, 15)));
  });
});

describe('CoolBar', () => {
  test('a band hosts a child control of the form, by design and by code; HeightChanged follows the rows; the child leaves when the band does', async () => {
    const r = await run([
      'Private Sub CoolBar1_HeightChanged(ByVal NewHeight As Single)', '  Debug.Print "height "; CStr(NewHeight)', 'End Sub',
      'Private Sub Form_Load()',
      '  Debug.Print CoolBar1.Bands.Count; CoolBar1.Bands(1).Caption; TypeName(CoolBar1.Bands(1).Child)',
      '  Dim b As Band',
      '  Set b = CoolBar1.Bands.Add(, "k2", "Search", , True)',
      '  Set b.Child = Text1',
      '  Debug.Print CoolBar1.Bands.Count; b.NewRow; b.Child.Name; CoolBar1.Bands("k2").Index',
      'End Sub', '',
    ].join('\n'), [
      ['CoolBar', 'CoolBar1', { Height: 390, Bands: ['Tools|k1||||Combo1'] }],
      ['ComboBox', 'Combo1', { Left: 100, Top: 100, Width: 1200, Height: 315 }],
      ['TextBox', 'Text1', { Left: 100, Top: 600, Width: 1200, Height: 300 }],
    ]);
    expect(r.out).toEqual([' 1 ToolsComboBox', 'height 765', ' 2 TrueText1 2 ']);
    const bar = r.el('CoolBar1');
    expect(bar.querySelectorAll('.cbr-band').length).toBe(2);
    expect(bar.querySelector('.cbr-body')!.contains(r.el('Combo1'))).toBe(true);
    expect(bar.querySelectorAll('.cbr-body')[1].contains(r.el('Text1'))).toBe(true);
    expect(r.el('CoolBar1').style.height).toBe('51px');
  });
});
