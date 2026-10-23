// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { CONTROL_TYPES, newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlDef, ControlType, FormDef, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import type { FromWindow } from '../../src/run/protocol';
import { mountFormWindow } from '../../src/run/formWindow';
import { RunSession } from '../../src/run/session';

let n = 0;
function mk(type: Exclude<ControlType, 'Form'>, props: Record<string, PropValue> = {}, extra: Partial<ControlDef> = {}): ControlDef {
  const base: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES[type].props) if (pd.designTime) base[pd.name] = pd.default;
  n++;
  return { id: `r${n}`, type, name: `${type}${n}`, index: null, parentId: null, props: { ...base, ...props }, ...extra };
}
let sent: FromWindow[];
let root: HTMLElement;
let win: ReturnType<typeof mountFormWindow> | undefined;
let session: RunSession | undefined;
beforeEach(() => { sent = []; root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { win?.dispose(); win = undefined; if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = () => new Promise(r => setTimeout(r, 0));
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

function mount(controls: ControlDef[], handled: Record<string, string[]>) {
  const form: FormDef = { id: 'f', name: 'Form1', props: {}, controls, code: '' };
  win = mountFormWindow(root, { key: 'f', form, assets: {}, handled, mode: 'ide' }, m => sent.push(m));
  return (d: ControlDef) => root.querySelector<HTMLElement>(`[data-control-id="${d.id}"]`)!;
}
const btnOf = (el: HTMLElement) => el.querySelector('button')!;

test('SSCheck Click passes Value (True = -1)', () => {
  const c = mk('SSCheck');
  const get = mount([c], { [c.id]: ['Click'] });
  click(get(c).querySelector('input')!);
  expect(sent.at(-1)).toMatchObject({ event: 'Click', args: [-1], state: { Value: true } });
  click(get(c).querySelector('input')!);
  expect(sent.at(-1)).toMatchObject({ event: 'Click', args: [0], state: { Value: false } });
});

test('SSRibbon groups: a click releases the other ribbon of the same GroupNumber and container', () => {
  const fr = mk('SSPanel');
  const a = mk('SSRibbon', { GroupNumber: 1, Value: true }, { parentId: fr.id });
  const b = mk('SSRibbon', { GroupNumber: 1 }, { parentId: fr.id });
  const other = mk('SSRibbon', { GroupNumber: 2, Value: true }, { parentId: fr.id });
  const solo = mk('SSRibbon', { Value: true });
  const get = mount([fr, a, b, other, solo], { [b.id]: ['Click'], [solo.id]: ['Click'] });
  click(btnOf(get(b)));
  expect(sent).toContainEqual({ t: 'state', id: a.id, props: { Value: false } });
  expect(sent.at(-1)).toMatchObject({ id: b.id, event: 'Click', args: [-1], state: { Value: true } });
  expect(sent.some(m => 'id' in m && m.id === other.id)).toBe(false);
  expect(btnOf(get(a)).classList.contains('down')).toBe(false);
  expect(btnOf(get(b)).classList.contains('down')).toBe(true);
  expect(btnOf(get(other)).classList.contains('down')).toBe(true);
  click(btnOf(get(b)));   // GroupAllowAllUp (default True): the pressed one goes up
  expect(sent.at(-1)).toMatchObject({ id: b.id, args: [0], state: { Value: false } });
  click(btnOf(get(solo)));   // no group: a plain toggle
  expect(sent.at(-1)).toMatchObject({ id: solo.id, args: [0], state: { Value: false } });
});

test('Sheridan controls at run time: Click(Value), option and ribbon groups from code, SSCommand.Value', async () => {
  const p = newProject();
  p.forms = [newForm('Form1', [
    'Private Sub SSCheck1_Click(Value As Integer)', '  Debug.Print "check"; Value', 'End Sub',
    'Private Sub SSOption1_Click(Value As Integer)', '  Debug.Print "o1"; Value', 'End Sub',
    'Private Sub SSOption2_Click(Value As Integer)', '  Debug.Print "o2"; Value', 'End Sub',
    'Private Sub SSRibbon1_Click(Value As Integer)', '  Debug.Print "r1"; Value', 'End Sub',
    'Private Sub SSRibbon2_Click(Value As Integer)', '  Debug.Print "r2"; Value', 'End Sub',
    'Private Sub SSCommand1_Click()', '  Debug.Print "cmd"', 'End Sub',
    'Private Sub Form_Load()',
    '  SSCheck1.Value = True', '  SSOption1.Value = True', '  SSOption2.Value = True',
    '  SSRibbon1.GroupNumber = 1', '  SSRibbon2.GroupNumber = 1', '  SSRibbon1.Value = True', '  SSRibbon2.Value = True',
    '  Debug.Print SSOption1.Value; SSOption2.Value; SSRibbon1.Value; SSRibbon2.Value',
    '  SSCommand1.Value = True',
    'End Sub', '',
  ].join('\n'))];
  const f = p.forms[0];
  for (const t of ['SSCheck', 'SSOption', 'SSOption', 'SSRibbon', 'SSRibbon', 'SSCommand'] as const) f.controls.push(newControl(f, t, { left: 0, top: 0 }, null));
  f.controls.forEach((c, i) => { c.name = ['SSCheck1', 'SSOption1', 'SSOption2', 'SSRibbon1', 'SSRibbon2', 'SSCommand1'][i]; });
  p.components = ['THREED32.OCX'];
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(root), {
    debugPrint: t => { out.push(t.trim()); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  for (let i = 0; i < 30; i++) await tick();
  expect(out).toEqual(['check-1', 'o1-1', 'o2-1', 'r1-1', 'r2-1', 'FalseTrueFalseTrue', 'cmd']);
});
