import { h } from './dom';

export interface TabDef { label: string; content: HTMLElement }

export interface Tabs {
  el: HTMLElement;
  readonly selected: number;
  select(i: number): void;
}

/** Win98 tab strip with a raised panel; only the selected tab's content is attached. */
export function createTabs(tabs: TabDef[], o: { selected?: number; onSelect?: (i: number) => void } = {}): Tabs {
  let selected = Math.min(Math.max(o.selected ?? 0, 0), Math.max(tabs.length - 1, 0));
  const strip = h('div', { class: 'tabs98-strip', role: 'tablist' });
  const panel = h('div', { class: 'tabs98-panel', role: 'tabpanel' });
  const el = h('div', { class: 'tabs98' }, strip, panel);

  const tabEls = tabs.map((t, i) => {
    const tab = h('div', { class: 'tabs98-tab', role: 'tab', tabindex: '0' }, t.label);
    tab.addEventListener('click', () => api.select(i));
    tab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.select(i); } });
    strip.appendChild(tab);
    return tab;
  });

  function render() {
    tabEls.forEach((t, i) => {
      t.setAttribute('aria-selected', String(i === selected));
      t.classList.toggle('selected', i === selected);
    });
    panel.replaceChildren(...(tabs[selected] ? [tabs[selected].content] : []));
  }

  const api: Tabs = {
    el,
    get selected() { return selected; },
    select(i) {
      if (i < 0 || i >= tabs.length) return;
      const changed = i !== selected;
      selected = i;
      render();
      if (changed) o.onSelect?.(i);
    },
  };
  render();
  return api;
}
