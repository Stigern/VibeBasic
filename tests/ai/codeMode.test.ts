// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { applyCodeProposal, diffLines, extractCode } from '../../src/ai/codeMode';
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
  expect(await p1).toBe(true);
  const p2 = showCodePreview(document, 'a', 'a', []);
  click('Cancel');
  expect(await p2).toBe(false);
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
