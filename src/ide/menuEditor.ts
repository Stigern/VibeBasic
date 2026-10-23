// Tools > Menu Editor (Ctrl+E): VB6's dialog for a form's menus. The fields edit the selected line of the list below them; the
// arrows change its level (indent, "····" per level) and its place; Next goes to the next line (a new one at the end), Insert
// adds a line above, Delete removes the line. OK checks the lines and applies them as one undo step; Cancel changes nothing.
import { MAX_MENU_LEVEL, SHORTCUT_LABELS, blankRow, checkMenuRows, isBlankRow, menuRows, rowsToMenus, sameMenus, setMenusCmd, shortcutText, type MenuRow } from '../model/menus';
import { createCombo } from '../ui98/combo';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import type { IdeState } from './ideState';
import './menuEditor.css';

const VB_OK_EXCL = 48;
const NEGOTIATE = ['0 - None', '1 - Left', '2 - Middle', '3 - Right'];
let ids = 0;

/** Opens the Menu Editor for the form; resolves true when OK changed the menus. */
export async function showMenuEditor(ide: IdeState, formId: string, doc: Document = document): Promise<boolean> {
  const form0 = ide.project.forms.find(f => f.id === formId);
  if (!form0 || ide.mode !== 'design') return false;
  const rows: MenuRow[] = menuRows(form0);
  rows.push(blankRow(0));   // VB6: an empty line at the end of the list, for the next menu
  let sel = 0;

  const field = (cls = 'me98-text') => h('input', { type: 'text', class: cls });
  const caption = field(), name = field(), index = field('me98-num'), help = field('me98-num');
  caption.dataset.autofocus = '';
  const shortcut = createCombo({ items: [...SHORTCUT_LABELS], value: SHORTCUT_LABELS[0], onChange: v => edit(r => { r.shortcut = Math.max(0, SHORTCUT_LABELS.indexOf(v)); }) });
  const negotiate = createCombo({ items: NEGOTIATE, value: NEGOTIATE[0], onChange: v => edit(r => { r.negotiatePosition = Math.max(0, NEGOTIATE.indexOf(v)); }) });
  const check = (label: string) => {
    const id = `me98-check-${++ids}`;
    const input = h('input', { type: 'checkbox', id });
    return { input, el: h('span', { class: 'me98-check' }, input, h('label', { for: id }, label)) };
  };
  const checked = check('Checked'), enabled = check('Enabled'), visible = check('Visible'), windowList = check('WindowList');
  const btn = (label: string, title: string, fn: () => void) => {
    const b = h('button', { type: 'button', title, class: 'me98-btn' }, label);
    b.addEventListener('click', fn);
    return b;
  };
  const list = h('div', { class: 'me98-list', tabindex: '0', role: 'listbox' });

  const lineText = (r: MenuRow) => `${'····'.repeat(r.level)}${r.caption}`;
  function renderList(): void {
    list.replaceChildren(...rows.map((r, i) => h('div', {
      class: `me98-row${i === sel ? ' sel' : ''}`, onmousedown: () => { sel = i; load(); },
    }, h('span', { class: 'me98-cap' }, lineText(r)), h('span', { class: 'me98-sc' }, shortcutText(r.shortcut)))));
    list.children[sel]?.scrollIntoView?.({ block: 'nearest' });
  }
  /** The selected line into the fields. */
  function load(): void {
    const r = rows[sel];
    caption.value = r.caption;
    name.value = r.name;
    index.value = r.index === null ? '' : String(r.index);
    help.value = String(r.helpContextId);
    shortcut.setValue(SHORTCUT_LABELS[r.shortcut] ?? SHORTCUT_LABELS[0]);
    negotiate.setValue(NEGOTIATE[r.negotiatePosition] ?? NEGOTIATE[0]);
    checked.input.checked = r.checked; enabled.input.checked = r.enabled; visible.input.checked = r.visible; windowList.input.checked = r.windowList;
    renderList();
  }
  function edit(fn: (r: MenuRow) => void): void {
    fn(rows[sel]);
    const line = list.children[sel];
    if (line) { line.children[0].textContent = lineText(rows[sel]); line.children[1].textContent = shortcutText(rows[sel].shortcut); }
  }
  caption.addEventListener('input', () => edit(r => { r.caption = caption.value; }));
  name.addEventListener('input', () => edit(r => { r.name = name.value; }));
  // Index: blank = no array; anything but a number is kept as -1 and refused on OK
  index.addEventListener('input', () => edit(r => { const t = index.value.trim(); r.index = t === '' ? null : /^\d+$/.test(t) ? Number(t) : -1; }));
  help.addEventListener('input', () => edit(r => { r.helpContextId = /^\d+$/.test(help.value.trim()) ? Number(help.value.trim()) : 0; }));
  checked.input.addEventListener('change', () => edit(r => { r.checked = checked.input.checked; }));
  enabled.input.addEventListener('change', () => edit(r => { r.enabled = enabled.input.checked; }));
  visible.input.addEventListener('change', () => edit(r => { r.visible = visible.input.checked; }));
  windowList.input.addEventListener('change', () => edit(r => { r.windowList = windowList.input.checked; }));

  const focusCaption = () => caption.focus();
  const left = btn('←', 'Move the item one level up (out)', () => { if (rows[sel].level > 0) { rows[sel].level--; renderList(); } });
  const right = btn('→', 'Move the item one level down (in)', () => {
    const r = rows[sel];
    if (sel > 0 && r.level <= rows[sel - 1].level && r.level < MAX_MENU_LEVEL) { r.level++; renderList(); }
  });
  const up = btn('↑', 'Move the item up', () => { if (sel > 0) { [rows[sel - 1], rows[sel]] = [rows[sel], rows[sel - 1]]; sel--; load(); } });
  const down = btn('↓', 'Move the item down', () => { if (sel < rows.length - 1) { [rows[sel + 1], rows[sel]] = [rows[sel], rows[sel + 1]]; sel++; load(); } });
  const next = btn('Next', 'Next item (a new one at the end)', () => {
    if (sel === rows.length - 1) {
      if (isBlankRow(rows[sel])) { focusCaption(); return; }
      rows.push(blankRow(rows[sel].level));
    }
    sel++;
    load();
    focusCaption();
  });
  const insert = btn('Insert', 'Insert an item above this one', () => { rows.splice(sel, 0, blankRow(rows[sel].level)); load(); focusCaption(); });
  const del = btn('Delete', 'Delete this item', () => {
    rows.splice(sel, 1);
    if (!rows.length) rows.push(blankRow(0));
    sel = Math.min(sel, rows.length - 1);
    load();
    focusCaption();
  });
  list.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    sel = Math.max(0, Math.min(rows.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
    load();
  });

  const row = (...kids: (Node | string)[]) => h('div', { class: 'me98-line' }, ...kids);
  const lbl = (text: string, input: HTMLElement) => h('label', { class: 'me98-label' }, h('span', { class: 'me98-lt' }, text), input);
  const content = h('div', { class: 'me98' },
    row(lbl('Caption:', caption)),
    row(lbl('Name:', name)),
    row(lbl('Index:', index), h('span', { class: 'me98-label' }, 'Shortcut:', shortcut.el)),
    row(lbl('HelpContextID:', help), h('span', { class: 'me98-label' }, 'NegotiatePosition:', negotiate.el)),
    row(checked.el, enabled.el, visible.el, windowList.el),
    h('div', { class: 'me98-hr' }),
    row(left, right, up, down, h('span', { class: 'me98-gap' }), next, insert, del),
    list);
  load();

  for (;;) {
    const r = await showDialog98(doc, { title: 'Menu Editor', content, buttonsSide: true, buttons: [
      { label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }] });
    if (r !== 'ok') return false;
    const form = ide.project.forms.find(f => f.id === formId);
    if (!form || ide.mode !== 'design') return false;
    const problem = checkMenuRows(rows, form);
    if (!problem) {
      const menus = rowsToMenus(rows);
      if (sameMenus(form, menus)) return false;
      ide.stack.execute(setMenusCmd(formId, menus));
      return true;
    }
    sel = problem.row;
    load();
    await messageBox98(doc, { prompt: problem.message, title: 'Menu Editor', buttons: VB_OK_EXCL });
  }
}
