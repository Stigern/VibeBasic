// Property editors for the ImageList family, kept apart from the Properties window (properties.ts calls `customPropEditor` first):
//  - the ListImages row of an ImageList: "(Custom)..." opens a Property Pages-style dialog where pictures are added with the picture
//    picker, given a Key and a Tag, reordered and removed. Pictures become project assets, like Picture properties;
//  - the ImageList / Icons / SmallIcons row of a Toolbar, TreeView, ListView or TabStrip: a drop-down of the ImageList controls of the form.
import type { Backend } from '../backend/backend';
import { addAssetCmd, removeAssetCmd, setPropertyCmd, type Command } from '../model/commands';
import type { PropDef } from '../model/controls';
import { newId } from '../model/controls';
import { listImageLine, parseListImage } from '../model/imageList';
import type { Asset, ControlType, FormDef, Project, PropValue } from '../model/types';
import { createCombo } from '../ui98/combo';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { bytesToBase64, mimeFromPath } from './propertyEditors';
import './pickers.css';

const NONE = '(None)';
const IMAGE_REF_PROPS = new Set(['ImageList', 'Icons', 'SmallIcons']);
const IMAGE_USERS = new Set<ControlType>(['Toolbar', 'TreeView', 'ListView', 'TabStrip']);
const VB_OK_EXCL = 48;

export interface CustomEditorEnv {
  doc: Document;
  backend: Backend;
  project: Project;
  form: FormDef;
  type: ControlType;
  def: PropDef;
  value: PropValue | undefined;
  cell: HTMLElement;
  /** Sets the property on the selected control(s) in one undo step, together with `extra` commands (new assets). */
  apply(value: PropValue, extra?: Command[]): void;
}

/** The editor a custom row put in its cell: what gets the keyboard focus, what Enter / double-click opens, and how a
 *  re-render closes its open list. */
export interface CustomEditor { focus: HTMLElement | null; open(): void; close(): void }

/** Fills `cell` with this property's own editor; null when the Properties window should use its standard one. */
export function customPropEditor(env: CustomEditorEnv): CustomEditor | null {
  if (env.type === 'ImageList' && env.def.name === 'ListImages') {
    const open = () => { void editListImages(env); };
    const btn = h('button', { type: 'button', class: 'pw98-btn pw98-wide', title: '(Custom)...' }, '(Custom)...');
    btn.addEventListener('mousedown', e => e.preventDefault());   // the row keeps the focus
    btn.addEventListener('click', open);
    env.cell.replaceChildren(h('span', { class: 'pw98-valtext' }, '(Collection)'), btn);
    return { focus: null, open, close: () => {} };
  }
  if (IMAGE_USERS.has(env.type) && IMAGE_REF_PROPS.has(env.def.name) && env.def.kind === 'string') {
    const names = env.form.controls.filter(c => c.type === 'ImageList').map(c => c.name);
    const cur = typeof env.value === 'string' ? env.value : '';
    const combo = createCombo({ items: [NONE, ...names], value: cur === '' ? NONE : cur, openOnClick: false, onChange: v => env.apply(v === NONE ? '' : v) });
    env.cell.replaceChildren(combo.el);
    return { focus: combo.el.querySelector('input'), open: () => combo.open(), close: () => combo.close() };
  }
  return null;
}

/** Renaming ImageList `oldName` to `newName`: the commands that make the controls naming it (ImageList, Icons,
 *  SmallIcons) follow, for the same undo step as the rename. */
export function imageListRenameCmds(form: FormDef, oldName: string, newName: string): Command[] {
  const old = oldName.toLowerCase();
  const out: Command[] = [];
  for (const c of form.controls) {
    if (!IMAGE_USERS.has(c.type)) continue;
    for (const p of IMAGE_REF_PROPS) {
      const v = c.props[p];
      if (typeof v === 'string' && v.toLowerCase() === old) out.push(setPropertyCmd(form.id, c.id, p, newName));
    }
  }
  return out;
}

interface Item { key: string; tag: string; asset: string; url: string; pending: Asset | null }

const dataUrl = (a: Asset): string => `data:${a.mime};base64,${a.dataBase64}`;

