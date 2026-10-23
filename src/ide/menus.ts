// The nine VB6 menus. Items call named IdeActions; an item without a registered action is disabled, so later
// tasks only have to add `ide.actions.<name> = ...` for their feature to light up its menu item.
import type { MenuDef, MenuItem } from '../ui98/menubar';
import { clipboardHasControls } from './clipboard';
import type { IdeState } from './ideState';

export type IdeAction = (...args: any[]) => void;
export interface IdeActions { [name: string]: IdeAction }

/** Every action name the shell knows. Later tasks register handlers under these names. */
export const ACTION_NAMES = [
  'newProject', 'openProject', 'saveProject', 'saveProjectAs', 'makeApp', 'exit',
  'undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll', 'find',
  'toggleOutlining', 'toggleAllOutlining', 'collapseToDefinitions',
  'viewCode', 'viewObject', 'viewImmediate', 'viewLocals', 'viewWatch', 'viewCallStack', 'viewProjectExplorer', 'viewProperties', 'viewToolbox',
  'addForm', 'addMdiForm', 'addModule', 'addClassModule', 'addFile', 'removeItem', 'components', 'projectProperties',
  'alignLefts', 'alignCenters', 'alignRights', 'alignTops', 'alignMiddles', 'alignBottoms',
  'sameWidth', 'sameHeight', 'sameBoth', 'bringToFront', 'sendToBack', 'lockControls',
  'stepInto', 'stepOver', 'stepOut', 'runToCursor', 'toggleBreakpoint', 'clearAllBreakpoints',
  'addWatch', 'editWatch', 'quickWatch', 'setNextStatement', 'showNextStatement',
  'start', 'startFullCompile', 'break', 'end', 'restart',
  'askAi', 'askAiAboutError', 'aiLog', 'menuEditor', 'options', 'about',
] as const;
export type IdeActionName = (typeof ACTION_NAMES)[number];

export type EditCommand = 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll';

/**
 * Enabled state of the Edit commands (menu and toolbar). Cut / Copy / Delete need a selection (selected controls in the
 * designer, selected text in code); Paste needs controls on the designer clipboard, or is always on in code (the system
 * clipboard cannot be read cheaply). Without an IdeState everything is enabled.
 */
export function editEnabled(state: IdeState | undefined, cmd: EditCommand): boolean {
  if (!state) return true;
  const v = state.activeView;
  const editable = state.mode === 'design';
  if (v.kind === 'code') {
    switch (cmd) {
      case 'copy': return state.codeHasSelection;
      case 'cut': case 'delete': return editable && state.codeHasSelection;
      case 'paste': return editable;
      case 'selectAll': return true;
    }
  }
  if (v.kind === 'designer' && editable) {
    switch (cmd) {
      case 'cut': case 'copy': case 'delete': return state.selection?.formId === v.formId && state.selection.ids.length > 0;
      case 'paste': return clipboardHasControls();
      case 'selectAll': return true;
    }
  }
  return false;
}

