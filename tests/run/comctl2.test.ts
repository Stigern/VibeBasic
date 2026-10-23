// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { dateFrom } from '../../src/lang/values';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

const serial = (y: number, m: number, d: number) => dateFrom(y, m, d).serial;

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][]) {
  const p: Project = newProject();
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
    readFile: async () => new Uint8Array(), appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  const el = (name: string) => container.querySelector<HTMLElement>(`[data-control-id="${p.forms[0].controls.find(c => c.name === name)!.id}"]`)!;
  return { out, el };
}
const press = (el: HTMLElement, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('DTPicker in a running program', () => {
  test('Value is a Date; Day / Month / Year / DayOfWeek follow it and can be set; MinDate clamps; Change fires for code and user', async () => {
    const r = await run([
      'Private Sub DTPicker1_Change()',
      '  Debug.Print "change"; IsNull(DTPicker1.Value)',
      'End Sub',
      'Private Sub Form_Load()',
      '  DTPicker1.Value = DateSerial(2026, 10, 22)',
      '  Debug.Print TypeName(DTPicker1.Value); Format(DTPicker1.Value, "yyyy-mm-dd"); DTPicker1.Day; DTPicker1.Month; DTPicker1.Year; DTPicker1.DayOfWeek',
      '  DTPicker1.Month = 2: DTPicker1.Day = 28',
      '  Debug.Print Format(DTPicker1.Value, "yyyy-mm-dd")',
      '  On Error Resume Next',
      '  DTPicker1.Day = 31',
      '  Debug.Print Err.Number: Err.Clear',
      '  DTPicker1.MinDate = DateSerial(2026, 3, 1)',
      '  Debug.Print Format(DTPicker1.Value, "yyyy-mm-dd")',
      '  DTPicker1.Value = DateSerial(2020, 1, 1)',
      '  Debug.Print Format(DTPicker1.Value, "yyyy-mm-dd")',
      '  DTPicker1.Value = Null',
      '  Debug.Print Err.Number: Err.Clear',
      '  DTPicker1.MaxDate = DateSerial(2000, 1, 1)',
      '  Debug.Print Err.Number: Err.Clear',
      '  Debug.Print dtpShortDate; dtpCustom; mvwMonday',
      'End Sub', '',
    ].join('\n'), [['DTPicker', 'DTPicker1', {}]]);
    expect(r.out.filter(l => !l.startsWith('change'))).toEqual([
      'Date2026-10-22 22  10  2026  5 ', '2026-02-28', ' 380 ', '2026-03-01', '2026-03-01', ' 94 ', ' 380 ', ' 1  3  2 ']);
    expect(r.out.filter(l => l.startsWith('change')).length).toBeGreaterThanOrEqual(3);
  });

  test('Value = Null works with CheckBox; the Day of a Null date is Null; the window shows it unchecked', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  DTPicker1.Value = Null',
      '  Debug.Print IsNull(DTPicker1.Value); IsNull(DTPicker1.Day)',
      '  DTPicker1.Value = "2026-10-22"',
      '  Debug.Print IsNull(DTPicker1.Value); DTPicker1.Day',
      '  DTPicker1.Value = Null',
      'End Sub', '',
    ].join('\n'), [['DTPicker', 'DTPicker1', { CheckBox: true }]]);
    expect(r.out).toEqual(['TrueTrue', 'False 22 ']);
    expect(r.el('DTPicker1').querySelector('.dtp-chk')!.classList.contains('on')).toBe(false);
  });

  test('the user edits a field with the keys: Change fires and Value follows', async () => {
    const r = await run([
      'Private Sub DTPicker1_Change()',
      '  Debug.Print Format(DTPicker1.Value, "yyyy-mm-dd")',
      'End Sub', '',
    ].join('\n'), [['DTPicker', 'DTPicker1', { Format: 3, CustomFormat: 'dd.MM.yyyy', Value: serial(2026, 10, 22) }]]);
    const root = r.el('DTPicker1').querySelector<HTMLElement>('.vb-dtp')!;
    press(root, 'ArrowUp');
    press(root, 'ArrowRight');
    press(root, '1'); press(root, '2');   // month 12, then on to the year field
    await settle();
    expect(r.out).toEqual(['2026-10-23', '2026-01-23', '2026-12-23']);   // "1" is January until the "2" makes it 12
    expect(r.el('DTPicker1').querySelector('.dtp-fields')!.textContent).toBe('23.12.2026');
  });
});

describe('MonthView in a running program', () => {
  test('DateClick passes the date, SelChange the range; Value, Day, Month, Year and SelStart follow', async () => {
    const r = await run([
      'Private Sub MonthView1_DateClick(ByVal DateClicked As Date)',
      '  Debug.Print "click "; Format(DateClicked, "yyyy-mm-dd"); " "; Format(MonthView1.Value, "yyyy-mm-dd"); MonthView1.Day',
      'End Sub',
      'Private Sub MonthView1_SelChange(StartDate As Date, EndDate As Date)',
      '  Debug.Print "sel "; Format(StartDate, "dd.mm"); " "; Format(EndDate, "dd.mm")',
      'End Sub',
      'Private Sub Form_Load()',
      '  Debug.Print Format(MonthView1.Value, "yyyy-mm-dd"); MonthView1.Month; MonthView1.Year',
      'End Sub', '',
    ].join('\n'), [['MonthView', 'MonthView1', { Value: serial(2026, 10, 22), StartOfWeek: 2 }]]);
    expect(r.out).toEqual(['2026-10-22 10  2026 ']);
    const day = r.el('MonthView1').querySelector<HTMLElement>(`.mv-d[data-serial="${serial(2026, 10, 15)}"]`)!;
    day.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await settle();
    expect(r.out.slice(1)).toEqual(['sel 15.10 15.10', 'click 2026-10-15 2026-10-15 15 ']);
  });

  test('code sets the range of a MultiSelect MonthView (at most MaxSelCount, else 380); constants', async () => {
    const r = await run([
      'Private Sub Form_Load()',
      '  MonthView1.SelStart = DateSerial(2026, 10, 5)',
      '  MonthView1.SelEnd = DateSerial(2026, 10, 8)',
      '  Debug.Print Format(MonthView1.SelStart, "d"); Format(MonthView1.SelEnd, "d"); Format(MonthView1.Value, "d")',
      '  On Error Resume Next',
      '  MonthView1.SelEnd = DateSerial(2026, 10, 20)',
      '  Debug.Print Err.Number: Err.Clear',
      '  MonthView1.Value = DateSerial(2026, 11, 2)',
      '  Debug.Print Format(MonthView1.SelStart, "d"); Format(MonthView1.SelEnd, "d")',
      '  Debug.Print mvwSunday; mvwSaturday',
      'End Sub', '',
    ].join('\n'), [['MonthView', 'MonthView1', { MultiSelect: true, MaxSelCount: 5 }]]);
    expect(r.out).toEqual(['585', ' 380 ', '22', ' 1  7 ']);
  });
});

