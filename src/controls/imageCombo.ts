// ImageCombo (MSCOMCTL.OCX): a combo box whose items show pictures of an ImageList, indented by their Indentation.
//
// DOM events the run mode dispatches on inputEl (formWindow.ts turns them into VB events):
//  - `input` (Text typed or picked; the window reads inputEl.value), `vbcomboitem` ({ index }: 1-based item picked), `vbcombodrop` (list opened)
import { parseComboItem, COMBO_INDENT_PX, type ComboItemData } from '../model/imageCombo';
import { h } from '../ui98/dom';
import type { Ctx, Renderer } from './render';

type Keys = ReadonlySet<string> | null;
const has = (k: Keys, ...names: string[]): boolean => k === null || names.some(n => k.has(n));
/** The pseudo property of render.ts: the ImageList changed. */
const IMAGES_CHANGED = '*images';

export function imageCombo(c: Ctx): Renderer {
  let input: HTMLInputElement, field: HTMLElement, list: HTMLElement, pic: HTMLElement;
  let items: ComboItemData[] = [];
  let sel = 0;   // 1-based, 0 = none
  let open = false;
  const doc = () => c.el.ownerDocument;
  const onOutside = (e: Event) => { if (!c.el.contains(e.target as Node)) close(); };

  function close(): void {
    open = false;
    list.classList.remove('open');
    doc().removeEventListener('mousedown', onOutside, true);
  }
  function openList(): void {
    if (c.mode !== 'run' || open || c.bool('Locked')) return;   // Locked: the user changes neither the text nor the selection
    open = true;
    list.classList.add('open');
    doc().addEventListener('mousedown', onOutside, true);
    c.fire('vbcombodrop');
  }
  const imageOf = (ref: string): HTMLElement | null => {
    const s = ref ? c.image('ImageList', ref) : null;
    return s ? h('img', { class: 'icb-img', src: s.url, draggable: 'false', style: { width: `${s.width}px`, height: `${s.height}px` } }) : null;
  };

  function paintList(): void {
    list.replaceChildren(...items.map((it, i) => {
      const img = imageOf(i + 1 === sel && it.selImage ? it.selImage : it.image);
      return h('div', { class: `vb-item icb-row${i + 1 === sel ? ' sel' : ''}`, dataset: { i: String(i + 1) }, style: { paddingLeft: `${2 + it.indent * COMBO_INDENT_PX}px` } },
        ...(img ? [img] : []), h('span', { class: 'icb-text' }, it.text));
    }));
  }
  function paintField(): void {
    const it = sel > 0 ? items[sel - 1] : undefined;
    const img = it && it.image ? imageOf(it.image) : null;
    pic.replaceChildren(...(img ? [img] : []));
    pic.style.display = img ? '' : 'none';
  }
  function pick(i: number): void {
    if (i < 1 || i > items.length || c.bool('Locked')) return;
    sel = i;
    input.value = items[i - 1].text;
    c.props.Text = input.value;
    c.props.SelectedIndex = i;
    paintList(); paintField();
    close();
    c.fire('input');
    c.fire('vbcomboitem', { index: i });
  }

  return {
    build() {
      if (open) close();
      input = h('input', { type: 'text', class: 'vb-input', spellcheck: false, autocomplete: 'off' });
      const btn = h('div', { class: 'vb-combo-btn' }, h('span', { class: 'vb-glyph' }));
      pic = h('div', { class: 'icb-pic' });
      field = h('div', { class: 'vb-combo-field' }, pic, input, btn);
      list = h('div', { class: 'vb-combo-list icb-list' });
      c.el.replaceChildren(field, list);
      c.setInput(input);
      sel = 0;
      if (c.mode !== 'run') return;
      const toggle = (e: Event) => { e.preventDefault(); input.focus(); open ? close() : openList(); };
      btn.addEventListener('mousedown', toggle);
      pic.addEventListener('mousedown', e => { if (input.readOnly) toggle(e); });
      input.addEventListener('mousedown', e => { if (input.readOnly) toggle(e); });
      list.addEventListener('mousedown', e => {
        const it = (e.target as Element).closest<HTMLElement>('.vb-item');
        if (!it) return;
        e.preventDefault();
        pick(Number(it.dataset.i));
      });
      input.addEventListener('input', () => {   // typed: the item with this text is the selected one
        const at = items.findIndex(i => i.text === input.value) + 1;
        sel = at; c.props.SelectedIndex = at;
        paintList(); paintField();
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Escape' && open) { e.preventDefault(); close(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          pick(Math.min(items.length, Math.max(1, (sel || (e.key === 'ArrowDown' ? 0 : items.length + 1)) + (e.key === 'ArrowDown' ? 1 : -1))));
        }
      });
    },
    patch(k) {
      if (has(k, 'ComboItems')) items = c.list('ComboItems').map(parseComboItem);
      if (has(k, 'Text') && input.value !== c.str('Text')) input.value = c.str('Text');
      if (has(k, 'ComboItems', 'SelectedIndex', 'Text')) {   // the selected item is the one the Text shows (the first with that text, unless SelectedIndex names another)
        const at = Math.min(items.length, Math.max(0, c.num('SelectedIndex')));
        sel = at > 0 && items[at - 1].text === c.str('Text') ? at : items.findIndex(i => i.text === c.str('Text')) + 1;
      }
      if (has(k, 'Locked')) input.readOnly = c.bool('Locked');
      if (has(k, 'ComboItems', 'SelectedIndex', 'ImageList', IMAGES_CHANGED)) { paintList(); paintField(); }
      if (has(k, 'BackColor')) { field.style.backgroundColor = c.color('BackColor'); list.style.backgroundColor = c.color('BackColor'); }
    },
    destroy() { if (open) close(); },
    bg: () => null,
  };
}
