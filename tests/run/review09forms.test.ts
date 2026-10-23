// @vitest-environment jsdom
// Review 0.9 (forms and run time): one regression test per finding, each with the repro of the report.
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { formClientTwips } from '../../src/model/geometry';
import { newMdiForm } from '../../src/model/mdi';
import { keyLetter, shortcutMatches, shortcutValue } from '../../src/model/menuShortcuts';
import type { ControlType, FormDef, Project, PropValue } from '../../src/model/types';
import { importFrm } from '../../src/model/vb6Import';
import { multiFileName } from '../../src/run/commonDialog';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { fromRtf, toRtf } from '../../src/run/objects/rtf';
import { RunSession } from '../../src/run/session';

type C = [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?];
interface F { name: string; code: string; controls?: C[]; props?: Record<string, PropValue>; mdi?: boolean }
function project(forms: F[]): Project {
  const p = newProject();
  p.forms = forms.map(f => {
    const fd: FormDef = f.mdi ? newMdiForm(f.name, f.code) : newForm(f.name, f.code);
    Object.assign(fd.props, f.props ?? {});
    let top = 120;
    for (const [type, name, props] of f.controls ?? []) {
      const c = newControl(fd, type, { left: 120, top }, null);
      top += 600;
      c.name = name;
      Object.assign(c.props, props ?? {});
      fd.controls.push(c);
    }
    return fd;
  });
  p.startupForm = forms[0].name;
  return p;
}

let container: HTMLElement;
let out: string[];
let current: Project;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); out = []; });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });

const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(): Promise<void> { for (let i = 0; i < 40; i++) await tick(); }
async function start(p: Project): Promise<RunSession> {
  current = p;
  const host = new InlineFormHost(container);
  host.runtimeErrorBox = async info => { out.push(`ERR ${info.number} ${info.description}`); return 'end'; };
  session = new RunSession(p, host, {
    debugPrint: t => { out.push(t.trim().replace(/\s+/g, ' ')); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  return session;
}
/** Immediate window: `statements: ? expression` runs the statements first (? must start a line there). */
async function run(code: string): Promise<string> {
  const [first, ask] = code.split(': ? ');
  if (ask !== undefined) { await session!.immediate(first); await settle(); }
  const r = await session!.immediate(ask !== undefined ? `? ${ask}` : code);
  await settle();
  return r.trim().replace(/\s+/g, ' ');
}
function elOf(name: string): HTMLElement {
  for (const f of current.forms) {
    const c = f.controls.find(d => d.name === name);
    if (c) { const el = container.querySelector<HTMLElement>(`[data-control-id="${c.id}"]`); if (el) return el; }
  }
  throw new Error(`no control ${name}`);
}
const mouse = (target: Element, type: string, x: number, y: number, buttons = 1) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y }));
const sub = (name: string, params: string, body: string) => `Private Sub ${name}(${params})\n${body}\nEnd Sub\n`;
const MOUSE = 'Button As Integer, Shift As Integer, X As Single, Y As Single';
const OLE = 'Data As DataObject, Effect As Long, Button As Integer, Shift As Integer, X As Single, Y As Single';
const PNG = { asset: 'data:image/png;base64,AAAA' };

