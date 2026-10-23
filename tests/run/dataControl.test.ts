// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';
import { FakeDb } from './fakeDb';

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 40)); };

/** People(ID, Name, Age) with Ann 31, Bob 42, Cid 25 in /app/people.db. */
function peopleDb(): FakeDb {
  const db = new FakeDb();
  db.db('/app/people.db').exec(`CREATE TABLE People (ID INTEGER PRIMARY KEY, Name TEXT NOT NULL, Age INTEGER, Member BOOLEAN);
    INSERT INTO People (Name, Age, Member) VALUES ('Ann', 31, 1), ('Bob', 42, 0), ('Cid', 25, 1);`);
  return db;
}

type Ctl = [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?];
async function run(code: string, controls: Ctl[], db = peopleDb()) {
  const p = newProject();
  p.forms = [newForm('Form1', code)];
  for (const [type, name, props] of controls) {
    const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    p.forms[0].controls.push(c);
  }
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container, db as unknown as Backend), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  const el = (name: string) => container.querySelector<HTMLElement>(`[data-control-id="${p.forms[0].controls.find(c => c.name === name)!.id}"]`)!;
  return { out, db, p, el };
}
const DATA: Ctl = ['Data', 'Data1', { DatabaseName: 'people.db', RecordSource: 'People' }];

test('Data1.Recordset: navigation with BOF / EOF, Fields, RecordCount, Reposition and Validate', async () => {
  const { out, el } = await run(`
Private Sub Data1_Reposition()
  Debug.Print "repos"
End Sub
Private Sub Data1_Validate(Action As Integer, Save As Integer)
  Debug.Print "validate " & Action & " " & Save
End Sub
Private Sub Command1_Click()
  Dim rs As Recordset, s As String
  Set rs = Data1.Recordset
  s = rs.RecordCount & " " & rs.BOF & " " & rs.EOF & ":"
  Do Until rs.EOF
    s = s & " " & rs.Fields("Name").Value & "/" & rs("Age") & "/" & rs.Fields(0)
    rs.MoveNext
  Loop
  Debug.Print s & " eof=" & rs.EOF
  rs.MovePrevious
  Debug.Print rs!Name & " " & rs.AbsolutePosition & " " & rs.Fields.Count & " " & rs.Fields(1).Name
  rs.MoveFirst
  rs.MovePrevious
  Debug.Print "bof=" & rs.BOF
  On Error Resume Next
  rs.MovePrevious
  Debug.Print "err " & Err.Number
End Sub`, [DATA, ['CommandButton', 'Command1']]);
  expect(out).toEqual(['repos']);   // the recordset opened after Form_Load
  out.length = 0;
  el('Command1').querySelector('button')!.click();
  await settle();
  // Validate and Reposition come with every move made by code (Save is an Integer: 0)
  expect(out.filter(l => l === 'validate 3 0')).toHaveLength(3);
  expect(out.filter(l => l === 'repos')).toHaveLength(6);
  expect(out.filter(l => l !== 'repos' && !l.startsWith('validate'))).toEqual([
    '3 False False: Ann/31/1 Bob/42/2 Cid/25/3 eof=True', 'Cid 2 4 Name', 'bof=True', 'err 3021']);
});

test('a bound TextBox shows the field; an edit is saved on MoveNext (the arrow button) and DataChanged is reset', async () => {
  const { out, db, el } = await run(`
Private Sub Data1_Reposition()
  Debug.Print "show " & Text1.Text & " " & Check1.Value & " " & Text1.DataChanged
End Sub
Private Sub Data1_Validate(Action As Integer, Save As Integer)
  Debug.Print "validate " & Action & " " & Save & " " & Text1.DataChanged
End Sub`, [DATA, ['TextBox', 'Text1', { DataSource: 'Data1', DataField: 'Name' }], ['CheckBox', 'Check1', { DataSource: 'Data1', DataField: 'Member' }]]);
  expect(out).toEqual(['show Ann 1 False']);
  const input = el('Text1').querySelector('input')!;
  input.value = 'Anna';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  el('Data1').querySelector<HTMLElement>('[data-nav="next"]')!.click();
  await settle();
  expect(out).toContain('validate 3 -1 True');
  expect(out[out.length - 1]).toBe('show Bob 0 False');
  expect(db.db('/app/people.db').prepare('SELECT Name FROM People WHERE ID = 1').get()).toEqual({ Name: 'Anna' });
  expect(db.calls.some(c => c.startsWith('exec UPDATE "People" SET "Name" = ? WHERE rowid = ? ["Anna",1]'))).toBe(true);
});

