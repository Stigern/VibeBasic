// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { parseProject } from '../../src/model/serialize';
import type { ControlType, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession, type SessionCallbacks } from '../../src/run/session';

type C = [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?, number?];
function project(forms: { name: string; code: string; controls?: C[] }[]): Project {
  const p = newProject();
  p.forms = [];
  p.startupForm = forms[0].name;
  for (const f of forms) {
    const fd = newForm(f.name, f.code);
    for (const [type, name, props, index] of f.controls ?? []) {
      const c = newControl(fd, type, { left: 120, top: 120 }, null);
      c.name = name; c.index = index ?? null;
      Object.assign(c.props, props ?? {});
      fd.controls.push(c);
    }
    p.forms.push(fd);
  }
  return p;
}

let container: HTMLElement;
let out: string[];
let ended: number;
let current: Project;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); out = []; ended = 0; });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });

async function start(p: Project, cb: Partial<SessionCallbacks> = {}): Promise<RunSession> {
  current = p;
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => { ended++; },
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app', ...cb,
  }, 'ide');
  await session.start();
  return session;
}
const E2E = import.meta.glob('./e2e/*.vbb', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const startProject = (file: string) => start(parseProject(E2E[`./e2e/${file}`]));

const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(s: RunSession): Promise<void> {
  for (let i = 0; i < 400 && (i < 10 || s.program.state === 'running'); i++) await tick();
  await tick();
}
function elOf(name: string, index: number | null = null): HTMLElement {
  for (const f of current.forms) {
    const c = f.controls.find(d => d.name === name && d.index === index);
    if (c) return container.querySelector<HTMLElement>(`[data-control-id="${c.id}"]`)!;
  }
  throw new Error(`no control ${name}`);
}
const inputOf = (el: HTMLElement) => el.querySelector<HTMLElement>('input, textarea, select, button, [role=scrollbar]') ?? el;
const click = (name: string, index: number | null = null) =>
  inputOf(elOf(name, index)).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
function text(name: string): string {
  const i = inputOf(elOf(name));
  return i instanceof HTMLInputElement || i instanceof HTMLTextAreaElement ? i.value : elOf(name).textContent ?? '';
}
const forms = () => [...container.querySelectorAll<HTMLElement>('.vb-form')];
const closeBox = (form: HTMLElement) => form.querySelector<HTMLElement>('.title-bar-controls button[aria-label="Close"]')!;

describe('RunSession', () => {
  test('hello: click sets label', async () => {
    const s = await startProject('hello.vbb');
    click('Command1'); await settle(s);
    expect(text('Label1')).toBe('Hei, verden!');
  });

  test('load order', async () => {
    const s = await start(project([{ name: 'Form1', code: ['Initialize', 'Load', 'Resize', 'Activate']
      .map(e => `Private Sub Form_${e}()\n    Debug.Print "${e}"\nEnd Sub\n`).join('') }]));
    await settle(s);
    expect(out).toEqual(['Initialize', 'Load', 'Resize', 'Activate']);
  });

  test('control array index', async () => {
    const s = await startProject('calc.vbb');
    click('Command1', 7); await settle(s);
    expect(text('Text1')).toBe('7');
  });

  test('renamed control: old handler not run', async () => {
    const s = await start(project([{ name: 'Form1', controls: [['CommandButton', 'cmdOK'], ['Label', 'Label1', { Caption: 'før' }]],
      code: 'Private Sub Command1_Click()\n    Label1.Caption = "endret"\nEnd Sub\n' }]));
    click('cmdOK'); await settle(s);
    expect(text('Label1')).toBe('før');
  });

  test('query unload cancel keeps form', async () => {
    const s = await start(project([{ name: 'Form1',
      code: 'Private Sub Form_QueryUnload(Cancel As Integer, UnloadMode As Integer)\n    Debug.Print UnloadMode\n    Cancel = 1\nEnd Sub\n' }]));
    closeBox(forms()[0]).click(); await settle(s);
    expect(out).toEqual([' 0 ']);
    expect(forms()).toHaveLength(1);
    expect(ended).toBe(0);
  });

  test('unload last form ends session', async () => {
    const s = await start(project([{ name: 'Form1', controls: [['CommandButton', 'Command1']],
      code: 'Private Sub Command1_Click()\n    Unload Me\nEnd Sub\nPrivate Sub Form_QueryUnload(Cancel As Integer, UnloadMode As Integer)\n    Debug.Print "qu"; UnloadMode\nEnd Sub\nPrivate Sub Form_Unload(Cancel As Integer)\n    Debug.Print "unload"\nEnd Sub\n' }]));
    click('Command1'); await settle(s);
    expect(out).toEqual(['qu 1 ', 'unload']);
    expect(ended).toBe(1);
    expect(s.state).toBe('ended');
    expect(forms()).toHaveLength(0);
  });

  test('form2 auto-loads on member access and modal show waits', async () => {
    const s = await start(project([
      { name: 'Form1', controls: [['CommandButton', 'Command1']],
        code: 'Private Sub Command1_Click()\n    Form2.Caption = "Andre"\n    Form2.Show vbModal\n    Debug.Print "etter"\nEnd Sub\n' },
      { name: 'Form2', code: 'Private Sub Form_Load()\n    Debug.Print "load2"\nEnd Sub\n' },
    ]));
    click('Command1'); await settle(s);
    expect(out).toEqual(['load2']);
    expect(forms()).toHaveLength(2);
    const f2 = forms().find(f => f.querySelector('.title-bar-text')?.textContent === 'Andre')!;
    expect(f2).toBeTruthy();
    expect(forms().find(f => f !== f2)!.querySelector('.vb-blocked')).not.toBeNull();
    closeBox(f2).click(); await settle(s);
    expect(out).toEqual(['load2', 'etter']);
    expect(forms()).toHaveLength(1);
    expect(forms()[0].querySelector('.vb-blocked')).toBeNull();
  });

  test('progress loop with DoEvents updates DOM before finishing', async () => {
    const s = await startProject('progress.vbb');
    const fill = elOf('ProgressBar1').querySelector<HTMLElement>('.pb-fill')!;
    const seen: [string, string][] = [];
    new MutationObserver(() => seen.push([fill.style.width, s.program.state])).observe(fill, { attributes: true });
    click('Command1'); await settle(s);
    expect(seen.some(([w, st]) => w !== '0%' && w !== '100%' && st === 'running')).toBe(true);
    expect(fill.style.width).toBe('100%');
    expect(text('Label1')).toBe('Ferdig');
  });

  test('timer fires', async () => {
    const s = await start(project([{ name: 'Form1', controls: [['Timer', 'Timer1', { Interval: 50, Enabled: true }]],
      code: 'Dim n As Integer\nPrivate Sub Timer1_Timer()\n    n = n + 1\n    Debug.Print n\nEnd Sub\n' }]));
    await new Promise(r => setTimeout(r, 200));
    expect(out.length).toBeGreaterThanOrEqual(2);
    s.end();
    expect(ended).toBe(1);
  });

  test('keypress uppercase via handler', async () => {
    const s = await start(project([{ name: 'Form1', controls: [['TextBox', 'Text1', { Text: '' }]],
      code: 'Private Sub Text1_KeyPress(KeyAscii As Integer)\n    KeyAscii = Asc(UCase(Chr(KeyAscii)))\nEnd Sub\n' }]));
    const input = inputOf(elOf('Text1')) as HTMLInputElement;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, bubbles: true, cancelable: true }));
    await settle(s);
    expect(input.value).toBe('A');
  });

  test('loadpicture missing file is 53', async () => {
    const readFile = vi.fn(async (_p: string): Promise<Uint8Array> => { throw new Error('ENOENT'); });
    await start(project([{ name: 'Form1', controls: [['PictureBox', 'Picture1']],
      code: 'Private Sub Form_Load()\n    On Error Resume Next\n    Picture1.Picture = LoadPicture("missing.bmp")\n    Debug.Print Err.Number\nEnd Sub\n' }]), { readFile });
    await settle(session!);
    expect(out).toEqual([' 53 ']);
    expect(readFile).toHaveBeenCalledWith('/app/missing.bmp');
  });

  test('code-set values raise VB6 events only on change', async () => {
    const s = await start(project([{ name: 'Form1', controls: [['TextBox', 'Text1', { Text: '' }], ['CheckBox', 'Check1'], ['CommandButton', 'Command1']],
      code: 'Private Sub Command1_Click()\n    Text1.Text = "x"\n    Text1.Text = "x"\n    Check1.Value = 1\n    Debug.Print "done"\nEnd Sub\n'
        + 'Private Sub Text1_Change()\n    Debug.Print "change"\nEnd Sub\nPrivate Sub Check1_Click()\n    Debug.Print "check"\nEnd Sub\n' }]));
    click('Command1'); await settle(s);
    expect(out).toEqual(['change', 'check', 'done']);
  });
  test('loadpicture: backslash paths from App.Path', async () => {
    const readFile = vi.fn(async (_p: string) => new Uint8Array([66, 77]));
    await start(project([{ name: 'Form1', controls: [['PictureBox', 'Picture1']],
      code: 'Private Sub Form_Load()\n    Picture1.Picture = LoadPicture(App.Path & "\\pic.bmp")\n    Picture1.Picture = LoadPicture("sub\\a.png")\n    Debug.Print Err.Number\nEnd Sub\n' }]), { readFile });
    await settle(session!);
    expect(out).toEqual([' 0 ']);
    expect(readFile.mock.calls.map(c => c[0])).toEqual(['/app/pic.bmp', '/app/sub/a.png']);
  });

  test('public members of another form: Sub, Function, variable; Private hidden', async () => {
    const s = await start(project([
      { name: 'Form1', controls: [['CommandButton', 'Command1']],
        code: 'Private Sub Command1_Click()\n    Form2.Greet "x"\n    Debug.Print Form2.Twice(3)\n    Form2.Counter = 5\n    Debug.Print Form2.Counter\n'
          + '    On Error Resume Next\n    Form2.Hidden\n    Debug.Print Err.Number\nEnd Sub\n' },
      { name: 'Form2', code: 'Public Counter As Integer\nSub Greet(s As String)\n    Debug.Print "hei " & s\nEnd Sub\n'
          + 'Public Function Twice(n As Integer) As Integer\n    Twice = n * 2\nEnd Function\nPrivate Sub Hidden()\nEnd Sub\n' },
    ]));
    click('Command1'); await settle(s);
    expect(out).toEqual(['hei x', ' 6 ', ' 5 ', ' 438 ']);
  });

  test('Form_Load waits for an Initialize that calls DoEvents', async () => {
    const s = await start(project([{ name: 'Form1', code: 'Private Sub Form_Initialize()\n    Debug.Print "i1"\n    DoEvents\n    Debug.Print "i2"\nEnd Sub\n'
      + 'Private Sub Form_Load()\n    Debug.Print "load"\nEnd Sub\n' }]));
    await settle(s);
    expect(out).toEqual(['i1', 'i2', 'load']);
  });
});

