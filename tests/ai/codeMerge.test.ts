// Regressions of the code-mode merge (review of 0.10, findings 1-8 and 17): the merged module stays well-formed.
import { expect, test } from 'vitest';
import { applyCodeProposal, mergeRefusal } from '../../src/ai/codeMode';
import { parseModuleLenient } from '../../src/lang/parser';

const L = (...ls: string[]) => ls.join('\n');
const errors = (src: string) => parseModuleLenient(src, 'Module1').errors.map(e => e.message);
const apply = (src: string, code: string, proc: string | null = null) => applyCodeProposal(src, code, proc);

test('#1 declarations never go inside a Type or Enum block', () => {
  for (const block of [L('Private Type Pt', '    X As Long', 'End Type'), L('Public Enum Colour', '    Red', '    Green', 'End Enum')]) {
    const src = L('Option Explicit', block, '', 'Sub Main()', 'End Sub');
    const r = apply(src, L('Dim count As Long', 'Sub Main()', '    count = 1', 'End Sub'))!;
    expect(r.source).toBe(L('Option Explicit', block, 'Dim count As Long', '', 'Sub Main()', '    count = 1', 'End Sub'));
    expect(errors(r.source)).toEqual([]);
  }
});

test('#2 declarations never go into the middle of a continued line', () => {
  const src = L('Private Const GREETING As String = "Hello, " & _', '    "world"', '', 'Sub Main()', 'End Sub');
  const r = apply(src, L('Dim t As Long', 'Sub Main()', '    t = 1', 'End Sub'))!;
  expect(r.source).toBe(L('Private Const GREETING As String = "Hello, " & _', '    "world"', 'Dim t As Long', '', 'Sub Main()', '    t = 1', 'End Sub'));
  expect(errors(r.source)).toEqual([]);
});

test('#3 a bare body keeps every line of a continued procedure header', () => {
  const src = L('Private Sub Foo(ByVal a As Long, _', '    ByVal b As Long)', '    Debug.Print a', 'End Sub');
  const r = apply(src, '    Debug.Print a + b', 'Foo')!;
  expect(r.source).toBe(L('Private Sub Foo(ByVal a As Long, _', '    ByVal b As Long)', '    Debug.Print a + b', 'End Sub'));
  expect(errors(r.source)).toEqual([]);
});

test('#4 a bare body ending in End Sub does not close the procedure twice', () => {
  const r = apply(L('Private Sub Foo()', '    Debug.Print 1', 'End Sub'), L('    Debug.Print 2', 'End Sub'), 'Foo')!;
  expect(r.source).toBe(L('Private Sub Foo()', '    Debug.Print 2', 'End Sub'));
});

test('#5 #If blocks of the answer stay whole, and new declarations never go inside an #If block', () => {
  const reply = L('#Const BETA = 0', '#If BETA Then', '    Const TITLE = "Beta"', '#Else', '    Const TITLE = "Release"', '#End If', 'Sub Main()', '    MsgBox TITLE', 'End Sub');
  const a = apply(L('Option Explicit', '', 'Sub Main()', 'End Sub'), reply)!;
  expect(a.source).toBe(L('Option Explicit', '#Const BETA = 0', '#If BETA Then', '    Const TITLE = "Beta"', '#Else', '    Const TITLE = "Release"', '#End If',
    '', 'Sub Main()', '    MsgBox TITLE', 'End Sub'));
  const src = L('#If DEBUG_MODE Then', 'Const A = 2', '#Else', 'Const A = 0', '#End If', '', 'Sub Main()', 'End Sub');
  const b = apply(src, L('Dim n As Long', 'Sub Main()', '    n = A', 'End Sub'))!;
  expect(b.source).toBe(L('#If DEBUG_MODE Then', 'Const A = 2', '#Else', 'Const A = 0', '#End If', 'Dim n As Long', '', 'Sub Main()', '    n = A', 'End Sub'));
});

