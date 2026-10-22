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
  'addForm', 'addModule', 'removeItem', 'projectProperties',
  'alignLefts', 'alignCenters', 'alignRights', 'alignTops', 'alignMiddles', 'alignBottoms',
  'sameWidth', 'sameHeight', 'sameBoth', 'bringToFront', 'sendToBack', 'lockControls',
  'stepInto', 'toggleBreakpoint',
  'start', 'startFullCompile', 'break', 'end', 'restart',
  'askAi', 'options', 'about',
] as const;
export type IdeActionName = (typeof ACTION_NAMES)[number];

export function buildMenus(ide: IdeActions, state?: IdeState): MenuDef[] {
  const projectName = () => state?.project.name ?? 'Project1';
  const activeItemName = (): string => {
    const v = state?.activeView;
    if (state && v?.kind === 'designer') return state.project.forms.find(f => f.id === v.formId)?.name ?? 'Form1';
    if (state && v?.kind === 'code') {
      const m = state.project.modules.find(x => x.id === v.itemId) ?? state.project.forms.find(x => x.id === v.itemId);
      if (m) return m.name;
    }
    return state?.project.forms[0]?.name ?? 'Form1';
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

  return [
    { label: 'File', items: [
      mk('New Project', 'newProject', 'Ctrl+N'),
      mk('Open Project...', 'openProject', 'Ctrl+O'),
      sep(),
      mk('Save Project', 'saveProject', 'Ctrl+S'),
      mk('Save Project As...', 'saveProjectAs'),
      sep(),
      mk(() => `Make ${projectName()}.app...`, 'makeApp'),
      sep(),
      mk('Exit', 'exit'),
    ] },
    { label: 'Edit', items: [
      mk('Undo', 'undo', 'Ctrl+Z', () => state?.activeView.kind === 'code' || (state?.stack.canUndo ?? true)),
      mk('Redo', 'redo', 'Ctrl+Y', () => state?.activeView.kind === 'code' || (state?.stack.canRedo ?? true)),
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
      mk('Add Form', 'addForm'),
      mk('Add Module', 'addModule'),
      sep(),
      mk(() => `Remove ${activeItemName()}`, 'removeItem'),
      sep(),
      mk(() => `${projectName()} Properties...`, 'projectProperties'),
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
      mk('Start', 'start', 'F5'),
      mk('Start With Full Compile', 'startFullCompile', 'Ctrl+F5'),
      mk('Break', 'break', 'Ctrl+Break'),
      mk('End', 'end'),
      mk('Restart', 'restart', 'Shift+F5'),
    ] },
    { label: 'Tools', items: [
      mk('Ask AI...', 'askAi', 'Ctrl+I'),
      sep(),
      mk('Options...', 'options'),
    ] },
    { label: 'Help', items: [mk('About VibeBasic...', 'about')] },
  ];
}
