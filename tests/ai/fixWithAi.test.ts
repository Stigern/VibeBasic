// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { askAiAboutError } from '../../src/ai/askDialog';
import { buildCodeRequest, buildFixRequest, lineOperands } from '../../src/ai/context';
import type { Backend } from '../../src/backend/backend';
import { openCodeWindow, type CodeWindow } from '../../src/ide/codeWindow';
import { IdeState } from '../../src/ide/ideState';
import { RunController } from '../../src/ide/runController';
import { Program } from '../../src/lang/interp/program';
import { newControl, newForm, newProject } from '../../src/model/controls';
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
  expect(user.content).toMatch(/\n\nFix the error\. Handle the actual values that cause it .*do not hide the error by setting a variable to a dummy value/);
  expect(user.content).not.toContain('Values on the failing line');
  // the failing line's operands with their values, when the run gave them
  const withValues = buildFixRequest(p, id, err, [{ name: 'x', value: '0' }], { lineValues: ['x = 0'] })[1].content;
  expect(withValues).toContain('Variable values:\nx = 0\n\nValues on the failing line: x = 0\n\nFix the error.');
  const compile = buildFixRequest(p, id, { ...err, compile: true, description: 'Variable not defined' }, [{ name: 'x', value: '0' }])[1].content;
  expect(compile).toContain('Compile error: Variable not defined');
  expect(compile).not.toContain('Variable values');
  expect(compile.endsWith('\n\nFix the error.')).toBe(true);
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

test('the fix request names the values on the failing line (age = Text1.Text with "twelve"), read without side effects', async () => {
  const original = 'Private Sub Form_Load()\n    Dim age As Integer\n    age = Text1.Text + Len(Text1.Text)\nEnd Sub';
  const p = newProject();
  const f = newForm('Form1', original);
  const t = newControl(f, 'TextBox', { left: 0, top: 0 }, null);
  t.name = 'Text1'; t.props.Text = 'twelve';
  f.controls.push(t);
  p.forms = [f];
  p.startupForm = 'Form1';
  const ide = new IdeState(p);
  const mdi = document.body.appendChild(document.createElement('div'));
  const layer = document.body.appendChild(document.createElement('div'));
  const backend = {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', model: 'm', apiKey: '' }),
    saveSettings: async () => {},
    aiChat: vi.fn(async () => '```vb\nPrivate Sub Form_Load()\nEnd Sub\n```'),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
  const wins = new Map<string, CodeWindow>();
  const openCode = (id: string) => { const w = wins.get(id) ?? openCodeWindow(ide, id, { mdiHost: mdi }); wins.set(id, w); return w; };
  let flow: Promise<void> | undefined;
  const rc: RunController = new RunController(ide, () => {
    const h = new InlineFormHost(layer);
    h.runtimeErrorBox = async () => 'ai';
    return h;
  }, openCode, { doc: document, onAskAi: fix => { flow = askAiAboutError(ide, backend, fix, { openCode, end: () => rc.endAndWait() }, document); } });
  void rc.start(false);
  const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  const user = (backend.aiChat.mock.calls[0][3] as { content: string }[])[1].content;
  expect(user).toContain('Run-time error 13: Type mismatch');
  expect(user).toContain('Values on the failing line: age = 0, Text1.Text = "twelve"\n\nFix the error. Handle the actual values');
  btn('Cancel')!.click();
  await flow;
  rc.end();
});

test('lineOperands: names and member chains, not calls, strings or the comment', () => {
  expect(lineOperands('    age = Text1.Text + Len(Text1.Text) \' Label1.Caption')).toEqual(['age', 'Text1.Text']);
  expect(lineOperands('lbl.Caption = "a.b " & x(2) & Me.Width')).toEqual(['lbl.Caption', 'Me.Width']);
  expect(lineOperands('If total / count > 2 Then MsgBox "x"')).toEqual(['If', 'total', 'count', 'Then', 'MsgBox']);
  expect(lineOperands('Rem nothing')).toEqual([]);
});

test('an event whose arguments cannot be bound (no statement ran) -> Ask AI: the program ends, then the fix request starts at the procedure', async () => {
  const p = newProject();
  p.forms = [newForm('Form1', 'Private Sub Form_Load(Index As Integer)\n    Caption = "hi"\nEnd Sub')];
  p.startupForm = 'Form1';
  const ide = new IdeState(p);
  const mdi = document.body.appendChild(document.createElement('div'));
  const layer = document.body.appendChild(document.createElement('div'));
  const backend = {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', model: 'm', apiKey: '' }),
    saveSettings: async () => {},
    aiChat: vi.fn(async () => '```vb\nPrivate Sub Form_Load()\n    Caption = "hi"\nEnd Sub\n```'),
    focusMainWindow: vi.fn(async () => {}),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn>; focusMainWindow: ReturnType<typeof vi.fn> };
  const wins = new Map<string, CodeWindow>();
  const openCode = (id: string) => { const w = wins.get(id) ?? openCodeWindow(ide, id, { mdiHost: mdi }); wins.set(id, w); return w; };
  let flow: Promise<void> | undefined;
  const rc: RunController = new RunController(ide, () => {
    const h = new InlineFormHost(layer);
    h.runtimeErrorBox = async () => 'ai';
    return h;
  }, openCode, { doc: document, onAskAi: fix => { flow = askAiAboutError(ide, backend, fix, { openCode, end: () => rc.endAndWait() }, document); } });
  void rc.start(false);
  const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  expect(ide.mode).toBe('design');
  expect(backend.focusMainWindow).toHaveBeenCalled();   // the IDE comes forward, above the program's windows
  const user = (backend.aiChat.mock.calls[0][3] as { content: string }[])[1].content;
  expect(user).toContain('Compile error: Argument not optional');
  expect(user).toContain('Line 1 in Form_Load');
  btn('OK')!.click();
  await flow;
  expect(p.forms[0].code).toBe('Private Sub Form_Load()\n    Caption = "hi"\nEnd Sub');
});
