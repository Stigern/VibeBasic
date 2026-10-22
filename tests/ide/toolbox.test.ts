// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { attachToolboxWindow, clampToolboxLayout, columnsFor, type ToolboxWindow } from '../../src/ide/toolbox';
import { buildLayout } from '../../src/ide/layout';
import { BrowserBackend } from '../../src/backend/browserBackend';

let tw: ToolboxWindow, pane: HTMLElement, bar: HTMLElement, grid: HTMLElement, area: HTMLElement;
const save = vi.fn();
const mouse = (t: EventTarget, type: string, x = 0, y = 0) => t.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));

beforeEach(() => {
  vi.useFakeTimers(); save.mockReset();
  const layout = buildLayout(document.body);
  area = layout.mainArea; pane = layout.panes.toolbox.el;
  bar = pane.querySelector(':scope > .title-bar')!;
  grid = document.createElement('div'); layout.toolboxHost.appendChild(grid);
  tw = attachToolboxWindow({ pane, bar, grid, area, save });
});
afterEach(() => { vi.useRealTimers(); document.body.textContent = ''; });

test('columnsFor gives 2..6 columns from the width', () => {
  expect([40, 56, 58, 80, 104, 152, 400].map(columnsFor)).toEqual([2, 2, 2, 3, 4, 6, 6]);
});

test('dragging the title bar floats, double-click docks', () => {
  mouse(bar, 'mousedown', 10, 10); mouse(document, 'mousemove', 60, 50); mouse(document, 'mouseup', 60, 50);
  expect(tw.getLayout().docked).toBe(false);
  expect(pane.classList.contains('tbx98-floating')).toBe(true);
  bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(tw.getLayout().docked).toBe(true);
  expect(pane.classList.contains('tbx98-floating')).toBe(false);
});

test('dragging the right edge changes columns and saves (debounced)', () => {
  const edge = pane.querySelector('.tbx98-edge')!;
  mouse(edge, 'mousedown', 0, 0); mouse(document, 'mousemove', 50, 0); mouse(document, 'mouseup', 50, 0);
  expect(tw.getLayout().width).toBe(108);
  expect(grid.style.gridTemplateColumns).toBe('repeat(4, 24px)');
  expect(save).not.toHaveBeenCalled();
  vi.advanceTimersByTime(400);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toMatchObject({ docked: true, width: 108 });
});

test('layout is saved and read back through the backend settings', async () => {
  vi.useRealTimers();
  const b = new BrowserBackend();
  await b.saveSettings('toolbox', { docked: false, x: 30, y: 40, width: 100 });
  tw.setLayout((await b.loadSettings('toolbox'))!);
  expect(tw.getLayout()).toEqual({ docked: false, x: 30, y: 40, width: 100 });
  expect(pane.style.left).toBe('30px');
});

test('floating position stays inside the IDE area and width within 2..6 columns', () => {
  const area = { width: 800, height: 500 };
  expect(clampToolboxLayout({ docked: false, x: -50, y: -9, width: 10 }, area)).toMatchObject({ x: 0, y: 0, width: 56 });
  expect(clampToolboxLayout({ docked: false, x: 9999, y: 9999, width: 999 }, area)).toMatchObject({ x: 800 - 152, y: 500 - 18, width: 152 });
});
