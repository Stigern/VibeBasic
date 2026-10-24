// @vitest-environment jsdom
// Regression tests for the live evaluation (tests-live/report.md): syntax complaints the model can act on, and members of objects
// of known classes (ListItem, ADODB) and read-only properties in the AI code check.
import { expect, test } from 'vitest';
import { isSyntaxProblem, syntaxProblem, validateCode } from '../../src/ai/validate';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, FormDef } from '../../src/model/types';
import { ADO_CONNECTION_MEMBERS, ConnectionObject } from '../../src/run/data/dbObjects';
import { LIST_ITEM_MEMBERS, ListItem } from '../../src/run/objects/listCollections';

const add = (f: FormDef, type: Exclude<ControlType, 'Form'>, name: string) => {
  const c = newControl(f, type, { left: 0, top: 0 }, null);
  c.name = name;
  f.controls.push(c);
  return c;
};

// ---------------------------------------------------------------------------------------------------------------
// 3. Syntax complaints the model can act on

test('syntax problems quote the statement, say "code line" and give the expected form', () => {
  expect(syntaxProblem(17, 'Picture1.Scale (0, 8), (4, 0)', 'Expected: -'))
    .toBe('Code line 17 (`Picture1.Scale (0, 8), (4, 0)`): Expected: -. Scale takes two corners: Picture1.Scale (x1, y1)-(x2, y2), e.g. Picture1.Scale (0, 100)-(10, 0).');
  expect(syntaxProblem(3, 'Set li = ListView1.ListItems.Add , , rs("Name")', 'Expected: end of statement')).toContain('ListItems.Add takes (Index, Key, Text)');
  expect(syntaxProblem(4, 'Picture1.Line (0, 0), (5, 5)', 'Expected: -')).toContain('Line takes [(x1, y1)]-(x2, y2)');
  expect(syntaxProblem(5, 'Circle 5, 5, 3', 'x')).toContain('Circle takes (x, y), radius');
  expect(syntaxProblem(6, 'PSet 1, 2', 'x')).toContain('PSet takes (x, y)');
  expect(syntaxProblem(7, 'Label1.Caption = "Line 1" +', 'Expected: expression')).toBe('Code line 7 (`Label1.Caption = "Line 1" +`): Expected: expression.');
  expect(syntaxProblem(8, 'Line Input #1, s s', 'x')).not.toContain('Line takes');
  const p = validateCode('Private Sub Form_Paint()\n    Picture1.Scale (0, 8), (4, 0)\nEnd Sub', { moduleName: 'Form1', form: null });
  expect(p[0]).toMatch(/^Code line 2 \(`Picture1\.Scale \(0, 8\), \(4, 0\)`\): .* Scale takes two corners/);
  expect(p.every(isSyntaxProblem)).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------
// 9. Validator: objects of known classes

test('validator: ADODB objects from CreateObject / New and ListItems are checked against the run-time members', () => {
  const p = newProject();
  const f = p.forms[0];
  add(f, 'ListView', 'ListView1');
  const check = (body: string) => validateCode(`Private Sub Form_Load()\n${body}\nEnd Sub`, { moduleName: 'Form1', form: f, project: p });
  expect(check('    Dim rs As Object\n    Set rs = CreateObject("ADODB.Recordset")\n    rs.Open "SELECT 1"\n    rs.MoveNext\n    rs.Seek 1')).toEqual(['rs is a ADODB.Recordset, which has no Seek method; it has the ADO members (Open, MoveNext, EOF, Fields, AddNew, Update, Find, Filter ...).']);
  expect(check('    Dim cn As New ADODB.Connection\n    cn.Open "Data Source=x.db"\n    cn.Execute "x"\n    cn.Fetch')).toHaveLength(1);
  expect(check('    Dim it\n    For Each it In ListView1.ListItems\n        it.SubItems(1) = "x"\n        it.Bold = True\n    Next')).toEqual([expect.stringMatching(/^it is a ListItem, which has no Bold property/)]);
  // set from something else as well: not certain, not checked
  expect(check('    Dim o As Object\n    Set o = CreateObject("ADODB.Recordset")\n    Set o = Me\n    o.Anything')).toEqual([]);
  expect(check('    Dim it As Object\n    Set it = ListView1.SelectedItem\n    Debug.Print it.Text, it.Index, it.Selected')).toEqual([]);
});

test('the member lists of the check match the run-time objects', () => {
  const item = new ListItem({ Text: 'a' }, { is: () => false, pick: () => {} });
  for (const m of LIST_ITEM_MEMBERS) expect(item.hasMember(m) || m === 'index').toBe(true);
  expect(item.hasMember('listsubitems')).toBe(false);
  const cn = new ConnectionObject(null, '');
  for (const m of ADO_CONNECTION_MEMBERS.filter(m => !['open', 'close', 'execute', 'begintrans', 'committrans', 'rollbacktrans'].includes(m))) expect(cn.hasMember(m)).toBe(true);
});


test('validator: a property that is read-only at run time set in code (WindowList, error 383)', () => {
  const f = newForm('Form1');
  const m = newControl(f, 'Menu', { left: 0, top: 0 }, null);
  m.name = 'mnuWindow';
  f.controls.push(m);
  expect(validateCode('Private Sub Form_Load()\n    mnuWindow.WindowList = True\n    mnuWindow.Caption = "&Window"\nEnd Sub', { moduleName: 'Form1', form: f }))
    .toEqual(['mnuWindow.WindowList is read-only at run time (error 383); it is set at design time, not in code.']);
});

test('validator: a form property that is read-only at run time (f.MDIChild = True on a New Form1, error 383)', () => {
  const p = newProject();
  const f = p.forms[0];
  const check = (body: string) => validateCode(`Private Sub Form_Load()\n${body}\nEnd Sub`, { moduleName: 'Form1', form: f, project: p });
  expect(check('    Dim f As Form1\n    Set f = New Form1\n    f.MDIChild = True\n    f.Caption = "x"\n    f.Show'))
    .toEqual(['f.MDIChild is read-only at run time (error 383); it is set at design time, not in code.']);
  expect(check('    Me.BorderStyle = 1')).toEqual(['Me.BorderStyle is read-only at run time (error 383); it is set at design time, not in code.']);
  expect(check('    Me.Caption = "ok"\n    Form1.Caption = "ok"')).toEqual([]);
});
