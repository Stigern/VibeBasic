// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { openCodeWindow, type CodeWindow } from '../../src/ide/codeWindow';
import { createImmediateWindow } from '../../src/ide/immediate';
import { IdeState } from '../../src/ide/ideState';
import { RunController } from '../../src/ide/runController';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { parseProject } from '../../src/model/serialize';
import type { Project } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';

vi.mock('../../src/ui98/dialogs', async orig => ({ ...(await orig<typeof import('../../src/ui98/dialogs')>()), compileErrorBox: vi.fn(async () => {}) }));
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const E2E = import.meta.glob('./e2e/*.vbb', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const tick = () => new Promise(r => setTimeout(r, 0));
async function until(cond: () => boolean, ms = 3000): Promise<void> { const t = Date.now(); while (!cond() && Date.now() - t < ms) await tick(); }

let ide: IdeState, rc: RunController, container: HTMLElement;
let wins: Map<string, CodeWindow>;

function setup(p: Project): void {
  ide = new IdeState(p);
  document.body.innerHTML = '';
  container = document.body.appendChild(document.createElement('div'));
  const immHost = document.body.appendChild(document.createElement('div'));
  const mdi = document.body.appendChild(document.createElement('div'));
  wins = new Map();
  const immediate = createImmediateWindow(immHost, () => rc.session, () => ide.project);
  rc = new RunController(ide, () => {
    const h = new InlineFormHost(container);
    h.runtimeErrorBox = async () => 'debug';
    return h;
  }, id => { const w = openCodeWindow(ide, id, { mdiHost: mdi }); wins.set(id, w); return w; }, { immediate, doc: document });
}
function loopProject(code: string): Project {
  const p = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  const c = newControl(p.forms[0], 'CommandButton', { left: 120, top: 120 }, null);
  c.name = 'Command1';
  p.forms[0].controls.push(c);
  return p;
}
const LOOP = 'Private Sub Command1_Click()\n    Do\n    Loop\nEnd Sub\n';
const click = (name: string, index: number | null = null) => {
  for (const f of ide.project.forms) {
    const c = f.controls.find(d => d.name === name && d.index === index);
    if (c) { container.querySelector<HTMLElement>(`[data-control-id="${c.id}"] button`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); return; }
  }
  throw new Error(`no control ${name}`);
};
const text1 = () => container.querySelector<HTMLInputElement>('[data-control-id] input, [data-control-id] textarea')!.value;

afterEach(async () => { rc?.end(); await tick(); });

test('infinite loop can be stopped quickly and IDE stays responsive', async () => {   // Review Focus 1
  setup(loopProject(LOOP));
  await rc.start(false);
  click('Command1');
  await new Promise(r => setTimeout(r, 100));
  let responsive = false;
  setTimeout(() => { responsive = true; }, 0);
  await new Promise(r => setTimeout(r, 50));
  expect(responsive).toBe(true);
  expect(ide.mode).toBe('run');
  const t = Date.now();
  rc.end();
  await until(() => ide.mode === 'design', 500);
  expect(ide.mode).toBe('design');
  expect(Date.now() - t).toBeLessThan(500);
  expect(container.querySelector('.vb-form')).toBeNull();
}, 2000);

test('break during infinite loop shows loop line', async () => {
  setup(loopProject(LOOP));
  await rc.start(false);
  click('Command1');
  await new Promise(r => setTimeout(r, 100));
  rc.breakNow();
  await until(() => ide.mode === 'break', 1000);
  expect(ide.mode).toBe('break');
  const w = wins.get(ide.project.forms[0].id)!;
  const line = w.win.el.querySelector('.cm-vb-break')?.textContent ?? '';
  expect(['Do', 'Loop']).toContain(line.trim());
}, 3000);

test('calc.vbb full scenario', async () => {
  // calc.vbb has digit buttons Command1(0..9) and cmdClear only (no operators): 1, 2 -> "12", C -> ""
  setup(parseProject(E2E['./e2e/calc.vbb']));
  await rc.start(false);
  click('Command1', 1); await tick(); await tick();
  click('Command1', 2); await tick(); await tick();
  expect(text1()).toBe('12');
  click('cmdClear'); await tick(); await tick();
  expect(text1()).toBe('');
});

test('20000 DoEvents finish quickly; a Timer still fires during the loop', async () => {
  const p = loopProject([
    'Dim ticks As Long',
    'Private Sub Timer1_Timer()', '    ticks = ticks + 1', 'End Sub',
    'Private Sub Command1_Click()',
    '    Dim i As Long',
    '    For i = 1 To 20000', '        Label1.Caption = CStr(i)', '        Command1.Caption = CStr(i)', '        DoEvents', '    Next',
    '    Debug.Print "ticks"; ticks > 0',
    'End Sub', '',
  ].join('\n'));
  const t1 = newControl(p.forms[0], 'Timer', { left: 0, top: 0 }, null);
  t1.name = 'Timer1'; t1.props.Interval = 20; t1.props.Enabled = true;
  const l1 = newControl(p.forms[0], 'Label', { left: 120, top: 1000 }, null);
  l1.name = 'Label1';
  p.forms[0].controls.push(t1, l1);
  setup(p);
  const printed: string[] = [];
  (rc as unknown as { opts: { immediate: { print(t: string): void } } }).opts.immediate.print = t => printed.push(t);
  await rc.start(false);
  const t = Date.now();
  click('Command1');
  await until(() => printed.length > 0, 10000);
  const ms = Date.now() - t;
  expect(printed[0]).toBe('ticksTrue');
  // Shared CI runners (especially Windows) have variable CPU scheduling. This still catches the old one-timer-per-call
  // regression: 20,000 timer turns take tens of seconds, while the batched loop completes in a few seconds under load.
  const ci = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CI;
  expect(ms).toBeLessThan(ci ? 5000 : 1500);
}, 15000);