async function editListImages(env: CustomEditorEnv): Promise<void> {
  const { doc, project } = env;
  const oldLines = Array.isArray(env.value) ? env.value.map(String) : [];
  const items: Item[] = oldLines.map(parseListImage).map(i => {
    const a = project.assets[i.asset];
    return { key: i.key, tag: i.tag, asset: i.asset, url: a ? dataUrl(a) : '', pending: null };
  });
  let sel = items.length ? 0 : -1;

  const list = h('div', { class: 'il98-list', tabindex: '0' });
  const index = h('input', { type: 'text', readOnly: true, class: 'il98-index' });
  const key = h('input', { type: 'text', class: 'il98-field', 'data-autofocus': '' });
  const tag = h('input', { type: 'text', class: 'il98-field' });
  const preview = h('div', { class: 'il98-preview' });
  const count = h('span', {});
  const remove = h('button', { type: 'button' }, 'Remove Picture');
  const insert = h('button', { type: 'button' }, 'Insert Picture...');
  const mode = (): void => {
    const it = items[sel];
    index.value = it ? String(sel + 1) : '';
    key.value = it?.key ?? ''; tag.value = it?.tag ?? '';
    key.disabled = tag.disabled = remove.disabled = !it;
    preview.replaceChildren(...(it?.url ? [h('img', { src: it.url, class: 'il98-img' })] : []));
    count.textContent = `Images: ${items.length}`;
    list.replaceChildren(...items.map((x, i) => h('div', { class: `il98-item${i === sel ? ' sel' : ''}`, onclick: () => { sel = i; mode(); } },
      x.url ? h('img', { src: x.url, class: 'il98-thumb' }) : h('span', { class: 'il98-thumb' }), `${i + 1}${x.key ? `  ${x.key}` : ''}`)));
  };
  key.addEventListener('input', () => {
    if (!items[sel]) return;
    items[sel].key = key.value;
    const label = list.children[sel]?.lastChild;
    if (label) label.textContent = `${sel + 1}${key.value ? `  ${key.value}` : ''}`;
  });
  tag.addEventListener('input', () => { if (items[sel]) items[sel].tag = tag.value; });
  remove.addEventListener('click', () => { if (sel < 0) return; items.splice(sel, 1); sel = Math.min(sel, items.length - 1); mode(); });
  insert.addEventListener('click', async () => {
    const path = await env.backend.openFileDialog([{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }]);
    if (!path) return;
    const asset: Asset = { mime: mimeFromPath(path), dataBase64: bytesToBase64(await env.backend.readBinaryFile(path)) };
    items.splice(sel + 1, 0, { key: '', tag: '', asset: `asset-${newId()}`, url: dataUrl(asset), pending: asset });
    sel++;
    mode();
  });
  mode();

  const content = h('div', { class: 'il98' },
    h('div', { class: 'il98-left' }, list, count),
    h('div', { class: 'il98-right' },
      h('label', {}, 'Index:', index), h('label', {}, 'Key:', key), h('label', {}, 'Tag:', tag),
      h('div', { class: 'il98-btns' }, insert, remove), h('div', {}, 'Image:'), preview));

  for (;;) {
    const r = await showDialog98(doc, { title: 'Property Pages - Images', content, buttons: [
      { label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }] });
    if (r !== 'ok') return;
    const keys = items.map(i => i.key.toLowerCase()).filter(k => k !== '');
    if (new Set(keys).size !== keys.length) {
      await messageBox98(doc, { prompt: 'Key is not unique in collection', title: 'VibeBasic', buttons: VB_OK_EXCL });
      continue;
    }
    break;
  }
  const lines = items.map(i => listImageLine({ key: i.key, asset: i.asset, tag: i.tag }));
  if (JSON.stringify(lines) === JSON.stringify(oldLines)) return;
  const kept = new Set(items.map(i => i.asset));
  const extra: Command[] = items.filter(i => i.pending).map(i => addAssetCmd(i.asset, i.pending!));
  // a removed picture's asset goes too, unless something else (a pasted copy of this ImageList) still names it
  const json = JSON.stringify(project.forms);
  for (const l of oldLines) {
    const a = parseListImage(l).asset;
    if (a && !kept.has(a) && a in project.assets && json.split(JSON.stringify(a)).length - 1 <= 1) extra.push(removeAssetCmd(a));
  }
  env.apply(lines, extra);
}
