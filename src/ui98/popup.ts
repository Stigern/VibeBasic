import { h } from './dom';

/** Small Win98 context menu at (x, y); closes on a click outside or on an item. */
export function popupMenu(doc: Document, x: number, y: number, items: { label: string; action: () => void }[]): void {
  const menu = h('div', { class: 'menu98 pe98-menu', style: `position:fixed;left:${x}px;top:${y}px;z-index:1000` });
  const close = () => { menu.remove(); doc.removeEventListener('mousedown', onOutside, true); };
  const onOutside = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
  for (const it of items) {
    const el = h('div', { class: 'menu98-item' }, h('span', { class: 'menu98-check' }), h('span', { class: 'menu98-label' }, it.label));
    el.addEventListener('mouseenter', () => el.classList.add('hot'));
    el.addEventListener('mouseleave', () => el.classList.remove('hot'));
    el.addEventListener('click', () => { close(); it.action(); });
    menu.appendChild(el);
  }
  doc.body.appendChild(menu);
  doc.addEventListener('mousedown', onOutside, true);
}
