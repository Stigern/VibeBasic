// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CONTROL_TYPES } from '../../src/model/controls';
import type { ControlDef, ControlType, FormDef, PropValue } from '../../src/model/types';
import type { FromWindow } from '../../src/run/protocol';
import { mountFormWindow } from '../../src/run/formWindow';

let n = 0;
function mk(type: Exclude<ControlType, 'Form'>, props: Record<string, PropValue> = {}, extra: Partial<ControlDef> = {}): ControlDef {
  const base: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES[type].props) if (pd.designTime) base[pd.name] = pd.default;
  n++;
  return { id: `id${n}`, type, name: `${type}${n}`, index: null, parentId: null, props: { ...base, ...props }, ...extra };
}

let sent: FromWindow[];
let root: HTMLElement;
let win: ReturnType<typeof mountFormWindow>;
beforeEach(() => { sent = []; root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { win?.dispose(); document.body.innerHTML = ''; });

function mount(controls: ControlDef[], handled: Record<string, string[]>, formProps: Record<string, PropValue> = {}) {
  const form: FormDef = { id: 'f', name: 'Form1', props: { ...formProps }, controls, code: '' };
  win = mountFormWindow(root, { key: 'f', form, assets: {}, handled, mode: 'ide' }, m => sent.push(m));
  return (d: ControlDef) => root.querySelector<HTMLElement>(`[data-control-id="${d.id}"]`)!;
}
const inputOf = <T extends HTMLElement = HTMLInputElement>(el: HTMLElement) => el.querySelector<HTMLElement>('input, textarea, select, button, [role=scrollbar], [role=slider], [role=spinbutton]') as T;
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
const key = (el: Element, type: 'keydown' | 'keyup', k: string, code = 0, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent(type, { key: k, keyCode: code, bubbles: true, cancelable: true, ...init }));
const typeKey = (el: Element, ch: string) => key(el, 'keydown', ch, ch.toUpperCase().charCodeAt(0));

describe('mountFormWindow', () => {
  test('button click sends Click', () => {
    const b = mk('CommandButton');
    const get = mount([b], { [b.id]: ['Click'] });
    click(inputOf(get(b)));
    expect(sent).toContainEqual({ t: 'event', id: b.id, event: 'Click', args: [] });
  });

  test('no handler → no event, but state', () => {
    const t1 = mk('TextBox');
    const b = mk('CommandButton');
    const get = mount([t1, b], { [b.id]: ['Click'] });
    const el = inputOf(get(t1)) as HTMLInputElement;
    el.value = 'a';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent).toEqual([{ t: 'state', id: t1.id, props: { Text: 'a' } }]);
  });

  test('handled Change carries state.Text', () => {
    const t1 = mk('TextBox');
    const get = mount([t1], { [t1.id]: ['Change'] });
    const el = inputOf(get(t1)) as HTMLInputElement;
    el.value = 'ab';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent).toEqual([{ t: 'event', id: t1.id, event: 'Change', args: [], state: { Text: 'ab' } }]);
  });

  test('checkbox toggles and reports state', () => {
    const c = mk('CheckBox');
    const get = mount([c], { [c.id]: ['Click'] });
    click(inputOf(get(c)));
    expect(sent.at(-1)).toMatchObject({ event: 'Click', state: { Value: 1 } });
    click(inputOf(get(c)));
    expect(sent.at(-1)).toMatchObject({ event: 'Click', state: { Value: 0 } });
    expect((inputOf(get(c)) as HTMLInputElement).checked).toBe(false);
  });

  test('option buttons exclusive per container', () => {
    const fr = mk('Frame');
    const a = mk('OptionButton', { Value: true }, { parentId: fr.id });
    const b = mk('OptionButton', {}, { parentId: fr.id });
    const c = mk('OptionButton', { Value: true });
    const get = mount([fr, a, b, c], { [b.id]: ['Click'] });
    click(inputOf(get(b)));
    expect(sent).toContainEqual({ t: 'state', id: a.id, props: { Value: false } });
    expect(sent.at(-1)).toMatchObject({ id: b.id, event: 'Click', state: { Value: true } });
    expect(sent.some(m => 'id' in m && m.id === c.id)).toBe(false);
    expect((inputOf(get(a)) as HTMLInputElement).checked).toBe(false);
    expect((inputOf(get(c)) as HTMLInputElement).checked).toBe(true);
  });

  test('keypress roundtrip cancel', () => {
    const t1 = mk('TextBox');
    const get = mount([t1], { [t1.id]: ['KeyPress'] });
    const el = inputOf(get(t1)) as HTMLInputElement;
    expect(typeKey(el, 'x')).toBe(false);   // default prevented
    const req = sent.at(-1) as Extract<FromWindow, { t: 'event' }>;
    expect(req).toMatchObject({ event: 'KeyPress', args: [120] });
    win.receive({ t: 'keyResult', requestId: req.requestId!, keyAscii: 0 });
    expect(el.value).toBe('');
  });

  test('keypress roundtrip uppercase', () => {
    const t1 = mk('TextBox');
    const get = mount([t1], { [t1.id]: ['KeyPress', 'Change'] });
    const el = inputOf(get(t1)) as HTMLInputElement;
    typeKey(el, 'x');
    const req = sent.at(-1) as Extract<FromWindow, { t: 'event' }>;
    win.receive({ t: 'keyResult', requestId: req.requestId!, keyAscii: 88 });
    expect(el.value).toBe('X');
    expect(sent.at(-1)).toMatchObject({ event: 'Change', state: { Text: 'X' } });
  });

  test('without KeyPress handler typing is left alone', () => {
    const t1 = mk('TextBox');
    const get = mount([t1], {});
    expect(typeKey(inputOf(get(t1)), 'x')).toBe(true);
  });

  test('KeyPreview sends form events first', () => {
    const t1 = mk('TextBox');
    const get = mount([t1], { form: ['KeyDown'], [t1.id]: ['KeyDown'] }, { KeyPreview: true });
    key(inputOf(get(t1)), 'keydown', 'a', 65, { shiftKey: true });
    expect(sent).toEqual([
      { t: 'event', id: 'form', event: 'KeyDown', args: [65, 1] },
      { t: 'event', id: t1.id, event: 'KeyDown', args: [65, 1] },
    ]);
  });

  test('enter clicks default button, escape cancel button', () => {
    const t1 = mk('TextBox');
    const ok = mk('CommandButton', { Default: true });
    const no = mk('CommandButton', { Cancel: true });
    const get = mount([t1, ok, no], { [ok.id]: ['Click'], [no.id]: ['Click'] });
    key(inputOf(get(t1)), 'keydown', 'Enter', 13);
    expect(sent).toEqual([{ t: 'event', id: ok.id, event: 'Click', args: [] }]);
    sent.length = 0;
    key(inputOf(get(t1)), 'keydown', 'Escape', 27);
    expect(sent).toEqual([{ t: 'event', id: no.id, event: 'Click', args: [] }]);
  });

  test('mouse coords in twips', () => {
    const b = mk('CommandButton');
    const get = mount([b], { [b.id]: ['MouseDown'] });
    inputOf(get(b)).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
    expect(sent).toEqual([{ t: 'event', id: b.id, event: 'MouseDown', args: [1, 0, 150, 300] }]);
  });

  test('right button and ctrl map to VB bits', () => {
    const l = mk('Label');
    const get = mount([l], { [l.id]: ['MouseUp'] });
    get(l).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2, ctrlKey: true }));
    expect(sent).toEqual([{ t: 'event', id: l.id, event: 'MouseUp', args: [2, 2, 0, 0] }]);
  });

  test('list box and combo report selection', () => {
    const lb = mk('ListBox', { List: ['a', 'b'] });
    const cb = mk('ComboBox', { List: ['x', 'y'] });
    const get = mount([lb, cb], { [lb.id]: ['Click', 'DblClick'], [cb.id]: ['Click'] });
    const sel = inputOf<HTMLSelectElement>(get(lb));
    sel.selectedIndex = 1;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ id: lb.id, event: 'Click', state: { ListIndex: 1 } });
    sel.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ id: lb.id, event: 'DblClick' });
    get(cb).querySelector('.vb-item[data-i="1"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(sent.at(-1)).toMatchObject({ id: cb.id, event: 'Click', state: { ListIndex: 1, Text: 'y' } });
  });

  test('scroll bar sends Scroll while dragging and Change with value', () => {
    const sb = mk('HScrollBar', { Max: 100 });
    const get = mount([sb], { [sb.id]: ['Scroll', 'Change'] });
    const el = inputOf(get(sb));
    el.dataset.value = '40';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ event: 'Scroll', state: { Value: 40 } });
    el.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ event: 'Change', state: { Value: 40 } });
  });

  test('slider: keys step by SmallChange / LargeChange and send Scroll then Change; Value stays in range', () => {
    const sl = mk('Slider', { Max: 10, LargeChange: 5 });
    const get = mount([sl], { [sl.id]: ['Scroll', 'Change'] });
    const el = inputOf(get(sl));
    key(el, 'keydown', 'ArrowRight', 39);
    expect(sent.filter(m => m.t === 'event' && (m.event === 'Scroll' || m.event === 'Change')).map(m => (m as any).event)).toEqual(['Scroll', 'Change']);
    expect(sent.at(-1)).toMatchObject({ event: 'Change', state: { Value: 1 } });
    key(el, 'keydown', 'End', 35);
    expect(sent.at(-1)).toMatchObject({ event: 'Change', state: { Value: 10 } });
    key(el, 'keydown', 'ArrowRight', 39);
    expect(el.dataset.value).toBe('10');
  });

  test('up-down: UpClick/DownClick then Change; Increment and Wrap', () => {
    const ud = mk('UpDown', { Max: 10, Value: 9, Increment: 2, Wrap: true });
    const get = mount([ud], { [ud.id]: ['UpClick', 'DownClick', 'Change'] });
    const el = inputOf(get(ud));
    const evs = () => sent.filter(m => m.t === 'event').map(m => (m as any).event);
    key(el, 'keydown', 'ArrowUp', 38);
    expect(evs()).toEqual(['UpClick', 'Change']);
    expect(sent.at(-1)).toMatchObject({ event: 'Change', state: { Value: 0 } });   // 9 + 2 > Max wraps to Min
    sent.length = 0;
    key(el, 'keydown', 'ArrowDown', 40);
    expect(evs()).toEqual(['DownClick', 'Change']);
    expect(sent.at(-1)).toMatchObject({ state: { Value: 10 } });                   // 0 - 2 < Min wraps to Max
  });

  test('up-down without Wrap stops at Max (UpClick only, no Change)', () => {
    const ud = mk('UpDown', { Max: 3, Value: 3 });
    const get = mount([ud], { [ud.id]: ['UpClick', 'Change'] });
    key(inputOf(get(ud)), 'keydown', 'ArrowUp', 38);
    expect(sent.filter(m => m.t === 'event').map(m => (m as any).event)).toEqual(['UpClick']);
  });

  test('focus and blur', () => {
    const t1 = mk('TextBox');
    const get = mount([t1], { [t1.id]: ['GotFocus', 'LostFocus'] });
    const el = inputOf(get(t1));
    el.focus(); el.blur();
    expect(sent.map(m => (m as { event: string }).event)).toEqual(['GotFocus', 'LostFocus']);
  });

  test('form click, close button and resize', () => {
    const get = mount([], { form: ['Click'] });
    click(root.querySelector('.vb-form-client')!);
    expect(sent).toEqual([{ t: 'event', id: 'form', event: 'Click', args: [] }]);
    click(root.querySelector('.title-bar button[aria-label=Close]')!);
    expect(sent.at(-1)).toEqual({ t: 'closeRequest' });
    void get;
  });

  test('resize observer reports twips in window mode', () => {
    let cb: ResizeObserverCallback = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(c: ResizeObserverCallback) { cb = c; } observe() {} disconnect() {} });
    root.dataset.vbWindow = '1';
    mount([], {}, { BorderStyle: 2 });
    cb([{ contentRect: { width: 300, height: 200 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(sent.at(-1)).toEqual({ t: 'resized', width: 4500, height: 3000 });
    vi.unstubAllGlobals();
  });

  test('patch updates DOM', () => {
    const l = mk('Label', { Caption: 'x' });
    const get = mount([l], {});
    win.receive({ t: 'patch', id: l.id, props: { Caption: 'Hei' } });
    expect(get(l).textContent).toBe('Hei');
  });

  test('patches message updates several controls', () => {
    const l = mk('Label', { Caption: 'x' });
    const m = mk('Label', { Caption: 'y' });
    const get = mount([l, m], {});
    win.receive({ t: 'patches', items: [{ id: l.id, props: { Caption: 'A' } }, { id: m.id, props: { Caption: 'B' } }] });
    expect([get(l).textContent, get(m).textContent]).toEqual(['A', 'B']);
  });

  test('a disabled control gets no mouse or DblClick events', () => {
    const l = mk('Label', { Enabled: false });
    const get = mount([l], { [l.id]: ['MouseDown', 'MouseUp', 'MouseMove', 'DblClick'] });
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'dblclick']) get(l).dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
    expect(sent.filter(m => m.t === 'event')).toEqual([]);
  });

  test('patch keeps user text on rebuild and tab order follows TabIndex', () => {
    const a = mk('TextBox', { TabIndex: 1 });
    const b = mk('TextBox', { TabIndex: 0 });
    const get = mount([a, b], {});
    expect(inputOf(get(b)).tabIndex).toBeLessThan(inputOf(get(a)).tabIndex);
    const el = inputOf(get(a)) as HTMLInputElement;
    el.value = 'hello';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    win.receive({ t: 'patch', id: a.id, props: { MultiLine: true } });
    expect((inputOf<HTMLTextAreaElement>(get(a))).value).toBe('hello');
    expect(inputOf(get(b)).tabIndex).toBeLessThan(inputOf(get(a)).tabIndex);
  });

  test('focus message focuses the control', () => {
    const t1 = mk('TextBox');
    const get = mount([t1], {});
    win.receive({ t: 'focus', id: t1.id });
    expect(document.activeElement).toBe(inputOf(get(t1)));
  });

  test('blocked overlay swallows clicks and keys', () => {
    const b = mk('CommandButton');
    const t1 = mk('TextBox');
    const get = mount([b, t1], { [b.id]: ['Click'], [t1.id]: ['KeyDown'] });
    win.receive({ t: 'blocked', blocked: true });
    expect(root.querySelector('.vb-blocked')).not.toBeNull();
    click(inputOf(get(b)));
    typeKey(inputOf(get(t1)), 'a');
    expect(sent).toEqual([]);
    win.receive({ t: 'blocked', blocked: false });
    expect(root.querySelector('.vb-blocked')).toBeNull();
    click(inputOf(get(b)));
    expect(sent).toHaveLength(1);
  });

  test('initial focus: Enter on the active element clicks the default button', async () => {
    const t1 = mk('TextBox');
    const ok = mk('CommandButton', { Default: true });
    mount([t1, ok], { [ok.id]: ['Click'] });
    await Promise.resolve();
    expect(document.activeElement).toBe(root.querySelector('input'));
    sent.length = 0;
    key(document.activeElement!, 'keydown', 'Enter', 13);
    expect(sent).toEqual([{ t: 'event', id: ok.id, event: 'Click', args: [] }]);
  });

  test('label-only form with KeyPreview receives keys; buttons keep Space', async () => {
    const l = mk('Label');
    mount([l], { form: ['KeyPress'] }, { KeyPreview: true });
    await Promise.resolve();
    expect(document.activeElement).toBe(root.firstElementChild);
    sent.length = 0;
    expect(typeKey(document.activeElement!, 'q')).toBe(true);   // not a text field: not swallowed
    expect(sent).toMatchObject([{ id: 'form', event: 'KeyPress', args: [113] }]);
  });

  test('ready is sent after mount', async () => {
    mount([], {});
    await Promise.resolve();
    expect(sent).toEqual([{ t: 'ready' }]);
  });
});
