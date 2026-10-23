// @vitest-environment jsdom
// 0.9 end to end, all three tracks in one program through RunSession and the inline host: Sub Main (A4) with a Dictionary and
// an in-memory ADO recordset (A3) shows a form whose menu (C1) draws a Circle on a ScaleMode 3 PictureBox (B1) and calls a
// class (A1) that raises an event handled in the form; a breakpoint in the class reads Locals, a watch on its property and data
// tips through the debugger API (C3).
import { afterEach, expect, test } from 'vitest';
import { formScaleSize } from '../../src/controls/render';
import type { DebugNode } from '../../src/lang/interp/debugger';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlDef, FormDef, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

let session: RunSession | undefined;
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0)); };

const COUNTER = [
  'Public Event Changed(ByVal n As Long)',   // 1
  'Private mN As Long',                      // 2
  'Public Property Get N() As Long',         // 3
  '    N = mN',                              // 4
  'End Property',                            // 5
  'Public Sub Bump()',                       // 6
  '    mN = mN + 1',                         // 7
  '    RaiseEvent Changed(mN)',              // 8
  'End Sub'].join('\n');
const MODULE = `Public gItems As String
Sub Main()
    Dim d As New Dictionary, rs As New ADODB.Recordset
    d.Add "b", 2: d.Add "a", 1
    rs.Fields.Append "Name", adVarChar, 20
    rs.Open , , , adLockOptimistic
    rs.AddNew: rs!Name = "x": rs.Update
    gItems = d.Count & " " & d("a") & " " & rs.RecordCount & rs!Name
    Form1.Show
End Sub`;
const FORM = `Private WithEvents c As Counter
Private Sub Form_Load()
    Set c = New Counter
    Debug.Print gItems; ScaleHeight
End Sub
Private Sub mnuDraw_Click()
    Picture1.Circle (10, 10), 5, vbRed
    Debug.Print Picture1.ScaleWidth; Picture1.Point(10, 5) = vbRed
    c.Bump
End Sub
Private Sub c_Changed(ByVal n As Long)
    Debug.Print "changed"; n
End Sub`;

function addMenu(f: FormDef, name: string, caption: string, parent: ControlDef | null): ControlDef {
  const m = newControl(f, 'Menu', { left: 0, top: 0 }, parent?.id ?? null);
  m.name = name;
  m.props.Caption = caption;
  f.controls.push(m);
  return m;
}

test('Sub Main, Dictionary and ADO, a menu that draws and raises a class event, a break in the class with a watch', async () => {
  const p = newProject();
  const f = newForm('Form1', FORM);
  const pic = newControl(f, 'PictureBox', { left: 0, top: 0, width: 1500, height: 1500 }, null);
  Object.assign(pic.props, { ScaleMode: 3, AutoRedraw: true } satisfies Record<string, PropValue>);
  f.controls.push(pic);
  addMenu(f, 'mnuDraw', '&Draw', addMenu(f, 'mnuFile', '&File', null));
  p.forms = [f];
  p.modules = [{ id: 'm1', name: 'Module1', code: MODULE }, { id: 'c1', name: 'Counter', code: COUNTER, kind: 'class', instancing: 1 }];
  p.subMain = true;

  const out: string[] = [];
  const seen: unknown[] = [];
  const container = document.body.appendChild(document.createElement('div'));
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onEnded: () => {}, readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
    onBreak: async info => {
      const dbg = session!.program.debug;
      const me = dbg.locals().find(n => n.name === 'Me')!;
      const row = (n: DebugNode) => `${n.name}=${n.value}`;
      seen.push(info.at.line, me.children!().map(row),
        (await dbg.watchNode({ expression: 'Me.N', module: 'Counter', procedure: 'Bump', kind: 'watch' })).value,
        dbg.dataTip('mN'), dbg.dataTip('Me.N'));   // a data tip reads variables, never runs Property Get
      return 'continue';
    },
  }, 'ide');
  session.setBreakpoints('Counter', [8]);
  await session.start();
  await settle();
  expect(out).toEqual([`2 1 1x ${formScaleSize(f.props, true).height} `]);   // the menu bar is not in ScaleHeight

  const form = container.querySelector<HTMLElement>('.vb-form')!;
  const fileTop = [...form.querySelectorAll<HTMLElement>('.vb-menubar-top')].find(t => t.textContent === 'File')!;
  fileTop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  await settle();
  const draw = [...document.querySelectorAll<HTMLElement>('.vb-menudrop .menu98-item')].find(i => i.textContent?.includes('Draw'))!;
  draw.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  await settle();
  expect(out.slice(1)).toEqual([' 96 True', 'changed 1 ']);
  expect(seen).toEqual([8, ['mN=1', 'N=1'], '1', 'mN = 1', null]);
});
