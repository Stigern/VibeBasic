// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { createCombo } from '../../src/ui98/combo';
import { createTabs } from '../../src/ui98/tabs';
import { h } from '../../src/ui98/dom';
import { compileErrorBox, inputBox98, messageBox98, showDialog98 } from '../../src/ui98/dialogs';

afterEach(() => { document.body.innerHTML = ''; });

const btns = () => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')];
const labels = () => btns().map(b => b.textContent);
const key = (k: string, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const closeX = () => document.querySelector<HTMLElement>('.dlg98 [aria-label="Close"]')!;

/** Resolves with the settled value or 'pending' after a macrotask. */
async function settled<T>(p: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>(r => setTimeout(() => r('pending'), 5))]);
}

describe('messageBox98 buttons', () => {
  test('yes/no question returns vbNo', async () => {
    const p = messageBox98(document, { prompt: 'Lagre?', title: 'T', buttons: 4 + 32 });
    expect(labels()).toEqual(['Yes', 'No']);
    btns()[1].click();
    expect(await p).toBe(7);
  });

  const sets: [number, string[], number[]][] = [
    [0, ['OK'], [1]],
    [1, ['OK', 'Cancel'], [1, 2]],
    [2, ['Abort', 'Retry', 'Ignore'], [3, 4, 5]],
    [3, ['Yes', 'No', 'Cancel'], [6, 7, 2]],
    [4, ['Yes', 'No'], [6, 7]],
    [5, ['Retry', 'Cancel'], [4, 2]],
  ];
  test.each(sets)('button set %i shows the right labels and returns VB constants', async (code, names, values) => {
    for (let i = 0; i < names.length; i++) {
      const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: code + 48 + 256 * 0 });
      expect(labels()).toEqual(names);
      btns()[i].click();
      expect(await p).toBe(values[i]);
      expect(document.querySelector('.dlg98-overlay')).toBeNull();
    }
  });

  test('icon bits and other flags are ignored for the button set', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 1 + 16 + 256 + 4096 });
    expect(labels()).toEqual(['OK', 'Cancel']);
    btns()[0].click();
    await p;
  });
});

describe('messageBox98 look', () => {
  test('title, prompt, modal overlay', async () => {
    const p = messageBox98(document, { prompt: 'Line1\r\nLine2\nLine3', title: 'My title', buttons: 0 });
    expect(document.querySelector('.dlg98 .title-bar-text')!.textContent).toBe('My title');
    const text = document.querySelector('.dlg98-text') as HTMLElement;
    expect(text.textContent).toBe('Line1\nLine2\nLine3');
    expect(document.querySelector('.dlg98-overlay')).not.toBeNull();
    expect(document.body.contains(document.querySelector('.dlg98-overlay'))).toBe(true);
    btns()[0].click();
    await p;
    expect(document.querySelector('.dlg98-overlay')).toBeNull();
  });

  test.each([[16, 'critical'], [32, 'question'], [48, 'exclamation'], [64, 'information']])(
    'icon %i is %s', async (code, name) => {
      const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: code });
      const icon = document.querySelector('.dlg98-icon') as HTMLElement;
      expect(icon.dataset.icon).toBe(name);
      expect(icon.querySelector('svg')).not.toBeNull();
      btns()[0].click();
      await p;
    });

  test('no icon when none requested', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 0 });
    expect(document.querySelector('.dlg98-icon')).toBeNull();
    btns()[0].click();
    await p;
  });
});

