// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { applyCodeProposal, diffLines, extractCode, skippedProblem } from '../../src/ai/codeMode';
import { codeForPrompt } from '../../src/ai/context';
import { BODY_OMITTED } from '../../src/ai/omitted';
import { showCodePreview } from '../../src/ai/previewDialogs';

test('extract fenced vb', () => expect(extractCode('Her:\n```vb\nPrivate Sub A()\nEnd Sub\n```\nFerdig')).toBe('Private Sub A()\nEnd Sub'));
test('extract prefers labelled block, strips thinking', () =>
  expect(extractCode('<think>```vb\nno\n```</think>```\nx\n```\n```vba\nDim a\n```')).toBe('Dim a'));
test('extract unlabelled fence', () => expect(extractCode('```\nSub A()\nEnd Sub\n```')).toBe('Sub A()\nEnd Sub'));
test('extract unfenced code', () => expect(extractCode('Private Sub A()\nEnd Sub')).toBe('Private Sub A()\nEnd Sub'));
test('prose only is null', () => expect(extractCode('Beklager, jeg forstår ikke.')).toBeNull());

test('replace by name case-insensitive', () => {
  const r = applyCodeProposal('Private Sub command1_click()\nx = 1\nEnd Sub', 'Private Sub Command1_Click()\nx = 2\nEnd Sub', null)!;
  expect(r.source).toBe('Private Sub Command1_Click()\nx = 2\nEnd Sub');
  expect(r.changes).toEqual([{ name: 'Command1_Click', kind: 'replaced' }]);
});
test('add new procedure', () => {
  const r = applyCodeProposal('Private Sub A()\nEnd Sub', 'Private Sub B()\nEnd Sub', null)!;
  expect(r.source).toBe('Private Sub A()\nEnd Sub\n\nPrivate Sub B()\nEnd Sub');
  expect(r.changes).toEqual([{ name: 'B', kind: 'added' }]);
});
test('declarations after option explicit, no dupes', () => {
  const code = 'Dim teller As Integer\nPrivate Sub A()\nEnd Sub';
  const r = applyCodeProposal('Option Explicit\n\nPrivate Sub A()\nx = 1\nEnd Sub', code, null)!;
  expect(r.source).toBe('Option Explicit\nDim teller As Integer\n\nPrivate Sub A()\nEnd Sub');
  expect(r.changes.map(c => c.kind)).toEqual(['declarations', 'replaced']);
  const again = applyCodeProposal(r.source, code, null)!;
  expect(again.source.match(/Dim teller/g)).toHaveLength(1);
});
test('bare statements replace current body', () => {
  const r = applyCodeProposal('Private Sub Command1_Click()\nOld\nEnd Sub\n\nSub B()\nEnd Sub', 'Label1.Caption = "Hei"', 'Command1_Click')!;
  expect(r.source).toBe('Private Sub Command1_Click()\nLabel1.Caption = "Hei"\nEnd Sub\n\nSub B()\nEnd Sub');
  expect(r.changes).toEqual([{ name: 'Command1_Click', kind: 'body' }]);
});
test('procedures echoed back with their bodies omitted keep their real code; the reply names them for the retry', () => {
  // a long module: the model is shown most procedures as heading + BODY_OMITTED and echoes the whole module back
  const procs = Array.from({ length: 30 }, (_, i) => `Private Sub P${i}()\n${Array.from({ length: 15 }, (_, k) => `    x = x + ${i * 100 + k}`).join('\n')}\nEnd Sub`);
  const source = `Option Explicit\nDim x As Long\n\n${procs.join('\n\n')}`;
  const shown = codeForPrompt(source, { procName: 'P3', mention: '' });
  expect(shown).toContain(`Private Sub P20()\n${BODY_OMITTED}\n`);   // heading and marker, no End Sub
  const reply = shown.replace('    x = x + 300', '    x = x - 300')   // the one real change, in the procedure shown in full
    .replace(`Private Sub P21()\n${BODY_OMITTED}`, "Private Sub P21()\n    ' ... unchanged");   // a stub in other words
  const r = applyCodeProposal(source, reply, 'P3')!;
  expect(r.changes).toEqual([{ name: 'P3', kind: 'replaced' }]);
  expect(r.source).toBe(source.replace('    x = x + 300', '    x = x - 300'));
  expect(r.skipped).toHaveLength(29);
  expect(r.skipped).toContain('P20');
  expect(r.skipped).toContain('P21');
  expect(skippedProblem(['P1', 'P2'])).toMatch(/P1, P2.*only the procedures you changed/s);
  // a stub alone changes nothing, but is still reported (so the one retry asks again)
  const only = applyCodeProposal(source, `Private Sub P5()\n${BODY_OMITTED}\nEnd Sub`, null)!;
  expect(only).toEqual({ source, changes: [], skipped: ['P5'] });
  // an empty body is a real change
  expect(applyCodeProposal(source, 'Private Sub P5()\nEnd Sub', null)!.changes).toEqual([{ name: 'P5', kind: 'replaced' }]);
});
test('bare statements without current proc is null', () => expect(applyCodeProposal('Option Explicit', 'x = 1', null)).toBeNull());

