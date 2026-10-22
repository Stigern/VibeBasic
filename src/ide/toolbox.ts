import { CONTROL_TYPES, TOOLBOX_ORDER } from '../model/controls';
import { h } from '../ui98/dom';
import { placeControlCentered } from './designer';
import type { IdeState } from './ideState';
import { TOOLBOX_ICONS } from './icons/toolboxIcons';

/** Two columns of 24x24 tool buttons with tooltips. Selecting a tool sets ide.currentTool (Pointer resets). */
export function createToolbox(host: HTMLElement, ide: IdeState): { refresh(): void; buttons: Map<string, HTMLElement> } {
  const buttons = new Map<string, HTMLElement>();
  const grid = h('div', { class: 'tbx98-grid' });
  for (const tool of TOOLBOX_ORDER) {
    const title = tool === 'Pointer' ? 'Pointer' : CONTROL_TYPES[tool].toolboxTooltip;
    const btn = h('div', { class: 'tbx98-btn', role: 'button', title, 'data-tool': tool });
    btn.innerHTML = TOOLBOX_ICONS[tool];
    btn.addEventListener('click', () => ide.setTool(tool));
    btn.addEventListener('dblclick', () => placeControlCentered(ide, tool));
    grid.appendChild(btn);
    buttons.set(tool, btn);
  }
  host.appendChild(grid);
  const refresh = () => { for (const [t, b] of buttons) b.classList.toggle('checked', t === ide.currentTool); };
  ide.on('tool', refresh);
  refresh();
  return { refresh, buttons };
}