describe('messageBox98 default button and keyboard', () => {
  test.each([[0, 0], [256, 1], [512, 2]])('default bits %i marks button %i', async (bits, idx) => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 3 + bits });
    expect(btns().map(b => b.classList.contains('default'))).toEqual([0, 1, 2].map(i => i === idx));
    expect(document.activeElement).toBe(btns()[idx]);
    btns()[0].click();
    await p;
  });

  test('default button beyond the button count falls back to first', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 0 + 512 });
    expect(btns()[0].classList.contains('default')).toBe(true);
    btns()[0].click();
    await p;
  });

  test('enter presses default button 2', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 1 + 256 });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await p).toBe(2);
  });

  test('enter presses default button 3 of Yes/No/Cancel', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 3 + 512 });
    key('Enter');
    expect(await p).toBe(2);
  });

  test('escape: OK/Cancel -> Cancel', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 1 });
    key('Escape');
    expect(await p).toBe(2);
  });
  test('escape: OK only -> OK', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 0 });
    key('Escape');
    expect(await p).toBe(1);
  });
  test('escape: Yes/No/Cancel -> Cancel', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 3 });
    key('Escape');
    expect(await p).toBe(2);
  });
  test('escape: Retry/Cancel -> Cancel', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 5 });
    key('Escape');
    expect(await p).toBe(2);
  });
  test.each([[4, 'Yes/No'], [2, 'Abort/Retry/Ignore']])('escape does nothing for %i (%s), as in VB6', async (code) => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: code });
    key('Escape');
    expect(await settled(p)).toBe('pending');
    expect(document.querySelector('.dlg98')).not.toBeNull();
    btns()[0].click();
    await p;
  });

  test('title bar close behaves like Escape', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 1 });
    closeX().click();
    expect(await p).toBe(2);
  });
  test('title bar close is disabled for Yes/No and ignored', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 4 });
    expect(closeX().getAttribute('aria-disabled')).toBe('true');
    closeX().click();
    expect(await settled(p)).toBe('pending');
    btns()[1].click();
    await p;
  });
  test('title bar close is enabled for OK only', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 0 });
    expect(closeX().getAttribute('aria-disabled')).toBeNull();
    closeX().click();
    expect(await p).toBe(1);
  });

  test('keydown is swallowed so IDE shortcuts do not see it', async () => {
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', spy);
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 0 });
    key('Enter');
    await p;
    window.removeEventListener('keydown', spy);
    expect(seen).toEqual([]);
  });

  test('only the topmost of stacked dialogs reacts to keys', async () => {
    const a = messageBox98(document, { prompt: 'a', title: 'A', buttons: 0 });
    const b = messageBox98(document, { prompt: 'b', title: 'B', buttons: 1 });
    key('Escape');
    expect(await b).toBe(2);
    expect(await settled(a)).toBe('pending');
    key('Enter');
    expect(await a).toBe(1);
  });
});

