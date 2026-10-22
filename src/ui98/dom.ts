const PROPS = ['value', 'checked', 'disabled', 'readOnly', 'selected', 'textContent', 'innerHTML'];

/**
 * Tiny DOM helper used by every ui98 widget.
 *
 * Attribute rules:
 *  - `class` / `className`: class string
 *  - `style`: CSS string or object of (camelCase or kebab-case) properties
 *  - `on<event>` (function): addEventListener
 *  - `data-*`: set as attribute; `dataset`: object merged into dataset
 *  - `value`, `checked`, `disabled`, `readOnly`, `selected`, `textContent`, `innerHTML`: set as properties
 *  - boolean true: empty attribute, false/null/undefined: skipped
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') el.className = String(v);
    else if (k === 'style') {
      if (typeof v === 'string') el.style.cssText = v;
      else for (const [p, val] of Object.entries(v as Record<string, string>)) {
        if (p.startsWith('--') || p.includes('-')) el.style.setProperty(p, String(val));
        else (el.style as unknown as Record<string, string>)[p] = String(val);
      }
    } else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (PROPS.includes(k) && k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Splits a VB-style label "&File" into text and accelerator index (for underline). */
export function parseMnemonic(label: string): { text: string; index: number } {
  let text = '';
  let index = -1;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '&') {
      if (label[i + 1] === '&') { text += '&'; i++; continue; }
      if (index < 0 && i + 1 < label.length) index = text.length;
      continue;
    }
    text += label[i];
  }
  return { text, index };
}

/** Renders a label with an underlined accelerator ("&File" -> F<u>i</u>le style). */
export function mnemonicNodes(label: string): Node[] {
  const { text, index } = parseMnemonic(label);
  if (index < 0) return [document.createTextNode(text)];
  return [
    document.createTextNode(text.slice(0, index)),
    h('u', {}, text[index]),
    document.createTextNode(text.slice(index + 1)),
  ];
}

/**
 * Title bar used by dialogs and MDI windows. The close box is a `span[role=button]` (not a `<button>`),
 * so dialog button queries only see the real dialog buttons.
 */
export function createTitleBar(title: string, o: { icon?: string; onClose?: () => void; closeDisabled?: boolean } = {}) {
  const text = h('div', { class: 'title-bar-text' }, title);
  const close = h('span', {
    class: 'tb98-btn tb98-close', role: 'button', 'aria-label': 'Close', title: 'Close',
    'aria-disabled': o.closeDisabled ? 'true' : null,
  });
  close.addEventListener('mousedown', e => e.stopPropagation());
  close.addEventListener('click', e => {
    e.stopPropagation();
    if (close.getAttribute('aria-disabled') === 'true') return;
    o.onClose?.();
  });
  const bar = h('div', { class: 'title-bar' },
    o.icon ? h('img', { class: 'title-bar-icon', src: o.icon, alt: '', draggable: false }) : '',
    text,
    h('div', { class: 'title-bar-controls' }, close));
  return { bar, text, close };
}
