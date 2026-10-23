// @vitest-environment jsdom
// Data tips and Locals property rows never run program code, start a form method or load a form (review 0.9 #1).
import { afterEach, expect, test } from 'vitest';
import type { DebugNode } from '../../src/lang/interp/debugger';
import { newForm, newProject } from '../../src/model/controls';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

let session: RunSession | undefined;
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0)); };

const MODULE = `Sub Main()
    Dim f As Form2
    Set f = Form2
    Form1.Show
    Debug.Print "at"
    Debug.Print "end"; Forms.Count; Form1.Visible
End Sub`;
const FORM1 = `Public Total As Long
Public Function Twice() As Long
    Debug.Print "ran"
    Twice = 2
End Function`;
const FORM2 = `Private Sub Form_Load()
    Debug.Print "load2"
End Sub
Public Function PublicFunc() As Long
    Debug.Print "ran2"
End Function`;

test('a data tip reads properties and variables, never a method, a procedure or a property of an unloaded form', async () => {
  const p = newProject();
  p.forms = [newForm('Form1', FORM1), newForm('Form2', FORM2)];
  p.modules = [{ id: 'm1', name: 'Module1', code: MODULE }];
  p.subMain = true;
  const out: string[] = [];
  const tips: (string | null)[] = [];
  let rows: string[] = [];
  const container = document.body.appendChild(document.createElement('div'));
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onEnded: () => {}, readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
    onBreak: async () => {
      const dbg = session!.program.debug;
      tips.push(...['Form1.Total', 'Form1.Caption', 'Form2.Caption', 'Form1.Hide', 'Form1.Refresh', 'Form2.PublicFunc', 'Form1.Twice', 'Form2']
        .map(t => dbg.dataTip(t)));
      const f = dbg.locals(o => (o.vbTypeName === 'Form' ? ['Caption', 'Visible'] : [])).find(n => n.name === 'f')!;
      rows = f.children!().map((n: DebugNode) => `${n.name}=${n.value}`);
      return 'continue';
    },
  }, 'ide');
  session.setBreakpoints('Module1', [5]);
  await session.start();
  await settle();
  expect(tips).toEqual(['Form1.Total = 0', 'Form1.Caption = "Form1"', 'Form2.Caption = <not loaded>', null, null, null, null, null]);
  expect(rows).toEqual(['Caption=<not loaded>', 'Visible=<not loaded>']);
  expect(out).toEqual(['at', 'end 1 True']);   // Form1 still shown, Form2 never loaded, no procedure ran
});