test('AddNew + Update (DAO and through a bound control), Edit, Delete, FindFirst, Database.Execute; rs!Name', async () => {
  const { out, db, el } = await run(`
Private Sub Command1_Click()
  Dim rs As Recordset
  Set rs = Data1.Recordset
  rs.AddNew
  rs!Name = "Dan"
  rs("Age") = 50
  rs.Update
  Debug.Print rs.RecordCount & " " & rs!Name
  rs.Bookmark = rs.LastModified
  Debug.Print rs!Name & " " & rs!Age & " " & rs!ID
  rs.Edit
  rs!Age = rs!Age + 1
  rs.Update
  rs.FindFirst "Name = 'bob'"
  Debug.Print rs.NoMatch & " " & rs!Name
  rs.Delete
  rs.MoveNext
  Debug.Print rs!Name
  rs.FindFirst "Age > 100"
  Debug.Print rs.NoMatch & " " & rs!Name
  On Error Resume Next
  rs!Name = "x"
  Debug.Print "no edit " & Err.Number
  Err.Clear
  Data1.Database.Execute "UPDATE People SET Age = Age * 2 WHERE Name = 'Ann'"
  Debug.Print "affected " & Data1.Database.RecordsAffected
  rs.Requery
  Debug.Print rs.RecordCount & " " & rs!Age
End Sub
Private Sub Command2_Click()
  Data1.Recordset.AddNew
  Text1.Text = "Eve"
  Data1.Recordset.Update
End Sub`, [DATA, ['CommandButton', 'Command1'], ['CommandButton', 'Command2'], ['TextBox', 'Text1', { DataSource: 'Data1', DataField: 'Name' }]]);
  el('Command1').querySelector('button')!.click();
  await settle();
  expect(out).toEqual(['4 Ann', 'Dan 50 4', 'False Bob', 'Cid', 'True Cid', 'no edit 3020', 'affected 1', '3 62']);
  const rows = () => db.db('/app/people.db').prepare('SELECT Name, Age FROM People ORDER BY ID').all();
  expect(rows()).toEqual([{ Name: 'Ann', Age: 62 }, { Name: 'Cid', Age: 25 }, { Name: 'Dan', Age: 51 }]);
  el('Command2').querySelector('button')!.click();
  await settle();
  expect(rows().map(r => (r as { Name: string }).Name)).toEqual(['Ann', 'Cid', 'Dan', 'Eve']);
});

test('Adodc: ConnectionString Data Source, WillMove / MoveComplete, ADO edit saved by a move, ActiveConnection.Execute', async () => {
  const { out, db, el } = await run(`
Private Sub Adodc1_WillMove(ByVal adReason As ADODB.EventReasonEnum, adStatus As ADODB.EventStatusEnum, ByVal pRecordset As ADODB.Recordset)
  If adReason = adRsnMoveLast Then adStatus = adStatusCancel
End Sub
Private Sub Adodc1_MoveComplete(ByVal adReason As ADODB.EventReasonEnum, ByVal pError As ADODB.Error, adStatus As ADODB.EventStatusEnum, ByVal pRecordset As ADODB.Recordset)
  If pRecordset.EOF Then Debug.Print "moved eof" Else Debug.Print "moved " & adReason & " " & pRecordset!Name
End Sub
Private Sub Command1_Click()
  Dim rs As ADODB.Recordset, n As Long
  Set rs = Adodc1.Recordset
  rs!Age = 99
  rs.MoveNext
  rs.MoveLast
  Debug.Print rs.AbsolutePosition & " " & rs.EditMode
  rs.Find "Name = 'Cid'"
  Debug.Print rs!Name & " " & rs.AbsolutePosition
  rs.Find "Name = 'Zed'"
  Debug.Print "eof " & rs.EOF
  rs.ActiveConnection.Execute "DELETE FROM People WHERE Age = 42", n
  Debug.Print "deleted " & n
  Dim r2 As ADODB.Recordset
  Set r2 = rs.ActiveConnection.Execute("SELECT COUNT(*) AS c FROM People")
  Debug.Print "count " & r2!c
End Sub`, [['Adodc', 'Adodc1', { ConnectionString: 'Provider=Microsoft.Jet.OLEDB.4.0;Data Source=people.db', RecordSource: 'SELECT * FROM People ORDER BY Name' }], ['CommandButton', 'Command1']]);
  expect(out).toEqual(['moved 10 Ann']);
  out.length = 0;
  el('Command1').querySelector('button')!.click();
  await settle();
  expect(out).toEqual(['moved 13 Bob', '2 0', 'moved 10 Cid', 'Cid 3', 'moved eof', 'eof True', 'deleted 1', 'count 2']);
  expect(db.db('/app/people.db').prepare('SELECT Age FROM People WHERE Name = \'Ann\'').get()).toEqual({ Age: 99 });
});

