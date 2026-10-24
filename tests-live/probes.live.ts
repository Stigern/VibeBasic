// @vitest-environment jsdom
// Offline probes of the AI code that the live runs pointed at (no server needed). They first pinned down the behaviour the
// report (report.md, "Bugs in VibeBasic's AI code") describes; each is now turned around to the fixed behaviour.
import { expect, test } from 'vitest';
import { applyCodeProposal } from '../src/ai/codeMode';
import { describeControlTypes } from '../src/ai/context';
import { isQuestion } from '../src/ai/answerDialog';
import { parseFormOps } from '../src/ai/formMode';
import { LANGUAGE_REFERENCE } from '../src/ai/langReference';
import { validateCode } from '../src/ai/validate';
import { findSyntaxErrors } from '../src/lang/parser';
import { newControl, newForm, newProject } from '../src/model/controls';

test('bug 4 (fixed): a changed module-level declaration replaces the old one', () => {
  const src = 'Option Explicit\nDim items As Collection\nPrivate Sub Form_Load()\n    items.Add 1\nEnd Sub';
  const code = 'Dim items As New Collection\nPrivate Sub Form_Load()\n    items.Add 1\nEnd Sub';
  const r = applyCodeProposal(src, code, 'Form_Load')!;
  expect(r.source.split('\n').slice(0, 3)).toEqual(['Option Explicit', 'Dim items As New Collection', 'Private Sub Form_Load()']);
  expect(findSyntaxErrors(r.source, 'Form1')).toEqual([]);
  const c = applyCodeProposal('Const MAX = 5\nPrivate Sub A()\nEnd Sub', 'Const MAX = 10\nPrivate Sub A()\n    Debug.Print MAX\nEnd Sub', 'A')!;
  expect(c.source.startsWith('Const MAX = 10\nPrivate Sub A()')).toBe(true);
});

test('bug 3 (fixed): "set" with the form\'s own name is a form op', () => {
  const f = newForm('Form1');
  const r = parseFormOps('{"ops":[{"op":"set","name":"Form1","props":{"Caption":"Main","MDIChild":true}}]}', f);
  expect(r.ok && r.ops).toEqual([{ op: 'form', props: { Caption: 'Main', MDIChild: true } }]);
});

test('bug 2 / 9 (fixed): an invalid value is a problem for the check-and-fix round, with the valid values; SSTab Tabs captions are taken', () => {
  const f = newForm('Form1');
  const r = parseFormOps('{"ops":[{"op":"form","props":{"StartUpPosition":4}},{"op":"add","type":"SSTab","name":"t","props":{"Tabs":"General\\nView\\nAdvanced"}}]}', f);
  if (!r.ok) throw new Error('not parsed');
  expect(r.issues).toEqual(['Ignored invalid value 4 for StartUpPosition on Form1 (valid: 0 Manual, 1 CenterOwner, 2 CenterScreen, 3 Windows Default).']);
  expect(r.ops[0]).toMatchObject({ op: 'add', type: 'SSTab', props: { TabCaption: ['General', 'View', 'Advanced'], Tabs: 3 } });
});

test('bug 5 (fixed): the system prompt no longer says there is no New ADODB.Connection', () => {
  expect(describeControlTypes()).not.toContain('there is no New ADODB.Connection');
  expect(LANGUAGE_REFERENCE).toMatch(/CreateObject\(ProgID\) or New: .*ADODB\.Connection/);
});

test('bug 9 (fixed): StartUpPosition, WindowState and the Form\'s BorderStyle carry their values', () => {
  const form = describeControlTypes().split('\n').find(l => l.startsWith('Form:'))!;
  expect(form).toContain('StartUpPosition(0 Manual,1 CenterOwner,2 CenterScreen,3 Windows Default)');
  expect(form).toContain('WindowState(0 Normal,1 Minimized,2 Maximized)');
  expect(form).toContain('BorderStyle(0 None,1 Fixed Single,2 Sizable,3 Fixed Dialog,4 Fixed ToolWindow,5 Sizable ToolWindow)');
});

test('isQuestion (fixed): the common question openings count', () => {
  expect(['How do I make an MDI app?', 'Can you explain this?', "What's wrong with this code?", 'Is this correct?', 'Why does this give error 13?'].map(isQuestion))
    .toEqual([true, true, true, true, true]);
});

test('bug 8 (fixed): members of a ListItem from ListItems.Add are checked (ListSubItems failed with 438)', () => {
  const p = newProject();
  const f = p.forms[0];
  const lv = newControl(f, 'ListView', { left: 0, top: 0 }, null);
  lv.name = 'ListView1';
  f.controls.push(lv);
  const code = 'Private Sub Form_Load()\n    Dim it As Object\n    Set it = ListView1.ListItems.Add(, , "x")\n    it.ListSubItems.Add 1, , "y"\nEnd Sub';
  expect(validateCode(code, { moduleName: 'Form1', form: f, project: p })).toEqual([expect.stringMatching(/^it is a ListItem, which has no ListSubItems property; it has Text, .*SubItems\(i\)/)]);
  const typed = 'Private Sub Form_Load()\n    Dim it As ListItem\n    Set it = ListView1.ListItems.Add(, , "x")\n    it.ListSubItems.Add 1, , "y"\nEnd Sub';
  expect(validateCode(typed, { moduleName: 'Form1', form: f, project: p })).toHaveLength(1);
});

test('...and VibeBasic runs the module with both declarations (the later one wins; VB6 says Duplicate declaration)', async () => {
  const { Rt, runtimeBackend } = await import('./runtime');
  const p = newProject();
  p.forms[0].code = 'Dim items As Collection\nDim items As New Collection\nPrivate Sub Form_Load()\n    items.Add "a"\n    Debug.Print items.Count\nEnd Sub';
  const rt = new Rt(p, runtimeBackend());
  let started = 'ok';
  try { await rt.start(); } catch (e) { started = e instanceof Error ? e.message : String(e); }
  const seen = { started, errors: rt.host?.errors.map(e => `${e.number} ${e.description}`) ?? [], out: rt.out };
  rt.end();
  expect(seen).toEqual({ started: 'ok', errors: [], out: [' 1 '] });
});

test('bug 7 (fixed): a streamed reply without content is marked as thinking, so code mode takes no code from it', async () => {
  const { BrowserBackend } = await import('../src/backend/browserBackend');
  const { extractCode } = await import('../src/ai/codeMode');
  const thinking = 'The user wants a button. Maybe:\n```vb\nPrivate Sub Command1_Click()\n    End\nEnd Sub\n```\nBut wait, that ends the program; better';
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: thinking } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n',
  ].join('');
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
  try {
    const text = await new BrowserBackend().aiChat('http://x/v1', '', 'm', [{ role: 'user', content: 'hi' }], 'low', { onDelta: () => {} });
    expect(text).toBe(`<think>${thinking}</think>`);
    expect(extractCode(text)).toBeNull();
  } finally { globalThis.fetch = real; }
});
