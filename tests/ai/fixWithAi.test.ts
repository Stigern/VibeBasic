// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { askAiAboutError } from '../../src/ai/askDialog';
import { buildCodeRequest, buildFixRequest } from '../../src/ai/context';
import type { Backend } from '../../src/backend/backend';
import { openCodeWindow, type CodeWindow } from '../../src/ide/codeWindow';
import { IdeState } from '../../src/ide/ideState';
import { RunController } from '../../src/ide/runController';
import { Program } from '../../src/lang/interp/program';
import { newForm, newProject } from '../../src/model/controls';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { TestHost } from '../lang/testHost';

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;
afterEach(() => { document.body.innerHTML = ''; });

/** Runs Main up to its Stop and returns the variables seen in break mode. */
async function varsAtStop(source: string) {
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source }], host);
  let vars: { name: string; value: string }[] = [];
  host.breakHook = () => { vars = prog.snapshotVariables(); return 'end'; };
  await prog.runEvent('Module1', 'Main');
  return vars;
}

test('snapshotVariables: locals first, then module variables; long strings cut, arrays as type and first values', async () => {
  const vars = await varsAtStop([
    'Dim counter As Integer', 'Dim names(5) As String',
    'Sub Main()', '    Dim s As String', '    Dim i As Integer',
    '    s = Space(200) & "end"', '    i = 7', '    counter = 3', '    names(0) = "Ann"', '    Stop', 'End Sub',
  ].join('\n'));
  expect(vars.map(v => v.name)).toEqual(['s', 'i', 'counter', 'names']);
  expect(vars[0].value).toBe(`"${' '.repeat(80)}..."`);
  expect(vars[1].value).toBe('7');
  expect(vars[3].value).toBe('String(0 To 5): "Ann", "", "", ...');
});

test('snapshotVariables lists at most 40 variables', async () => {
  const decls = Array.from({ length: 50 }, (_, i) => `Dim v${i} As Integer`);
  const vars = await varsAtStop([...decls, 'Sub Main()', '    Stop', 'End Sub'].join('\n'));
  expect(vars).toHaveLength(40);
});

test('buildFixRequest: code-mode system prompt; code, then error number, line and variables, then Fix the error.', () => {
  const p = newProject();
  p.forms = [newForm('Form1', 'Private Sub Form_Load()\n    Dim x As Double\n    x = 1 / 0\nEnd Sub')];
  const id = p.forms[0].id;
  const err = { number: 11, description: 'Division by zero', compile: false, line: 3, procName: 'Form_Load' };
  const [sys, user] = buildFixRequest(p, id, err, [{ name: 'x', value: '0' }]);
  expect(sys).toEqual(buildCodeRequest(p, id, 1, 'x')[0]);
  const at = (s: string) => user.content.indexOf(s);
  for (const s of ['Form description:', 'x = 1 / 0', 'Run-time error 11: Division by zero', 'Line 3 in Form_Load', 'Variable values:\nx = 0']) expect(at(s)).toBeGreaterThanOrEqual(0);
  expect(at('Form description:')).toBeLessThan(at('Private Sub Form_Load'));
  expect(at('Private Sub Form_Load')).toBeLessThan(at('Run-time error 11'));
  expect(at('Run-time error 11')).toBeLessThan(at('Line 3 in Form_Load'));
  expect(at('Line 3 in Form_Load')).toBeLessThan(at('Variable values:'));
  expect(user.content.endsWith('\n\nFix the error.')).toBe(true);
  const compile = buildFixRequest(p, id, { ...err, compile: true, description: 'Variable not defined' }, [{ name: 'x', value: '0' }])[1].content;
  expect(compile).toContain('Compile error: Variable not defined');
  expect(compile).not.toContain('Variable values');
});

test('x = 1 / 0 -> Ask AI -> proposal -> OK: the program has ended, the code is fixed, one undo restores it', async () => {
  const original = 'Private Sub Form_Load()\n    Dim x As Double\n    x = 1 / 0\nEnd Sub';
  const fixed = 'Private Sub Form_Load()\n    Dim x As Double\n    x = 1 / 2\nEnd Sub';
  const p = newProject();
  p.forms = [newForm('Form1', original)];
  p.startupForm = 'Form1';
  const ide = new IdeState(p);
  const mdi = document.body.appendChild(document.createElement('div'));
  const layer = document.body.appendChild(document.createElement('div'));
  const backend = {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', model: 'm', apiKey: '' }),
    saveSettings: async () => {},
    aiChat: vi.fn(async () => `\`\`\`vb\n${fixed}\n\`\`\``),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
  const wins = new Map<string, CodeWindow>();
  const openCode = (id: string) => { const w = wins.get(id) ?? openCodeWindow(ide, id, { mdiHost: mdi }); wins.set(id, w); return w; };
  let flow: Promise<void> | undefined;
  const rc: RunController = new RunController(ide, () => {
    const h = new InlineFormHost(layer);
    h.runtimeErrorBox = async () => 'ai';
    return h;
  }, openCode, {
    doc: document,
    onAskAi: fix => { flow = askAiAboutError(ide, backend, fix, { openCode, end: () => rc.endAndWait() }, document); },
  });
  void rc.start(false);
  const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  expect(ide.mode).toBe('break');
  const sent = backend.aiChat.mock.calls[0][3] as { content: string }[];
  expect(sent[1].content).toContain("Run-time error 11: Division by zero");
  expect(sent[1].content).toContain('Line 3 in Form_Load: x = 1 / 0');
  expect(sent[1].content).toMatch(/Variable values:\nx = 0/);
  btn('OK')!.click();
  await flow;
  expect(ide.mode).toBe('design');
  expect(rc.session).toBeNull();
  expect(p.forms[0].code).toBe(fixed);
  undo((wins.get(p.forms[0].id) as CodeWindow & { view: EditorView }).view);
  expect(p.forms[0].code).toBe(original);
});