test('DataGrid shows the records under column headers; a click moves the recordset, an edited cell is saved', async () => {
  const { out, db, el } = await run(`
Private Sub DataGrid1_RowColChange(LastRow As Variant, ByVal LastCol As Integer)
  Debug.Print "rowcol " & DataGrid1.Row & " " & DataGrid1.Col & " " & Adodc1.Recordset!Name
End Sub
Private Sub DataGrid1_AfterColUpdate(ByVal ColIndex As Integer)
  Debug.Print "after " & ColIndex & " " & DataGrid1.Columns(ColIndex).Value
End Sub
Private Sub Command1_Click()
  DataGrid1.Columns(1).Caption = "Who"
  Debug.Print DataGrid1.Columns.Count & " " & DataGrid1.Columns(0).Caption & " " & DataGrid1.Columns("Age").ColIndex & " " & DataGrid1.ApproxCount
End Sub`, [['Adodc', 'Adodc1', { ConnectionString: 'Data Source=people.db', RecordSource: 'People' }], ['DataGrid', 'DataGrid1', { DataSource: 'Adodc1' }], ['CommandButton', 'Command1']]);
  const grid = el('DataGrid1');
  const texts = (sel: string) => [...grid.querySelectorAll(sel)].map(e => e.textContent);
  expect(texts('th')).toEqual(['', 'ID', 'Name', 'Age', 'Member']);
  expect([...grid.querySelectorAll('tr[data-r]')].map(tr => [...tr.querySelectorAll('td[data-c]')].map(td => td.textContent).join(','))).toEqual(['1,Ann,31,True', '2,Bob,42,False', '3,Cid,25,True']);
  expect(grid.querySelector('tr[data-r="0"] td.dg-sel')!.textContent).toBe('▶');
  el('Command1').querySelector('button')!.click();
  await settle();
  expect(out).toEqual(['4 ID 2 3']);
  expect(texts('th')[2]).toBe('Who');
  grid.querySelector<HTMLElement>('td[data-r="1"][data-c="1"]')!.click();
  await settle();
  expect(out[out.length - 1]).toBe('rowcol 1 1 Bob');
  grid.querySelector<HTMLElement>('td[data-r="2"][data-c="2"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const editor = grid.querySelector<HTMLInputElement>('input.dg-editor')!;
  editor.value = '26';
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(out).toContain('rowcol 2 2 Cid');
  expect(out[out.length - 1]).toBe('after 2 26');
  expect(db.db('/app/people.db').prepare('SELECT Age FROM People WHERE Name = \'Cid\'').get()).toEqual({ Age: 26 });
  expect(grid.querySelector('td[data-r="2"][data-c="2"]')!.textContent).toBe('26');
});

test('DataCombo: the list from RowSource, BoundText from the bound field, a pick is saved to the DataField', async () => {
  const db = peopleDb();
  db.db('/app/people.db').exec(`CREATE TABLE Orders (ID INTEGER PRIMARY KEY, Item TEXT, PersonID INTEGER);
    INSERT INTO Orders (Item, PersonID) VALUES ('Pen', 2), ('Cup', 3);`);
  const { out, el } = await run(`
Private Sub Command1_Click()
  Debug.Print DataCombo1.BoundText & " " & DataCombo1.Text & " " & DataCombo1.MatchedWithList
  DataCombo1.BoundText = "3"
  Debug.Print DataCombo1.Text & " " & DataCombo1.DataChanged
  DataCombo1.BoundText = "2"
End Sub`, [DATA, ['Data', 'Data2', { DatabaseName: 'people.db', RecordSource: 'SELECT * FROM Orders' }],
    ['DataCombo', 'DataCombo1', { RowSource: 'Data1', ListField: 'Name', BoundColumn: 'ID', DataSource: 'Data2', DataField: 'PersonID', Style: 2 }],
    ['CommandButton', 'Command1']], db);
  const combo = el('DataCombo1');
  expect([...combo.querySelectorAll('.vb-item')].map(e => e.textContent)).toEqual(['Ann', 'Bob', 'Cid']);
  expect(combo.querySelector('input')!.value).toBe('Bob');
  el('Command1').querySelector('button')!.click();
  await settle();
  expect(out).toEqual(['2 Bob True', 'Cid True']);
  // the user picks Ann; the next record of Data2 saves PersonID = 1 for the Pen
  combo.querySelector<HTMLElement>('.vb-item[data-i="0"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el('Data2').querySelector<HTMLElement>('[data-nav="next"]')!.click();
  await settle();
  expect(db.db('/app/people.db').prepare('SELECT PersonID FROM Orders ORDER BY ID').all()).toEqual([{ PersonID: 1 }, { PersonID: 3 }]);
  expect(combo.querySelector('input')!.value).toBe('Cid');
});

test('rs!Name and rs![Field Name] parse as rs("Name")', async () => {
  const { parseExpression } = await import('../../src/lang/exprParser');
  const { exprToString } = await import('../../src/lang/ast');
  expect(exprToString(parseExpression('rs!Name'))).toBe('(call rs "Name")');
  expect(exprToString(parseExpression('Data1.Recordset![Order Date] & x!'))).toBe('(& (call (. Data1 Recordset) "Order Date") x!)');
});
