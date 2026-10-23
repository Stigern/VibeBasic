// @vitest-environment jsdom
// 0.9 B3: MousePointer / MouseIcon / Screen.MousePointer, Validate / CausesValidation / ValidateControls, accelerator keys.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cursorCss } from '../../src/controls/cursor';
import { CONTROL_TYPES, newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlDef, ControlType, FormDef, Project, PropValue } from '../../src/model/types';
import { mountFormWindow } from '../../src/run/formWindow';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import type { FromWindow } from '../../src/run/protocol';
import { RunSession } from '../../src/run/session';

// ---- the form window on its own ----
let n = 0;
function mk(type: Exclude<ControlType, 'Form'>, props: Record<string, PropValue> = {}): ControlDef {
  const base: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES[type].props) if (pd.designTime) base[pd.name] = pd.default;
  n++;
  return { id: `id${n}`, type, name: `${type}${n}`, index: null, parentId: null, props: { ...base, ...props } };
}
let sent: FromWindow[];
let root: HTMLElement;
let win: ReturnType<typeof mountFormWindow>;
beforeEach(() => { sent = []; root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { win?.dispose(); if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
function mount(controls: ControlDef[], handled: Record<string, string[]>, formProps: Record<string, PropValue> = {}) {
  const form: FormDef = { id: 'f', name: 'Form1', props: { ...formProps }, controls, code: '' };
  win = mountFormWindow(root, { key: 'f', form, assets: {}, handled, mode: 'ide' }, m => sent.push(m));
  return (d: ControlDef) => root.querySelector<HTMLElement>(`[data-control-id="${d.id}"]`)!;
}
const inputOf = (el: HTMLElement) => el.querySelector<HTMLElement>('input, textarea, button')!;
const events = () => sent.filter((m): m is Extract<FromWindow, { t: 'event' }> => m.t === 'event');
const altKey = (el: Element, key: string, code: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, code, altKey: true, bubbles: true, cancelable: true }));

describe('cursor', () => {
  test('MousePointer 11 puts the hourglass on the form; a control and its field follow its own; MouseIcon with 99', () => {
    const b = mk('CommandButton', { MousePointer: 2 });
    const t = mk('TextBox', { MousePointer: 99, MouseIcon: { asset: 'data:image/png;base64,AAAA' } });
    const get = mount([b, t], {}, { MousePointer: 11 });
    const client = root.querySelector<HTMLElement>('.vb-form-client')!;
    expect(client.style.cursor).toBe(cursorCss(11));
    expect(client.style.cursor).toContain('image/svg+xml');
    expect(get(b).style.cursor).toBe('crosshair');
    expect(get(b).hasAttribute('data-vb-cursor')).toBe(true);
    expect(get(t).style.cursor).toBe('url("data:image/png;base64,AAAA") 0 0, default');
    win.receive({ t: 'patch', id: 'form', props: { MousePointer: 0 } });
    win.receive({ t: 'patch', id: b.id, props: { MousePointer: 0 } });
    expect(client.style.cursor).toBe('');
    expect(get(b).hasAttribute('data-vb-cursor')).toBe(false);
  });

  test('the registry has MousePointer (0 .. 15, 99) and MouseIcon on visible controls and the Form, not on Shape, Line or Timer', () => {
    for (const t of ['Form', 'CommandButton', 'Label', 'Frame', 'Image', 'TreeView'] as ControlType[]) {
      expect(CONTROL_TYPES[t].props.some(p => p.name === 'MousePointer' && p.kind === 'enum' && p.enumValues!.length === 17)).toBe(true);
      expect(CONTROL_TYPES[t].props.some(p => p.name === 'MouseIcon' && p.kind === 'picture')).toBe(true);
    }
    for (const t of ['Shape', 'Line', 'Timer'] as ControlType[]) expect(CONTROL_TYPES[t].props.some(p => p.name === 'MousePointer')).toBe(false);
  });
});

describe('Validate', () => {
  /** A text box with Validate code and a button, the focus in the text box. */
  function setup(buttonProps: Record<string, PropValue> = {}) {
    const t = mk('TextBox');
    const b = mk('CommandButton', buttonProps);
    const get = mount([t, b], { [t.id]: ['Validate', 'LostFocus'], [b.id]: ['GotFocus', 'Click'] });
    inputOf(get(t)).focus();
    sent.length = 0;
    return { t, b, ti: inputOf(get(t)), bi: inputOf(get(b)) };
  }

  test('LostFocus and GotFocus wait for Validate; Cancel = True puts the focus back and eats the click', () => {
    const { t, b, ti, bi } = setup();
    bi.focus();
    bi.click();
    expect(events().map(e => e.event)).toEqual(['Validate']);   // nothing else yet
    const req = events()[0];
    expect(req).toMatchObject({ id: t.id, args: [0] });
    win.receive({ t: 'validated', requestId: req.requestId!, cancel: true });
    expect(document.activeElement).toBe(ti);
    expect(events().map(e => e.event)).toEqual(['Validate']);   // no LostFocus, GotFocus or Click
    expect(sent.some(m => m.t === 'focused' && m.id === b.id)).toBe(false);
  });

  test('without Cancel the held events follow in the VB6 order: LostFocus, GotFocus, Click', () => {
    const { b, bi } = setup();
    bi.focus();
    bi.click();
    win.receive({ t: 'validated', requestId: events()[0].requestId!, cancel: false });
    expect(events().map(e => `${e.id === b.id ? 'b' : 't'}.${e.event}`)).toEqual(['t.Validate', 't.LostFocus', 'b.GotFocus', 'b.Click']);
    expect(document.activeElement).toBe(bi);
  });

  test('CausesValidation = False on the target skips Validate', () => {
    const { t, b, bi } = setup({ CausesValidation: false });
    bi.focus();
    expect(events().map(e => `${e.id === b.id ? 'b' : 't'}.${e.event}`)).toEqual(['t.LostFocus', 'b.GotFocus']);
    expect(t.id).toBeTruthy();
  });
});

describe('accelerator keys', () => {
  test('Alt+O clicks the &OK button (also as Option+O on a Mac) and keeps the special character out of the text box', () => {
    const t = mk('TextBox');
    const ok = mk('CommandButton', { Caption: '&OK' });
    const get = mount([t, ok], { [ok.id]: ['Click'] });
    const ti = inputOf(get(t));
    ti.focus();
    expect(altKey(ti, 'ø', 'KeyO')).toBe(false);   // default prevented
    expect(events()).toEqual([{ t: 'event', id: ok.id, event: 'Click', args: [] }]);
    sent.length = 0;
    expect(altKey(ti, 'x', 'KeyX')).toBe(true);    // no accelerator: the key is left alone
    expect(events()).toEqual([]);
  });

  test('the accelerator of a Label moves the focus to the next control in tab order', () => {
    const l = mk('Label', { Caption: '&Name:', TabIndex: 0 });
    const a = mk('CommandButton', { TabIndex: 1 });
    const t = mk('TextBox', { TabIndex: 2 });
    const get = mount([l, a, t], {});
    altKey(root.querySelector('.vb-form')!, 'n', 'KeyN');
    expect(document.activeElement).toBe(inputOf(get(a)));
  });

  test('a disabled button has no accelerator', () => {
    const ok = mk('CommandButton', { Caption: '&OK', Enabled: false });
    mount([ok], { [ok.id]: ['Click'] });
    expect(altKey(root.querySelector('.vb-form')!, 'o', 'KeyO')).toBe(true);
    expect(events()).toEqual([]);
  });
});

// ---- the run session ----
let session: RunSession | undefined;
function project(forms: [string, string, [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][]][]): Project {
  const p = newProject();
  p.forms = forms.map(([name, code, controls]) => {
    const fd = newForm(name, code);
    for (const [type, cname, props] of controls) {
      const c = newControl(fd, type, { left: 120, top: 120 }, null);
      c.name = cname;
      Object.assign(c.props, props ?? {});
      fd.controls.push(c);
    }
    return fd;
  });
  p.startupForm = forms[0][0];
  return p;
}
const sub = (name: string, body: string, params = '') => `Private Sub ${name}(${params})\n${body}\nEnd Sub\n`;
async function run(p: Project): Promise<string[]> {
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(root), {
    debugPrint: t => { out.push(t.trim()); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  return out;
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0)); };
const windows = () => [...root.querySelectorAll<HTMLElement>('.vb-form')];

describe('run session', () => {
  test('Screen.MousePointer applies to every form window, also one opened later, and is gone at End', async () => {
    await run(project([
      ['Form1', sub('Form_Load', 'Form2.Show\nScreen.MousePointer = vbHourglass\nDebug.Print Screen.MousePointer\nForm3.Show'), []],
      ['Form2', '', []], ['Form3', '', []],
    ]));
    expect(windows()).toHaveLength(3);
    for (const w of windows()) expect(w.hasAttribute('data-vb-screen')).toBe(true);
    const css = [...document.head.querySelectorAll('style')].map(s => s.textContent).filter(t => t?.includes('data-vb-screen'));
    expect(css).toHaveLength(3);
    expect(css[0]).toContain('!important');
    expect(css[0]).toContain(cursorCss(11));
    session!.end();
    await settle();
    expect(document.head.querySelectorAll('style')).toHaveLength(0);
    expect(root.querySelectorAll('[data-vb-screen]')).toHaveLength(0);
  });

  test('MousePointer and MouseIcon by code reach the window; a value outside the list is error 380', async () => {
    const out = await run(project([['Form1', sub('Form_Load', `MousePointer = vbCrosshair
Command1.MousePointer = vbUpArrow
On Error Resume Next
Command1.MousePointer = 16
Debug.Print Err.Number
Err.Clear
Screen.MousePointer = 7
Debug.Print Err.Number; Screen.MousePointer
Screen.MousePointer = 16
Debug.Print Err.Number; Screen.MousePointer`), [['CommandButton', 'Command1']]]]));
    expect(out).toEqual(['380', '0  7', '380  7']);
    expect(root.querySelector<HTMLElement>('.vb-form-client')!.style.cursor).toBe('crosshair');
    expect(root.querySelector<HTMLElement>('.vb-CommandButton')!.style.cursor).toBe(cursorCss(10));
  });

  test('Validate Cancel keeps the focus in the text box, the button does not click; ValidateControls raises 380 on Cancel', async () => {
    const out = await run(project([['Form1', sub('Text1_Validate', 'Debug.Print "validate " & Text1.Text\nCancel = (Text1.Text = "bad")', 'Cancel As Boolean')
      + sub('Command1_Click', 'Debug.Print "click"')
      + sub('Form_Click', 'On Error Resume Next\nValidateControls\nDebug.Print "VC " & Err.Number'),
      [['TextBox', 'Text1', { TabIndex: 0 }], ['CommandButton', 'Command1', { TabIndex: 1 }]]]]));
    const t = root.querySelector<HTMLInputElement>('.vb-TextBox input, .vb-TextBox textarea')!;
    const b = root.querySelector<HTMLButtonElement>('.vb-CommandButton button')!;
    expect(document.activeElement).toBe(t);   // the first control has the focus
    t.value = 'bad';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    b.focus(); b.click();
    await settle();
    expect(out).toEqual(['validate bad']);
    expect(document.activeElement).toBe(t);
    root.querySelector<HTMLElement>('.vb-form-client')!.click();
    await settle();
    expect(out.slice(1)).toEqual(['validate bad', 'VC 380']);
    t.value = 'good';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    b.focus(); b.click();
    await settle();
    expect(out.slice(3)).toEqual(['validate good', 'click']);
    expect(document.activeElement).toBe(b);
  });
});
