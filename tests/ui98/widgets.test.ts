// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { h } from '../../src/ui98/dom';
import { createToolbar } from '../../src/ui98/toolbar';
import { createCombo } from '../../src/ui98/combo';
import { createTabs } from '../../src/ui98/tabs';

afterEach(() => { document.body.innerHTML = ''; });

describe('h()', () => {
  test('creates elements with attrs, classes, styles, handlers and children', () => {
    const fn = vi.fn();
    const el = h('div', { class: 'a b', id: 'x', style: { color: 'red', width: '3px' }, onclick: fn, 'data-k': 'v', hidden: false, disabled: true },
      'text', h('span', {}, 'in'), null as unknown as string);
    expect(el.className).toBe('a b');
    expect(el.id).toBe('x');
    expect(el.style.color).toBe('red');
    expect(el.dataset.k).toBe('v');
    expect(el.hasAttribute('hidden')).toBe(false);
    expect(el.hasAttribute('disabled')).toBe(true);
    expect(el.textContent).toBe('textin');
    el.click();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  test('draggable=false is rendered as the string "false"', () => {
    expect(h('img', { draggable: false }).getAttribute('draggable')).toBe('false');
    expect(h('img', { draggable: true }).getAttribute('draggable')).toBe('true');
    expect(h('img', {}).hasAttribute('draggable')).toBe(false);
  });
  test('string style and input value property', () => {
    expect(h('div', { style: 'left:1px' }).style.left).toBe('1px');
    expect(h('input', { value: 'v' }).value).toBe('v');
  });
});

describe('toolbar', () => {
  test('icon images are not draggable', () => {
    const root = document.createElement('div');
    createToolbar(root, [{ icon: 'x.png', title: 'T' }]);
    expect(root.querySelector('img')!.getAttribute('draggable')).toBe('false');
  });
  test('buttons run action, honour enabled/checked, refresh, separators', () => {
    const root = document.createElement('div');
    const act = vi.fn(); let on = false; let en = true;
    const tb = createToolbar(root, [
      { title: 'Save', label: 'S', action: act },
      { separator: true },
      { title: 'Toggle', label: 'T', checked: () => on, enabled: () => en, action: () => {} },
    ]);
    const buttons = () => [...root.querySelectorAll<HTMLElement>('.tb98-btn')];
    expect(buttons().length).toBe(2);
    expect(root.querySelectorAll('.tb98-sep').length).toBe(1);
    expect(buttons()[0].title).toBe('Save');
    buttons()[0].click();
    expect(act).toHaveBeenCalledTimes(1);
    on = true; en = false;
    tb.refresh();
    expect(buttons()[1].classList.contains('checked')).toBe(true);
    expect(buttons()[1].classList.contains('disabled')).toBe(true);
  });
});

describe('combo', () => {
  test('select an item from the dropdown list', () => {
    const onChange = vi.fn();
    const c = createCombo({ items: ['A', 'B', 'C'], value: 'B', onChange });
    document.body.appendChild(c.el);
    expect(c.getValue()).toBe('B');
    expect(c.el.querySelector('input')!.value).toBe('B');
    expect(c.list).toBeNull();
    (c.el.querySelector('.cb98-arrow') as HTMLElement).click();
    expect(c.list!.closest('.popup98-layer')!.parentElement).toBe(document.body);   // body-level layer, not inside the combo
    expect(c.el.contains(c.list)).toBe(false);
    const rows = [...c.list!.querySelectorAll<HTMLElement>('.cb98-item')];
    expect(rows.map(r => r.textContent)).toEqual(['A', 'B', 'C']);
    expect(rows[1].classList.contains('selected')).toBe(true);
    rows[2].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('C');
    expect(c.getValue()).toBe('C');
    expect(c.list).toBeNull();
    expect(document.querySelector('.cb98-list')).toBeNull();
  });
  test('the arrow opens the list inside a <label> too (the label must not pass the click on to the input)', () => {
    for (const editable of [false, true]) {
      const c = createCombo({ items: ['A', 'B'], value: 'A', editable });
      document.body.appendChild(h('label', {}, 'Thinking:', c.el));
      (c.el.querySelector('.cb98-arrow') as HTMLElement).click();
      expect(c.list).not.toBeNull();
      c.close();
    }
  });
  test('setItems/setValue; non-editable input is readonly', () => {
    const c = createCombo({ items: ['A'] });
    c.setItems(['X', 'Y']); c.setValue('Y');
    expect(c.getValue()).toBe('Y');
    expect(c.el.querySelector('input')!.readOnly).toBe(true);
  });
  test('Escape closes an open list and is consumed; with the list closed it is not', () => {
    const c = createCombo({ items: ['A'] });
    document.body.appendChild(c.el);
    const input = c.el.querySelector('input')!;
    (c.el.querySelector('.cb98-arrow') as HTMLElement).click();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(c.list).toBeNull();
    const ev2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });
  test('editable combo accepts typed text', () => {
    const onChange = vi.fn();
    const c = createCombo({ items: ['A'], editable: true, onChange });
    const input = c.el.querySelector('input')!;
    input.value = '42';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(c.getValue()).toBe('42');
    expect(onChange).toHaveBeenCalledWith('42');
  });
});

describe('tabs', () => {
  test('shows only the selected panel and selects on click', () => {
    const onSelect = vi.fn();
    const t = createTabs([{ label: 'One', content: h('div', {}, '1') }, { label: 'Two', content: h('div', {}, '2') }], { onSelect });
    document.body.appendChild(t.el);
    const tabs = [...t.el.querySelectorAll<HTMLElement>('.tabs98-tab')];
    expect(tabs.map(x => x.textContent)).toEqual(['One', 'Two']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(t.el.querySelector('.tabs98-panel')!.textContent).toBe('1');
    tabs[1].click();
    expect(t.selected).toBe(1);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(t.el.querySelector('.tabs98-panel')!.textContent).toBe('2');
    expect(onSelect).toHaveBeenCalledWith(1);
    t.select(0);
    expect(t.selected).toBe(0);
  });
});
