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
import { askAi, askAiAboutError } from '../ai/askDialog';
import { wizardDialog } from '../ai/wizardDialog';
import { showAiLog } from '../ai/aiLog';
import { getCodeWindow, openCodeWindow, registerCodeActions, type CodeEnv } from './codeWindow';
import { openDesigner, registerDesignerActions } from './designer';
import { createPropertiesWindow, type PropertiesWindow } from './properties';
import { attachToolboxWindow, createToolbox, type ToolboxLayout } from './toolbox';
import { createProjectExplorer, registerProjectActions, type ProjectExplorer } from './projectExplorer';
import { showComponents, showProjectProperties } from './projectDialogs';
import { showOptions } from './optionsDialog';
import { showMenuEditor } from './menuEditor';
import { makeAppFlow } from '../build/makeApp';
import { FileController } from './fileController';
import { showNewProjectDialog } from './newProjectDialog';
import { projectLabel, RecentProjects } from './recentProjects';
import type { MenuItem } from '../ui98/menubar';

/** The recent projects at the end of the File menu (VB6 showed four). */
const MENU_RECENT = 4;
import { RunController, type ErrorToFix } from './runController';
import { createImmediateWindow } from './immediate';
import { registerDebugActions, type CodeTarget } from './debugWindows';
import { InlineFormHost } from '../run/inlineFormHost';
import { TauriFormHost } from '../run/tauriFormHost';
import type { FormHost } from '../run/formHost';
import { h } from '../ui98/dom';

export interface Ide { state: IdeState; layout: IdeLayout; actions: IdeActions; menus: ReturnType<typeof buildMenus>; run: RunController; refresh(): void }

