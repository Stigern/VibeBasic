// Project Properties and Project > Components dialogs, and the shared tabbed-dialog runner (also used by Options).
import { getBackend } from '../backend/backend';
import { assetUsedElsewhere } from '../model/assetRefs';
import { addAssetCmd, compositeCmd, removeAssetCmd, setProjectFieldCmd, setProjectIconCmd, setProjectOptionsCmd, type Command, type ProjectOptions } from '../model/commands';
import { availableComponents, componentDef, componentInUse, componentLocation, normalizeComponents, setComponentsCmd } from '../model/components';
import { newId } from '../model/controls';
import { DEFAULT_VERSION, sameVersion, type Asset, type Project, type VersionInfo } from '../model/types';
import { parseCondConsts } from '../lang/condComp';
import { bytesToBase64 } from './propertyEditors';
import { validateName } from '../model/controls';
import { createCombo } from '../ui98/combo';
import { h } from '../ui98/dom';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { createTabs } from '../ui98/tabs';
import type { IdeState } from './ideState';

export interface DialogTab {
  label: string;
  content: HTMLElement;
  /** Returns an error message (shown in a MsgBox; the dialog stays open) or null when the tab is valid. */
  validate?(): string | null;
  /** Called on OK, after every tab validated. */
  apply?(): void;
  /** Project Properties only: undoable commands, executed together as one undo step. */
  commands?(): Command[];
}
export type DialogTabBuilder = (ide: IdeState, doc?: Document) => DialogTab;

/** Shows `tabs` with OK / Cancel. Resolves true when OK was pressed and all tabs were valid and applied. */
export async function runTabbedDialog(doc: Document, title: string, tabs: DialogTab[], onOk?: () => void, selected = 0): Promise<boolean> {
  const t = createTabs(tabs.map(x => ({ label: x.label, content: x.content })), { selected });
  for (;;) {
    const v = await showDialog98(doc, {
      title, content: t.el,
      buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
    });
    if (v !== 'ok') return false;
    let error: string | null = null;
    tabs.forEach((tab, i) => { if (error === null) { const e = tab.validate?.() ?? null; if (e !== null) { error = e; t.select(i); } } });
    if (error !== null) { await messageBox98(doc, { prompt: error, title: 'VibeBasic', buttons: 48 }); continue; }
    for (const tab of tabs) tab.apply?.();
    onOk?.();
    return true;
  }
}

export const field = (label: string, control: HTMLElement): HTMLElement => h('label', { class: 'dlgform98-row' }, h('span', {}, label), control);

// 98.css hides the native box and draws it with `input + label[for]::before`, so the label must follow the input
// as a sibling (as in the font dialog's .pw98-fontchk); a box wrapped inside its label is invisible.
let checkIds = 0;
export const check = (label: string, on: boolean): { el: HTMLElement; input: HTMLInputElement } => {
  const id = `opt98-check-${++checkIds}`;
  const input = h('input', { type: 'checkbox', checked: on, id });
  return { input, el: h('div', { class: 'dlgform98-check' }, input, h('label', { for: id }, label)) };
};

/** Extra tabs for Project Properties. Plan 04 pushes a builder for the "Make" tab here. */
export const projectPropertiesTabs: DialogTabBuilder[] = [];