describe('MaskedEdit in a running program', () => {
  const code = [
    'Private Sub MaskEdBox1_ValidationError(InvalidText As String, StartPosition As Integer)',
    '  Debug.Print "invalid "; InvalidText; " at "; StartPosition',
    'End Sub',
    'Private Sub Command1_Click()',
    '  Debug.Print "["; MaskEdBox1.Text; "]["; MaskEdBox1.ClipText; "]["; MaskEdBox1.FormattedText; "]"',
    'End Sub', '',
  ].join('\n');
  const typeInto = (input: HTMLInputElement, keys: string, at = 0) => {
    input.setSelectionRange(at, at);
    for (const k of keys) input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };
  const peek = async (r: Awaited<ReturnType<typeof run>>) => {
    r.el('Command1').querySelector('button')!.click();
    await settle();
    return r.out.at(-1);
  };

  test('typing "01022024" into "##.##.####" gives Text "01.02.2024" and ClipText "01022024"', async () => {
    const r = await run(code, [['MaskedEdit', 'MaskEdBox1', { Mask: '##.##.####', Text: '__.__.____' }], ['CommandButton', 'Command1']]);
    const input = r.el('MaskEdBox1').querySelector('input')!;
    expect(input.value).toBe('__.__.____');
    typeInto(input, '010220');
    await settle();
    expect(input.value).toBe('01.02.20__');
    expect(await peek(r)).toBe('[01.02.20__][010220][01.02.20__]');
    typeInto(input, '010220');
    input.setSelectionRange(0, 0);
    typeInto(input, '01022024');
    await settle();
    expect(await peek(r)).toBe('[01.02.2024][01022024][01.02.2024]');
  });

  test('an invalid letter raises ValidationError(InvalidText, StartPosition) and is refused', async () => {
    const r = await run(code, [['MaskedEdit', 'MaskEdBox1', { Mask: '##.##.####', Text: '__.__.____' }], ['CommandButton', 'Command1']]);
    const input = r.el('MaskEdBox1').querySelector('input')!;
    typeInto(input, '1');
    typeInto(input, 'x', 1);
    await settle();
    expect(r.out).toEqual(['invalid x at  1 ']);
    expect(input.value).toBe('1_.__.____');
    expect(await peek(r)).toBe('[1_.__.____][1][1_.__.____]');
  });

  test('Text and Mask set by code; PromptInclude False; a text that does not fit is error 380; KeyPress can change the key', async () => {
    const r = await run([
      'Private Sub MaskEdBox1_KeyPress(KeyAscii As Integer)',
      '  If KeyAscii = 97 Then KeyAscii = 55',
      'End Sub',
      'Private Sub Form_Load()',
      '  MaskEdBox1.Text = "01.02.2024"',
      '  Debug.Print MaskEdBox1.Text; "|"; MaskEdBox1.ClipText',
      '  MaskEdBox1.Text = "0102"',
      '  Debug.Print MaskEdBox1.Text; "|"; MaskEdBox1.ClipText',
      '  MaskEdBox1.PromptInclude = False',
      '  Debug.Print "["; MaskEdBox1.Text; "]["; MaskEdBox1.FormattedText; "]"',
      '  On Error Resume Next',
      '  MaskEdBox1.Text = "ab.cd.efgh"',
      '  Debug.Print Err.Number: Err.Clear',
      '  MaskEdBox1.Mask = "AAA"',
      '  Debug.Print "["; MaskEdBox1.Text; "]"',
      'End Sub', '',
    ].join('\n'), [['MaskedEdit', 'MaskEdBox1', { Mask: '##.##.####', Text: '__.__.____' }]]);
    expect(r.out).toEqual(['01.02.2024|01022024', '01.02.____|0102', '[01.02.    ][01.02.____]', ' 380 ', '[   ]']);
    const input = r.el('MaskEdBox1').querySelector('input')!;
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));   // the program turns "a" into "7"
    await settle();
    expect(input.value).toBe('7__');   // the new mask AAA accepts it as a letter or digit
  });

  test('a MaskedEdit without a Mask is a plain text field with MaxLength', async () => {
    const r = await run(code, [['MaskedEdit', 'MaskEdBox1', { Text: 'abc', MaxLength: 5 }], ['CommandButton', 'Command1']]);
    const input = r.el('MaskEdBox1').querySelector('input')!;
    expect(input.value).toBe('abc');
    expect(input.maxLength).toBe(5);
    input.value = 'abcde';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(await peek(r)).toBe('[abcde][abcde][abcde]');
  });
});
