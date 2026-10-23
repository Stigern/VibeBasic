// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = () => new Promise(r => setTimeout(r, 0));

test('SSTab at run time: a child on tab 1 is hidden on tab 0; clicking tab 2 raises Click(PreviousTab); code sets Tab and TabCaption', async () => {
  const p = newProject();
  p.forms = [newForm('Form1', [
    'Private Sub SSTab1_Click(PreviousTab As Integer)',
    '  Debug.Print "click"; PreviousTab; SSTab1.Tab; SSTab1.Caption',
    'End Sub',
    'Private Sub Form_Load()',
    '  SSTab1.TabCaption(2) = "&Third"',
    '  Debug.Print SSTab1.Tabs; SSTab1.TabCaption(0); SSTab1.TabEnabled(1); ssStylePropertyPage',
    '  On Error Resume Next',
    '  SSTab1.Tab = 3',
    '  Debug.Print Err.Number',
    'End Sub', '',
  ].join('\n'))];
  const f = p.forms[0];
  const tab = newControl(f, 'SSTab', { left: 120, top: 120 }, null);
  const label = newControl(f, 'Label', { left: 240, top: 720 }, tab.id);
  label.tab = 1;
  f.controls.push(tab, label);
  p.components = ['TABCTL32.OCX'];
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  for (let i = 0; i < 20; i++) await tick();
  const el = (id: string) => container.querySelector<HTMLElement>(`[data-control-id="${id}"]`)!;
  const labelShown = () => (el(label.id).parentElement as HTMLElement).style.display !== 'none';
  expect(out).toEqual([' 3 Tab 0True 1 ', ' 380 ']);
  expect(labelShown()).toBe(false);

  const tabs = el(tab.id).querySelectorAll<HTMLElement>('.sst-tab');
  expect([...tabs].map(t => t.textContent)).toEqual(['Tab 0', 'Tab 1', 'Third']);
  tabs[2].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  for (let i = 0; i < 10; i++) await tick();
  expect(out[2]).toBe('click 0  2 &Third');

  expect(await session.immediate('Form1.SSTab1.Tab = 1')).toBe('');
  for (let i = 0; i < 10; i++) await tick();
  expect(out[3]).toBe('click 2  1 Tab 1');
  expect(labelShown()).toBe(true);
});
