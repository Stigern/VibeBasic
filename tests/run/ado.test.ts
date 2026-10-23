// @vitest-environment jsdom
// 0.9 A3: ADO in code (New ADODB.Connection / Recordset / Command, CreateObject), Filter / Sort, transactions.
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { newForm, newProject } from '../../src/model/controls';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';
import { FakeDb } from './fakeDb';

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 40)); };

/** Form_Load runs `body` after a Connection to /app/shop.db (made empty) is open as `cn`. */
async function run(body: string, db = new FakeDb()) {
  const p = newProject();
  p.forms = [newForm('Form1', `Private Sub Form_Load()
  Dim cn As New ADODB.Connection, rs As ADODB.Recordset, s As String, n As Long
  On Error GoTo bad
  cn.Open "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=shop.db"
  cn.Execute "CREATE TABLE Orders (ID INTEGER PRIMARY KEY, Name TEXT, Amount INTEGER)"
  cn.Execute "INSERT INTO Orders (Name, Amount) VALUES ('Ann', 12), ('Bob', 30), ('Abe', 5), ('Amy', 40)", n
${body}
  Exit Sub
bad:
  Debug.Print "error " & Err.Number & " " & Err.Description
End Sub`)];
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container, db as unknown as Backend), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  return { out, db };
}

test('Connection.Open on a db file, Execute CREATE / INSERT (RecordsAffected), Execute SELECT and loop', async () => {
  const { out, db } = await run(`  Debug.Print "inserted " & n & " state " & cn.State
  Set rs = cn.Execute("SELECT Name, Amount FROM Orders ORDER BY ID")
  Do Until rs.EOF
    s = s & rs!Name & "=" & rs("Amount") & " "
    rs.MoveNext
  Loop
  Debug.Print s
  cn.Close
  Debug.Print cn.State`);
  expect(out).toEqual(['inserted 4 state 1', 'Ann=12 Bob=30 Abe=5 Amy=40 ', ' 0 ']);
  expect(db.calls).toContain('open /app/shop.db');
});

test('Recordset.Open with a lock type: Filter with And / Like, Sort DESC, AddNew, Clone, Supports; read-only by default; Fields.Append', async () => {
  const { out } = await run(`  Set rs = New ADODB.Recordset
  rs.Open "Orders", cn, adOpenStatic, adLockOptimistic, adCmdTable
  rs.Filter = "Amount > 10 And Name Like 'A*'"
  Debug.Print rs.RecordCount & " " & rs!Name & " " & rs.Filter
  rs.Filter = adFilterNone
  rs.Sort = "Name DESC"
  Do Until rs.EOF: s = s & rs!Name & " ": rs.MoveNext: Loop
  Debug.Print s & rs.RecordCount
  rs.AddNew: rs!Name = "Cy": rs!Amount = 1: rs.Update
  Debug.Print rs.Clone.RecordCount & " " & rs.Supports(adAddNew) & " " & rs.Supports(adSeek)
  Dim r2 As Object
  Set r2 = CreateObject("ADODB.Recordset")
  r2.Open "SELECT * FROM Orders WHERE Amount < 10", cn
  Debug.Print r2.RecordCount & " " & r2.LockType & " " & r2.Supports(adUpdate)
  Dim m As New ADODB.Recordset
  m.Fields.Append "Item", adVarChar, 20
  m.Open , , , adLockOptimistic
  m.AddNew: m!Item = "x": m.Update: m.AddNew: m!Item = "a": m.Update
  m.Sort = "Item": Debug.Print m.RecordCount & m!Item & m.Fields(0).Type
  On Error Resume Next
  r2.AddNew
  Debug.Print Err.Number
  rs.Filter = "Nope = 1"
  Debug.Print Err.Number`);
  expect(out).toEqual(['2 Ann Amount > 10 And Name Like \'A*\'', 'Bob Ann Amy Abe 4', '5 True False', '2 1 False', '2a202', ' 3251 ', ' 3265 ']);
});

test('BeginTrans / RollbackTrans undoes the changes; CommitTrans keeps them; a Command with ? parameters', async () => {
  const { out } = await run(`  Debug.Print cn.BeginTrans
  cn.Execute "DELETE FROM Orders"
  cn.RollbackTrans
  Debug.Print cn.Execute("SELECT COUNT(*) AS c FROM Orders")!c
  cn.BeginTrans
  cn.Execute "DELETE FROM Orders WHERE Name = 'Bob'"
  cn.CommitTrans
  Dim cmd As New ADODB.Command
  Set cmd.ActiveConnection = cn
  cmd.CommandText = "SELECT Name FROM Orders WHERE Amount > ? ORDER BY Name"
  cmd.Parameters.Append cmd.CreateParameter("min", adInteger, adParamInput, , 10)
  Set rs = cmd.Execute
  Do Until rs.EOF: s = s & rs!Name & " ": rs.MoveNext: Loop
  Debug.Print s
  On Error Resume Next
  cn.CommitTrans
  Debug.Print Err.Number & " " & Err.Description`);
  expect(out).toEqual([' 1 ', ' 4 ', 'Amy Ann ', '-2147168242 No transaction is active.']);
});
