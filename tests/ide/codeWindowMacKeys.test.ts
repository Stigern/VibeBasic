// @vitest-environment jsdom
// CodeMirror reads the platform once when it loads; this file makes it a Mac before any import.
import { vi, expect, test } from 'vitest';
vi.hoisted(() => { Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true }); });
import type { EditorView } from '@codemirror/view';
import { openCodeWindow } from '../../src/ide/codeWindow';
import { IdeState } from '../../src/ide/ideState';

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

test('Cmd+Y redoes in the code window on a Mac (as Cmd+Shift+Z does)', () => {
  const ide = new IdeState();
  const host = document.body.appendChild(document.createElement('div'));
  const cw = openCodeWindow(ide, ide.project.forms[0].id, { mdiHost: host });
  const view = (cw as unknown as { view: EditorView }).view;
  view.dispatch({ changes: { from: 0, insert: 'x = 1' }, userEvent: 'input.type' });
  const key = (k: string, shiftKey = false) => {
    const ev = new KeyboardEvent('keydown', { key: k, keyCode: k.toUpperCase().charCodeAt(0), metaKey: true, shiftKey, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(ev);
    return ev;
  };
  key('z');
  expect(view.state.doc.toString()).toBe('');
  const ev = key('y');
  expect(view.state.doc.toString()).toBe('x = 1');
  expect(ev.defaultPrevented).toBe(true);
});
