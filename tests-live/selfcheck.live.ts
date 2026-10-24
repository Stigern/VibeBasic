// @vitest-environment jsdom
// Self-test of the harness without a server: hand-written correct answers must pass the behaviour checks of their tasks,
// so a failed check in the live runs is the model's, not the check's.
import { expect, test } from 'vitest';
import { newControl } from '../src/model/controls';
import type { Project } from '../src/model/types';
import { Rt, runtimeBackend } from './runtime';
import { TASKS } from './tasks';

async function check(id: string, edit: (p: Project) => void): Promise<string[]> {
  const task = TASKS.find(t => t.id === id)!;
  const p = task.project();
  edit(p);
  const env = runtimeBackend();
  task.seed?.(env);
  const rt = new Rt(p, env);
  try {
    await rt.start();
    return [...(task.inspect?.(p) ?? []), ...await task.check!(rt, p)];
  } finally { rt.end(); }
}

test('c-ado: SubItems on a ListItem', async () => {
  expect(await check('c-ado', p => {
    p.forms[0].code = `Private Sub Form_Load()
    Dim cn As New ADODB.Connection, rs As New ADODB.Recordset, it As ListItem
    cn.Open "Data Source=people.db"
    rs.Open "SELECT Name, City FROM People ORDER BY Name", cn
    ListView1.View = 3
    ListView1.ColumnHeaders.Add , , "Name"
    ListView1.ColumnHeaders.Add , , "City"
    Do Until rs.EOF
        Set it = ListView1.ListItems.Add(, , rs!Name)
        it.SubItems(1) = rs!City
        rs.MoveNext
    Loop
End Sub`;
  })).toEqual([]);
});

test('f-tabstrip: SelectedItem.Index switches the frames', async () => {
  expect(await check('f-tabstrip', p => {
    const f = p.forms[0];
    const ts = newControl(f, 'TabStrip', { left: 120, top: 120, width: 4000, height: 2400 }, null);
    ts.name = 'TabStrip1'; ts.props.Tabs = ['General|g', 'Advanced|a'];
    f.controls.push(ts);
    for (const [n, vis] of [['fraGeneral', true], ['fraAdvanced', false]] as const) {
      const fr = newControl(f, 'Frame', { left: 240, top: 600, width: 3600, height: 1500 }, null);
      fr.name = n; fr.props.Visible = vis;
      f.controls.push(fr);
      const cb = newControl(f, 'CheckBox', { left: 120, top: 240 }, fr.id);
      f.controls.push(cb);
    }
    f.code = `Private Sub TabStrip1_Click()
    fraGeneral.Visible = (TabStrip1.SelectedItem.Index = 1)
    fraAdvanced.Visible = (TabStrip1.SelectedItem.Index = 2)
End Sub`;
  })).toEqual([]);
});

test('e-mismatch: a Val fix passes', async () => {
  expect(await check('e-mismatch', p => {
    p.forms[0].code = `Private Sub Command1_Click()
    Dim age As Integer
    age = Val(Text1.Text)
    Label1.Caption = "Next year you are " & (age + 1)
End Sub`;
  })).toEqual([]);
});