test('Beep reuses one AudioContext per session and closes it when the session ends', async () => {
  const made: { close: ReturnType<typeof vi.fn> }[] = [];
  class FakeAudio {
    currentTime = 0;
    destination = {};
    close = vi.fn(async () => {});
    constructor() { made.push(this); }
    createOscillator() { return { frequency: { value: 0 }, connect: (g: unknown) => g, start() {}, stop() {} }; }
    createGain() { return { gain: { value: 0 }, connect: (d: unknown) => d }; }
  }
  vi.stubGlobal('AudioContext', FakeAudio);
  try {
    const s = await start(project([{ name: 'Form1', code: 'Private Sub Form_Load()\n    Beep\n    Beep\nEnd Sub' }]));
    await settle(s);
    expect(made).toHaveLength(1);
    s.end();
    expect(made[0].close).toHaveBeenCalledTimes(1);
    s.beep();   // after the end: no new context
    expect(made).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); }
});

test('App.EXEName is the project name in the IDE and cb.appName in a made app', async () => {
  const mk = () => { const p = newProject(); p.name = 'Proj'; p.forms = [newForm('Form1', 'Private Sub Form_Load()\nDebug.Print App.EXEName\nEnd Sub')]; p.startupForm = 'Form1'; return p; };
  await start(mk());
  expect(out.join('')).toContain('Proj');
  session!.end();
  out = [];
  await start(mk(), { appName: 'Mitt Program' });
  expect(out.join('')).toContain('Mitt Program');
});

test('TypeOf on controls and forms (For Each over Me.Controls)', async () => {
  const s = await start(project([{ name: 'Form1', controls: [['TextBox', 'Text1'], ['CommandButton', 'Command1'], ['Label', 'Label1']],
    code: [
      'Private Sub Form_Load()',
      '  Dim c As Control, n As Integer',
      '  For Each c In Me.Controls',
      '    If TypeOf c Is TextBox Or TypeOf c Is VB.Label Then n = n + 1',
      '  Next',
      '  Debug.Print n; TypeOf Command1 Is CommandButton; TypeOf Command1 Is Control; TypeOf Command1 Is TextBox',
      '  Debug.Print TypeOf Me Is Form; TypeOf Me Is Form1; TypeOf Me Is Form2; TypeOf Text1 Is Object',
      'End Sub'].join('\n') }]));
  await settle(s);
  expect(out).toEqual([' 2 TrueTrueFalse', 'TrueTrueFalseTrue']);
});
