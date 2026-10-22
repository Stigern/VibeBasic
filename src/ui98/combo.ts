import { h } from './dom';
import { showFloating, type Floating } from './floating';

export interface ComboOptions {
  items: string[];
  value?: string;
  /** Editable = typed text is accepted (DropDown Combo); otherwise Dropdown List. */
  editable?: boolean;
  onChange?: (value: string) => void;
  /** Items for which this returns true are shown in bold. */
  bold?: (item: string) => boolean;
  /** Custom rendering of the shown value and the list items (e.g. "<b>Form1</b> Form"). */
  format?: (item: string) => Node;
  /** Dropdown List only: a click on the text opens the list (default true). */
  openOnClick?: boolean;
}

export interface Combo {
  el: HTMLElement;
  getValue(): string;
  setValue(v: string): void;
  setItems(items: string[], bold?: (item: string) => boolean): void;
  /** The open dropdown list (in the body-level popup layer), or null. */
  readonly list: HTMLElement | null;
  open(): void;
  close(): void;
}

/** Win98 dropdown combo box (own DOM list, so it looks the same everywhere). The list is rendered in the
 *  body-level popup layer (see floating.ts), so it is never clipped by the combo's ancestors. */
export function createCombo(o: ComboOptions): Combo {
  let items = [...o.items];
  let bold = o.bold;
  let value = o.value ?? '';
  const input = h('input', { type: 'text', class: 'cb98-input', value, readOnly: !o.editable });
  const arrow = h('span', { class: 'cb98-arrow', role: 'button', 'aria-label': 'Open list' }, h('span', { class: 'cb98-glyph' }));
  const display = o.format ? h('span', { class: 'cb98-display' }) : null;
  const el = h('div', { class: `cb98${display ? ' cb98-formatted' : ''}` }, input, ...(display ? [display] : []), arrow);
  let floating: Floating | null = null;
  let listEl: HTMLElement | null = null;
  let hot = -1;

  const render = () => { if (display) display.replaceChildren(o.format!(value)); };
  render();
  const set = (v: string, notify: boolean) => {
    value = v;
    input.value = v;
    render();
    if (notify) o.onChange?.(v);
  };

  const markHot = () => listEl?.querySelectorAll('.cb98-item').forEach((r, i) => r.classList.toggle('selected', i === hot));

  function closeList() { floating?.close(); }

  function openList() {
    closeList();
    if (input.disabled) return;
    hot = items.indexOf(value);
    const list = h('div', { class: 'cb98-list' }, ...items.map(it => {
      const row = h('div', { class: `cb98-item${it === value ? ' selected' : ''}${bold?.(it) ? ' cb98-bold' : ''}` },
        o.format ? o.format(it) : it);
      row.addEventListener('mousedown', e => { e.preventDefault(); closeList(); set(it, true); });
      return row;
    }));
    listEl = list;
    floating = showFloating(el, list, { onClose: () => { floating = null; listEl = null; } });
    list.querySelector('.cb98-item.selected')?.scrollIntoView?.({ block: 'nearest' });
  }

  arrow.addEventListener('mousedown', e => e.preventDefault());   // keep the focus where it is
  arrow.addEventListener('click', () => (floating ? closeList() : openList()));
  if (!o.editable && o.openOnClick !== false) input.addEventListener('click', () => (floating ? closeList() : openList()));
  input.addEventListener('change', () => set(input.value, true));
  input.addEventListener('keydown', e => {
    if ((e.key === 'ArrowDown' && e.altKey) || e.key === 'F4') { e.preventDefault(); return floating ? closeList() : openList(); }
    if (floating && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      hot = Math.max(0, Math.min(items.length - 1, hot + (e.key === 'ArrowDown' ? 1 : -1)));
      markHot();
      return;
    }
    if (floating && e.key === 'Enter') {
      e.preventDefault();
      const it = items[hot];
      closeList();
      if (it !== undefined) set(it, true);
      return;
    }
    // Dropdown List: typing a character selects the next item that starts with it
    if (!o.editable && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      const start = items.indexOf(value);
      for (let k = 1; k <= items.length; k++) {
        const it = items[(start + k + items.length) % items.length];
        if (it.toLowerCase().startsWith(ch)) {
          e.preventDefault();
          if (floating) { hot = items.indexOf(it); markHot(); } else if (it !== value) set(it, true);
          return;
        }
      }
    }
  });

  return {
    el,
    getValue: () => value,
    setValue: v => set(v, false),
    setItems: (next, b) => { items = [...next]; bold = b ?? bold; if (floating) openList(); },
    get list() { return listEl; },
    open: openList,
    close: closeList,
  };
}
