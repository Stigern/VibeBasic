// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { CONTROL_TYPES } from '../../src/model/controls';
import type { ControlDef, FormDef, PropValue } from '../../src/model/types';
import { runtimeErrorContent } from '../../src/run/errorDialog';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import type { FromWindow } from '../../src/run/protocol';

afterEach(() => { document.body.innerHTML = ''; });

describe('runtimeErrorContent', () => {
  test('ide runtime error content', () => expect(runtimeErrorContent({ number: 13, description: 'Type mismatch', compile: false, mode: 'ide', title: 'P' }))
    .toEqual({ title: 'VibeBasic', text: "Run-time error '13':\n\nType mismatch", buttons: [
      { label: 'Continue', value: 'end', disabled: true }, { label: 'End', value: 'end' }, { label: 'Debug', value: 'debug' }, { label: 'Ask AI', value: 'ai' }, { label: 'Help', value: 'end', disabled: true }] }));
  test('ide compile error breaks on OK', () => {
    const c = runtimeErrorContent({ number: 0, description: 'Expected: )', compile: true, mode: 'ide', title: 'P' });
    expect(c.text).toBe('Compile error:\n\nExpected: )');
    expect(c.buttons[0]).toEqual({ label: 'OK', value: 'debug' });
  });
  test('app runtime error ends', () => expect(runtimeErrorContent({ number: 11, description: 'Division by zero', compile: false, mode: 'app', title: 'Kalk' }))
    .toMatchObject({ title: 'Kalk', buttons: [{ label: 'OK', value: 'end' }] }));
});

function snapshot() {
  const props: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES.CommandButton.props) if (pd.designTime) props[pd.name] = pd.default;
  const b: ControlDef = { id: 'b1', type: 'CommandButton', name: 'Command1', index: null, parentId: null, props, };
  const form: FormDef = { id: 'f', name: 'Form1', props: {}, controls: [b], code: '' };
  return { key: 'f', form, assets: {}, handled: { b1: ['Click'] }, mode: 'ide' as const };
}

async function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const host = new InlineFormHost(container);
  const win = await host.openForm(snapshot(), { modal: false });
  const got: FromWindow[] = [];
  win.onMessage(m => got.push(m));
  const btn = () => container.querySelector<HTMLButtonElement>('[data-control-id="b1"] button')!;
  return { host, win, got, btn };
}
const tick = () => new Promise(r => setTimeout(r, 0));

describe('dialogs during run', () => {
  test('msgbox blocks forms while open', async () => {
    const { host, got, btn } = await setup();
    const p = host.messageBox({ prompt: 'Hi', title: 'T', buttons: 0 });
    btn().dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(got.filter(m => m.t === 'event')).toEqual([]);
    document.querySelector<HTMLButtonElement>('.dlg98 button, button.default')!.click();
    expect(await p).toBe(1);
    await tick();
    btn().dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(got.filter(m => m.t === 'event')).toHaveLength(1);
  });
  test('inputbox returns typed text', async () => {
    const { host } = await setup();
    const p = host.inputBox({ prompt: 'Name?', title: 'T', defaultText: '' });
    const input = document.querySelector<HTMLInputElement>('input.dlg98-input')!;
    expect(document.activeElement).toBe(input);
    input.value = 'Alice';
    document.querySelector<HTMLButtonElement>('button.default')!.click();
    expect(await p).toBe('Alice');
  });
  test('runtime error box: Debug is default, disabled buttons rendered disabled', async () => {
    const { host } = await setup();
    const p = host.runtimeErrorBox({ number: 13, description: 'Type mismatch', compile: false, mode: 'ide', title: 'P' });
    const btns = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(b => ['Continue', 'End', 'Debug', 'Help'].includes(b.textContent ?? ''));
    expect(btns.map(b => [b.textContent, b.disabled])).toEqual([['Continue', true], ['End', false], ['Debug', false], ['Help', true]]);
    expect(document.activeElement?.textContent).toBe('Debug');
    btns[1].click();
    expect(await p).toBe('end');
  });
});
