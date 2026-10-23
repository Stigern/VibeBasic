// @vitest-environment jsdom
// MDI forms at run time: children in the MDI form's workspace, Arrange, maximize (caption), unloading, ActiveForm, New instances,
// merged menus and the Window list.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { newMdiForm } from '../../src/model/mdi';
import type { ControlDef, FormDef, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

let container: HTMLElement;
let out: string[];
let session: RunSession | undefined;
beforeEach(() => { container = document.body.appendChild(document.createElement('div')); out = []; });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });

function menu(f: FormDef, name: string, caption: string, parent: ControlDef | null, props: Record<string, PropValue> = {}): ControlDef {
  const c = newControl(f, 'Menu', { left: 0, top: 0 }, parent?.id ?? null);
  c.name = name;
  Object.assign(c.props, { Caption: caption, ...props });
  f.controls.push(c);
  return c;
}
/** MDIForm1 (startup) and the children Form2 and Form3 (MDIChild = True). */
function project(mdiCode: string, childCode = '', extra?: (p: Project) => void): Project {
  const p = newProject();
  const mdi = newMdiForm('MDIForm1', mdiCode);
  const kid = (name: string) => {
    const f = newForm(name, childCode);
    Object.assign(f.props, { MDIChild: true, Width: 3000, Height: 2000 });
    return f;
  };
  p.forms = [mdi, kid('Form2'), kid('Form3')];
  p.startupForm = 'MDIForm1';
  extra?.(p);
  return p;
}
async function start(p: Project): Promise<RunSession> {
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {}, readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  return session;
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(): Promise<void> { for (let i = 0; i < 30; i++) await tick(); }
const run = async (code: string) => { const r = await session!.immediate(code); await settle(); return r; };
const parentEl = () => container.querySelector<HTMLElement>('.vb-inline-window > .vb-form')!;
const kids = () => [...parentEl().querySelectorAll<HTMLElement>('.vb-mdi-workspace > .vb-mdi-child')];
const kidTitle = (el: HTMLElement) => el.querySelector(':scope > .vb-form > .title-bar .title-bar-text')!.textContent;
const parentTitle = () => parentEl().querySelector(':scope > .title-bar .title-bar-text')!.textContent;
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

const SHOW_BOTH = 'Private Sub MDIForm_Load()\n    Form2.Show\n    Form3.Show\nEnd Sub\n';

test('children render inside the MDI form; Cascade arranges them; maximize merges the caption', async () => {
  await start(project(SHOW_BOTH));
  expect(container.querySelectorAll('.vb-inline-window')).toHaveLength(1);   // one real window: the MDI form
  expect(kids().map(kidTitle)).toEqual(['Form2', 'Form3']);
  await run('MDIForm1.Arrange vbCascade');
  expect(await run('? Form2.Left; Form2.Top; Form3.Left; Form3.Top')).toBe(' 0  0  330  330 ');
  const [k2] = kids();
  click(k2.querySelector('.title-bar-controls button[aria-label="Maximize"]')!);
  await settle();
  expect(parentTitle()).toBe('MDIForm1 - [Form2]');
  expect(await run('? Form2.WindowState; MDIForm1.ActiveForm.Name')).toBe(' 2 Form2');
  await run('Form2.WindowState = 0');
  expect(parentTitle()).toBe('MDIForm1');
});

test('closing the MDI form unloads the children first, with QueryUnload UnloadMode vbFormMDIForm', async () => {
  const log = (who: string) => `Private Sub Form_QueryUnload(Cancel As Integer, UnloadMode As Integer)\n    Debug.Print "${who}Q" & UnloadMode\nEnd Sub\n`
    + `Private Sub Form_Unload(Cancel As Integer)\n    Debug.Print "${who}U"\nEnd Sub\n`;
  await start(project(SHOW_BOTH + log('M').replace(/Form_/g, 'MDIForm_'), log('C')));
  click(parentEl().querySelector(':scope > .title-bar .title-bar-controls button[aria-label="Close"]')!);
  await settle();
  expect(out.join(' ')).toBe('MQ0 CQ4 CQ4 CU CU MU');
  expect(session!.state).toBe('ended');
});

test('ActiveForm is the active child; a click on another child makes it active', async () => {
  await start(project(SHOW_BOTH, 'Private Sub Form_Activate()\n    Debug.Print "act " & Me.Name\nEnd Sub\n'));
  expect(await run('? MDIForm1.ActiveForm.Name; " "; Screen.ActiveForm.Name')).toBe('Form3 Form3');
  kids()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  await settle();
  expect(await run('? MDIForm1.ActiveForm.Name')).toBe('Form2');
  expect(out.join('|')).toBe('act Form2|act Form3|act Form2');
});


test('two instances of a child via New, each with its own controls and variables', async () => {
  await start(project('', 'Public Hits As Integer\nPrivate Sub Form_Load()\n    Hits = Hits + 1\nEnd Sub\n', p => {
    const t = newControl(p.forms[1], 'TextBox', { left: 0, top: 0 }, null);
    t.name = 'Text1';
    p.forms[1].controls.push(t);
    p.forms[0].code = 'Public a As Form2, b As Form2\nPrivate Sub MDIForm_Load()\n    Set a = New Form2\n    Set b = New Form2\n'
      + '    a.Caption = "One": a.Text1.Text = "x"\n    b.Caption = "Two"\n    a.Hits = 10\n    a.Show: b.Show\nEnd Sub\n';
  }));
  expect(kids().map(kidTitle)).toEqual(['One', 'Two']);
  expect(await run('? MDIForm1.a.Hits; MDIForm1.b.Hits; "[" & MDIForm1.b.Text1.Text & "]"; MDIForm1.a.Text1.Text')).toBe(' 10  1 [Text1]x');
});

test('the active child\'s menus replace the MDI form\'s; the Window list checks the active child', async () => {
  await start(project(SHOW_BOTH, '', p => {
    const win = menu(p.forms[0], 'mnuWindow', '&Window', null, { WindowList: true });
    menu(p.forms[0], 'mnuCascade', '&Cascade', win);
    const f = menu(p.forms[2], 'mnuChildFile', '&Edit', null);
    menu(p.forms[2], 'mnuChildCut', 'Cu&t', f);
  }));
  const tops = () => [...parentEl().querySelectorAll(':scope > .vb-menubar .vb-menubar-top')].map(t => t.textContent);
  expect(tops()).toEqual(['Edit']);   // Form3 (active) has menus
  kids()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  await settle();
  expect(tops()).toEqual(['Window']);   // Form2 has none: the MDI form's
  parentEl().querySelector<HTMLElement>(':scope > .vb-menubar .vb-menubar-top')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  await settle();
  const items = [...document.querySelectorAll('.vb-menudrop .menu98-item:not(.sep)')];
  expect(items.map(i => i.querySelector('.menu98-label')!.textContent)).toEqual(['Cascade', '1 Form2', '2 Form3']);
  expect(items.map(i => i.querySelector('.menu98-check')!.textContent)).toEqual(['', '✓', '']);
  click(items[2]);
  await settle();
  expect(await run('? MDIForm1.ActiveForm.Name')).toBe('Form3');
});
