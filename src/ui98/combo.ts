import { h } from './dom';

export interface ComboOptions {
  items: string[];
  value?: string;
  /** Editable = typed text is accepted (DropDown Combo); otherwise Dropdown List. */
  editable?: boolean;
  onChange?: (value: string) => void;
  /** Items for which this returns true are shown in bold. */
  bold?: (item: string) => boolean;
}

export interface Combo {
  el: HTMLElement;
  getValue(): string;
  setValue(v: string): void;
  setItems(items: string[], bold?: (item: string) => boolean): void;
}

/** Win98 dropdown combo box (own DOM list, so it looks the same everywhere). */
export function createCombo(o: ComboOptions): Combo {
  let items = [...o.items];
  let bold = o.bold;
  let value = o.value ?? '';
  const input = h('input', { type: 'text', class: 'cb98-input', value, readOnly: !o.editable });
  const arrow = h('span', { class: 'cb98-arrow', role: 'button', 'aria-label': 'Open list' }, h('span', { class: 'cb98-glyph' }));
  const el = h('div', { class: 'cb98' }, input, arrow);
  let list: HTMLElement | null = null;

  const set = (v: string, notify: boolean) => {
    value = v;
    input.value = v;
    if (notify) o.onChange?.(v);
  };

  function closeList() {
    list?.remove();
    list = null;
    el.ownerDocument.removeEventListener('mousedown', onOutside, true);
  }
  function onOutside(e: Event) { if (!el.contains(e.target as Node)) closeList(); }

  function openList() {
    closeList();
    list = h('div', { class: 'cb98-list' }, ...items.map(it => {
      const row = h('div', { class: `cb98-item${it === value ? ' selected' : ''}${bold?.(it) ? ' cb98-bold' : ''}` }, it);
      row.addEventListener('mousedown', e => { e.preventDefault(); set(it, true); closeList(); });
      return row;
    }));
    el.appendChild(list);
    el.ownerDocument.addEventListener('mousedown', onOutside, true);
  }

  arrow.addEventListener('click', () => (list ? closeList() : openList()));
  if (!o.editable) input.addEventListener('click', () => (list ? closeList() : openList()));
  input.addEventListener('change', () => set(input.value, true));
  input.addEventListener('keydown', e => { if (e.key === 'Escape' && list) { e.preventDefault(); closeList(); } });

  return {
    el,
    getValue: () => value,
    setValue: v => set(v, false),
    setItems: (next, b) => { items = [...next]; bold = b ?? bold; if (list) openList(); },
  };
}
