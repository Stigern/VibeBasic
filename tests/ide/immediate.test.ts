// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { createImmediateWindow } from '../../src/ide/immediate';
import { newForm, newProject } from '../../src/model/controls';

const tick = () => new Promise(r => setTimeout(r, 0));

function make(code = '') {
  const p = newProject();
  p.forms = [newForm('Form1')];
  p.modules = [{ id: 'm1', name: 'Module1', code }];
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const w = createImmediateWindow(host, () => null, () => p);
  const ta = host.querySelector('textarea')!;
  const enter = async (line: string) => {
    ta.value += line;
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) await tick();
  };
  return { w, ta, enter };
}

test('immediate in design mode evaluates', async () => {
  const { ta, enter } = make();
  await enter('? 1 + 2');
  expect(ta.value).toBe('? 1 + 2\n 3 \n');
  expect(ta.selectionStart).toBe(ta.value.length);
});

test('Debug.Print from an immediate line and from outside land in the window', async () => {
  const { w, ta, enter } = make();
  await enter('Debug.Print "hi"');
  expect(ta.value).toBe('Debug.Print "hi"\nhi\n');
  w.print('later', true);
  expect(ta.value.endsWith('later\n')).toBe(true);
});

test('design immediate calls procedures of the project; errors become text', async () => {
  const { ta, enter } = make('Public Function Twice(n As Integer) As Integer\n    Twice = n * 2\nEnd Function\n');
  await enter('? Twice(21)');
  expect(ta.value).toContain(' 42 ');
  await enter('? 1 / 0');
  expect(ta.value).toContain("Run-time error '11'");
});
