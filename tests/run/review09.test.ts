// @vitest-environment jsdom
// Regression tests for the 0.9 language review (.superpowers/sdd/v09/review/lang.md), ADO findings #2 and #8.
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

/** Form_Load runs `body` after a Connection to /app/shop.db (made empty, Orders with Ann and Bob) is open as `cn`. */
async function run(body: string, db = new FakeDb({ separate: true })) {
  const p = newProject();
  p.forms = [newForm('Form1', `Private Sub Form_Load()
  Dim cn As New ADODB.Connection, cn2 As New ADODB.Connection, rs As ADODB.Recordset
  On Error GoTo bad
  cn.Open "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=shop.db"
  cn.Execute "CREATE TABLE Orders (ID INTEGER PRIMARY KEY, Name TEXT, Amount INTEGER)"
  cn.Execute "INSERT INTO Orders (Name, Amount) VALUES ('Ann', 12), ('Bob', 30)"
  cn2.Open "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=shop.db"
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

const count = 'cn.Execute("SELECT COUNT(*) AS c FROM Orders" & w)!c';

test('#2 each Connection has its own transaction: levels, Rollback and Close act on their own connection only', async () => {
  const { out } = await run(`  Dim w As String
  Debug.Print cn.BeginTrans; cn2.BeginTrans
  cn.Execute "DELETE FROM Orders WHERE Name = 'Ann'"
  cn.RollbackTrans
  cn2.CommitTrans
  w = " WHERE Name = 'Ann'": Debug.Print ${count}
  cn2.BeginTrans
  cn.BeginTrans
  cn.Execute "DELETE FROM Orders"
  cn2.Close
  cn.CommitTrans
  w = "": Debug.Print ${count}`);
  expect(out).toEqual([' 1  1 ', ' 1 ', ' 0 ']);
});

test('#8 AddNew FieldList, Values posts the record at once; Update Fields, Values writes the current one', async () => {
  const { out } = await run(`  Dim w As String
  Set rs = New ADODB.Recordset
  rs.Open "Orders", cn, adOpenKeyset, adLockOptimistic
  rs.AddNew Array("Name", "Amount"), Array("Zoe", 3)
  w = " WHERE Name = 'Zoe'": Debug.Print ${count}
  rs.Update "Amount", 4
  w = " WHERE Amount = 4": Debug.Print ${count}
  On Error Resume Next
  rs.AddNew Array("Name", "Amount"), Array("Q")
  Debug.Print Err.Number`);
  expect(out).toEqual([' 1 ', ' 1 ', ' 3001 ']);
});
