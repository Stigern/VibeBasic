// @vitest-environment jsdom
// Offline probes of the AI code that the live runs pointed at. Each test pins down the CURRENT behaviour (no server needed),
// so the report's bug claims are reproducible; when a behaviour is fixed, its probe fails and can be turned around.
import { expect, test } from 'vitest';
import { applyCodeProposal } from '../src/ai/codeMode';
import { describeControlTypes } from '../src/ai/context';
import { isQuestion } from '../src/ai/answerDialog';
import { parseFormOps } from '../src/ai/formMode';
import { LANGUAGE_REFERENCE } from '../src/ai/langReference';
import { validateCode } from '../src/ai/validate';
import { findSyntaxErrors } from '../src/lang/parser';
import { newControl, newForm, newProject } from '../src/model/controls';

test('a changed module-level declaration is added next to the old one, not put in its place', () => {
  const src = 'Option Explicit\nDim items As Collection\nPrivate Sub Form_Load()\n    items.Add 1\nEnd Sub';
  const code = 'Dim items As New Collection\nPrivate Sub Form_Load()\n    items.Add 1\nEnd Sub';
  const r = applyCodeProposal(src, code, 'Form_Load')!;
  expect(r.source.split('\n').slice(0, 3)).toEqual(['Option Explicit', 'Dim items As Collection', 'Dim items As New Collection']);
  // the parser does not see the duplicate either, so nothing in the check-and-fix round complains
  expect(findSyntaxErrors(r.source, 'Form1')).toEqual([]);
  const c = applyCodeProposal('Const MAX = 5\nPrivate Sub A()\nEnd Sub', 'Const MAX = 10\nPrivate Sub A()\n    Debug.Print MAX\nEnd Sub', 'A')!;
  expect(c.source.startsWith('Const MAX = 5\nConst MAX = 10')).toBe(true);
});

test('form mode: "set" with the form\'s own name is dropped as a missing control', () => {
  const f = newForm('Form1');
  const r = parseFormOps('{"ops":[{"op":"set","name":"Form1","props":{"Caption":"Main","MDIChild":true}}]}', f);
  expect(r.ok).toBe(false);   // nothing usable: the whole answer is "not understood"
  const r2 = parseFormOps('{"ops":[{"op":"set","name":"Form1","props":{"Caption":"Main"}},{"op":"add","type":"Label","name":"Label1","props":{}}]}', f);
  expect(r2.ok && r2.warnings).toEqual(['Ignored change to missing control Form1.']);
});

test('form mode: an invalid or unknown property is only a grey warning, never a problem for the check-and-fix round', () => {
  const f = newForm('Form1');
  const r = parseFormOps('{"ops":[{"op":"form","props":{"StartUpPosition":4}},{"op":"add","type":"SSTab","name":"t","props":{"Tabs":"General\\nView\\nAdvanced"}}]}', f);
  expect(r.ok && r.warnings).toEqual(['Ignored invalid value for StartUpPosition on Form.', 'Ignored invalid value for Tabs on t.']);
  // runFormConversation builds `problems` from validateCode (code), skipped stubs, renames and the layout check only
});

test('the system prompt contradicts itself about New ADODB.Connection', () => {
  expect(describeControlTypes()).toContain('there is no New ADODB.Connection');
  expect(LANGUAGE_REFERENCE).toMatch(/CreateObject\(ProgID\) or New: .*ADODB\.Connection/);
});

test('StartUpPosition is listed by name only, so the model has to guess its values', () => {
  const form = describeControlTypes().split('\n').find(l => l.startsWith('Form:'))!;
  expect(form).toMatch(/StartUpPosition(,|\s|$)/);
  expect(form).not.toMatch(/StartUpPosition\(/);
});

test('isQuestion misses common question openings (they still reach the AI Answer box only if the reply is prose)', () => {
  expect(['How do I make an MDI app?', 'Can you explain this?', "What's wrong with this code?", 'Is this correct?', 'Why does this give error 13?'].map(isQuestion))
    .toEqual([false, false, true, false, true]);
});

test('validator: members of an Object variable are not checked (ListItem.ListSubItems got through and failed with 438)', () => {
  const p = newProject();
  const f = p.forms[0];
  const lv = newControl(f, 'ListView', { left: 0, top: 0 }, null);
  lv.name = 'ListView1';
  f.controls.push(lv);
  const code = 'Private Sub Form_Load()\n    Dim it As Object\n    Set it = ListView1.ListItems.Add(, , "x")\n    it.ListSubItems.Add 1, , "y"\nEnd Sub';
  expect(validateCode(code, { moduleName: 'Form1', form: f, project: p })).toEqual([]);
  const typed = 'Private Sub Form_Load()\n    Dim it As ListItem\n    Set it = ListView1.ListItems.Add(, , "x")\n    it.ListSubItems.Add 1, , "y"\nEnd Sub';
  expect(validateCode(typed, { moduleName: 'Form1', form: f, project: p })).toEqual([]);
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

test('a streamed reply without content falls back to the thinking text, which code mode then treats as the answer', async () => {
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
    expect(text).toBe(thinking);
    expect(extractCode(text)).toBe('Private Sub Command1_Click()\n    End\nEnd Sub');
  } finally { globalThis.fetch = real; }
});
