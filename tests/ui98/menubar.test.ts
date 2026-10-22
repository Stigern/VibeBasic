// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bindShortcuts, createMenubar, type MenuItem } from '../../src/ui98/menubar';

let root: HTMLElement;
beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { document.body.innerHTML = ''; });

const tops = () => [...root.querySelectorAll<HTMLElement>('.mb98-top')];
const openItems = () => [...root.querySelectorAll<HTMLElement>('.menu98 > .menu98-item')];
const text = (e: Element) => e.querySelector('.menu98-label')!.textContent;

function build(extra?: Partial<{ enabled: boolean; checked: boolean }>) {
  const state = { enabled: extra?.enabled ?? true, checked: extra?.checked ?? false };
  const save = vi.fn(); const sub = vi.fn(); const dis = vi.fn();
  const menus = [
    { label: '&File', items: [
      { label: '&Save', shortcut: 'Ctrl+S', action: save },
      { label: 'sep', separator: true },
      { label: 'Disabled', action: dis, enabled: () => state.enabled },
      { label: 'Grid', checked: () => state.checked, action: () => {} },
      { label: 'More', submenu: [{ label: 'Inner', action: sub }, { label: 'Inner2', shortcut: 'F5' }] },
    ] as MenuItem[] },
    { label: '&Edit', items: [{ label: 'Cut', shortcut: 'Ctrl+X', action: () => {} }] },
  ];
  const bar = createMenubar(root, menus);
  return { state, save, sub, dis, menus, bar };
}