test('diff', () => expect(diffLines(['a', 'b'], ['a', 'c'])).toEqual([{ kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'c' }]));

test('preview dialog resolves on OK and Cancel', async () => {
  const click = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label)!.click();
  const p1 = showCodePreview(document, 'a\nb', 'a\nc', [{ name: 'A', kind: 'replaced' }]);
  expect(document.body.textContent).toContain('AI Suggestion');
  expect(document.body.textContent).toContain('Before');
  expect(document.querySelector('.ai-after .add')!.textContent).toBe('c');
  expect(document.querySelector('.ai-before .del')!.textContent).toBe('b');
  click('OK');
  expect(await p1).toBe('ok');
  const p2 = showCodePreview(document, 'a', 'a', []);
  click('Cancel');
  expect(await p2).toBe('cancel');
});

test('header before the first procedure: declarations and attached comments only; comment above the procedure stays with it', () => {
  const code = [
    'Here is the updated code:',
    "' counter for clicks",
    'Private mCount As Integer',
    'Private Type Pt',
    '    X As Long',
    'End Type',
    'This adds a counter.',
    '',
    "' Handles the click",
    'Private Sub Command1_Click()',
    '    mCount = mCount + 1',
    'End Sub',
  ].join('\n');
  const r = applyCodeProposal('Option Explicit\n\nPrivate Sub Form_Load()\nEnd Sub', code, null)!;
  expect(r.source).toBe([
    'Option Explicit',
    "' counter for clicks",
    'Private mCount As Integer',
    'Private Type Pt',
    '    X As Long',
    'End Type',
    '',
    'Private Sub Form_Load()',
    'End Sub',
    '',
    "' Handles the click",
    'Private Sub Command1_Click()',
    '    mCount = mCount + 1',
    'End Sub',
  ].join('\n'));
});

test('with a selection, a bare-body answer replaces exactly the selection', () => {
  const src = 'Private Sub A()\n    x = 1\n    y = 2\n    z = 3\nEnd Sub';
  const from = src.indexOf('    y'), to = src.indexOf('    z');   // the whole line "    y = 2\n"
  const r = applyCodeProposal(src, '    y = 20\n    w = 4', 'A', { from, to })!;
  expect(r.source).toBe('Private Sub A()\n    x = 1\n    y = 20\n    w = 4\n    z = 3\nEnd Sub');
  expect(r.changes).toEqual([{ name: 'A', kind: 'selection' }]);
  // a whole procedure still replaces the procedure
  expect(applyCodeProposal(src, 'Private Sub A()\nEnd Sub', 'A', { from, to })!.source).toBe('Private Sub A()\nEnd Sub');
});
