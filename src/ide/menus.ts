// The nine VB6 menus. Items call named IdeActions; an item without a registered action is disabled, so later
// tasks only have to add `ide.actions.<name> = ...` for their feature to light up its menu item.
import type { MenuDef, MenuItem } from '../ui98/menubar';
import type { IdeState } from './ideState';

export type IdeAction = (...args: any[]) => void;
export interface IdeActions { [name: string]: IdeAction }

/** Every action name the shell knows. Later tasks register handlers under these names. */
export const ACTION_NAMES = [
  'newProject', 'openProject', 'saveProject', 'saveProjectAs', 'makeApp', 'exit',
  'undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll', 'find',
  'viewCode', 'viewObject', 'viewImmediate', 'viewProjectExplorer', 'viewProperties', 'viewToolbox',
  'addForm', 'addModule', 'removeItem', 'components', 'projectProperties',
  'alignLefts', 'alignCenters', 'alignRights', 'alignTops', 'alignMiddles', 'alignBottoms',
  'sameWidth', 'sameHeight', 'sameBoth', 'bringToFront', 'sendToBack', 'lockControls',
  'stepInto', 'toggleBreakpoint',
  'start', 'startFullCompile', 'break', 'end', 'restart',
  'askAi', 'askAiAboutError', 'options', 'about',
] as const;
export type IdeActionName = (typeof ACTION_NAMES)[number];

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
  const never = () => false;
  const design = () => (state?.mode ?? 'design') === 'design';
  const idle = () => !state?.busy;

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
      mk('Cut', 'cut', 'Ctrl+X'),
      mk('Copy', 'copy', 'Ctrl+C'),
      mk('Paste', 'paste', 'Ctrl+V'),
      mk('Delete', 'delete', 'Del'),
      sep(),
      mk('Select All', 'selectAll', 'Ctrl+A'),
      sep(),
      mk('Find...', 'find', 'Ctrl+F'),
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
      mk('Components...', 'components', 'Ctrl+T', design),
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
      mk('Step Into', 'stepInto', 'F8', never),
      mk('Toggle Breakpoint', 'toggleBreakpoint', 'F9', never),
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
      sep(),
      mk('Options...', 'options'),
    ] },
    { label: 'Help', items: [mk('About VibeBasic...', 'about')] },
  ];
}
