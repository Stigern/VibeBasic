// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { blockBrowserKeys, isBrowserKey } from '../src/browserKeys';
import { setPlatform } from '../src/platform';

afterEach(() => setPlatform('mac', false));

const k = (key: string, mods: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}) =>
  ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('the browser\'s own keys: reload, Find, print, caret browsing, back / forward', () => {
  for (const e of [k('F5'), k('F5', { ctrlKey: true }), k('F5', { shiftKey: true }), k('r', { ctrlKey: true }), k('R', { ctrlKey: true, shiftKey: true }),
    k('f', { ctrlKey: true }), k('g', { ctrlKey: true }), k('p', { ctrlKey: true }), k('F3'), k('F3', { shiftKey: true }), k('F7'),
    k('ArrowLeft', { altKey: true }), k('BrowserBack')]) expect(isBrowserKey(e), JSON.stringify(e)).toBe(true);
  for (const e of [k('r'), k('c', { ctrlKey: true }), k('v', { ctrlKey: true }), k('a', { ctrlKey: true }), k('F4'), k('ArrowLeft'),
    k('r', { ctrlKey: true, altKey: true }), k('@', { ctrlKey: true, altKey: true }), k('r', { metaKey: true }), k('F5', { altKey: true })])
    expect(isBrowserKey(e), JSON.stringify(e)).toBe(false);
});

test('the page sees the key first (also handlers that skip a defaultPrevented key), then the browser\'s action is cancelled', () => {
  setPlatform('windows');
  blockBrowserKeys(window);
  const seen: boolean[] = [];
  const handler = (e: KeyboardEvent) => { seen.push(e.defaultPrevented); };
  window.addEventListener('keydown', handler);   // added after blockBrowserKeys, as the IDE's menus are
  const f5 = new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true });
  document.body.dispatchEvent(f5);
  expect(seen).toEqual([false]);
  expect(f5.defaultPrevented).toBe(true);
  const x = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  document.body.dispatchEvent(x);
  expect(x.defaultPrevented).toBe(false);

  setPlatform('mac', false);   // WKWebView has no such keys; Ctrl+F there moves the caret in a text field
  const f = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(f);
  expect(f.defaultPrevented).toBe(false);
  window.removeEventListener('keydown', handler);
});