/** `prompt`: the New Project dialog at start (when Options > General, Prompt for project is on); the app's own start asks for it. */
export function startIde(backend: Backend, root: HTMLElement = document.getElementById('app') ?? document.body, o: { prompt?: boolean } = {}): Ide {
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
  const menus = buildMenus(actions, state, { breakOnError: () => !!run.rc?.breakError });
  let refresh = () => {};
  registerDesignerActions(state, actions, () => refresh());
  // one CodeEnv for every code window (the data tips are wired below, once the run controller exists)
  const env: CodeEnv = { mdiHost: layout.mdiHost, actions };
  registerCodeActions(state, actions, env);
  registerProjectActions(state, actions, env);
  actions.projectProperties = () => { if (state.mode === 'design') void showProjectProperties(state, doc); };
  actions.components = () => { if (state.mode === 'design') void showComponents(state, doc); };
  actions.options = () => { void showOptions(state, backend, doc); };
  actions.menuEditor = () => {
    const v = state.activeView;
    if (state.mode === 'design' && v.kind === 'designer' && committed()) void showMenuEditor(state, v.formId, doc);
  };
  actions.askAi = () => { void askAi(state, backend, { codeWindowFor: id => getCodeWindow(state, id) }, doc); };
  // the AI Wizard of the New Project dialog: Ask AI on the new Form1 with the wizard's own dialog (description and improvements)
  const runWizard = () => { void askAi(state, backend, { codeWindowFor: id => getCodeWindow(state, id) }, doc, { prompt: () => wizardDialog(doc, { copy: t => backend.clipboardSetText(t) }) }); };
  actions.aiLog = () => { void showAiLog(doc, text => backend.clipboardSetText(text)); };
  const recent = new RecentProjects(backend);
  const fc = new FileController(state, backend, doc, recent);
  fc.onProjectReplaced = () => {
    const id = state.project.forms.find(f => f.name === state.project.startupForm)?.id ?? state.project.forms[0]?.id;
    if (id) openDesigner(state, id, env);
  };
  fc.onItemAdded = id => {
    if (state.project.forms.some(f => f.id === id)) openDesigner(state, id, env); else openCodeWindow(state, id, env);
  };
  // a value typed in the Properties window but not yet entered goes into the project first (false: it was invalid). New, Open,
  // Exit and closing the window do so too, so "Save changes?" asks about it instead of the value being lost.
  const committed = (): boolean => propsWin?.commitPendingEdit() ?? true;
  actions.aiWizard = async () => {
    if (state.mode !== 'design' || state.busy || !committed()) return;
    if (await fc.newProject('aiWizard')) runWizard();
  };
  /** The New Project dialog: a new project of a type (the AI Wizard then asks the AI), or (at start) an existing or recent one. */
  const chooseProject = async (startup: boolean): Promise<void> => {
    if (startup) await recent.ready();
    const r = await showNewProjectDialog(doc, { startup, recent: recent.list });
    if (r.dontShow && state.options.promptForProject) {
      state.setOptions({ promptForProject: false });
      void backend.saveSettings('ide', state.options).catch(() => {});
    }
    const c = r.choice;
    if (!c) return;
    if (c.kind === 'new') { if ((await fc.newProject(c.template)) && c.template === 'aiWizard') runWizard(); }
    else await fc.open(c.kind === 'recent' ? c.path : undefined);
  };
  actions.newProject = () => { if (state.mode === 'design' && committed()) void chooseProject(false); };
  actions.openProject = () => { if (state.mode === 'design' && committed()) void fc.open(); };
  actions.openRecent = (path: string) => { if (state.mode === 'design' && committed()) void fc.open(path); };
  // the File menu ends with the recent projects before Exit (built each time it opens, as the list changes)
  const fileItems = menus[0].items;
  Object.defineProperty(menus[0], 'items', {
    get: (): MenuItem[] => {
      const r = recent.list.slice(0, MENU_RECENT).map((p, i): MenuItem => ({
        label: `&${i + 1} ${projectLabel(p)}`, action: () => actions.openRecent?.(p), enabled: () => state.mode === 'design',
      }));
      return r.length ? [...fileItems.slice(0, -1), ...r, { label: '-', separator: true }, ...fileItems.slice(-1)] : fileItems;
    },
  });
  actions.addFile = () => { if (state.mode === 'design' && committed()) void fc.addFile(); };
  actions.saveProject = () => { if (committed()) void fc.save(); };
  actions.saveProjectAs = () => { if (committed()) void fc.saveAs(); };
  actions.makeApp = () => { if (state.mode === 'design' && committed()) void makeAppFlow(state, backend); };
  actions.exit = () => { if (committed()) void fc.exit(); };
  backend.onCloseRequested(async () => committed() && fc.confirmDiscard());
  // Form windows: real Tauri windows in the app, a floating layer over the MDI area in the browser
  const hostFactory = (): FormHost => {
    if (backend.kind === 'tauri') return new TauriFormHost();
    const layer = h('div', { class: 'ide98-runlayer' });
    layout.mdiHost.appendChild(layer);
    const host = new InlineFormHost(layer);
    return Object.assign(host, { dispose: () => { InlineFormHost.prototype.dispose.call(host); layer.remove(); } });
  };
  const askAboutError = (fix: ErrorToFix) => {
    void askAiAboutError(state, backend, fix, { openCode: id => openCodeWindow(state, id, env), end: () => rc.endAndWait() }, doc);
  };
  const rc = new RunController(state, hostFactory, id => openCodeWindow(state, id, env), {
    immediate, doc, readFile: p => backend.readBinaryFile(p), onAskAi: askAboutError,
  });
  run.rc = rc;
  actions.askAiAboutError = () => { const fix = rc.errorToFix(); if (fix) askAboutError(fix); };
  actions.start = () => { if (committed()) void rc.start(false); };
  actions.startFullCompile = () => { if (committed()) void rc.start(true); };
  actions.break = () => rc.breakNow();
  actions.end = () => rc.end();
  actions.restart = () => { void rc.restart(); };
  actions.stepInto = () => { if (committed()) rc.step('into'); };   // in design mode these start the program
  actions.stepOver = () => { if (committed()) rc.step('over'); };
  actions.stepOut = () => rc.step('out');
  actions.runToCursor = () => {
    const v = state.activeView;
    const w = v.kind === 'code' ? getCodeWindow(state, v.itemId) : null;
    const item = v.kind === 'code' ? [...state.project.forms, ...state.project.modules].find(x => x.id === v.itemId) : undefined;
    if (w && item) rc.runToCursor(item.name, w.getCursorLine());
  };
  const codeTarget = (): CodeTarget | null => {
    const v = state.activeView;
    const w = v.kind === 'code' ? getCodeWindow(state, v.itemId) : null;
    const item = v.kind === 'code' ? [...state.project.forms, ...state.project.modules].find(x => x.id === v.itemId) : undefined;
    return w && item ? { moduleName: item.name, line: w.getCursorLine(), selection: w.getSelection?.()?.text ?? null, exprAtCursor: w.exprAtCursor?.() ?? null } : null;
  };
  const debugWins = registerDebugActions(state, actions, {
    localsHost: layout.localsHost, watchHost: layout.watchHost, showPane: n => layout.setPaneVisible(n, true), run: rc, code: codeTarget, doc,
  });
  env.dataTip = debugWins.dataTip;
  const menubar = createMenubar(layout.menubarHost, menus);

  const toolbar = createToolbar(layout.toolbarHost, buildToolbarItems(actions, state));
  const readouts = createReadouts(layout.toolbarHost, state);
  createToolbox(layout.toolboxHost, state, () => actions.components?.());
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
  }).catch(() => {}).finally(() => {
    // the New Project dialog at start: once the saved options are known, and only while the startup project is untouched
    if (o.prompt && state.options.promptForProject && !state.stack.isDirty && state.mode === 'design') void chooseProject(true);
  });

  openDesigner(state, state.project.forms[0].id, { mdiHost: layout.mdiHost, actions });
  return { state, layout, actions, menus, run: rc, refresh };
}