/** Make tab: the icon of made apps. Stored in project.assets / project.iconAsset, one undo step. */
function makeTab(ide: IdeState, doc: Document = document): DialogTab {
  const p = ide.project;
  // undefined: unchanged; null: cleared; otherwise a newly picked PNG
  let pending: { id: string; asset: Asset } | null | undefined;
  const current = (): Asset | null => {
    if (pending !== undefined) return pending ? pending.asset : null;
    return p.iconAsset ? p.assets[p.iconAsset] ?? null : null;
  };
  const preview = h('img', { class: 'dlgform98-icon', width: '32', height: '32', alt: '' }) as HTMLImageElement;
  const clear = h('button', { type: 'button' }, 'Clear') as HTMLButtonElement;
  const refresh = () => {
    const a = current();
    if (a) preview.src = `data:${a.mime};base64,${a.dataBase64}`; else preview.removeAttribute('src');
    preview.style.visibility = a ? 'visible' : 'hidden';
    clear.disabled = !a;
  };
  const browse = h('button', { type: 'button' }, 'Browse...') as HTMLButtonElement;
  browse.addEventListener('click', async () => {
    try {
      const backend = getBackend();
      const path = await backend.openFileDialog([{ name: 'PNG image', extensions: ['png'] }]);
      if (!path) return;
      const bytes = await backend.readBinaryFile(path);
      pending = { id: `asset-${newId()}`, asset: { mime: 'image/png', dataBase64: bytesToBase64(bytes) } };
      refresh();
    } catch (e) {
      await messageBox98(doc, { prompt: e instanceof Error ? e.message : String(e), title: 'VibeBasic', buttons: 16 });
    }
  });
  clear.addEventListener('click', () => { pending = null; refresh(); });
  refresh();

  const v = p.versionInfo ?? DEFAULT_VERSION;
  const num = (n: number) => h('input', { type: 'text', value: String(n), class: 'dlgform98-num' });
  const major = num(v.major), minor = num(v.minor), revision = num(v.revision);
  const auto = check('Auto Increment', v.autoIncrement === true);
  // Version Information: VB6's Type list and Value box
  const info: Record<InfoKey, string> = Object.fromEntries(VERSION_INFO.map(([k]) => [k, v[k] ?? ''])) as Record<InfoKey, string>;
  const value = h('input', { type: 'text', value: info.comments });
  let shown: InfoKey = 'comments';
  const type = createCombo({ items: VERSION_INFO.map(([, l]) => l), value: VERSION_INFO[0][1], onChange: l => {
    shown = VERSION_INFO.find(([, x]) => x === l)?.[0] ?? 'comments';
    value.value = info[shown];
  } });
  value.addEventListener('input', () => { info[shown] = value.value; });
  const fileTypes = h('input', { type: 'text', value: (p.fileTypes ?? []).join(', '), placeholder: 'kalk, txt' });
  const cmdLine = h('input', { type: 'text', value: p.commandLine ?? '' });
  const condComp = h('input', { type: 'text', value: p.condComp ?? '', placeholder: 'DEBUG = 1 : BETA = 0' });
  const versionNumbers = [major, minor, revision];
  return {
    label: 'Make',
    content: h('div', { class: 'dlgform98' },
      field('Version Number:', h('div', { class: 'dlgform98-nums' }, 'Major', major, 'Minor', minor, 'Revision', revision)),
      auto.el,
      field('Version Information:', type.el), field('Value:', value),
      field('Icon:', h('span', {}, preview, browse, clear)),
      field('File Types:', fileTypes),
      field('Command Line Arguments:', cmdLine),
      field('Conditional Compilation Arguments:', condComp)),
    validate: () => {
      if (!versionNumbers.every(i => /^\d{1,4}$/.test(i.value.trim()))) return 'Invalid property value';
      if (parseFileTypes(fileTypes.value) === null) return 'Invalid file type: use extensions such as kalk, txt';
      try { parseCondConsts(condComp.value); } catch (e) { return `Conditional Compilation Arguments: ${e instanceof Error ? e.message : String(e)}`; }
      return null;
    },
    commands: () => {
      const cmds: Command[] = [];
      if (pending !== undefined) {
        const old = p.iconAsset;
        const drop = old !== null && old in p.assets && !assetUsedElsewhere(p, old) ? [removeAssetCmd(old)] : [];
        if (pending === null) { if (old !== null) cmds.push(setProjectIconCmd(null), ...drop); }
        else cmds.push(addAssetCmd(pending.id, pending.asset), setProjectIconCmd(pending.id), ...drop);
      }
      const nv: VersionInfo = { major: Number(major.value), minor: Number(minor.value), revision: Number(revision.value) };
      if (auto.input.checked) nv.autoIncrement = true;
      for (const [k] of VERSION_INFO) if (info[k] !== '') nv[k] = info[k];
      const opts: ProjectOptions = {};
      if (!sameVersion(nv, p.versionInfo)) opts.versionInfo = nv;
      const types = parseFileTypes(fileTypes.value) ?? [];
      if (types.join() !== (p.fileTypes ?? []).join()) opts.fileTypes = types.length ? types : undefined;
      if (cmdLine.value !== (p.commandLine ?? '')) opts.commandLine = cmdLine.value || undefined;
      if (condComp.value !== (p.condComp ?? '')) opts.condComp = condComp.value || undefined;
      if (Object.keys(opts).length) cmds.push(setProjectOptionsCmd(opts));
      return cmds;
    },
  };
}