/** `breakOnError`: the program is stopped on an unhandled error (enables Tools > Ask AI about this error). */
export function buildMenus(ide: IdeActions, state?: IdeState, o: { breakOnError?: () => boolean } = {}): MenuDef[] {
  const projectName = () => state?.project.name ?? 'Project1';
  const activeItemName = (): string => {
    const id = state?.currentItemId();
    const item = state && id ? [...state.project.forms, ...state.project.modules].find(x => x.id === id) : undefined;
    return item?.name ?? 'Form1';
  };
  const mk = (label: string | (() => string), name: IdeActionName, shortcut?: string, pred?: () => boolean, extra: Partial<MenuItem> = {}): MenuItem => ({
    get label() { return typeof label === 'function' ? label() : label; },
    shortcut,
    action: () => ide[name]?.(),
    enabled: () => !!ide[name] && (pred ? pred() : true),
    ...extra,
  });
  const sep = (): MenuItem => ({ label: '-', separator: true });
  const sub = (label: string, items: MenuItem[]): MenuItem => ({ label, submenu: items });
  const design = () => (state?.mode ?? 'design') === 'design';
  const idle = () => !state?.busy;
  const inCode = () => !state || state.activeView.kind === 'code';
  // Format: design mode with a designer active; Align and Make Same Size need 2 selected controls, Order 1 (VB6 greys them out)
  const inDesigner = () => !state || (design() && state.activeView.kind === 'designer');
  const selected = (min: number) => () => {
    if (!state) return true;
    const v = state.activeView;
    if (!inDesigner() || v.kind !== 'designer' || state.selection?.formId !== v.formId) return false;
    const form = state.project.forms.find(f => f.id === v.formId);
    return state.selection.ids.filter(i => form?.controls.some(c => c.id === i)).length >= min;
  };
  // stepping starts the program in design mode and goes on in break mode; never while it runs
  const canStep = () => idle() && (state?.mode ?? 'design') !== 'run';
  const inBreak = () => !state || state.mode === 'break';

  return [
    { label: 'File', items: [
      mk('New Project', 'newProject', 'Ctrl+N', design),
      mk('Open Project...', 'openProject', 'Ctrl+O', design),
      sep(),
      mk('Save Project', 'saveProject', 'Ctrl+S'),
      mk('Save Project As...', 'saveProjectAs'),
      sep(),
      mk(() => `Make ${projectName()}.app...`, 'makeApp', undefined, () => design() && idle()),
      sep(),
      mk('Exit', 'exit'),
    ] },
    { label: 'Edit', items: [
      mk('Undo', 'undo', 'Ctrl+Z', () => design() && (state?.activeView.kind === 'code' || (state?.stack.canUndo ?? true))),
      mk('Redo', 'redo', 'Ctrl+Y', () => design() && (state?.activeView.kind === 'code' || (state?.stack.canRedo ?? true))),
      sep(),
      mk('Cut', 'cut', 'Ctrl+X', () => editEnabled(state, 'cut')),
      mk('Copy', 'copy', 'Ctrl+C', () => editEnabled(state, 'copy')),
      mk('Paste', 'paste', 'Ctrl+V', () => editEnabled(state, 'paste')),
      mk('Delete', 'delete', 'Del', () => editEnabled(state, 'delete')),
      sep(),
      mk('Select All', 'selectAll', 'Ctrl+A', () => editEnabled(state, 'selectAll')),
      sep(),
      mk('Find...', 'find', 'Ctrl+F', inCode),
      sep(),
      // two-key chords (Visual Studio): the code editor's keymap handles them, bindShortcuts skips them
      sub('Outlining', [
        mk('Toggle Outlining Expansion', 'toggleOutlining', 'Ctrl+M, Ctrl+M', inCode),
        mk('Toggle All Outlining', 'toggleAllOutlining', 'Ctrl+M, Ctrl+L', inCode),
        mk('Collapse to Definitions', 'collapseToDefinitions', 'Ctrl+M, Ctrl+O', inCode),
      ]),
    ] },
    { label: 'View', items: [
      mk('Code', 'viewCode', 'F7'),
      mk('Object', 'viewObject', 'Shift+F7'),
      sep(),
      mk('Immediate Window', 'viewImmediate', 'Ctrl+G'),
      mk('Locals Window', 'viewLocals'),
      mk('Watch Window', 'viewWatch'),
      mk('Call Stack...', 'viewCallStack', 'Ctrl+L', inBreak),
      mk('Project Explorer', 'viewProjectExplorer', 'Ctrl+R'),
      mk('Properties Window', 'viewProperties', 'F4'),
      mk('Toolbox', 'viewToolbox'),
    ] },
    { label: 'Project', items: [
      mk('Add Form', 'addForm', undefined, design),
      mk('Add MDI Form', 'addMdiForm', undefined, () => design() && !state?.project.forms.some(f => f.mdi)),   // one per project (VB6)
      mk('Add Module', 'addModule', undefined, design),
      mk('Add Class Module', 'addClassModule', undefined, design),
      mk('Add File...', 'addFile', 'Ctrl+D', design),
      sep(),
      mk(() => `Remove ${activeItemName()}`, 'removeItem', undefined, design),
      sep(),
      mk('Components...', 'components', 'Ctrl+T', design),
      sep(),
      mk(() => `${projectName()} Properties...`, 'projectProperties', undefined, design),
    ] },
    { label: 'Format', items: [
      sub('Align', [
        mk('Lefts', 'alignLefts', undefined, selected(2)), mk('Centers', 'alignCenters', undefined, selected(2)),
        mk('Rights', 'alignRights', undefined, selected(2)), mk('Tops', 'alignTops', undefined, selected(2)),
        mk('Middles', 'alignMiddles', undefined, selected(2)), mk('Bottoms', 'alignBottoms', undefined, selected(2)),
      ]),
      sub('Make Same Size', [
        mk('Width', 'sameWidth', undefined, selected(2)), mk('Height', 'sameHeight', undefined, selected(2)), mk('Both', 'sameBoth', undefined, selected(2)),
      ]),
      sub('Order', [mk('Bring to Front', 'bringToFront', 'Ctrl+J', selected(1)), mk('Send to Back', 'sendToBack', 'Ctrl+K', selected(1))]),
      sep(),
      mk('Lock Controls', 'lockControls', undefined, inDesigner, { checked: () => state?.controlsLocked ?? false }),
    ] },
    { label: 'Debug', items: [
      mk('Step Into', 'stepInto', 'F8', canStep),
      mk('Step Over', 'stepOver', 'Shift+F8', canStep),
      mk('Step Out', 'stepOut', 'Ctrl+Shift+F8', () => state?.mode === 'break'),
      mk('Run To Cursor', 'runToCursor', 'Ctrl+F8', () => canStep() && inCode()),
      sep(),
      mk('Add Watch...', 'addWatch'),
      mk('Edit Watch...', 'editWatch', 'Ctrl+W', () => !state || (state.project.watches?.length ?? 0) > 0),
      mk('Quick Watch...', 'quickWatch', 'Shift+F9', () => inBreak() && inCode()),
      sep(),
      mk('Toggle Breakpoint', 'toggleBreakpoint', 'F9', inCode),
      mk('Clear All Breakpoints', 'clearAllBreakpoints', 'Ctrl+Shift+F9', () => state?.hasBreakpoints ?? true),
      sep(),
      mk('Set Next Statement', 'setNextStatement', 'Ctrl+F9', () => inBreak() && inCode()),
      mk('Show Next Statement', 'showNextStatement', undefined, inBreak),
    ] },
    { label: 'Run', items: [
      mk(() => (state?.mode === 'break' ? 'Continue' : 'Start'), 'start', 'F5', () => idle() && (state?.mode ?? 'design') !== 'run'),
      mk('Start With Full Compile', 'startFullCompile', 'Ctrl+F5', () => idle() && (state?.mode ?? 'design') === 'design'),
      mk('Break', 'break', 'Ctrl+Break', () => state?.mode === 'run'),
      mk('End', 'end', undefined, () => (state?.mode ?? 'design') !== 'design'),
      mk('Restart', 'restart', 'Shift+F5', () => idle() && (state?.mode ?? 'design') !== 'design'),
    ] },
    { label: 'Tools', items: [
      mk('Ask AI...', 'askAi', 'Ctrl+I', design),
      mk('Ask AI about this error', 'askAiAboutError', undefined, () => state?.mode === 'break' && !!o.breakOnError?.()),
      mk('AI Log...', 'aiLog'),
      sep(),
      mk('Menu Editor...', 'menuEditor', 'Ctrl+E', inDesigner),
      sep(),
      mk('Options...', 'options'),
    ] },
    { label: 'Help', items: [mk('About VibeBasic...', 'about')] },
  ];
}