describe('menubar', () => {
  test('renders top-level labels with accelerator underline, menus closed', () => {
    build();
    expect(tops().map(t => t.textContent)).toEqual(['File', 'Edit']);
    expect(tops()[0].querySelector('u')!.textContent).toBe('F');
    expect(root.querySelector('.menu98')).toBeNull();
  });

  test('click opens, click again closes', () => {
    build();
    tops()[0].click();
    expect(openItems().length).toBe(5);
    expect(tops()[0].classList.contains('open')).toBe(true);
    tops()[0].click();
    expect(root.querySelector('.menu98')).toBeNull();
  });

  test('shortcut text is rendered right-aligned in its own span', () => {
    build();
    tops()[0].click();
    expect(openItems()[0].querySelector('.menu98-shortcut')!.textContent).toBe('Ctrl+S');
    expect(openItems()[1].classList.contains('sep')).toBe(true);
  });

  test('click on item runs the action and closes the menu', () => {
    const { save } = build();
    tops()[0].click();
    openItems()[0].click();
    expect(save).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.menu98')).toBeNull();
  });

  test('disabled item is greyed, does not run, and keeps the menu open', () => {
    const { dis } = build({ enabled: false });
    tops()[0].click();
    const item = openItems()[2];
    expect(item.classList.contains('disabled')).toBe(true);
    item.click();
    expect(dis).not.toHaveBeenCalled();
    expect(root.querySelector('.menu98')).not.toBeNull();
  });

  test('checked item shows a check mark; refresh() re-evaluates enabled/checked', () => {
    const { state, bar } = build();
    tops()[0].click();
    expect(openItems()[3].classList.contains('checked')).toBe(false);
    expect(openItems()[3].querySelector('.menu98-check')!.textContent).toBe('');
    state.checked = true; state.enabled = false;
    bar.refresh();
    expect(openItems()[3].classList.contains('checked')).toBe(true);
    expect(openItems()[3].querySelector('.menu98-check')!.textContent).toBe('✓');
    expect(openItems()[2].classList.contains('disabled')).toBe(true);
  });

  test('state is re-evaluated each time a menu opens', () => {
    const { state } = build();
    tops()[0].click();
    expect(openItems()[3].classList.contains('checked')).toBe(false);
    tops()[0].click();
    state.checked = true;
    tops()[0].click();
    expect(openItems()[3].classList.contains('checked')).toBe(true);
  });

  test('submenu opens on hover and its item runs', () => {
    const { sub } = build();
    tops()[0].click();
    const more = openItems()[4];
    expect(more.classList.contains('has-sub')).toBe(true);
    expect(more.querySelector('.menu98-arrow')).not.toBeNull();
    expect(more.querySelector('.menu98 .menu98-item')).toBeNull();
    more.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const inner = [...more.querySelectorAll<HTMLElement>('.menu98 .menu98-item')];
    expect(inner.map(text)).toEqual(['Inner', 'Inner2']);
    expect(inner[1].querySelector('.menu98-shortcut')!.textContent).toBe('F5');
    inner[0].click();
    expect(sub).toHaveBeenCalled();
    expect(root.querySelector('.menu98')).toBeNull();
  });

  test('clicking a submenu parent does not close', () => {
    build();
    tops()[0].click();
    openItems()[4].click();
    expect(root.querySelector('.menu98')).not.toBeNull();
  });

  test('hover switches between menus only while one is open', () => {
    build();
    tops()[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(root.querySelector('.menu98')).toBeNull();
    tops()[0].click();
    tops()[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(tops()[1].classList.contains('open')).toBe(true);
    expect(tops()[0].classList.contains('open')).toBe(false);
    expect(openItems().map(text)).toEqual(['Cut']);
  });

  test('Escape closes; outside mousedown closes', () => {
    build();
    tops()[0].click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.menu98')).toBeNull();
    tops()[0].click();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(root.querySelector('.menu98')).toBeNull();
  });

  test('keyboard: arrows move over enabled items, skipping separators and disabled items', () => {
    build({ enabled: false });
    tops()[0].click();
    const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const hot = () => openItems().findIndex(i => i.classList.contains('hot'));
    key('ArrowDown');
    expect(hot()).toBe(0);
    key('ArrowDown');
    expect(hot()).toBe(3);
    key('ArrowUp');
    expect(hot()).toBe(0);
  });

  test('keyboard: Enter on hot item runs action', () => {
    const { save } = build();
    tops()[0].click();
    const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowDown'); key('Enter');
    expect(save).toHaveBeenCalled();
  });

  test('keyboard: ArrowRight switches to next menu', () => {
    build();
    tops()[0].click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tops()[1].classList.contains('open')).toBe(true);
  });
});

describe('bindShortcuts', () => {
  const unbinders: (() => void)[] = [];
  afterEach(() => { while (unbinders.length) unbinders.pop()!(); });
  const key = (init: KeyboardEventInit, target: EventTarget = window) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const mk = (shortcut: string, extra: Partial<MenuItem> = {}) => {
    const action = vi.fn();
    unbinders.push(bindShortcuts([{ label: 'M', items: [{ label: 'X', shortcut, action, ...extra }] }], window));
    return action;
  };

  test('ctrl shortcut also matches cmd', () => {
    const a = mk('Ctrl+S');
    key({ key: 's', ctrlKey: true });
    key({ key: 's', metaKey: true });
    key({ key: 'S', ctrlKey: true });
    expect(a).toHaveBeenCalledTimes(3);
  });
  test('does not match bare key, shift or alt variants', () => {
    const a = mk('Ctrl+S');
    key({ key: 's' });
    key({ key: 's', ctrlKey: true, shiftKey: true });
    key({ key: 's', ctrlKey: true, altKey: true });
    key({ key: 'x', ctrlKey: true });
    expect(a).not.toHaveBeenCalled();
  });
  test('preventDefault is called on a match', () => {
    mk('Ctrl+S');
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
  test('F keys and Shift+F7', () => {
    const f5 = mk('F5'); const sf7 = mk('Shift+F7');
    key({ key: 'F5' });
    key({ key: 'F7', shiftKey: true });
    key({ key: 'F7' });
    expect(f5).toHaveBeenCalledTimes(1);
    expect(sf7).toHaveBeenCalledTimes(1);
  });
  test('Ctrl+ with function key and compound modifiers', () => {
    const a = mk('Ctrl+Shift+F9');
    key({ key: 'F9', metaKey: true, shiftKey: true });
    expect(a).toHaveBeenCalledTimes(1);
  });
  test('Del', () => {
    const a = mk('Del');
    key({ key: 'Delete' });
    expect(a).toHaveBeenCalledTimes(1);
  });
  test('Ctrl+Break matches Ctrl+Pause, Ctrl+Cancel and Cmd+.', () => {
    const a = mk('Ctrl+Break');
    key({ key: 'Pause', ctrlKey: true });
    key({ key: 'Cancel', ctrlKey: true });
    key({ key: '.', metaKey: true });
    expect(a).toHaveBeenCalledTimes(3);
    key({ key: '.' });
    expect(a).toHaveBeenCalledTimes(3);
  });
  test('submenu items and disabled items', () => {
    const inner = vi.fn(); const off = vi.fn();
    unbinders.push(bindShortcuts([{ label: 'M', items: [
      { label: 'Sub', submenu: [{ label: 'In', shortcut: 'Ctrl+I', action: inner }] },
      { label: 'Off', shortcut: 'Ctrl+O', action: off, enabled: () => false },
    ] }], window));
    key({ key: 'i', ctrlKey: true });
    key({ key: 'o', ctrlKey: true });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
  });
  test('unmodified keys and clipboard shortcuts are left alone inside text fields', () => {
    const del = mk('Del'); const cp = mk('Ctrl+C'); const sv = mk('Ctrl+S');
    const input = document.createElement('input');
    document.body.appendChild(input);
    key({ key: 'Delete' }, input);
    key({ key: 'c', ctrlKey: true }, input);
    key({ key: 's', ctrlKey: true }, input);
    expect(del).not.toHaveBeenCalled();
    expect(cp).not.toHaveBeenCalled();
    expect(sv).toHaveBeenCalledTimes(1);
  });
  test('returned function unbinds', () => {
    const action = vi.fn();
    const unbind = bindShortcuts([{ label: 'M', items: [{ label: 'X', shortcut: 'Ctrl+U', action }] }], window);
    unbind();
    key({ key: 'u', ctrlKey: true });
    expect(action).not.toHaveBeenCalled();
  });
  test('a matching shortcut of a disabled item does nothing but still prevents the browser default', () => {
    const a = mk('F5', { enabled: () => false });
    const ev = new KeyboardEvent('keydown', { key: 'F5', cancelable: true });
    window.dispatchEvent(ev);
    expect(a).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });
  test('a disabled item does not shadow an enabled item with the same shortcut', () => {
    const off = vi.fn(); const on = vi.fn();
    unbinders.push(bindShortcuts([{ label: 'M', items: [
      { label: 'A', shortcut: 'F6', action: off, enabled: () => false },
      { label: 'B', shortcut: 'F6', action: on },
    ] }], window));
    key({ key: 'F6' });
    expect(off).not.toHaveBeenCalled();
    expect(on).toHaveBeenCalledTimes(1);
  });
  test('Del also matches Backspace outside text fields, but not inside them', () => {
    const a = mk('Del');
    key({ key: 'Backspace' });
    expect(a).toHaveBeenCalledTimes(1);
    const input = document.createElement('input');
    document.body.appendChild(input);
    key({ key: 'Backspace' }, input);
    expect(a).toHaveBeenCalledTimes(1);
  });
  test('unrelated keys do not preventDefault', () => {
    mk('Ctrl+S');
    const ev = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('bindShortcuts and consumed keys', () => {
  test('a key whose default was already prevented does not fire the shortcut', () => {
    const action = vi.fn();
    const un = bindShortcuts([{ label: 'M', items: [{ label: 'X', shortcut: 'Del', action }] }], window);
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.addEventListener('keydown', e => e.preventDefault());
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    expect(action).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    expect(action).toHaveBeenCalledTimes(1);
    un();
  });
});