type InfoKey = 'comments' | 'companyName' | 'fileDescription' | 'legalCopyright' | 'legalTrademarks' | 'productName';
/** The Version Information types, as VB6's Make tab lists them. */
const VERSION_INFO: [InfoKey, string][] = [
  ['comments', 'Comments'], ['companyName', 'Company Name'], ['fileDescription', 'File Description'],
  ['legalCopyright', 'Legal Copyright'], ['legalTrademarks', 'Legal Trademarks'], ['productName', 'Product Name'],
];

/** "kalk, *.TXT .md" -> ['kalk', 'txt', 'md']; null when one is not an extension (letters, digits, - and _). */
export function parseFileTypes(text: string): string[] | null {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.replace(/^\*?\./, '').toLowerCase();
    if (!e) continue;
    if (!/^[a-z0-9_-]+$/.test(e)) return null;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}
projectPropertiesTabs.push(makeTab);

/** The Startup Object that runs Sub Main of a standard module. */
export const SUB_MAIN = 'Sub Main';

function generalTab(ide: IdeState): DialogTab {
  const p = ide.project;
  const name = h('input', { type: 'text', value: p.name, 'data-autofocus': '' });
  const startup = createCombo({ items: [SUB_MAIN, ...p.forms.map(f => f.name)], value: p.subMain ? SUB_MAIN : p.startupForm });
  const title = h('input', { type: 'text', value: p.title });
  return {
    label: 'General',
    content: h('div', { class: 'dlgform98' }, field('Project Name:', name), field('Startup Object:', startup.el), field('Application Title:', title)),
    validate: () => (validateName(name.value) ? null : 'Invalid property value'),
    commands: () => {
      const cmds: Command[] = [];
      if (name.value !== p.name) cmds.push(setProjectFieldCmd('name', name.value));
      const subMain = startup.getValue() === SUB_MAIN;
      if (subMain !== (p.subMain === true)) cmds.push(setProjectOptionsCmd({ subMain: subMain || undefined }));
      if (!subMain && startup.getValue() !== p.startupForm && p.forms.some(f => f.name === startup.getValue())) cmds.push(setProjectFieldCmd('startupForm', startup.getValue()));
      if (title.value !== p.title) cmds.push(setProjectFieldCmd('title', title.value));
      return cmds;
    },
  };
}

