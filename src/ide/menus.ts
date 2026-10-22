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
  'viewCode', 'viewObject', 'viewImmediate', 'viewProjectExplorer', 'viewProperties', 'viewToolbox',
  'addForm', 'addModule', 'removeItem', 'projectProperties',
  'alignLefts', 'alignCenters', 'alignRights', 'alignTops', 'alignMiddles', 'alignBottoms',
  'sameWidth', 'sameHeight', 'sameBoth', 'bringToFront', 'sendToBack', 'lockControls',
  'stepInto', 'stepOver', 'stepOut', 'runToCursor', 'toggleBreakpoint', 'clearAllBreakpoints',
  'start', 'startFullCompile', 'break', 'end', 'restart',
  'askAi', 'options', 'about',
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

export function buildMenus(ide: IdeActions, state?: IdeState): MenuDef[] {
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
  // stepping starts the program in design mode and goes on in break mode; never while it runs
  const canStep = () => idle() && (state?.mode ?? 'design') !== 'run';

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
    ] },
    { label: 'View', items: [
      mk('Code', 'viewCode', 'F7'),
      mk('Object', 'viewObject', 'Shift+F7'),
      sep(),
      mk('Immediate Window', 'viewImmediate', 'Ctrl+G'),
      mk('Project Explorer', 'viewProjectExplorer', 'Ctrl+R'),
      mk('Properties Window', 'viewProperties', 'F4'),
      mk('Toolbox', 'viewToolbox'),
    ] },
    { label: 'Project', items: [
      mk('Add Form', 'addForm', undefined, design),
      mk('Add Module', 'addModule', undefined, design),
      sep(),
      mk(() => `Remove ${activeItemName()}`, 'removeItem', undefined, design),
      sep(),
      mk(() => `${projectName()} Properties...`, 'projectProperties', undefined, design),
    ] },
    { label: 'Format', items: [
      sub('Align', [
        mk('Lefts', 'alignLefts'), mk('Centers', 'alignCenters'), mk('Rights', 'alignRights'),
        mk('Tops', 'alignTops'), mk('Middles', 'alignMiddles'), mk('Bottoms', 'alignBottoms'),
      ]),
      sub('Make Same Size', [mk('Width', 'sameWidth'), mk('Height', 'sameHeight'), mk('Both', 'sameBoth')]),
      sub('Order', [mk('Bring to Front', 'bringToFront', 'Ctrl+J'), mk('Send to Back', 'sendToBack', 'Ctrl+K')]),
      sep(),
      mk('Lock Controls', 'lockControls', undefined, undefined, { checked: () => state?.controlsLocked ?? false }),
    ] },
    { label: 'Debug', items: [
      mk('Step Into', 'stepInto', 'F8', canStep),
      mk('Step Over', 'stepOver', 'Shift+F8', canStep),
      mk('Step Out', 'stepOut', 'Ctrl+Shift+F8', () => state?.mode === 'break'),
      mk('Run To Cursor', 'runToCursor', 'Ctrl+F8', () => canStep() && inCode()),
      sep(),
      mk('Toggle Breakpoint', 'toggleBreakpoint', 'F9', inCode),
      mk('Clear All Breakpoints', 'clearAllBreakpoints', 'Ctrl+Shift+F9', () => state?.hasBreakpoints ?? true),
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
      sep(),
      mk('Options...', 'options'),
    ] },
    { label: 'Help', items: [mk('About VibeBasic...', 'about')] },
  ];
}
