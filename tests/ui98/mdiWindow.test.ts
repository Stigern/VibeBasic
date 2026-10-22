// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createMdiWindow } from '../../src/ui98/mdiWindow';

let host: HTMLElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
afterEach(() => { document.body.innerHTML = ''; });

const mk = (title = 'W', x = 10, y = 20, resizable = false) =>
  createMdiWindow(host, { title, x, y, width: 300, height: 200, resizable });
const isActive = (w: { el: HTMLElement }) => !w.el.querySelector('.title-bar')!.classList.contains('inactive');
const mouse = (t: EventTarget, type: string, x: number, y: number) =>
  t.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));

describe('createMdiWindow', () => {
  test('geometry, title and body', () => {
    const w = mk('Form1');
    expect(w.el.parentElement).toBe(host);
    expect(w.el.style.left).toBe('10px');
    expect(w.el.style.top).toBe('20px');
    expect(w.el.style.width).toBe('300px');
    expect(w.el.style.height).toBe('200px');
    expect(w.el.querySelector('.title-bar-text')!.textContent).toBe('Form1');
    expect(w.body.parentElement).toBe(w.el);
    w.setTitle('Other');
    expect(w.el.querySelector('.title-bar-text')!.textContent).toBe('Other');
  });

  test('new window is active, previous becomes inactive (gradient classes)', () => {
    const a = mk('A'); const b = mk('B');
    expect(isActive(b)).toBe(true);
    expect(isActive(a)).toBe(false);
    expect(b.el.classList.contains('active')).toBe(true);
  });

  test('activate() and mousedown bring a window to the front', () => {
    const a = mk('A'); const b = mk('B');
    a.activate();
    expect(isActive(a)).toBe(true);
    expect(isActive(b)).toBe(false);
    expect(Number(a.el.style.zIndex)).toBeGreaterThan(Number(b.el.style.zIndex));
    mouse(b.body, 'mousedown', 5, 5);
    expect(isActive(b)).toBe(true);
    expect(isActive(a)).toBe(false);
  });

  test('windows of different hosts are independent', () => {
    const other = document.createElement('div'); document.body.appendChild(other);
    const a = mk('A');
    createMdiWindow(other, { title: 'O', x: 0, y: 0, width: 50, height: 50 });
    expect(isActive(a)).toBe(true);
  });

  test('close button removes the window and activates the one below', () => {
    const a = mk('A'); const b = mk('B');
    (b.el.querySelector('[aria-label="Close"]') as HTMLElement).click();
    expect(host.contains(b.el)).toBe(false);
    expect(isActive(a)).toBe(true);
  });

  test('onClose returning false cancels the close', () => {
    const w = mk();
    w.onClose = vi.fn(() => false);
    (w.el.querySelector('[aria-label="Close"]') as HTMLElement).click();
    expect(w.onClose).toHaveBeenCalledTimes(1);
    expect(host.contains(w.el)).toBe(true);
    w.close();
    expect(host.contains(w.el)).toBe(true);
    w.onClose = () => true;
    w.close();
    expect(host.contains(w.el)).toBe(false);
  });

  test('close() without onClose removes', () => {
    const w = mk();
    w.close();
    expect(host.contains(w.el)).toBe(false);
  });

  test('drag by the title bar moves the window; dragging controls does not', () => {
    const w = mk('A', 10, 20);
    const bar = w.el.querySelector('.title-bar') as HTMLElement;
    mouse(bar, 'mousedown', 100, 100);
    mouse(document, 'mousemove', 130, 150);
    expect(w.el.style.left).toBe('40px');
    expect(w.el.style.top).toBe('70px');
    mouse(document, 'mouseup', 130, 150);
    mouse(document, 'mousemove', 300, 300);
    expect(w.el.style.left).toBe('40px');
  });

  test('drag is clamped inside the host when it has a size', () => {
    Object.defineProperty(host, 'clientWidth', { value: 500 });
    Object.defineProperty(host, 'clientHeight', { value: 400 });
    const w = mk('A', 10, 20);
    const bar = w.el.querySelector('.title-bar') as HTMLElement;
    mouse(bar, 'mousedown', 0, 0);
    mouse(document, 'mousemove', -5000, -5000);
    expect(parseInt(w.el.style.top)).toBe(0);
    expect(parseInt(w.el.style.left)).toBeGreaterThanOrEqual(-300);
    mouse(document, 'mousemove', 5000, 5000);
    expect(parseInt(w.el.style.left)).toBeLessThan(500);
    expect(parseInt(w.el.style.top)).toBeLessThan(400);
    mouse(document, 'mouseup', 0, 0);
  });

  test('resizable window has a grip that resizes, non-resizable has none', () => {
    expect(mk('N').el.querySelector('.mdi98-grip')).toBeNull();
    const w = mk('R', 0, 0, true);
    const grip = w.el.querySelector('.mdi98-grip') as HTMLElement;
    mouse(grip, 'mousedown', 300, 200);
    mouse(document, 'mousemove', 340, 230);
    expect(w.el.style.width).toBe('340px');
    expect(w.el.style.height).toBe('230px');
    mouse(document, 'mousemove', -1000, -1000);
    expect(parseInt(w.el.style.width)).toBeGreaterThanOrEqual(80);
    mouse(document, 'mouseup', 0, 0);
  });
});
