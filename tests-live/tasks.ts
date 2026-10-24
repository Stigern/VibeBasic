// The task suite: what a hobbyist asks the AI in code mode, form mode, on a run-time error and as a question.
// Each task builds a fresh project, names the window the request is made from, and (where it can) checks the behaviour
// of the result by running it.
import { layoutProblems } from '../src/ai/layoutCheck';
import { shortcutText } from '../src/model/menus';
import { newMdiForm } from '../src/model/mdi';
import { newControl, newForm, newProject } from '../src/model/controls';
import type { ControlDef, ControlType, FormDef, ModuleDef, Project, PropValue } from '../src/model/types';
import { APP, type Rt, type runtimeBackend } from './runtime';

export type Category = 'code' | 'form' | 'error' | 'question';
export interface Step {
  /** The form or module whose window the request is made from. */
  item: string;
  view: 'code' | 'designer';
  prompt: string;
  /** Code window cursor: a line number, or the name of a procedure (its first body line). Default line 1. */
  cursor?: number | string;
  changes?: string[];
  askMore?: string[];
}
type Env = ReturnType<typeof runtimeBackend>;
export interface Task {
  id: string;
  category: Category;
  title: string;
  hard?: boolean;
  /** A request VibeBasic cannot fulfil with its current ops (a capability probe; not counted in the success rates). */
  gap?: boolean;
  project(): Project;
  steps: Step[];
  /** Ask AI on an error: the program runs in the RunController; `click` presses a button after the start. */
  error?: { click?: string; compile?: boolean };
  /** Questions: the answer text is checked (null: fine, else the failure). */
  answerCheck?(text: string): string | null;
  /** Seeds files and databases before every run (the error run and the check run). */
  seed?(env: Env): void;
  /** Static checks of the resulting project (failures). */
  inspect?(p: Project): string[];
  /** Behaviour checks in a run of the resulting project (failures). */
  check?(rt: Rt, p: Project): Promise<string[]>;
}

// ---------------------------------------------------------------------------------------------------------------
// project building

type Ctl = [type: Exclude<ControlType, 'Form'>, name: string, props?: Record<string, PropValue>, parent?: string];
function mkForm(name: string, code: string, ctls: Ctl[], props: Record<string, PropValue> = {}): FormDef {
  const f = newForm(name, code);
  Object.assign(f.props, props);
  for (const [type, cname, p = {}, parent] of ctls) {
    const par = parent ? f.controls.find(c => c.name === parent) : undefined;
    const c = newControl(f, type, { left: Number(p.Left ?? 240), top: Number(p.Top ?? 240), width: p.Width as number | undefined, height: p.Height as number | undefined }, par?.id ?? null);
    if (c.props.Caption === c.name) c.props.Caption = cname;
    if (c.props.Text === c.name) c.props.Text = '';
    c.name = cname;
    Object.assign(c.props, p);
    f.controls.push(c);
  }
  return f;
}
function project(forms: FormDef[], modules: ModuleDef[] = [], startup = forms[0]?.name ?? 'Form1'): Project {
  const p = newProject();
  p.forms = forms; p.modules = modules; p.startupForm = startup;
  return p;
}
const lines = (...l: string[]) => l.join('\n');

// ---------------------------------------------------------------------------------------------------------------
// check helpers

