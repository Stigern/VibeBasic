// IDE shell: builds the main window and wires menus, toolbar, Toolbox and the first designer window.
import type { Backend } from '../backend/backend';
import { newProject } from '../model/controls';
import { bindShortcuts, createMenubar } from '../ui98/menubar';
import { createToolbar } from '../ui98/toolbar';
import { buildToolbarItems, createReadouts } from './toolbarItems';
import { showAbout } from './aboutDialog';
import { IdeState, OPTION_EXPLICIT, type IdeOptions } from './ideState';
import { buildLayout, type IdeLayout } from './layout';
import { buildMenus, type IdeActions } from './menus';
import { askAi } from '../ai/askDialog';
import { getCodeWindow, openCodeWindow, registerCodeActions } from './codeWindow';
import { openDesigner, registerDesignerActions } from './designer';
import { createPropertiesWindow, type PropertiesWindow } from './properties';
import { attachToolboxWindow, createToolbox, type ToolboxLayout } from './toolbox';
import { createProjectExplorer, registerProjectActions, type ProjectExplorer } from './projectExplorer';
import { showProjectProperties } from './projectDialogs';
import { showOptions } from './optionsDialog';
import { makeAppFlow } from '../build/makeApp';
import { FileController } from './fileController';
import { RunController } from './runController';
import { createImmediateWindow } from './immediate';
import { InlineFormHost } from '../run/inlineFormHost';
import { TauriFormHost } from '../run/tauriFormHost';
import type { FormHost } from '../run/formHost';
import { h } from '../ui98/dom';

export interface Ide { state: IdeState; layout: IdeLayout; actions: IdeActions; menus: ReturnType<typeof buildMenus>; run: RunController; refresh(): void }

export function startIde(backend: Backend, root: HTMLElement = document.getElementById('app') ?? document.body): Ide {
  const state = new IdeState(newProject());
  const layout = buildLayout(root);
  const doc = root.ownerDocument;

  const run: { rc?: RunController } = {};
  const immediate = createImmediateWindow(layout.immediateHost, () => run.rc?.session ?? null, () => state.project);
  let propsWin: PropertiesWindow | undefined;
  let explorer: ProjectExplorer | undefined;
  const actions: IdeActions = {
    undo: () => { if (state.mode === 'design') state.stack.undo(); },
    redo: () => { if (state.mode === 'design') state.stack.redo(); },
    viewImmediate: () => { immediate.show(); immediate.focus(); },
    viewProjectExplorer: () => { layout.setPaneVisible('project', true); explorer?.focus(); },
    viewProperties: () => { layout.setPaneVisible('properties', true); propsWin?.focus(); },
    viewToolbox: () => layout.setPaneVisible('toolbox', true),
    about: () => { void showAbout(doc); },
  };
  const menus = buildMenus(actions, state);
  let refresh = () => {};
  registerDesignerActions(state, actions, () => refresh());
  registerCodeActions(state, actions, { mdiHost: layout.mdiHost, actions });
  const env = { mdiHost: layout.mdiHost, actions };
  registerProjectActions(state, actions, env);
  actions.projectProperties = () => { if (state.mode === 'design') void showProjectProperties(state, doc); };
  actions.options = () => { void showOptions(state, backend, doc); };
  actions.askAi = () => { void askAi(state, backend, { codeWindowFor: id => getCodeWindow(state, id) }, doc); };
  const fc = new FileController(state, backend, doc);
  fc.onProjectReplaced = () => {
    const id = state.project.forms.find(f => f.name === state.project.startupForm)?.id ?? state.project.forms[0]?.id;
    if (id) openDesigner(state, id, env);
  };
  actions.newProject = () => { if (state.mode === 'design') void fc.newProject(); };
  actions.openProject = () => { if (state.mode === 'design') void fc.open(); };
  actions.saveProject = () => { void fc.save(); };
  actions.saveProjectAs = () => { void fc.saveAs(); };
  actions.makeApp = () => { if (state.mode === 'design') void makeAppFlow(state, backend); };
  actions.exit = () => { void fc.exit(); };
  backend.onCloseRequested(() => fc.confirmDiscard());
  // Form windows: real Tauri windows in the app, a floating layer over the MDI area in the browser
  const hostFactory = (): FormHost => {
    if (backend.kind === 'tauri') return new TauriFormHost();
    const layer = h('div', { class: 'ide98-runlayer' });
    layout.mdiHost.appendChild(layer);
    const host = new InlineFormHost(layer);
    return Object.assign(host, { dispose: () => { InlineFormHost.prototype.dispose.call(host); layer.remove(); } });
  };
  const rc = new RunController(state, hostFactory, id => openCodeWindow(state, id, env), {
    immediate, doc, readFile: p => backend.readBinaryFile(p),
  });
  run.rc = rc;
  actions.start = () => { void rc.start(false); };
  actions.startFullCompile = () => { void rc.start(true); };
  actions.break = () => rc.breakNow();
  actions.end = () => rc.end();
  actions.restart = () => { void rc.restart(); };
  actions.stepInto = () => rc.step('into');
  actions.stepOver = () => rc.step('over');
  actions.stepOut = () => rc.step('out');
  actions.runToCursor = () => {
    const v = state.activeView;
    const w = v.kind === 'code' ? getCodeWindow(state, v.itemId) : null;
    const item = v.kind === 'code' ? [...state.project.forms, ...state.project.modules].find(x => x.id === v.itemId) : undefined;
    if (w && item) rc.runToCursor(item.name, w.getCursorLine());
  };
  const menubar = createMenubar(layout.menubarHost, menus);

  const toolbar = createToolbar(layout.toolbarHost, buildToolbarItems(actions, state));
  const readouts = createReadouts(layout.toolbarHost, state);
  createToolbox(layout.toolboxHost, state);
  const tbxPane = layout.panes.toolbox.el;
  const toolboxWin = attachToolboxWindow({
    pane: tbxPane, bar: tbxPane.querySelector(':scope > .title-bar')!, grid: layout.toolboxHost.querySelector('.tbx98-grid')!,
    area: layout.mainArea, save: l => { void backend.saveSettings('toolbox', l).catch(() => {}); },
  });
  void backend.loadSettings<Partial<ToolboxLayout>>('toolbox').then(l => { if (l && typeof l === 'object') toolboxWin.setLayout(l); }).catch(() => {});
  explorer = createProjectExplorer(layout.projectHost, state, env);
  propsWin = createPropertiesWindow(layout.propertiesHost, state, { backend });
  bindShortcuts(menus, window);

  refresh = () => { menubar.refresh(); toolbar.refresh(); readouts.refresh(); };
  const updateTitle = () => fc.updateTitle();
  state.on('project', () => { refresh(); updateTitle(); });
  state.on('mode', () => { refresh(); updateTitle(); });
  state.on('selection', () => refresh());
  state.on('activeView', () => refresh());
  state.on('codeSelection', () => refresh());
  state.on('breakpoints', () => refresh());   // only fires when selected / not selected flips, so no throttle is needed
  updateTitle();
  // Saved IDE options (async; the defaults apply until they arrive)
  void backend.loadSettings<Partial<IdeOptions>>('ide').then(o => {
    if (!o) return;
    state.setOptions(o);
    const f = state.project.forms[0];   // the untouched startup project follows the saved option too
    if (o.requireVariableDeclaration && f && f.code === '' && !state.stack.isDirty) f.code = OPTION_EXPLICIT;
  }).catch(() => {});

  openDesigner(state, state.project.forms[0].id, { mdiHost: layout.mdiHost, actions });
  return { state, layout, actions, menus, run: rc, refresh };
}
