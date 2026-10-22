// IDE shell: builds the main window and wires menus, toolbar, Toolbox and the first designer window.
import type { Backend } from '../backend/backend';
import { formMetrics, renderFormSurface } from '../controls/render';
import { newProject } from '../model/controls';
import type { FormDef } from '../model/types';
import { createMdiWindow, type MdiWindow } from '../ui98/mdiWindow';
import { bindShortcuts, createMenubar } from '../ui98/menubar';
import { createToolbar, type ToolbarItem } from '../ui98/toolbar';
import { messageBox98, vbOK } from '../ui98/dialogs';
import { TOOLBAR_ICONS } from './icons/toolbarIcons';
import { IdeState } from './ideState';
import { buildLayout, type IdeLayout } from './layout';
import { buildMenus, type IdeActions } from './menus';
import { createToolbox } from './toolbox';

export interface Ide { state: IdeState; layout: IdeLayout; actions: IdeActions; menus: ReturnType<typeof buildMenus>; refresh(): void }

export const ABOUT_TEXT = 'VibeBasic\nA Visual Basic 6 style programming environment for macOS.\n\n'
  + "Pixel font 'MS Sans Serif' by lou (FontStruct), CC BY-SA 3.0\nWin98 look based on 98.css (MIT).";

export function startIde(backend: Backend, root: HTMLElement = document.getElementById('app') ?? document.body): Ide {
  const state = new IdeState(newProject());
  const layout = buildLayout(root);
  const doc = root.ownerDocument;

  const actions: IdeActions = {
    undo: () => state.stack.undo(),
    redo: () => state.stack.redo(),
    viewImmediate: () => layout.setPaneVisible('immediate', !layout.isPaneVisible('immediate')),
    viewProjectExplorer: () => layout.setPaneVisible('project', true),
    viewProperties: () => layout.setPaneVisible('properties', true),
    viewToolbox: () => layout.setPaneVisible('toolbox', true),
    about: () => { void messageBox98(doc, { prompt: ABOUT_TEXT, title: 'About VibeBasic', buttons: vbOK }); },
  };
  const menus = buildMenus(actions, state);
  const menubar = createMenubar(layout.menubarHost, menus);

  const tb = (icon: string, title: string, name: string, pred?: () => boolean): ToolbarItem => ({
    icon: TOOLBAR_ICONS[icon], title, action: () => actions[name]?.(), enabled: () => !!actions[name] && (pred ? pred() : true),
  });
  const sep: ToolbarItem = { separator: true };
  const toolbar = createToolbar(layout.toolbarHost, [
    tb('new', 'New Project', 'newProject'), tb('open', 'Open Project', 'openProject'), tb('save', 'Save Project', 'saveProject'), sep,
    tb('cut', 'Cut', 'cut'), tb('copy', 'Copy', 'copy'), tb('paste', 'Paste', 'paste'), sep,
    tb('undo', 'Undo', 'undo', () => state.stack.canUndo), tb('redo', 'Redo', 'redo', () => state.stack.canRedo), sep,
    tb('start', 'Start', 'start'), tb('break', 'Break', 'break'), tb('end', 'End', 'end'), sep,
    tb('projectExplorer', 'Project Explorer', 'viewProjectExplorer'), tb('properties', 'Properties Window', 'viewProperties'),
    tb('toolbox', 'Toolbox', 'viewToolbox'),
  ]);
  createToolbox(layout.toolboxHost, state);
  bindShortcuts(menus, window);

  const refresh = () => { menubar.refresh(); toolbar.refresh(); };
  const updateTitle = () => {
    void backend.setWindowTitle(`${state.project.name} - VibeBasic [${state.mode}]`);
  };
  state.on('project', () => { refresh(); updateTitle(); });
  state.on('mode', () => { refresh(); updateTitle(); });
  updateTitle();

  openFormWindow(state, layout, state.project.forms[0]);
  return { state, layout, actions, menus, refresh };
}

/** Placeholder designer window (Task 7 replaces it with the interactive designer): the form in design mode with grid. */
export function openFormWindow(state: IdeState, layout: IdeLayout, form: FormDef): MdiWindow {
  const o = state.options;
  const surface = renderFormSurface(form, 'design', () => null,
    { showGrid: o.showGrid, gridX: o.gridWidth, gridY: o.gridHeight });
  const win = createMdiWindow(layout.mdiHost, {
    title: `${state.project.name} - ${form.name} (Form)`, x: 20, y: 20, width: 0, height: 0, resizable: true,
  });
  win.body.appendChild(surface.el);
  const m = formMetrics(form.props);
  win.el.style.width = `${m.outerWidth + 8}px`;
  win.el.style.height = `${m.outerHeight + 30}px`;
  win.activate();
  state.setActiveView({ kind: 'designer', formId: form.id });
  state.setSelection({ formId: form.id, ids: [] });
  return win;
}