const formOf = (p: Project, name = 'Form1') => p.forms.find(f => f.name.toLowerCase() === name.toLowerCase())!;
const ofType = (f: FormDef, t: ControlType) => f.controls.filter(c => c.type === t);
const num = (v: PropValue | undefined) => Number(v ?? 0);
const expectEq = (fails: string[], what: string, got: string, want: string) => { if (got !== want) fails.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
/** A caption that ends in the number `want` ("5", "Result: 5", "= 5"), not in a longer one ("15", "1020"). */
const expectNum = (fails: string[], what: string, got: string, want: string) => { if (!new RegExp(`(^|[^0-9.])${want.replace('.', '\\.')}$`).test(got.trim())) fails.push(`${what}: got ${JSON.stringify(got)}, want ${want}`); };
const noErrors = (rt: Rt, fails: string[]) => {
  for (const e of rt.host.errors) fails.push(`run-time error ${e.number}: ${e.description}`);
  if (rt.breaks) fails.push(`${rt.breaks} break(s)`);
};
const caption = (c: ControlDef) => String(c.props.Caption ?? '').replace(/&/g, '');
const byCaption = (f: FormDef, re: RegExp, t?: ControlType) => f.controls.find(c => (!t || c.type === t) && re.test(caption(c)));
/** New layout problems of the result compared with the form before (by rule and controls). */
export function newLayoutProblems(before: FormDef | undefined, after: FormDef): string[] {
  const old = new Set(before ? layoutProblems(before).map(p => p.key) : []);
  return layoutProblems(after).filter(p => !old.has(p.key)).map(p => p.text);
}

// ---------------------------------------------------------------------------------------------------------------
// code mode

const calc = (): Project => project([mkForm('Form1', '', [
  ['TextBox', 'Text1', { Left: 240, Top: 240 }], ['TextBox', 'Text2', { Left: 240, Top: 720 }],
  ['CommandButton', 'Command1', { Left: 240, Top: 1200, Caption: '+' }], ['Label', 'Label1', { Left: 240, Top: 1800, Width: 2400 }]])]);

export const TASKS: Task[] = [
  {
    id: 'c-calc', category: 'code', title: 'calculator button handler',
    project: calc,
    steps: [{ item: 'Form1', view: 'code', prompt: 'When I click Command1, add the numbers in Text1 and Text2 and show the result in Label1.' }],
    async check(rt) {
      const f: string[] = [];
      await rt.exec('Form1.Text1.Text = "2"'); await rt.exec('Form1.Text2.Text = "3"');
      await rt.click('Form1', 'Command1');
      expectNum(f, '2+3', await rt.val('Form1.Label1.Caption'), '5');
      await rt.exec('Form1.Text1.Text = "10"'); await rt.exec('Form1.Text2.Text = "20"');
      await rt.click('Form1', 'Command1');
      expectNum(f, '10+20', await rt.val('Form1.Label1.Caption'), '30');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'c-validate', category: 'code', title: 'validate a TextBox as a number with MsgBox',
    project: () => project([mkForm('Form1', '', [['TextBox', 'Text1'], ['CommandButton', 'Command1', { Top: 720 }], ['Label', 'Label1', { Top: 1320, Width: 2400 }]])]),
    steps: [{ item: 'Form1', view: 'code', prompt: 'When Command1 is clicked, check that Text1 contains a number. If not, show a MsgBox saying "Please enter a number" and put the focus back in Text1. If it is a number, show the number times 2 in Label1.' }],
    async check(rt) {
      const f: string[] = [];
      await rt.exec('Form1.Text1.Text = "abc"');
      await rt.click('Form1', 'Command1');
      if (!rt.host.msgs.some(m => /number/i.test(m))) f.push(`no MsgBox about a number for "abc" (msgs: ${JSON.stringify(rt.host.msgs)})`);
      await rt.exec('Form1.Text1.Text = "4"');
      await rt.click('Form1', 'Command1');
      expectNum(f, '4*2', await rt.val('Form1.Label1.Caption'), '8');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'c-file', category: 'code', title: 'read a text file into a ListBox with Open / Line Input',
    project: () => project([mkForm('Form1', '', [['ListBox', 'List1', { Width: 2400, Height: 1500 }], ['CommandButton', 'Command1', { Top: 1920 }]])]),
    seed: env => env.fs.writeFile(`${APP}/names.txt`, 'Ann\r\nBob\r\nCid\r\n'),
    steps: [{ item: 'Form1', view: 'code', prompt: 'When Command1 is clicked, read the text file names.txt in the program folder line by line with Open and Line Input # and add every line to List1.' }],
    async check(rt) {
      const f: string[] = [];
      await rt.click('Form1', 'Command1');
      expectEq(f, 'ListCount', await rt.val('Form1.List1.ListCount'), '3');
      expectEq(f, 'List(0)', await rt.val('Form1.List1.List(0)'), 'Ann');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'c-settings', category: 'code', title: 'save settings with SaveSetting',
    project: () => project([mkForm('Form1', '', [['TextBox', 'Text1'], ['CommandButton', 'Command1', { Top: 720, Caption: 'Save' }]])]),
    steps: [{ item: 'Form1', view: 'code', prompt: 'Save the text of Text1 with SaveSetting when Command1 is clicked (app "MyApp", section "Options", key "Name"), and load it back into Text1 in Form_Load with GetSetting.' }],
    async check(rt) {
      const f: string[] = [];
      await rt.exec('Form1.Text1.Text = "Stig"');
      await rt.click('Form1', 'Command1');
      expectEq(f, 'GetSetting after Save', await rt.val('GetSetting("MyApp", "Options", "Name")'), 'Stig');
      noErrors(rt, f);
      // a second run loads it back
      rt.session.end();
      await rt.start();
      expectEq(f, 'Text1 after restart', await rt.val('Form1.Text1.Text'), 'Stig');
      return f;
    },
  },
  {
    id: 'c-class', category: 'code', title: 'class module Person with Property Let/Get and a method, used from a form', hard: true,
    project: () => project([mkForm('Form1', '', [['CommandButton', 'Command1'], ['Label', 'Label1', { Top: 840, Width: 3000 }]])],
      [{ id: 'cls1', name: 'Person', code: '', kind: 'class', instancing: 1 }]),
    steps: [
      { item: 'Person', view: 'code', prompt: 'Write this class: Name (String) and Age (Integer) as properties with Property Let and Property Get, stored in private variables, and a function Describe that returns the name, " is " and the age, like "Ann is 30".' },
      { item: 'Form1', view: 'code', prompt: 'When Command1 is clicked, create a new Person with Name Ann and Age 30 and show its Describe in Label1.' },
    ],
    async check(rt) {
      const f: string[] = [];
      await rt.click('Form1', 'Command1');
      expectEq(f, 'Label1', await rt.val('Form1.Label1.Caption'), 'Ann is 30');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'c-timer', category: 'code', title: 'Timer animation that moves a Shape',
    project: () => project([mkForm('Form1', '', [['Timer', 'Timer1', { Enabled: false, Interval: 50 }], ['Shape', 'Shape1', { Left: 240, Top: 1200, Width: 495, Height: 495 }],
      ['CommandButton', 'Command1', { Left: 240, Top: 240, Caption: 'Start' }]])]),
    steps: [{ item: 'Form1', view: 'code', prompt: 'Make Shape1 move to the right by 60 twips on every tick of Timer1. Command1 starts and stops the animation. When the shape reaches the right edge of the form it should start again at the left.' }],
    async check(rt) {
      const f: string[] = [];
      const left0 = Number(await rt.val('Form1.Shape1.Left'));
      await rt.click('Form1', 'Command1');
      await new Promise(r => setTimeout(r, 700));
      const left1 = Number(await rt.val('Form1.Shape1.Left'));
      if (!(left1 > left0)) f.push(`Shape1 did not move after Start (Left ${left0} -> ${left1})`);
      await rt.click('Form1', 'Command1');
      const left2 = Number(await rt.val('Form1.Shape1.Left'));
      await new Promise(r => setTimeout(r, 400));
      const left3 = Number(await rt.val('Form1.Shape1.Left'));
      if (left3 !== left2) f.push(`Shape1 still moves after the second click (${left2} -> ${left3})`);
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'c-chart', category: 'code', title: 'bar chart with Line on a PictureBox (ScaleMode)', hard: true,
    project: () => project([mkForm('Form1', '', [['PictureBox', 'Picture1', { Width: 4000, Height: 2500, BackColor: 16777215 }], ['CommandButton', 'Command1', { Top: 2880 }]], { Width: 4800, Height: 4200 })]),
    steps: [{ item: 'Form1', view: 'code', prompt: 'When Command1 is clicked, draw a bar chart of the values 3, 7, 2 and 5 in Picture1: one filled bar per value with Line and BF, each in a different colour. Use ScaleMode or Scale so the bars fill the picture.' }],
    async check(rt) {
      const f: string[] = [];
      await rt.click('Form1', 'Command1');
      noErrors(rt, f);
      if (f.length) return f;
      const sl = Number(await rt.val('Form1.Picture1.ScaleLeft')), st = Number(await rt.val('Form1.Picture1.ScaleTop'));
      const sw = Number(await rt.val('Form1.Picture1.ScaleWidth')), sh = Number(await rt.val('Form1.Picture1.ScaleHeight'));
      const colors = new Map<string, number>();
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
        const v = await rt.val(`Form1.Picture1.Point(${sl + sw * (i + 0.5) / 12}, ${st + sh * (j + 0.5) / 12})`);
        colors.set(v, (colors.get(v) ?? 0) + 1);
      }
      const drawn = [...colors.entries()].filter(([c]) => c !== '16777215' && c !== '-1').reduce((n, [, k]) => n + k, 0);
      const distinct = [...colors.keys()].filter(c => c !== '16777215' && c !== '-1').length;
      if (drawn < 144 * 0.15) f.push(`too little drawn: ${drawn} of 144 samples not white (${JSON.stringify([...colors])})`);
      if (distinct < 2) f.push(`bars not in different colours (${distinct} colour)`);
      return f;
    },
  },
  {
    id: 'c-ado', category: 'code', title: 'ADO query on a SQLite file into a ListView', hard: true,
    project: () => project([mkForm('Form1', '', [['ListView', 'ListView1', { Width: 4300, Height: 2500 }]])]),
    seed: env => env.db.db(`${APP}/people.db`).exec("CREATE TABLE People (ID INTEGER PRIMARY KEY, Name TEXT, City TEXT); INSERT INTO People (Name, City) VALUES ('Cid', 'Bergen'), ('Ann', 'Oslo'), ('Bob', 'Trondheim');"),
    steps: [{ item: 'Form1', view: 'code', prompt: 'In Form_Load, open the SQLite file people.db in the program folder with ADO, run SELECT Name, City FROM People ORDER BY Name and show the rows in ListView1 in report view with the columns Name and City.' }],
    async check(rt) {
      const f: string[] = [];
      noErrors(rt, f);
      if (f.length) return f;
      expectEq(f, 'ListItems.Count', await rt.val('Form1.ListView1.ListItems.Count'), '3');
      expectEq(f, 'first item', await rt.val('Form1.ListView1.ListItems(1).Text'), 'Ann');
      expectEq(f, 'first City', await rt.val('Form1.ListView1.ListItems(1).SubItems(1)'), 'Oslo');
      expectEq(f, 'View', await rt.val('Form1.ListView1.View'), '3');
      return f;
    },
  },
  {
    id: 'c-dict', category: 'code', title: 'Dictionary word count',
    project: () => project([mkForm('Form1', '', [['TextBox', 'Text1', { Width: 3600 }], ['CommandButton', 'Command1', { Top: 720 }], ['ListBox', 'List1', { Top: 1200, Width: 3600, Height: 1500 }]])]),
    steps: [{ item: 'Form1', view: 'code', prompt: 'When Command1 is clicked, count how often each word occurs in Text1 (words are separated by spaces, ignore upper/lower case) using a Dictionary, and fill List1 with one line per word like "apple: 2", in the order the words first appear.' }],
    async check(rt) {
      const f: string[] = [];
      await rt.exec('Form1.Text1.Text = "the cat and the hat The end"');
      await rt.click('Form1', 'Command1');
      expectEq(f, 'ListCount', await rt.val('Form1.List1.ListCount'), '5');
      expectEq(f, 'List(0)', await rt.val('Form1.List1.List(0)'), 'the: 3');
      expectEq(f, 'List(3)', await rt.val('Form1.List1.List(3)'), 'hat: 1');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'c-fib', category: 'code', title: 'recursive Fibonacci with error handling',
    project: calc,
    steps: [{ item: 'Form1', view: 'code', prompt: 'Add a recursive function Fib(n) that returns the n-th Fibonacci number (Fib(0) = 0, Fib(1) = 1). When Command1 is clicked, show Fib of the number in Text1 in Label1. Use error handling (On Error) so that a bad input shows "Error" in Label1 instead of stopping the program.' }],
    async check(rt) {
      const f: string[] = [];
      await rt.exec('Form1.Text1.Text = "10"');
      await rt.click('Form1', 'Command1');
      expectNum(f, 'Fib(10)', await rt.val('Form1.Label1.Caption'), '55');
      await rt.exec('Form1.Text1.Text = "abc"');
      await rt.click('Form1', 'Command1');
      if (!/error/i.test(await rt.val('Form1.Label1.Caption'))) f.push(`Fib(abc): Label1 ${JSON.stringify(await rt.val('Form1.Label1.Caption'))}`);
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'c-compile', category: 'code', title: 'fix a compile error (For without Next) via the compile error box',
    project: () => project([mkForm('Form1', lines(
      'Private Sub Command1_Click()',
      '    Dim i As Integer, total As Integer',
      '    For i = 1 To 10',
      '        total = total + i',
      '    Label1.Caption = total',
      'End Sub'), [['CommandButton', 'Command1'], ['Label', 'Label1', { Top: 840 }]])]),
    steps: [],
    error: { compile: true },
    async check(rt) {
      const f: string[] = [];
      await rt.click('Form1', 'Command1');
      expectNum(f, 'Label1', await rt.val('Form1.Label1.Caption'), '55');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'c-explain-change', category: 'code', title: 'explain, then Ask more... to change it',
    project: () => project([mkForm('Form1', lines(
      'Private Sub Command1_Click()',
      '    Label1.Caption = Val(Text1.Text) / Val(Text2.Text)',
      'End Sub'), [['TextBox', 'Text1'], ['TextBox', 'Text2', { Top: 720 }], ['CommandButton', 'Command1', { Top: 1200 }], ['Label', 'Label1', { Top: 1800, Width: 3000 }]])]),
    steps: [{ item: 'Form1', view: 'code', cursor: 'Command1_Click', prompt: 'Explain what Command1_Click does.',
      askMore: ['Now change it so that when Text2 is 0 it shows "Cannot divide by zero" in Label1 instead of an error.'] }],
    async check(rt) {
      const f: string[] = [];
      await rt.exec('Form1.Text1.Text = "6"'); await rt.exec('Form1.Text2.Text = "3"');
      await rt.click('Form1', 'Command1');
      expectNum(f, '6/3', await rt.val('Form1.Label1.Caption'), '2');
      await rt.exec('Form1.Text2.Text = "0"');
      await rt.click('Form1', 'Command1');
      if (!/cannot divide by zero/i.test(await rt.val('Form1.Label1.Caption'))) f.push(`6/0: Label1 ${JSON.stringify(await rt.val('Form1.Label1.Caption'))}`);
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'c-change', category: 'code', title: 'a proposal, then Change... with a further wish',
    project: () => project([mkForm('Form1', '', [['TextBox', 'Text1'], ['Label', 'Label1', { Top: 720, Width: 2400 }],
      ['CommandButton', 'Command1', { Top: 1200, Caption: 'Copy' }], ['CommandButton', 'Command2', { Left: 1680, Top: 1200, Caption: 'Clear' }]])]),
    steps: [{ item: 'Form1', view: 'code', prompt: 'Command2 should clear Text1 and Label1.',
      changes: ['Also put the focus back in Text1 after clearing, and make Command1 copy Text1 into Label1.'] }],
    async check(rt) {
      const f: string[] = [];
      await rt.exec('Form1.Text1.Text = "hi"');
      await rt.click('Form1', 'Command1');
      expectEq(f, 'copy', await rt.val('Form1.Label1.Caption'), 'hi');
      await rt.click('Form1', 'Command2');
      expectEq(f, 'clear Text1', await rt.val('Form1.Text1.Text'), '');
      expectEq(f, 'clear Label1', await rt.val('Form1.Label1.Caption'), '');
      noErrors(rt, f);
      return f;
    },
  },

  // -------------------------------------------------------------------------------------------------------------
  // form mode

  {
    id: 'f-login', category: 'form', title: 'login form (then Change...: fixed dialog, centred)',
    project: () => project([newForm('Form1')]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'Make this a login form: a user name box and a password box (shows *) with labels, and OK and Cancel buttons. Cancel closes the form. OK shows MsgBox "Welcome " & the user name.',
      changes: ['Make it a fixed dialog (BorderStyle 3) and centre it on the screen.'] }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      const boxes = ofType(form, 'TextBox');
      if (boxes.length < 2) f.push(`${boxes.length} TextBoxes`);
      if (!boxes.some(b => b.props.PasswordChar === '*')) f.push('no TextBox with PasswordChar *');
      if (!byCaption(form, /^OK$/i, 'CommandButton') || !byCaption(form, /^Cancel$/i, 'CommandButton')) f.push('no OK and Cancel buttons');
      if (form.props.BorderStyle !== 3) f.push(`BorderStyle ${String(form.props.BorderStyle)}`);
      if (![1, 2].includes(Number(form.props.StartUpPosition))) f.push(`StartUpPosition ${String(form.props.StartUpPosition)}`);
      return f;
    },
    async check(rt, p) {
      const f: string[] = [], form = formOf(p);
      const user = ofType(form, 'TextBox').find(b => b.props.PasswordChar !== '*');
      const ok = byCaption(form, /^OK$/i, 'CommandButton'), cancel = byCaption(form, /^Cancel$/i, 'CommandButton');
      if (!user || !ok || !cancel) return ['controls missing'];
      await rt.exec(`Form1.${user.name}.Text = "stig"`);
      await rt.click('Form1', ok.name, ok.index);
      if (!rt.host.msgs.some(m => /Welcome stig/i.test(m))) f.push(`OK: no "Welcome stig" (msgs ${JSON.stringify(rt.host.msgs)})`);
      await rt.click('Form1', cancel.name, cancel.index);
      if (!rt.ended && (await rt.val('Forms.Count')) !== '0') f.push('Cancel did not close the form');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'f-calc', category: 'form', title: 'calculator layout', hard: true,
    project: () => project([newForm('Form1')]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'Lay out a calculator: a read-only display TextBox at the top, right-aligned, and below it a grid of buttons: 7 8 9 /, 4 5 6 *, 1 2 3 -, 0 C = +. No code yet.' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      const btns = ofType(form, 'CommandButton');
      if (btns.length !== 16) f.push(`${btns.length} buttons, want 16`);
      for (const k of ['7', '8', '9', '/', '0', 'C', '=', '+']) if (!btns.some(b => caption(b) === k)) f.push(`no button ${k}`);
      const box = ofType(form, 'TextBox')[0];
      if (!box) f.push('no TextBox'); else {
        if (box.props.Locked !== true) f.push('display not Locked');
        if (num(box.props.Alignment) !== 1) f.push(`display Alignment ${String(box.props.Alignment)}`);
        if (btns.some(b => num(b.props.Top) < num(box.props.Top) + num(box.props.Height))) f.push('buttons not below the display');
      }
      const tops = new Set(btns.map(b => num(b.props.Top))), lefts = new Set(btns.map(b => num(b.props.Left)));
      if (btns.length === 16 && (tops.size !== 4 || lefts.size !== 4)) f.push(`not a 4x4 grid (${tops.size} rows, ${lefts.size} columns)`);
      return f;
    },
  },
  {
    id: 'f-menu', category: 'form', title: 'menu bar File/Edit/Help with shortcuts',
    project: () => project([newForm('Form1')]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'Add a menu bar: File with New (Ctrl+N), Open... (Ctrl+O), Save (Ctrl+S), a separator and Exit; Edit with Cut (Ctrl+X), Copy (Ctrl+C), Paste (Ctrl+V); Help with About. Exit ends the program and About shows a MsgBox.' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      const menus = ofType(form, 'Menu');
      const top = menus.filter(m => !m.parentId).map(caption);
      if (top.join(',') !== 'File,Edit,Help') f.push(`top menus ${JSON.stringify(top)}`);
      const want: [RegExp, string][] = [[/^New/, 'Ctrl+N'], [/^Open/, 'Ctrl+O'], [/^Save/, 'Ctrl+S'], [/^Cut/, 'Ctrl+X'], [/^Copy/, 'Ctrl+C'], [/^Paste/, 'Ctrl+V']];
      for (const [re, sc] of want) {
        const m = menus.find(x => re.test(caption(x)));
        if (!m) f.push(`no ${re.source} item`); else if (shortcutText(m.props.Shortcut ?? 0) !== sc) f.push(`${caption(m)} shortcut ${shortcutText(m.props.Shortcut ?? 0)}`);
      }
      if (!menus.some(m => caption(m) === '-')) f.push('no separator');
      return f;
    },
    async check(rt, p) {
      const f: string[] = [], form = formOf(p);
      const about = form.controls.find(c => c.type === 'Menu' && /^About/.test(caption(c)));
      const exit = form.controls.find(c => c.type === 'Menu' && /^Exit/.test(caption(c)));
      if (!about || !exit) return ['About or Exit missing'];
      await rt.fire('Form1', `${about.name}_Click`);
      if (!rt.host.msgs.length) f.push('About showed no MsgBox');
      await rt.fire('Form1', `${exit.name}_Click`);
      if (!rt.ended && (await rt.val('Forms.Count')) !== '0') f.push('Exit did not end the program');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'f-entry', category: 'form', title: 'data-entry form with aligned labels',
    project: () => project([newForm('Form1')]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'A customer data-entry form with Name, Address, City, Phone and E-mail fields: labels on the left, the text boxes in one column with the same left edge and width, and Save and Cancel buttons at the bottom right.' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      const boxes = ofType(form, 'TextBox'), labels = ofType(form, 'Label');
      if (boxes.length !== 5) f.push(`${boxes.length} TextBoxes`);
      if (new Set(boxes.map(b => num(b.props.Left))).size > 1) f.push('boxes do not share Left');
      if (new Set(boxes.map(b => num(b.props.Width))).size > 1) f.push('boxes do not share Width');
      for (const b of boxes) {
        const mid = num(b.props.Top) + num(b.props.Height) / 2;
        const l = labels.find(x => Math.abs(num(x.props.Top) + num(x.props.Height) / 2 - mid) <= 120);
        if (!l) f.push(`no label beside ${b.name}`); else if (num(l.props.Left) + num(l.props.Width) > num(b.props.Left)) f.push(`label ${l.name} overlaps or is right of ${b.name}`);
      }
      const save = byCaption(form, /^Save$/i, 'CommandButton'), cancel = byCaption(form, /^Cancel$/i, 'CommandButton');
      if (!save || !cancel) f.push('no Save and Cancel');
      else if (boxes.some(b => num(save.props.Top) < num(b.props.Top) + num(b.props.Height))) f.push('Save not below the boxes');
      else if (num(cancel.props.Left) + num(cancel.props.Width) < num(form.props.Width) / 2) f.push('buttons not at the right');
      return f;
    },
  },
  {
    id: 'f-sstab', category: 'form', title: 'SSTab settings dialog', hard: true,
    project: () => project([newForm('Form1')]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'A settings dialog with an SSTab with three tabs: General, View and Advanced. General: a CheckBox "Start with Windows" and a CheckBox "Check for updates". View: OptionButtons "Small icons" and "Large icons". Advanced: a Label "Cache size:" and a TextBox. OK and Cancel below the SSTab.' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      const tab = ofType(form, 'SSTab')[0];
      if (!tab) return ['no SSTab'];
      if (num(tab.props.Tabs) !== 3) f.push(`Tabs = ${String(tab.props.Tabs)}`);
      const caps = String(tab.props.TabCaption ?? '');
      if (!/General/.test(caps) || !/Advanced/.test(caps)) f.push(`TabCaption ${JSON.stringify(caps)}`);
      const on = (re: RegExp, t: number) => form.controls.find(c => c.parentId === tab.id && re.test(caption(c)) && (c.tab ?? 0) === t);
      if (!on(/Start with Windows/i, 0)) f.push('"Start with Windows" not on tab 0');
      if (!on(/Large icons/i, 1)) f.push('"Large icons" not on tab 1');
      if (!form.controls.some(c => c.parentId === tab.id && c.type === 'TextBox' && (c.tab ?? 0) === 2)) f.push('no TextBox on tab 2');
      const ok = byCaption(form, /^OK$/i, 'CommandButton');
      if (!ok || ok.parentId) f.push('no OK outside the SSTab');
      else if (num(ok.props.Top) < num(tab.props.Top) + num(tab.props.Height)) f.push('OK not below the SSTab');
      return f;
    },
  },
  {
    id: 'f-tabstrip', category: 'form', title: 'TabStrip with a Frame per tab, switched in code', hard: true,
    project: () => project([newForm('Form1')]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'A settings dialog with a TabStrip with the tabs General and Advanced and one Frame per tab with a CheckBox on each; show the right Frame when the tab changes (TabStrip1_Click).' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      const ts = ofType(form, 'TabStrip')[0];
      if (!ts) return ['no TabStrip'];
      const tabs = Array.isArray(ts.props.Tabs) ? ts.props.Tabs : String(ts.props.Tabs ?? '').split('\n');
      if (tabs.length !== 2) f.push(`Tabs ${JSON.stringify(ts.props.Tabs)}`);
      if (ofType(form, 'Frame').length < 2) f.push('fewer than 2 Frames');
      if (!/Sub\s+TabStrip1_Click/i.test(form.code)) f.push('no TabStrip1_Click');
      return f;
    },
    async check(rt, p) {
      const f: string[] = [];
      noErrors(rt, f);
      const frames = ofType(formOf(p), 'Frame');
      if (frames.length >= 2) {
        const vis = [await rt.val(`Form1.${frames[0].name}.Visible`), await rt.val(`Form1.${frames[1].name}.Visible`)];
        if (vis[0] === vis[1]) f.push(`at start both frames have Visible ${vis[0]}`);
      }
      await rt.exec('Set Form1.TabStrip1.SelectedItem = Form1.TabStrip1.Tabs(2)');
      await rt.fire('Form1', 'TabStrip1_Click');
      if (frames.length >= 2 && (await rt.val(`Form1.${frames[1].name}.Visible`)) !== 'True') f.push('second frame not shown after tab 2');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'f-mdi', category: 'form', title: 'MDI app: File/New child, Window menu (existing MDIForm)', hard: true,
    project: () => {
      const child = newForm('Form1');
      child.props.MDIChild = true;
      return project([newMdiForm('MDIForm1'), child], [], 'MDIForm1');
    },
    steps: [{ item: 'MDIForm1', view: 'designer', prompt: 'Add a File menu with New (opens a new Form1 window inside this MDI form) and Exit, and a Window menu with Cascade, Tile Horizontal and the list of open windows.' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p, 'MDIForm1');
      const menus = ofType(form, 'Menu');
      if (!menus.some(m => !m.parentId && /Window/.test(caption(m)) && m.props.WindowList === true)) f.push('no top Window menu with WindowList');
      if (!menus.some(m => /^New/.test(caption(m)))) f.push('no New item');
      if (!menus.some(m => /Cascade/.test(caption(m)))) f.push('no Cascade item');
      return f;
    },
    async check(rt, p) {
      const f: string[] = [], form = formOf(p, 'MDIForm1');
      const nw = form.controls.find(c => c.type === 'Menu' && /^New/.test(caption(c)));
      const cas = form.controls.find(c => c.type === 'Menu' && /Cascade/.test(caption(c)));
      if (!nw) return ['no New'];
      const before = Number(await rt.val('Forms.Count'));
      await rt.fire('MDIForm1', `${nw.name}_Click`);
      await rt.fire('MDIForm1', `${nw.name}_Click`);
      const after = Number(await rt.val('Forms.Count'));
      if (after - before < 2) f.push(`New twice: Forms.Count ${before} -> ${after}`);
      if (cas) await rt.fire('MDIForm1', `${cas.name}_Click`);
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'f-mdi-new', category: 'form', title: 'turn a one-form project into an MDI app (capability probe)', gap: true,
    project: () => project([mkForm('Form1', '', [['TextBox', 'Text1', { Width: 3000, Height: 1500, MultiLine: true }]])]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'Turn this project into an MDI application: a main MDI window with a File menu (New, Exit), and Form1 as the child form.' }],
    inspect(p) {
      const f: string[] = [];
      if (!p.forms.some(x => x.mdi)) f.push('no MDI form in the project');
      if (formOf(p).props.MDIChild !== true) f.push('Form1 is not an MDI child');
      return f;
    },
  },
  {
    id: 'f-bars', category: 'form', title: 'form with a Toolbar and a StatusBar',
    project: () => project([newForm('Form1')]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'Add a Toolbar at the top with the buttons New, Open and Save, and a StatusBar at the bottom with two panels: the first says "Ready", the second shows the time. When a toolbar button is clicked, show its caption in the first panel.' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      const tb = ofType(form, 'Toolbar')[0], sb = ofType(form, 'StatusBar')[0];
      if (!tb) f.push('no Toolbar'); else {
        const b = Array.isArray(tb.props.Buttons) ? tb.props.Buttons : [];
        if (b.filter(x => /New|Open|Save/.test(x)).length < 3) f.push(`Buttons ${JSON.stringify(tb.props.Buttons)}`);
      }
      if (!sb) f.push('no StatusBar'); else {
        const pn = Array.isArray(sb.props.Panels) ? sb.props.Panels : [];
        if (pn.length < 2) f.push(`Panels ${JSON.stringify(sb.props.Panels)}`);
      }
      if (!/_ButtonClick\s*\(/i.test(form.code)) f.push('no ButtonClick handler');
      return f;
    },
    async check(rt, p) {
      const f: string[] = [];
      noErrors(rt, f);
      const sb = ofType(formOf(p), 'StatusBar')[0];
      if (sb) expectEq(f, 'panel 1', await rt.val(`Form1.${sb.name}.Panels(1).Text`), 'Ready');
      return f;
    },
  },
  {
    id: 'f-messy', category: 'form', title: '"make it look nicer / align these controls" on a messy form',
    project: () => project([mkForm('Form1', lines(
      'Private Sub Command1_Click()',
      '    MsgBox "Saved " & Text1.Text',
      'End Sub',
      'Private Sub Command2_Click()',
      '    Unload Me',
      'End Sub'), [
      ['Label', 'Label1', { Left: 240, Top: 300, Width: 735, Height: 255, Caption: 'Name:' }], ['TextBox', 'Text1', { Left: 1100, Top: 240, Width: 2000, Height: 315 }],
      ['Label', 'Label2', { Left: 300, Top: 700, Width: 735, Height: 255, Caption: 'E-mail:' }], ['TextBox', 'Text2', { Left: 1180, Top: 660, Width: 2400, Height: 315 }],
      ['Label', 'Label3', { Left: 220, Top: 1150, Width: 615, Height: 255, Caption: 'Phone:' }], ['TextBox', 'Text3', { Left: 1000, Top: 1100, Width: 1900, Height: 315 }],
      ['CommandButton', 'Command1', { Left: 2400, Top: 1700, Width: 1215, Height: 375, Caption: 'OK' }], ['CommandButton', 'Command2', { Left: 3300, Top: 1750, Width: 1215, Height: 375, Caption: 'Cancel' }],
    ], { Width: 4800, Height: 2800 })]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'Make it look nicer: align these controls.' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      for (const n of ['Label1', 'Text1', 'Label2', 'Text2', 'Label3', 'Text3', 'Command1', 'Command2']) if (!form.controls.some(c => c.name === n)) f.push(`${n} gone`);
      const boxes = ['Text1', 'Text2', 'Text3'].map(n => form.controls.find(c => c.name === n)).filter((c): c is ControlDef => !!c);
      if (new Set(boxes.map(b => num(b.props.Left))).size > 1) f.push('boxes do not share Left');
      const labels = ['Label1', 'Label2', 'Label3'].map(n => form.controls.find(c => c.name === n)).filter((c): c is ControlDef => !!c);
      if (new Set(labels.map(b => num(b.props.Left))).size > 1) f.push('labels do not share Left');
      const c1 = form.controls.find(c => c.name === 'Command1'), c2 = form.controls.find(c => c.name === 'Command2');
      if (c1 && c2 && num(c1.props.Top) !== num(c2.props.Top)) f.push('OK and Cancel not on one row');
      const layout = layoutProblems(form);
      if (layout.length) f.push(`${layout.length} layout problems remain: ${layout.map(x => x.text).join(' | ').slice(0, 400)}`);
      return f;
    },
  },
  {
    id: 'f-cancel', category: 'form', title: '"add a Cancel button next to OK"',
    project: () => project([mkForm('Form1', lines(
      'Private Sub cmdOK_Click()',
      '    MsgBox "Hello " & Text1.Text',
      'End Sub'), [
      ['Label', 'Label1', { Left: 240, Top: 240, Width: 1095, Height: 255, Caption: 'Your name:' }], ['TextBox', 'Text1', { Left: 1440, Top: 240, Width: 2895, Height: 315 }],
      ['CommandButton', 'cmdOK', { Left: 1800, Top: 960, Width: 1215, Height: 375, Caption: 'OK', Default: true }],
    ], { Width: 4800, Height: 1950 })]),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'Add a Cancel button next to OK that closes the form.' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      const ok = form.controls.find(c => c.name === 'cmdOK'), cancel = byCaption(form, /^Cancel$/i, 'CommandButton');
      if (!ok) return ['cmdOK gone'];
      if (!cancel) return ['no Cancel button'];
      if (Math.abs(num(cancel.props.Top) - num(ok.props.Top)) > 15) f.push(`Cancel Top ${String(cancel.props.Top)} vs OK ${String(ok.props.Top)}`);
      if (!/MsgBox "Hello " & Text1\.Text/.test(form.code)) f.push('cmdOK_Click code changed');
      const layout = newLayoutProblems(undefined, form).filter(t => /cmdOK|Cancel|cmd/i.test(t));
      if (layout.length) f.push(`layout: ${layout.join(' | ').slice(0, 300)}`);
      return f;
    },
    async check(rt, p) {
      const f: string[] = [], form = formOf(p);
      const cancel = byCaption(form, /^Cancel$/i, 'CommandButton');
      if (!cancel) return ['no Cancel'];
      await rt.click('Form1', cancel.name, cancel.index);
      if (!rt.ended && (await rt.val('Forms.Count')) !== '0') f.push('Cancel did not close the form');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'f-datagrid', category: 'form', title: 'DataGrid bound to a data control', hard: true,
    project: () => project([newForm('Form1')]),
    seed: env => env.db.db(`${APP}/customers.db`).exec("CREATE TABLE Customers (ID INTEGER PRIMARY KEY, Name TEXT, City TEXT); INSERT INTO Customers (Name, City) VALUES ('Ann', 'Oslo'), ('Bob', 'Bergen'), ('Cid', 'Tromso');"),
    steps: [{ item: 'Form1', view: 'designer', prompt: 'Show the table Customers of the database customers.db (in the program folder) in a DataGrid bound to a data control, with the data control under the grid to move through the records.' }],
    inspect(p) {
      const f: string[] = [], form = formOf(p);
      const grid = ofType(form, 'DataGrid')[0];
      if (!grid) return ['no DataGrid'];
      const dc = form.controls.find(c => c.name.toLowerCase() === String(grid.props.DataSource ?? '').toLowerCase());
      if (!dc) f.push(`DataSource ${JSON.stringify(grid.props.DataSource)} is not a control`);
      else {
        // set in the Properties window or in Form_Load (the recordset opens after Form_Load)
        if (!/customers\.db/i.test(String(dc.props.DatabaseName ?? '') + String(dc.props.ConnectionString ?? '') + form.code)) f.push('data control does not name customers.db');
        if (!/Customers/i.test(String(dc.props.RecordSource ?? '')) && !/RecordSource\s*=\s*"[^"]*Customers/i.test(form.code)) f.push(`RecordSource ${JSON.stringify(dc.props.RecordSource)}`);
        if (num(dc.props.Top) < num(grid.props.Top) + num(grid.props.Height)) f.push('data control not under the grid');
      }
      return f;
    },
    async check(rt, p) {
      const f: string[] = [], form = formOf(p);
      const grid = ofType(form, 'DataGrid')[0];
      const dc = grid && form.controls.find(c => c.name.toLowerCase() === String(grid.props.DataSource ?? '').toLowerCase());
      noErrors(rt, f);
      if (!dc) return f;
      await rt.exec(`Form1.${dc.name}.Recordset.MoveLast`);
      expectEq(f, 'RecordCount', await rt.val(`Form1.${dc.name}.Recordset.RecordCount`), '3');
      noErrors(rt, f);
      return f;
    },
  },

  // -------------------------------------------------------------------------------------------------------------
  // Ask AI on a run-time error (real paused frame, runtimeErrorBox -> 'ai')

  {
    id: 'e-div0', category: 'error', title: 'division by zero (11)',
    project: () => project([mkForm('Form1', lines(
      'Private Sub Form_Load()',
      '    Dim total As Double, count As Integer',
      '    total = 120',
      '    Label1.Caption = "Average: " & total / count',
      'End Sub'), [['Label', 'Label1', { Width: 3000 }]])]),
    steps: [], error: {},
    async check(rt) {
      const f: string[] = [];
      noErrors(rt, f);
      if (!/^Average/.test(await rt.val('Form1.Label1.Caption'))) f.push(`Label1 ${await rt.val('Form1.Label1.Caption')}`);
      return f;
    },
  },
  {
    id: 'e-subscript', category: 'error', title: 'subscript out of range (9)',
    project: () => project([mkForm('Form1', lines(
      'Private Sub Form_Load()',
      '    Dim scores(1 To 5) As Integer, i As Integer, sum As Integer',
      '    For i = 1 To 6',
      '        scores(i) = i * 10',
      '        sum = sum + scores(i)',
      '    Next i',
      '    Label1.Caption = "Sum: " & sum',
      'End Sub'), [['Label', 'Label1', { Width: 3000 }]])]),
    steps: [], error: {},
    async check(rt) {
      const f: string[] = [];
      noErrors(rt, f);
      if (!/^Sum: \d+/.test(await rt.val('Form1.Label1.Caption'))) f.push(`Label1 ${await rt.val('Form1.Label1.Caption')}`);
      return f;
    },
  },
  {
    id: 'e-mismatch', category: 'error', title: 'type mismatch (13) from a TextBox',
    project: () => project([mkForm('Form1', lines(
      'Private Sub Command1_Click()',
      '    Dim age As Integer',
      '    age = Text1.Text',
      '    Label1.Caption = "Next year you are " & (age + 1)',
      'End Sub'), [['TextBox', 'Text1', { Text: 'twelve' }], ['CommandButton', 'Command1', { Top: 720 }], ['Label', 'Label1', { Top: 1320, Width: 3000 }]])]),
    steps: [], error: { click: 'Command1' },
    async check(rt) {
      const f: string[] = [];
      await rt.click('Form1', 'Command1');
      noErrors(rt, f);
      await rt.exec('Form1.Text1.Text = "20"');
      await rt.click('Form1', 'Command1');
      expectEq(f, 'age 20', await rt.val('Form1.Label1.Caption'), 'Next year you are 21');
      noErrors(rt, f);
      return f;
    },
  },
  {
    id: 'e-nothing', category: 'error', title: 'object variable not set (91)',
    project: () => project([mkForm('Form1', lines(
      'Dim items As Collection',
      'Private Sub Form_Load()',
      '    items.Add "apple"',
      '    items.Add "pear"',
      '    Label1.Caption = items.Count & " items"',
      'End Sub'), [['Label', 'Label1', { Width: 3000 }]])]),
    steps: [], error: {},
    async check(rt) {
      const f: string[] = [];
      noErrors(rt, f);
      expectEq(f, 'Label1', await rt.val('Form1.Label1.Caption'), '2 items');
      return f;
    },
  },
  {
    id: 'e-nofile', category: 'error', title: 'file not found (53)',
    project: () => project([mkForm('Form1', lines(
      'Private Sub Form_Load()',
      '    Dim s As String',
      '    Open App.Path & "\\config.txt" For Input As #1',
      '    Line Input #1, s',
      '    Close #1',
      '    Label1.Caption = s',
      'End Sub'), [['Label', 'Label1', { Width: 3000 }]])]),
    steps: [], error: {},
    async check(rt) {
      const f: string[] = [];
      noErrors(rt, f);
      return f;
    },
  },

  // -------------------------------------------------------------------------------------------------------------
  // questions

  {
    id: 'q-what', category: 'question', title: '"what does this code do"',
    project: () => project([mkForm('Form1', lines(
      'Private Sub Command1_Click()',
      '    Dim t As Double',
      '    t = Val(Text1.Text)',
      '    If Option1.Value Then',
      '        Label1.Caption = Format(t * 9 / 5 + 32, "0.0") & " F"',
      '    Else',
      '        Label1.Caption = Format((t - 32) * 5 / 9, "0.0") & " C"',
      '    End If',
      'End Sub'), [['TextBox', 'Text1'], ['OptionButton', 'Option1', { Top: 720, Caption: 'C to F' }], ['OptionButton', 'Option2', { Top: 1080, Caption: 'F to C' }],
      ['CommandButton', 'Command1', { Top: 1500 }], ['Label', 'Label1', { Top: 2040 }]])]),
    steps: [{ item: 'Form1', view: 'code', prompt: 'What does this code do?' }],
    answerCheck: t => (/celsius|fahrenheit|temperature/i.test(t) ? null : 'does not mention the temperature conversion'),
  },
  {
    id: 'q-why13', category: 'question', title: '"why does this give error 13"',
    project: () => project([mkForm('Form1', lines(
      'Private Sub Command1_Click()',
      '    Label1.Caption = Text1.Text * 2',
      'End Sub'), [['TextBox', 'Text1', { Text: 'ten' }], ['CommandButton', 'Command1', { Top: 720 }], ['Label', 'Label1', { Top: 1320 }]])]),
    steps: [{ item: 'Form1', view: 'code', cursor: 'Command1_Click', prompt: 'Why does this give error 13 when I click Command1?' }],
    answerCheck: t => (/number|numeric|Val\b|IsNumeric|text/i.test(t) && /13|type mismatch|mismatch/i.test(t) ? null : 'does not explain the text-to-number mismatch'),
  },
  {
    id: 'q-mdi', category: 'question', title: '"how do I make an MDI app"',
    project: () => project([newForm('Form1')]),
    steps: [{ item: 'Form1', view: 'code', prompt: 'How do I make an MDI app?' }],
    answerCheck: t => (/MDIForm|MDI form/i.test(t) && /MDIChild/i.test(t) ? null : 'does not mention MDIForm and MDIChild'),
  },
];
