// @vitest-environment jsdom
// 0.9 B4: classic drag and drop (DragMode, Drag, DragOver / DragDrop) and OLE drag and drop (files from Finder, TextBox text).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

let root: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });

function project(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][], formProps: Record<string, PropValue> = {}): Project {
  const p = newProject();
  const fd = newForm('Form1', code);
  Object.assign(fd.props, formProps);
  for (const [type, name, props] of controls) {
    const c = newControl(fd, type, { left: 120, top: 120 }, null);
    c.name = name;
    Object.assign(c.props, props ?? {});
    fd.controls.push(c);
  }
  p.forms = [fd];
  return p;
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0)); };
async function run(p: Project): Promise<string[]> {
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(root), {
    debugPrint: t => { out.push(t.trim()); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  return out;
}
const el = (p: Project, name: string) => root.querySelector<HTMLElement>(`[data-control-id="${p.forms[0].controls.find(c => c.name === name)!.id}"]`)!;
const mouse = (target: Element, type: string, x: number, y: number, buttons = 1) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y }));
const sub = (name: string, params: string, body: string) => `Private Sub ${name}(${params})\n${body}\nEnd Sub\n`;
const OVER = 'Source As Control, X As Single, Y As Single, State As Integer';
const OLE = 'Data As DataObject, Effect As Long, Button As Integer, Shift As Integer, X As Single, Y As Single';

describe('classic drag and drop', () => {
  test('DragMode automatic: a drag from Picture1 to Picture2 raises DragOver enter / leave / over and DragDrop with Source = Picture1', async () => {
    const p = project(
      sub('Picture1_DragOver', OVER, 'Debug.Print "over1 " & Source.Name & " " & State')
      + sub('Picture2_DragOver', OVER, 'Debug.Print "over2 " & Source.Name & " " & State')
      + sub('Picture2_DragDrop', 'Source As Control, X As Single, Y As Single', 'Debug.Print "drop " & Source.Name & " " & X & " " & Y')
      + sub('Picture1_MouseDown', 'Button As Integer, Shift As Integer, X As Single, Y As Single', 'Debug.Print "mousedown"')
      + sub('Form_Click', '', 'Debug.Print "click"'),
      [['PictureBox', 'Picture1', { DragMode: 1 }], ['PictureBox', 'Picture2']]);
    const out = await run(p);
    mouse(el(p, 'Picture1'), 'mousedown', 5, 5);
    mouse(el(p, 'Picture2'), 'mousemove', 10, 20);
    mouse(el(p, 'Picture2'), 'mousemove', 12, 22);
    mouse(el(p, 'Picture2'), 'mouseup', 12, 22, 0);
    root.querySelector('.vb-form-client')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // the browser's click after the drag
    await settle();
    // no layout in jsdom: X, Y are the client pixels in twips (ScaleMode twips)
    expect(out).toEqual(['over1 Picture1 0', 'over1 Picture1 1', 'over2 Picture1 0', 'over2 Picture1 2', 'drop Picture1 180 330']);
    expect(root.querySelector('.vb-drag-outline')).toBeNull();
  });

  test('Drag 0 cancels a drag begun by code: no DragDrop', async () => {
    const p = project(
      sub('Picture1_MouseDown', 'Button As Integer, Shift As Integer, X As Single, Y As Single', 'Picture1.Drag vbBeginDrag')
      + sub('Picture2_DragOver', OVER, 'Debug.Print "over " & State\nPicture1.Drag 0')
      + sub('Picture2_DragDrop', 'Source As Control, X As Single, Y As Single', 'Debug.Print "drop"'),
      [['PictureBox', 'Picture1'], ['PictureBox', 'Picture2']]);
    const out = await run(p);
    mouse(el(p, 'Picture1'), 'mousedown', 5, 5);
    await settle();
    expect(root.querySelector('.vb-drag-outline')).not.toBeNull();   // the outline follows the mouse
    mouse(el(p, 'Picture2'), 'mousemove', 10, 20);
    await settle();
    expect(root.querySelector('.vb-drag-outline')).toBeNull();
    mouse(el(p, 'Picture2'), 'mouseup', 10, 20, 0);
    await settle();
    expect(out).toEqual(['over 0']);
  });
});

describe('OLE drag and drop', () => {
  test('a file dropped from Finder on a form with OLEDropMode 1 raises OLEDragOver and OLEDragDrop with Data.Files', async () => {
    const p = project(
      sub('Form_OLEDragOver', `${OLE}, State As Integer`, 'Debug.Print "over " & State & " " & Effect')
      + sub('Form_OLEDragDrop', OLE, 'Debug.Print Data.Files(1) & "|" & Data.GetFormat(vbCFFiles) & "|" & Data.GetFormat(vbCFText) & "|" & Data.Files.Count & "|" & Effect\n'
        + 'Dim f\nFor Each f In Data.Files\nDebug.Print f\nNext'),
      [], { OLEDropMode: 1 });
    const out = await run(p);
    const win = root.querySelector('.vb-inline-window')!;
    const drag = (detail: object) => win.dispatchEvent(new CustomEvent('vbfiledrag', { detail }));
    drag({ type: 'enter', paths: ['/Users/me/a.txt', '/Users/me/b.png'], x: 30, y: 40 });
    drag({ type: 'over', x: 31, y: 41 });
    drag({ type: 'drop', paths: ['/Users/me/a.txt', '/Users/me/b.png'], x: 31, y: 41 });
    await settle();
    expect(out).toEqual(['over 0 1', 'over 2 1', '/Users/me/a.txt|True|False|2|1', '/Users/me/a.txt', '/Users/me/b.png']);
  });

  test('OLEDragMode automatic drags a TextBox\'s selected text into another (OLEDropMode automatic): the text moves', async () => {
    const p = project(
      sub('Form_Load', '', 'Text2.SelStart = Len(Text2.Text)')
      + sub('Text1_OLEStartDrag', 'Data As DataObject, AllowedEffects As Long', 'Debug.Print "start " & Data.GetData(vbCFText) & " " & AllowedEffects')
      + sub('Text1_OLECompleteDrag', 'Effect As Long', 'Debug.Print "complete " & Effect & " [" & Text1.Text & "] [" & Text2.Text & "]"'),
      [['TextBox', 'Text1', { Text: 'Hello World', OLEDragMode: 1 }], ['TextBox', 'Text2', { Text: 'Hi ', OLEDropMode: 2 }]]);
    const out = await run(p);
    const t1 = el(p, 'Text1').querySelector('input')!, t2 = el(p, 'Text2').querySelector('input')!;
    t1.focus();
    t1.setSelectionRange(6, 11);
    mouse(t1, 'mousedown', 50, 10);
    mouse(t2, 'mousemove', 60, 50);
    mouse(t2, 'mouseup', 60, 50, 0);
    await settle();
    expect(out).toEqual(['start World 3', 'complete 2 [Hello ] [Hi World]']);
    expect(t2.value).toBe('Hi World');
    expect(t1.value).toBe('Hello ');
  });
});
