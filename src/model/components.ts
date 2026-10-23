// Project > Components: the ActiveX components (OCX files) a project can use. A control type names its component in the
// registry (ControlTypeDef.component); a component is listed only when at least one of its controls exists, so a later
// task only has to set `component` on its new control types. The Toolbox shows the intrinsic controls first, then the
// controls of the checked components (Project.components) in the order of COMPONENTS.
import type { Command } from './commands';
import { CONTROL_TYPES, TOOLBOX_ORDER } from './controls';
import type { ControlType, Project } from './types';

export interface ComponentDef { file: string; name: string; /** Folder shown on the "Location:" line. */ dir?: string }

const SYSTEM = 'C:\\WINDOWS\\SYSTEM';

/** Every known component, in Toolbox order. */
export const COMPONENTS: readonly ComponentDef[] = [
  { file: 'MSCOMCTL.OCX', name: 'Microsoft Windows Common Controls 6.0 (SP6)' },
  { file: 'MSCOMCT2.OCX', name: 'Microsoft Windows Common Controls-2 6.0' },
  { file: 'COMDLG32.OCX', name: 'Microsoft Common Dialog Control 6.0' },
  { file: 'RICHTX32.OCX', name: 'Microsoft Rich Textbox Control 6.0' },
  { file: 'MSFLXGRD.OCX', name: 'Microsoft FlexGrid Control 6.0' },
  { file: 'TABCTL32.OCX', name: 'Microsoft Tabbed Dialog Control 6.0' },
  { file: 'SHDOCVW.DLL', name: 'Microsoft Internet Controls' },
  { file: 'MSINET.OCX', name: 'Microsoft Internet Transfer Control 6.0' },
  { file: 'MSWINSCK.OCX', name: 'Microsoft Winsock Control 6.0' },
  { file: 'MSCHRT20.OCX', name: 'Microsoft Chart Control 6.0' },
  { file: 'MSMASK32.OCX', name: 'Microsoft Masked Edit Control 6.0' },
  { file: 'MCI32.OCX', name: 'Microsoft Multimedia Control 6.0' },
  { file: 'MSDXM.OCX', name: 'Windows Media Player' },
  { file: 'MSADODC.OCX', name: 'Microsoft ADO Data Control 6.0 (SP6) (OLEDB)' },
  { file: 'AGENTCTL.DLL', name: 'Microsoft Agent Control 2.0', dir: 'C:\\WINDOWS\\MSAGENT' },
];

/** The components whose controls existed before Project > Components: a project saved without `components` gets them all,
 *  so its Toolbox looks as it did. */
export const LEGACY_COMPONENTS: readonly string[] = ['MSCOMCTL.OCX', 'MSCOMCT2.OCX', 'COMDLG32.OCX', 'RICHTX32.OCX', 'MSFLXGRD.OCX'];

const same = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

export function componentDef(file: string): ComponentDef | undefined { return COMPONENTS.find(c => same(c.file, file)); }
export function componentLocation(c: ComponentDef): string { return `${c.dir ?? SYSTEM}\\${c.file}`; }

/** The component a control type belongs to, or null for an intrinsic control. */
export function componentOf(type: ControlType): string | null { return CONTROL_TYPES[type].component ?? null; }

/** The control types of a component, in Toolbox order. */
export function controlsOf(file: string): ControlType[] {
  return TOOLBOX_ORDER.filter((t): t is ControlType => t !== 'Pointer' && !!CONTROL_TYPES[t].component && same(CONTROL_TYPES[t].component!, file));
}

/** The components the Components dialog lists: those with at least one existing control type. */
export function availableComponents(): ComponentDef[] { return COMPONENTS.filter(c => controlsOf(c.file).length > 0); }

/** The Toolbox: Pointer and the intrinsic controls, then the controls of each checked component in component order. */
export function toolboxTools(components: readonly string[]): (ControlType | 'Pointer')[] {
  const out = TOOLBOX_ORDER.filter(t => t === 'Pointer' || !CONTROL_TYPES[t].component);
  for (const c of COMPONENTS) if (components.some(x => same(x, c.file))) out.push(...controlsOf(c.file));
  return out;
}

/** The components used by a control on any form. */
export function usedComponents(p: Pick<Project, 'forms'>): string[] {
  const used = new Set<string>();
  for (const f of p.forms) for (const c of f.controls) { const k = componentOf(c.type); if (k) used.add(k); }
  return COMPONENTS.map(c => c.file).filter(f => used.has(f));
}

export function componentInUse(p: Pick<Project, 'forms'>, file: string): boolean {
  return usedComponents(p).some(f => same(f, file));
}

/** `list` plus `extra`, without duplicates: known components in COMPONENTS order (canonical spelling), unknown ones kept at the end. */
export function normalizeComponents(list: readonly string[], extra: readonly string[] = []): string[] {
  const all = [...list, ...extra];
  const known = COMPONENTS.filter(c => all.some(x => same(x, c.file))).map(c => c.file);
  const unknown: string[] = [];
  for (const x of all) if (!componentDef(x) && !unknown.some(u => same(u, x))) unknown.push(x);
  return [...known, ...unknown];
}

/** The components of a project read from a file: `raw` (missing in old projects: LEGACY_COMPONENTS) plus every used component. */
export function loadedComponents(raw: unknown, p: Pick<Project, 'forms'>): string[] {
  const list = Array.isArray(raw) && raw.every(x => typeof x === 'string') ? raw as string[] : LEGACY_COMPONENTS;
  return normalizeComponents(list, usedComponents(p));
}

/** The components `p` needs added for controls of `types` (none when they are all checked already). */
export function missingComponents(p: Pick<Project, 'components'>, types: readonly ControlType[]): string[] {
  const out: string[] = [];
  for (const t of types) {
    const k = componentOf(t);
    if (k && !p.components.some(x => same(x, k)) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Replaces the checked components (Project > Components; the AI adds the component of a control it adds). */
export function setComponentsCmd(components: readonly string[]): Command {
  const next = [...components];
  let old: string[] = [];
  return {
    label: 'Components',
    do(p) { old = [...(p.components ?? [])]; p.components = [...next]; },
    undo(p) { p.components = [...old]; },
  };
}

/** A command that checks the components controls of `types` need, or null when nothing is missing. */
export function addComponentsCmd(p: Pick<Project, 'components'>, types: readonly ControlType[]): Command | null {
  const missing = missingComponents(p, types);
  return missing.length ? setComponentsCmd(normalizeComponents(p.components, missing)) : null;
}
