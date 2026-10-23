// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, FontValue, PropValue } from '../../src/model/types';
import { dialogFilters } from '../../src/backend/dialogFilters';
import { filterIndexFor, parseVbFilter } from '../../src/run/commonDialog';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = () => new Promise(r => setTimeout(r, 0));

type FakeBackend = Pick<Backend, 'showOpenDialog' | 'showSaveDialog'>;
const sent: string[] = [];   // the kinds of the messages to the form windows
class TestHost extends InlineFormHost {
  override async openForm(...a: Parameters<InlineFormHost['openForm']>) {
    const w = await super.openForm(...a);
    return { ...w, send: (m: Parameters<typeof w.send>[0]) => { sent.push(m.t); w.send(m); } };
  }
  override async colorDialog(): Promise<number | null> { return 0xff; }
  override async fontDialog(): Promise<FontValue | null> { return { name: 'Arial', size: 14, bold: true, italic: false, underline: true }; }
  override async printerDialog() { return null; }
}

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][], backend: FakeBackend) {
  const p = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  for (const [type, name, props] of controls) {
    const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    p.forms[0].controls.push(c);
  }
  const out: string[] = [];
  session = new RunSession(p, new TestHost(container, backend as Backend), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  for (let i = 0; i < 30; i++) await tick();
  const el = (name: string) => container.querySelector<HTMLElement>(`[data-control-id="${p.forms[0].controls.find(c => c.name === name)!.id}"]`)!;
  return { out, el };
}

test('the VB filter becomes dialog filters', () => {
  expect(parseVbFilter('Tekst (*.txt)|*.txt|Alle (*.*)|*.*')).toEqual([
    { name: 'Tekst (*.txt)', extensions: ['txt'] }, { name: 'Alle (*.*)', extensions: ['*'] }]);
  expect(parseVbFilter('Web (*.htm;*.html)|*.htm;*.html')).toEqual([{ name: 'Web (*.htm;*.html)', extensions: ['htm', 'html'] }]);
  expect(parseVbFilter('')).toEqual([]);
  expect(parseVbFilter('Orphan')).toEqual([]);
});

test('ShowOpen / ShowSave fill FileName and FileTitle and pass filter, title and folder; the chosen filter comes first', async () => {
  const backend = { showOpenDialog: vi.fn(async () => '/Users/me/notes/a.txt'), showSaveDialog: vi.fn(async () => '/Users/me/b.rtf') };
  const r = await run([
    'Private Sub Form_Load()',
    '  CommonDialog1.ShowOpen',
    '  Debug.Print CommonDialog1.FileName; "|"; CommonDialog1.FileTitle',
    '  CommonDialog1.ShowSave',
    '  Debug.Print CommonDialog1.FileName; "|"; CommonDialog1.FileTitle',
    'End Sub'].join('\n'),
  [['CommonDialog', 'CommonDialog1', { Filter: 'Tekst (*.txt)|*.txt|Alle (*.*)|*.*', FilterIndex: 2, DialogTitle: 'Velg', InitDir: '/Users/me' }]], backend);
  expect(r.out.join('')).toBe('/Users/me/notes/a.txt|a.txt/Users/me/b.rtf|b.rtf');
  expect(backend.showOpenDialog).toHaveBeenCalledWith(
    [{ name: 'Alle (*.*)', extensions: ['*'] }, { name: 'Tekst (*.txt)', extensions: ['txt'] }], 'Velg', '/Users/me');
  expect(backend.showSaveDialog).toHaveBeenCalledWith(expect.any(Array), 'Velg', '/Users/me', 'a.txt');
});

test('Cancel: CancelError = True gives 32755, False returns and keeps FileName; ShowPrinter cancelled gives 32755, ShowHelp 438', async () => {
  const backend = { showOpenDialog: vi.fn(async () => null), showSaveDialog: vi.fn(async () => null) };
  const r = await run([
    'Private Sub Form_Load()',
    '  On Error Resume Next',
    '  CommonDialog1.FileName = "keep.txt"',
    '  CommonDialog1.ShowOpen',
    '  Debug.Print Err.Number; CommonDialog1.FileName; "|"',
    '  CommonDialog1.CancelError = True',
    '  CommonDialog1.ShowOpen',
    '  Debug.Print Err.Number; Err.Description; "|"',
    '  Err.Clear',
    '  CommonDialog1.ShowColor',
    '  Debug.Print Err.Number; "|"',
    '  Err.Clear',
    '  CommonDialog1.ShowPrinter',
    '  Debug.Print Err.Number; "|"',
    '  Err.Clear',
    '  CommonDialog1.ShowHelp',
    '  Debug.Print Err.Number',
    'End Sub'].join('\n'), [['CommonDialog', 'CommonDialog1']], backend);
  expect(r.out.join('')).toBe(' 0 keep.txt| 32755 Cancel was selected| 0 | 32755 | 438 ');
});

test('ShowColor and ShowFont fill Color and Font*', async () => {
  const r = await run([
    'Private Sub Form_Load()',
    '  CommonDialog1.ShowColor',
    '  CommonDialog1.ShowFont',
    '  Debug.Print CommonDialog1.Color; CommonDialog1.FontName; CommonDialog1.FontSize; CommonDialog1.FontBold; CommonDialog1.FontItalic; CommonDialog1.FontUnderline',
    'End Sub'].join('\n'), [['CommonDialog', 'CommonDialog1']], { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() });
  expect(r.out.join('')).toBe(' 255 Arial 14 TrueFalseTrue');
});

test('RichTextBox: SelBold formats the selection only; Text stays plain; a format set at the caret applies to SelText', async () => {
  const r = await run([
    'Private Sub Form_Load()',
    '  RichTextBox1.Text = "hello world"',
    '  RichTextBox1.SelStart = 0',
    '  RichTextBox1.SelLength = 5',
    '  RichTextBox1.SelBold = True',
    '  RichTextBox1.SelStart = 11',
    '  RichTextBox1.SelLength = 0',
    '  RichTextBox1.SelItalic = True',
    '  RichTextBox1.SelText = "!"',
    '  Debug.Print RichTextBox1.Text; "|"; RichTextBox1.SelBold; RichTextBox1.SelItalic',
    'End Sub'].join('\n'), [['RichTextBox', 'RichTextBox1']], { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() });
  const rtf = r.el('RichTextBox1').querySelector<HTMLElement>('.vb-rtf')!;
  expect(rtf.textContent).toBe('hello world!');
  const spans = [...rtf.querySelectorAll<HTMLElement>('span')].map(s => [s.textContent, s.dataset.vbBold, s.dataset.vbItalic]);
  expect(spans).toEqual([['hello', '1', undefined], ['!', undefined, '1']]);
  expect(r.out.join('')).toBe('hello world!|FalseTrue');
});

test('RichTextBox: typing raises Change with the plain Text; moving the selection raises SelChange and updates SelStart / SelLength', async () => {
  const r = await run([
    'Private Sub RichTextBox1_Change()',
    '  Debug.Print "C:" & RichTextBox1.Text',
    'End Sub',
    'Private Sub RichTextBox1_SelChange()',
    '  Debug.Print "S:" & RichTextBox1.SelStart & "," & RichTextBox1.SelLength',
    'End Sub'].join('\n'), [['RichTextBox', 'RichTextBox1', { Text: 'abc' }]], { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() });
  const rtf = r.el('RichTextBox1').querySelector<HTMLElement>('.vb-rtf')!;
  const range = document.createRange();
  range.setStart(rtf.firstChild!, 1); range.setEnd(rtf.firstChild!, 3);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  rtf.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
  for (let i = 0; i < 10; i++) await tick();
  rtf.firstChild!.nodeValue = 'abcd';
  document.getSelection()!.collapse(rtf.firstChild!, 4);
  rtf.dispatchEvent(new Event('input', { bubbles: true }));
  for (let i = 0; i < 10; i++) await tick();
  expect(r.out).toEqual(['S:1,2', 'S:4,0', 'C:abcd']);
});

test('RichTextBox: many Sel* writes in one procedure go out in one patch and are replayed in order', async () => {
  const r = await run([
    'Private Sub Command1_Click()',
    '  Dim i As Integer',
    '  RichTextBox1.Text = "aa bb cc dd ee"',
    '  For i = 0 To 4',
    '    RichTextBox1.SelStart = i * 3',
    '    RichTextBox1.SelLength = 2',
    '    RichTextBox1.SelColor = 255',
    '    RichTextBox1.SelBold = (i Mod 2 = 0)',
    '  Next',
    '  RichTextBox1.SelStart = 14',
    '  RichTextBox1.SelLength = 0',
    '  RichTextBox1.SelItalic = True',   // waits at the caret for the next typing
    'End Sub'].join('\n'), [['RichTextBox', 'RichTextBox1'], ['CommandButton', 'Command1']], { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() });
  sent.length = 0;
  r.el('Command1').querySelector('button')!.click();
  for (let i = 0; i < 30; i++) await tick();
  expect(sent.filter(t => t === 'patch' || t === 'patches')).toHaveLength(1);
  const rtf = r.el('RichTextBox1').querySelector<HTMLElement>('.vb-rtf')!;
  expect(rtf.textContent).toBe('aa bb cc dd ee');
  const bold = [...rtf.querySelectorAll<HTMLElement>('span')].filter(s => s.dataset.vbBold === '1').map(s => s.textContent);
  expect(bold).toEqual(['aa', 'cc', 'ee']);
  expect(r.out).toEqual([]);
});

test('"All files" is kept: listed last, and for the Mac dialog (merged filters) it lifts the restriction; FilterIndex follows the file', async () => {
  const backend = { showOpenDialog: vi.fn(async () => '/Users/me/pic.png'), showSaveDialog: vi.fn(async () => '/Users/me/b.html') };
  const r = await run([
    'Private Sub Form_Load()',
    '  CommonDialog1.ShowOpen',
    '  Debug.Print CommonDialog1.FilterIndex;',
    '  CommonDialog1.FilterIndex = 3',
    '  CommonDialog1.ShowSave',
    '  Debug.Print CommonDialog1.FilterIndex',
    'End Sub'].join('\n'),
  [['CommonDialog', 'CommonDialog1', { Filter: 'All (*.*)|*.*|Text (*.txt)|*.txt|Web|*.htm;*.html', FilterIndex: 2 }]], backend);
  expect(backend.showOpenDialog).toHaveBeenCalledWith([
    { name: 'Text (*.txt)', extensions: ['txt'] }, { name: 'Web', extensions: ['htm', 'html'] }, { name: 'All (*.*)', extensions: ['*'] }], '', '');
  expect(r.out.join('')).toBe(' 1  3 ');   // pic.png: only "All" matches; b.html: Web, which was selected
  expect(dialogFilters(parseVbFilter('Text|*.txt|All|*.*'))).toEqual([]);
  expect(dialogFilters(parseVbFilter('Text|*.txt|Web|*.htm;*.html'))).toEqual([{ name: 'Text', extensions: ['txt'] }, { name: 'Web', extensions: ['htm', 'html'] }]);
  expect(filterIndexFor('Text|*.txt|All|*.*', 1, '/a/b.TXT')).toBe(1);
  expect(filterIndexFor('Text|*.txt|Web|*.htm', 1, '/a/b.htm')).toBe(2);
  expect(filterIndexFor('Text|*.txt', 1, '/a/b.png')).toBe(1);
});