export async function showProjectProperties(ide: IdeState, doc: Document = document): Promise<void> {
  const tabs = [generalTab(ide), ...projectPropertiesTabs.map(b => b(ide, doc))];
  await runTabbedDialog(doc, `${ide.project.name} - Project Properties`, tabs, () => {
    const cmds = tabs.flatMap(t => t.commands?.() ?? []);
    if (cmds.length) ide.stack.execute(compositeCmd('Project Properties', cmds));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Project > Components (Ctrl+T)

/** VB6's message when a component that a form uses is unchecked. */
export const COMPONENT_IN_USE = "Can't remove control or reference; in use";

/** What Apply / OK does with the checked boxes: a component in use stays checked (`refused`). */
export function applyComponentChoice(p: Project, wanted: readonly string[]): { components: string[]; refused: string[] } {
  const want = new Set(wanted.map(w => w.toUpperCase()));
  const refused = p.components.filter(c => !want.has(c.toUpperCase()) && componentInUse(p, c));
  return { components: normalizeComponents(wanted, refused), refused };
}

/** The Controls tab lists the components (checkbox and name, alphabetical); the frame at the bottom names the selected one
 *  and its file. OK and Apply change the project's components at once (the Toolbox follows); a component a form uses
 *  cannot be unchecked. */
export async function showComponents(ide: IdeState, doc: Document = document): Promise<void> {
  const all = availableComponents().sort((a, b) => a.name.localeCompare(b.name));
  const checked = new Set(ide.project.components.map(c => c.toUpperCase()));
  let current = all[0]?.file ?? '';
  const list = h('div', { class: 'cmp98-list', role: 'listbox', tabindex: '0', 'data-autofocus': '' });
  const nameEl = h('legend', {}), locEl = h('div', { class: 'cmp98-loc' });
  // 98.css draws a checkbox as `input + label[for]`
  const only = h('input', { type: 'checkbox', id: 'cmp98-only' }) as HTMLInputElement;
  const showInfo = () => {
    const c = componentDef(current);
    nameEl.textContent = c?.name ?? '';
    locEl.textContent = c ? `Location: ${componentLocation(c)}` : '';
  };
  const render = () => {
    const rows = all.filter(c => !only.checked || checked.has(c.file)).map(c => {
      const id = `cmp98-${c.file}`;
      const box = h('input', { type: 'checkbox', id, checked: checked.has(c.file), 'data-file': c.file }) as HTMLInputElement;
      box.addEventListener('change', () => { if (box.checked) checked.add(c.file); else checked.delete(c.file); });
      const row = h('div', { class: c.file === current ? 'cmp98-row selected' : 'cmp98-row', 'data-file': c.file }, box, h('label', { for: id }, c.name));
      row.addEventListener('mousedown', () => {
        current = c.file;
        for (const r of list.querySelectorAll('.cmp98-row')) r.classList.toggle('selected', r === row);
        showInfo();
      });
      return row;
    });
    list.replaceChildren(...rows);
  };
  only.addEventListener('change', render);
  list.addEventListener('keydown', e => {
    const i = all.findIndex(c => c.file === current);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { current = next.file; render(); showInfo(); }
    } else if (e.key === ' ' && current) {
      e.preventDefault();
      if (checked.has(current)) checked.delete(current); else checked.add(current);
      render();
    }
  });
  render();
  showInfo();
  const browse = h('button', { type: 'button', disabled: true }, 'Browse...');
  const side = h('div', { class: 'cmp98-side' }, browse, h('div', {}, only, h('label', { for: 'cmp98-only' }, 'Selected Items Only')));
  const body = h('div', { class: 'cmp98' },
    h('div', { class: 'cmp98-top' }, list, side),
    h('fieldset', { class: 'cmp98-info' }, nameEl, locEl));
  const tabs = createTabs([{ label: 'Controls', content: body }]);
  /** Applies the boxes; false when a component in use had to stay checked. */
  const apply = async (): Promise<boolean> => {
    const r = applyComponentChoice(ide.project, [...checked]);
    const now = normalizeComponents(ide.project.components);
    if (JSON.stringify(r.components) !== JSON.stringify(now)) ide.stack.execute(setComponentsCmd(r.components));
    if (!r.refused.length) return true;
    for (const f of r.refused) checked.add(f.toUpperCase());
    render();
    await messageBox98(doc, { prompt: COMPONENT_IN_USE, title: 'Components', buttons: 48 });
    return false;
  };
  for (;;) {
    const v = await showDialog98(doc, {
      title: 'Components', content: tabs.el,
      buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Apply', value: 'apply' }],
    });
    if (v !== 'ok' && v !== 'apply') return;
    const ok = await apply();
    if (v === 'ok' && ok) return;
  }
}