test('#6 a continued Dim of the answer is kept whole', () => {
  const r = apply(L('Option Explicit', '', 'Sub Main()', 'End Sub'), L('Dim a As Long, _', '    b As Long', 'Sub Main()', '    a = b', 'End Sub'))!;
  expect(r.source).toBe(L('Option Explicit', 'Dim a As Long, _', '    b As Long', '', 'Sub Main()', '    a = b', 'End Sub'));
  expect(errors(r.source)).toEqual([]);
  // a bare reply of one continued Dim is a declaration too, not a body
  const d = apply(L('Option Explicit', '', 'Sub Main()', 'End Sub'), L('Dim c As Long, _', '    d As Long'), 'Main')!;
  expect(d.changes).toEqual([{ name: '(Declarations)', kind: 'declarations' }]);
});

test('#7 declarations between procedures go to the declarations section; each procedure keeps its comment block', () => {
  const src = L('Option Explicit', '', 'Sub Main()', 'End Sub');
  const reply = L('Sub Main()', '    counter = counter + 1', 'End Sub', '', 'Dim counter As Long', '', "' The other one", 'Sub Other()', 'End Sub');
  const r = apply(src, reply)!;
  expect(r.source).toBe(L('Option Explicit', 'Dim counter As Long', '', 'Sub Main()', '    counter = counter + 1', 'End Sub', '', "' The other one", 'Sub Other()', 'End Sub'));
});

test('#8 replacing a procedure keeps its Attribute lines', () => {
  const src = L('Public Property Get Item(i As Long) As Variant', 'Attribute Item.VB_UserMemId = 0', '    Item = 1', 'End Property');
  const r = apply(src, L('Public Property Get Item(i As Long) As Variant', '    Item = i * 2', 'End Property'))!;
  expect(r.source).toBe(L('Public Property Get Item(i As Long) As Variant', 'Attribute Item.VB_UserMemId = 0', '    Item = i * 2', 'End Property'));
  // a bare body keeps them too
  expect(apply(src, '    Item = 3', 'Item')!.source).toBe(L('Public Property Get Item(i As Long) As Variant', 'Attribute Item.VB_UserMemId = 0', '    Item = 3', 'End Property'));
});

test('#17 a changed declaration replaces the old one', () => {
  const src = L('Option Explicit', "' running total", 'Dim total As Integer', '', 'Sub Main()', 'End Sub');
  const r = apply(src, L("' running total", 'Dim total As Long', 'Sub Main()', '    total = 1', 'End Sub'))!;
  expect(r.source).toBe(L('Option Explicit', "' running total", 'Dim total As Long', '', 'Sub Main()', '    total = 1', 'End Sub'));
  // two existing declarations declared again on one line
  const two = apply(L('Dim a As Integer', 'Dim b As Integer', '', 'Sub Main()', 'End Sub'), L('Dim a As Long, b As Long', 'Sub Main()', 'End Sub'))!;
  expect(two.source).toBe(L('Dim a As Long, b As Long', '', 'Sub Main()', 'End Sub'));
});

test('the merge refuses a result with more syntax errors than the module and the answer had, or a name declared twice', () => {
  expect(mergeRefusal('Sub A()\nEnd Sub', 'Sub A()\nEnd Sub\nEnd Sub')).toMatch(/^Merging the answer into the module would break it:\nLine 3: /);
  expect(mergeRefusal('Sub A()\nEnd Sub', 'Sub A()\n    If x Then\nEnd Sub', 1)).toBeNull();   // the answer's own error: shown in the preview
  expect(mergeRefusal('Dim a, b\nSub A()\nEnd Sub', 'Dim a, b\nDim a As Long\nSub A()\nEnd Sub')).toBe('Merging the answer into the module would declare a twice.');
  // a partial redeclaration is not merged into a duplicate: refused, with the reason
  const out: { refused?: string } = {};
  expect(applyCodeProposal(L('Dim a, b', '', 'Sub Main()', 'End Sub'), L('Dim a As Long', 'Sub Main()', 'End Sub'), null, null, out)).toBeNull();
  expect(out.refused).toBe('Merging the answer into the module would declare a twice.');
});

test('a stub of a procedure with a continued header keeps the real procedure', () => {
  const src = L('Private Sub Foo(ByVal a As Long, _', '    ByVal b As Long)', '    Debug.Print a', 'End Sub');
  for (const stub of [L('Private Sub Foo(ByVal a As Long, _', '    ByVal b As Long)', "' ... (body omitted)"), L('Private Sub Foo(ByVal a As Long, _', "' ... (body omitted)")]) {
    expect(apply(src, stub)).toEqual({ source: src, changes: [], skipped: ['Foo'] });
  }
});
