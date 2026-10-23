// @vitest-environment jsdom
// Locals window editing, saved watches, the data-tip expression under the mouse.
import { expect, test } from 'vitest';
import { Program } from '../../src/lang/interp/program';
import { createLocalsWindow, exprAt } from '../../src/ide/debugWindows';
import { newProject } from '../../src/model/controls';
import { parseProject, serializeProject } from '../../src/model/serialize';
import { TestHost, TEST_OPTIONS } from '../lang/testHost';

const tick = () => new Promise(r => setTimeout(r, 0));

test('editing a value in the Locals window assigns it to the variable', async () => {
  const src = ['Sub Main()', '  Dim x As Integer', '  x = 5', '  Debug.Print x', 'End Sub'].join('\n');
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source: src }], host, TEST_OPTIONS);
  prog.setBreakpoints('Module1', [4]);
  const div = document.createElement('div');
  document.body.replaceChildren(div);
  let shown = '';
  host.breakHook = async () => {
    const w = createLocalsWindow(div, {
      target: () => ({ debug: prog.debug, immediate: t => prog.immediate(t) }), inBreak: () => true, projectName: () => 'Project1',
      members: () => [], doc: document, changed: () => w.refresh(),
    }, () => {});
    w.refresh();
    const value = () => [...div.querySelectorAll('.dbg98-row')].find(r => r.querySelector('.dbg98-c0')!.textContent === 'x')!.querySelector('.dbg98-c1') as HTMLElement;
    value().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = div.querySelector('input.dbg98-edit') as HTMLInputElement;
    input.value = '41';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 5; i++) await tick();
    shown = value().textContent!;
    return 'continue';
  };
  await prog.runEvent('Module1', 'Main');
  expect(shown).toBe('41');
  expect(host.lines()).toEqual([' 41 ']);
});

test('watches are saved with the project; a project without them loads as before', () => {
  const p = newProject();
  expect(parseProject(serializeProject(p)).watches).toBeUndefined();
  const w = [
    { expression: 'x', module: 'Module1', procedure: 'Main', kind: 'breakChange' as const },
    { expression: 'Text1.Text', module: null, procedure: null, kind: 'watch' as const },
  ];
  const text = serializeProject({ ...p, watches: w }).replace('"kind": "watch"', '"kind": "watch"},{"expression":"bad","kind":"nope"');
  expect(parseProject(text).watches).toEqual(w);
});

test('the data-tip expression is the variable or obj.Property under the mouse, never in a string or comment', () => {
  const line = '  Text1.Text = s$ & "abc" \' x';
  expect(exprAt(line, 9)?.text).toBe('Text1.Text');
  expect(exprAt(line, 3)?.text).toBe('Text1');
  expect(exprAt(line, 15)?.text).toBe('s$');
  expect(exprAt(line, 21)).toBeNull();
  expect(exprAt(line, 28)).toBeNull();
});