describe('review 0.9 forms', () => {
  test('1: a control\'s Left / Width, Move, Line X1 and its MouseDown X, Y are in the form\'s ScaleMode', async () => {
    await start(project([{ name: 'Form1', controls: [['CommandButton', 'Command1'], ['Line', 'Line1']], code:
      sub('Form_Load', '', 'ScaleMode = vbPixels\nCommand1.Move 10, 10, 100, 30\nDebug.Print Command1.Left; Command1.Width; Command1.Height\nLine1.X1 = 20\nDebug.Print Line1.X1')
      + sub('Command1_MouseDown', MOUSE, 'Debug.Print "down"; X; Y') }]));
    expect(elOf('Command1').style.left).toBe('10px');
    expect(elOf('Command1').style.width).toBe('100px');
    // no layout in jsdom: the button's origin is at 0, 0, so the point is 10, 20 px into it
    mouse(elOf('Command1').querySelector('button') ?? elOf('Command1'), 'mousedown', 10, 20);
    await settle();
    expect(out).toEqual(['10 100 30', '20', 'down 10 20']);
    expect(await run('Form1.ScaleMode = vbTwips: ? Form1.Line1.X1; Form1.Command1.Left')).toBe('300 150');
  });

  test('2: an aligned PictureBox gets the client width, follows a resize of the form (Resize) and draws over all of it', async () => {
    await start(project([{ name: 'Form1', controls: [['PictureBox', 'Picture1', { Align: 1, Height: 600 }]], code:
      sub('Picture1_Resize', '', 'Debug.Print "resize"; Picture1.Width') }]));
    const client = formClientTwips({ Width: 4800, Height: 3600 });
    expect(await run('? Form1.Picture1.Width')).toBe(String(client.width));
    out = [];
    await run('Form1.Width = Form1.Width + 3000');
    expect(out).toEqual([`resize ${client.width + 3000}`]);
    expect(await run('Form1.Picture1.ScaleMode = 3: Form1.Picture1.PSet (400, 5), vbRed: ? Form1.Picture1.Point(400, 5)')).toBe('255');
  });

  test('3: FontName ... FontStrikethru on Form, PictureBox and controls, and unqualified in form code', async () => {
    await start(project([{ name: 'Form1', controls: [['PictureBox', 'Picture1'], ['Label', 'Label1'], ['CommandButton', 'Command1']], code:
      sub('Command1_Click', '', 'FontSize = 18\nDebug.Print Me.Font.Size; TextHeight("X") > 195') }]));
    (elOf('Command1').querySelector('button') ?? elOf('Command1')).click();
    await settle();
    expect(out).toEqual(['18 True']);
    expect(await run('Form1.FontSize = 24: ? Form1.Font.Size; Form1.FontSize')).toBe('24 24');
    expect(await run('Form1.Picture1.FontBold = True: Form1.Picture1.FontItalic = True: ? Form1.Picture1.Font.Bold; Form1.Picture1.FontItalic')).toBe('TrueTrue');
    expect(await run('Form1.Label1.FontName = "Arial": Form1.Label1.FontUnderline = True: ? Form1.Label1.FontName; Form1.Label1.Font.Name; Form1.Label1.FontUnderline')).toBe('ArialArialTrue');
    expect(await run('Form1.Label1.FontStrikethru = True: ? Form1.Label1.FontStrikethru; Form1.Label1.Font.Strikethrough')).toBe('TrueTrue');
    expect(elOf('Label1').style.fontFamily).toContain('Arial');
    expect(elOf('Label1').style.textDecoration).toContain('line-through');
  });

  test('4: the RTF round trip keeps the format of paragraph marks (blank lines)', () => {
    const base = { bold: false, italic: false, underline: false, strike: false, color: 0, fontName: 'MS Sans Serif', fontSize: 8 };
    const runs = [{ text: 'Title\n\nBody', fmt: { fontName: 'Arial', fontSize: 20 } }];
    expect(fromRtf(toRtf(runs, [], base), base)!.runs).toEqual(runs);
  });

  test('5: MDIForm ScaleWidth / ScaleHeight (the workspace), MousePointer and OLEDropMode', async () => {
    await start(project([{ name: 'MDIForm1', mdi: true, code: '', controls: [['PictureBox', 'Picture1', { Align: 1, Height: 600 }]] }]));
    const client = formClientTwips({ Width: 7200, Height: 5400 });
    expect(await run('? MDIForm1.ScaleWidth; MDIForm1.ScaleHeight')).toBe(`${client.width} ${client.height - 600}`);
    expect(await run('MDIForm1.MousePointer = 11: MDIForm1.OLEDropMode = 1: ? MDIForm1.MousePointer; MDIForm1.OLEDropMode')).toBe('11 1');
    expect(out).toEqual([]);
  });

  test('6: files dragged from Finder reach the MDI child under the pointer (and the MDI form outside the children)', async () => {
    await start(project([
      { name: 'MDIForm1', mdi: true, props: { OLEDropMode: 1 }, code: sub('MDIForm_Load', '', 'Form2.Show')
        + sub('MDIForm_OLEDragDrop', OLE, 'Debug.Print "mdi " & Data.Files(1)') },
      { name: 'Form2', props: { MDIChild: true, OLEDropMode: 1, Width: 3000, Height: 2000 }, code: sub('Form_OLEDragDrop', OLE, 'Debug.Print "drop " & Data.Files(1)')
        + sub('Form_OLEDragOver', `${OLE}, State As Integer`, 'Debug.Print "over " & State') },
    ]));
    const win = container.querySelector('.vb-inline-window')!;
    const kid = win.querySelector('.vb-mdi-child .vb-form-client')!, workspace = win.querySelector('.vb-mdi-workspace')!;
    let under: Element = kid;
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => under;
    const drag = (detail: object) => win.dispatchEvent(new CustomEvent('vbfiledrag', { detail }));
    drag({ type: 'enter', paths: ['/tmp/a.txt'], x: 30, y: 40 });
    drag({ type: 'over', x: 31, y: 41 });
    drag({ type: 'drop', paths: ['/tmp/a.txt'], x: 31, y: 41 });
    await settle();
    under = workspace;
    drag({ type: 'enter', paths: ['/tmp/b.txt'], x: 300, y: 300 });
    drag({ type: 'drop', paths: ['/tmp/b.txt'], x: 300, y: 300 });
    await settle();
    expect(out).toEqual(['over 0', 'over 2', 'drop /tmp/a.txt', 'mdi /tmp/b.txt']);
  });

  test('7: an MDI child\'s Minimize, Restore and Maximize raise Form_Resize with the new WindowState', async () => {
    await start(project([
      { name: 'MDIForm1', mdi: true, code: sub('MDIForm_Load', '', 'Form2.Show') },
      { name: 'Form2', props: { MDIChild: true, Width: 3000, Height: 2000 }, code: sub('Form_Resize', '', 'Debug.Print "resize"; Me.WindowState') },
    ]));
    out = [];
    const btn = (label: string) => container.querySelector<HTMLElement>(`.vb-mdi-child .title-bar-controls button[aria-label="${label}"]`)!;
    btn('Minimize').click(); await settle();
    btn('Restore').click(); await settle();
    btn('Maximize').click(); await settle();
    expect(out).toEqual(['resize 1', 'resize 0', 'resize 2']);
  });

  test('8: New Form2 instances are let go once unloaded and no variable holds them', async () => {
    const s = await start(project([
      { name: 'Form1', controls: [['CommandButton', 'Command1']], code: sub('Command1_Click', '', 'Dim f As Form2, i As Integer\nFor i = 1 To 5\nSet f = New Form2\nf.Show\nUnload f\nSet f = Nothing\nNext\n'
        // jsdom keeps the last closed window alive (the reason of its last AbortSignal is an Error whose stack holds the frames): one more
        + 'Dim g As Form3\nSet g = New Form3\ng.Show\nUnload g\nSet g = Nothing\nDebug.Print "done"') },
      { name: 'Form2', code: 'Dim big(10000) As Long\n' },
      { name: 'Form3', code: '' },
    ]));
    (elOf('Command1').querySelector('button') ?? elOf('Command1')).click();
    await settle();
    expect(out).toEqual(['done']);
    expect((s as unknown as { forms: Map<string, unknown> }).forms.size).toBe(3);   // the session holds the default instances only
    const instances = () => [1, 2, 3, 4, 5].filter(i => s.program.hasModule(`Form2:${i}`));
    expect(instances()).toHaveLength(5);
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    for (let i = 0; i < 50 && instances().length > 0; i++) { gc(); await tick(); }
    expect(instances()).toEqual([]);   // collected: their modules (Dim big) are gone too
  });

  test('9: Source.DragIcon set in DragOver swaps the outline for the icon as the cursor', async () => {
    await start(project([{ name: 'Form1', controls: [['PictureBox', 'Picture1', { DragMode: 1 }], ['PictureBox', 'Picture2'], ['PictureBox', 'Picture3', { Picture: PNG }]], code:
      sub('Picture2_DragOver', 'Source As Control, X As Single, Y As Single, State As Integer', 'If State = vbEnter Then Source.DragIcon = Picture3.Picture') }]));
    mouse(elOf('Picture1'), 'mousedown', 5, 5);
    expect(container.querySelector('.vb-drag-outline')).not.toBeNull();
    mouse(elOf('Picture2'), 'mousemove', 10, 20);
    await settle();
    expect(container.querySelector('.vb-drag-outline')).toBeNull();
    expect([...document.head.querySelectorAll('style')].some(st => st.textContent!.includes('[data-vb-drag]') && st.textContent!.includes('url('))).toBe(true);
    mouse(elOf('Picture2'), 'mouseup', 10, 20, 0);
  });

  test('10: menu Shortcut keys and menu letters follow the character the key types (QWERTZ, AZERTY), not the key\'s place', () => {
    const key = (k: string, code: string, o: Partial<{ ctrlKey: boolean; altKey: boolean }> = {}) =>
      ({ key: k, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
    const ctrlZ = shortcutValue('Ctrl+Z')!, ctrlY = shortcutValue('Ctrl+Y')!;
    expect(shortcutMatches(ctrlZ, key('z', 'KeyY', { ctrlKey: true }))).toBe(true);    // German: Z is where QWERTY has Y
    expect(shortcutMatches(ctrlY, key('z', 'KeyY', { ctrlKey: true }))).toBe(false);
    expect(shortcutMatches(shortcutValue('Ctrl+A')!, key('a', 'KeyQ', { ctrlKey: true }))).toBe(true);   // AZERTY
    expect(shortcutMatches(shortcutValue('Ctrl+C')!, key('с', 'KeyC', { ctrlKey: true }))).toBe(true);   // Cyrillic: the key's code
    expect(shortcutMatches(shortcutValue('F5')!, key('F5', 'F5'))).toBe(true);
    expect(keyLetter(key('z', 'KeyY', { altKey: true }))).toBe('z');
    expect(keyLetter(key('Ω', 'KeyZ', { altKey: true }))).toBe('z');   // Option+Z on a Mac types Ω
    expect(keyLetter(key('ø', 'Semicolon'))).toBe('ø');
  });

  test('11: multiselect FileName from different folders: their common folder, each name relative to it', () => {
    expect(multiFileName(['/Users/s/Documents/a.txt', '/Users/s/Desktop/b.txt'], true)).toBe('/Users/s\0Documents/a.txt\0Desktop/b.txt');
    expect(multiFileName(['/Users/s/a.txt', '/Users/s/b.txt'], false)).toBe('/Users/s a.txt b.txt');
  });

  test('12: a VB6 form with a design-time user scale (ScaleMode 0) runs in it', async () => {
    const frm = ['VERSION 5.00', 'Begin VB.Form Form1', '   Caption = "Form1"', '   ClientHeight = 3000', '   ClientWidth = 4005',
      '   ScaleHeight = 100', '   ScaleLeft = -50', '   ScaleMode = 0  \'User', '   ScaleWidth = 100.5', 'End', 'Attribute VB_Name = "Form1"',
      'Private Sub Form_Load()', 'Debug.Print ScaleMode; ScaleLeft; ScaleWidth; ScaleHeight', 'End Sub', ''].join('\r\n');
    const warnings: string[] = [];
    const { form } = await importFrm(frm, () => null, 'Form1.frm', w => warnings.push(w));
    expect(form.props).toMatchObject({ ScaleMode: 0, ScaleLeft: -50, ScaleWidth: 100.5, ScaleHeight: 100 });
    const p = newProject();
    p.forms = [form];
    await start(p);
    expect(out).toEqual(['0 -50 100.5 100']);
  });

  test('13: Form.Move that changes the size raises Resize and Paint', async () => {
    await start(project([{ name: 'Form1', code: sub('Form_Resize', '', 'Debug.Print "resize"') + sub('Form_Paint', '', 'Debug.Print "paint"') }]));
    out = [];
    await run('Form1.Move 0, 0, 7000, 5000');
    expect(out).toEqual(['resize', 'paint']);
  });
});
