import { h } from './dom';

export interface ToolbarItem {
  /** URL of a 16x16 image (or inline SVG markup starting with "<svg"). */
  icon?: string;
  /** Text shown instead of / next to the icon. */
  label?: string;
  /** Tooltip. */
  title?: string;
  action?: () => void;
  enabled?: () => boolean;
  /** Toggle buttons are drawn pressed while this returns true. */
  checked?: () => boolean;
  separator?: boolean;
}

/** Flat Win98/VB6 toolbar. */
export function createToolbar(root: HTMLElement, items: ToolbarItem[]): { refresh(): void } {
  root.classList.add('tb98-bar');
  const entries: { el: HTMLElement; item: ToolbarItem }[] = [];
  for (const item of items) {
    if (item.separator) { root.appendChild(h('span', { class: 'tb98-sep' })); continue; }
    const el = h('span', { class: 'tb98-btn tb98-tool', role: 'button', title: item.title ?? item.label ?? '' });
    if (item.icon) {
      if (item.icon.trim().startsWith('<svg')) {
        const holder = h('span', { class: 'tb98-icon' });
        holder.innerHTML = item.icon;
        el.appendChild(holder);
      } else el.appendChild(h('img', { class: 'tb98-icon', src: item.icon, alt: '', draggable: false }));
    }
    if (item.label) el.appendChild(h('span', { class: 'tb98-label' }, item.label));
    el.addEventListener('click', () => {
      if (item.enabled && !item.enabled()) return;
      item.action?.();
      update();
    });
    root.appendChild(el);
    entries.push({ el, item });
  }
  function update() {
    for (const { el, item } of entries) {
      el.classList.toggle('disabled', item.enabled ? !item.enabled() : false);
      el.classList.toggle('checked', item.checked ? !!item.checked() : false);
    }
  }
  update();
  return { refresh: update };
}
