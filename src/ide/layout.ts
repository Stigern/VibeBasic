// Main window layout: menu bar + toolbar on top; Toolbox left; MDI area in the middle (Immediate docked below,
// hidden until opened); Project Explorer over Properties on the right with a draggable splitter between them.
// Later tasks fill the exposed hosts (mdiHost, projectHost, propertiesHost, immediateHost, toolboxHost).
import { createTitleBar, h } from '../ui98/dom';
import './ide.css';

export type PaneName = 'toolbox' | 'project' | 'properties' | 'immediate';
export interface Pane { el: HTMLElement; body: HTMLElement; titleText: HTMLElement }

export interface IdeLayout {
  root: HTMLElement;
  menubarHost: HTMLElement;
  toolbarHost: HTMLElement;
  toolboxHost: HTMLElement;
  /** The area below menu/toolbar (toolbox, MDI, right panes); the floating Toolbox is confined to it. */
  mainArea: HTMLElement;
  /** The grey MDI area (#808080); designer and code windows are createMdiWindow(mdiHost, ...). */
  mdiHost: HTMLElement;
  projectHost: HTMLElement;
  propertiesHost: HTMLElement;
  immediateHost: HTMLElement;
  statusHost: HTMLElement;
  panes: Record<PaneName, Pane>;
  setPaneVisible(name: PaneName, visible: boolean): void;
  isPaneVisible(name: PaneName): boolean;
  setPaneTitle(name: PaneName, title: string): void;
}

export function buildLayout(root: HTMLElement): IdeLayout {
  root.classList.add('ide98');
  root.textContent = '';
  let layout: IdeLayout;
  const mkPane = (name: PaneName, title: string, cls: string): Pane => {
    const t = createTitleBar(title, { onClose: () => layout.setPaneVisible(name, false) });
    const body = h('div', { class: 'ide98-pane-body' });
    const el = h('div', { class: `ide98-pane ${cls}` }, t.bar, body);
    return { el, body, titleText: t.text };
  };
  const panes: Record<PaneName, Pane> = {
    toolbox: mkPane('toolbox', 'General', 'ide98-toolbox'),
    project: mkPane('project', 'Project', 'ide98-project'),
    properties: mkPane('properties', 'Properties', 'ide98-properties'),
    immediate: mkPane('immediate', 'Immediate', 'ide98-immediate'),
  };
  panes.immediate.el.classList.add('hidden');

  const menubarHost = h('div');
  const toolbarHost = h('div');
  const mdiHost = h('div', { class: 'ide98-mdi' });
  const statusHost = h('div', { class: 'ide98-status' });
  const right = h('div', { class: 'ide98-right' });
  const split = h('div', { class: 'ide98-split', title: 'Drag to resize' });
  right.append(panes.project.el, split, panes.properties.el);
  const center = h('div', { class: 'ide98-center' }, mdiHost, panes.immediate.el);
  const mainArea = h('div', { class: 'ide98-main' }, panes.toolbox.el, center, right);
  root.append(menubarHost, toolbarHost, mainArea, statusHost);

  split.addEventListener('mousedown', e => {
    e.preventDefault();
    const doc = root.ownerDocument;
    const move = (ev: MouseEvent) => {
      const r = right.getBoundingClientRect();
      const h0 = Math.max(60, Math.min(r.height - 60, ev.clientY - r.top));
      panes.project.el.style.flex = `0 0 ${h0}px`;
    };
    const up = () => { doc.removeEventListener('mousemove', move); doc.removeEventListener('mouseup', up); };
    doc.addEventListener('mousemove', move);
    doc.addEventListener('mouseup', up);
  });

  layout = {
    root, menubarHost, toolbarHost, mainArea, mdiHost, statusHost, panes,
    toolboxHost: panes.toolbox.body, projectHost: panes.project.body,
    propertiesHost: panes.properties.body, immediateHost: panes.immediate.body,
    setPaneVisible(name, visible) { panes[name].el.classList.toggle('hidden', !visible); },
    isPaneVisible(name) { return !panes[name].el.classList.contains('hidden'); },
    setPaneTitle(name, title) { panes[name].titleText.textContent = title; },
  };
  return layout;
}