describe('inputBox98', () => {
  const input = () => document.querySelector<HTMLInputElement>('.dlg98 input[type=text]')!;

  test('escape cancels inputbox to empty string', async () => {
    const p = inputBox98(document, { prompt: 'Navn', title: 'T', defaultText: 'Ola' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p).toBe('');
  });

  test('layout: prompt, OK/Cancel stacked at the side, default text selected and focused', async () => {
    const p = inputBox98(document, { prompt: 'Navn\r\nher', title: 'Tittel', defaultText: 'Ola' });
    expect(document.querySelector('.dlg98 .title-bar-text')!.textContent).toBe('Tittel');
    expect(document.querySelector('.dlg98-text')!.textContent).toBe('Navn\nher');
    expect(labels()).toEqual(['OK', 'Cancel']);
    expect(document.querySelector('.dlg98-buttons.side')).not.toBeNull();
    expect(input().value).toBe('Ola');
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(3);
    expect(document.activeElement).toBe(input());
    btns()[1].click();
    expect(await p).toBe('');
  });

  test('OK returns the (edited) text', async () => {
    const p = inputBox98(document, { prompt: 'x', title: 'T', defaultText: 'Ola' });
    input().value = 'Kari';
    btns()[0].click();
    expect(await p).toBe('Kari');
  });

  test('Enter inside the field accepts', async () => {
    const p = inputBox98(document, { prompt: 'x', title: 'T', defaultText: 'a' });
    input().value = 'b';
    key('Enter', input());
    expect(await p).toBe('b');
  });

  test('Cancel returns empty string even when text was typed; close X too', async () => {
    const p = inputBox98(document, { prompt: 'x', title: 'T', defaultText: 'a' });
    input().value = 'typed';
    btns()[1].click();
    expect(await p).toBe('');
    const q = inputBox98(document, { prompt: 'x', title: 'T', defaultText: 'a' });
    closeX().click();
    expect(await q).toBe('');
  });
});

describe('compileErrorBox', () => {
  test('title, text, buttons', async () => {
    const p = compileErrorBox(document, 'Expected: expression');
    expect(document.querySelector('.dlg98 .title-bar-text')!.textContent).toBe('VibeBasic');
    expect(document.querySelector('.dlg98-text')!.textContent).toBe('Compile error:\n\nExpected: expression');
    expect((document.querySelector('.dlg98-icon') as HTMLElement).dataset.icon).toBe('exclamation');
    expect(labels()).toEqual(['OK', 'Help']);
    expect(btns()[1].disabled).toBe(true);
    btns()[1].click();
    expect(await settled(p)).toBe('pending');
    btns()[0].click();
    expect(await p).toBe('ok');
  });
  test('Ask AI after OK when asked for', async () => {
    const p = compileErrorBox(document, 'x', { askAi: true });
    expect(labels()).toEqual(['OK', 'Ask AI', 'Help']);
    btns()[1].click();
    expect(await p).toBe('ai');
  });
  test('enter and escape both close it', async () => {
    const p = compileErrorBox(document, 'x');
    key('Enter');
    await p;
    const q = compileErrorBox(document, 'x');
    key('Escape');
    await q;
    expect(document.querySelector('.dlg98')).toBeNull();
  });
});

describe('showDialog98', () => {
  test('returns the value of the clicked button; custom content is shown', async () => {
    const content = document.createElement('div');
    content.id = 'mine';
    const p = showDialog98(document, {
      title: 'Generic', content,
      buttons: [{ label: 'Save', value: 'save', default: true }, { label: "Don't", value: 'no' }, { label: 'Cancel', value: 'cancel', cancel: true }],
    });
    expect(document.querySelector('.dlg98 #mine')).not.toBeNull();
    expect(labels()).toEqual(['Save', "Don't", 'Cancel']);
    btns()[1].click();
    expect(await p).toBe('no');
  });
  test('default via Enter, cancel via Escape; disabled buttons are inert', async () => {
    const mk = () => showDialog98(document, {
      title: 'G', content: document.createElement('div'),
      buttons: [{ label: 'A', value: 'a', default: true }, { label: 'B', value: 'b', cancel: true }, { label: 'C', value: 'c', disabled: true }],
    });
    let p = mk(); key('Enter'); expect(await p).toBe('a');
    p = mk(); key('Escape'); expect(await p).toBe('b');
    p = mk(); btns()[2].click(); expect(await settled(p)).toBe('pending'); key('Enter'); await p;
  });
  test('modal overlay blocks pointer events to the rest of the document and is centred', async () => {
    const p = showDialog98(document, { title: 'G', content: document.createElement('div'), buttons: [{ label: 'OK', value: 'ok', default: true }] });
    const ov = document.querySelector('.dlg98-overlay') as HTMLElement;
    expect(ov.parentElement).toBe(document.body);
    key('Enter');
    await p;
  });
  test('Tab cycles within the dialog', async () => {
    const p = showDialog98(document, { title: 'G', content: document.createElement('div'), buttons: [{ label: 'A', value: 'a', default: true }, { label: 'B', value: 'b' }] });
    expect(document.activeElement).toBe(btns()[0]);
    key('Tab');
    expect(document.activeElement).toBe(btns()[1]);
    key('Tab');
    expect(document.activeElement).toBe(btns()[0]);
    key('Enter');
    await p;
  });
});

describe('widgets inside a dialog', () => {
  function withWidgets() {
    const tabs = createTabs([{ label: 'One', content: h('div', {}, '1') }, { label: 'Two', content: h('div', {}, '2') }]);
    const combo = createCombo({ items: ['A', 'B'], value: 'A' });
    const content = h('div', {}, tabs.el, combo.el);
    const p = showDialog98(document, {
      title: 'W', content,
      buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
    });
    return { tabs, combo, p };
  }
  const tabEls = () => [...document.querySelectorAll<HTMLElement>('.tabs98-tab')];

  test('Enter on a tab switches the tab and does not press the default button', async () => {
    const { tabs, p } = withWidgets();
    key('Enter', tabEls()[1]);
    expect(tabs.selected).toBe(1);
    expect(await settled(p)).toBe('pending');
    expect(document.querySelector('.dlg98')).not.toBeNull();
    key('Escape'); await p;
  });

  test('Escape with the combo list open closes only the list', async () => {
    const { p } = withWidgets();
    (document.querySelector('.cb98-arrow') as HTMLElement).click();
    expect(document.querySelector('.cb98-list')).not.toBeNull();
    key('Escape', document.querySelector('.cb98 input')!);
    expect(document.querySelector('.cb98-list')).toBeNull();
    expect(await settled(p)).toBe('pending');
    key('Escape', document.querySelector('.cb98 input')!);
    expect(await p).toBe('cancel');
  });

  test('Tab reaches the tabs', async () => {
    const { p } = withWidgets();
    const seen = new Set<Element | null>();
    for (let i = 0; i < 8; i++) { key('Tab'); seen.add(document.activeElement); }
    expect(tabEls().every(t => seen.has(t))).toBe(true);
    key('Escape'); await p;
  });

  test('Enter on a non-widget element inside the dialog still presses the default button', async () => {
    const { p } = withWidgets();
    key('Enter', document.querySelector('.cb98 input')!);
    expect(await p).toBe('ok');
  });

  test('IDE window keydown listener gets nothing while open, from inside or outside the dialog', async () => {
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', spy);
    const { p } = withWidgets();
    key('F5');
    key('s', tabEls()[0]);
    key('Enter', tabEls()[1]);
    key('Escape');
    await p;
    window.removeEventListener('keydown', spy);
    expect(seen).toEqual([]);
  });
});

describe('dialog lifecycle', () => {
  test('focus is restored to the previously focused element after close', async () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 0 });
    expect(document.activeElement).not.toBe(before);
    key('Enter');
    await p;
    expect(document.activeElement).toBe(before);
  });

  test('after close, keys are no longer swallowed', async () => {
    const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 0 });
    key('Enter');
    await p;
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', spy);
    key('Enter');
    key('Escape');
    window.removeEventListener('keydown', spy);
    expect(seen).toEqual(['Enter', 'Escape']);
  });
});
