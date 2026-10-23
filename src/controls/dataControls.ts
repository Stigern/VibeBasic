// Rendering of the data controls: the Data control and the ADO Data Control (the arrow bar |< < Caption > >|), and the DataGrid.
// Run mode: a click on an arrow dispatches `vbuseraction` { nav: 'first' | 'previous' | 'next' | 'last' }; the run session moves
// the recordset (run/data/dataControl.ts). DataList and DataCombo use the ListBox and ComboBox renderers.
import { splitFields } from '../model/fieldLines';
import { twipsToPx } from '../model/twips';
import { h } from '../ui98/dom';
import type { Ctx, Renderer } from './render';

const SVG = 'http://www.w3.org/2000/svg';

/** A black arrow glyph: `bar` draws the |< / >| stop line, `dir` is the direction. */
function arrow(dir: 'left' | 'right', bar: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', '8');
  svg.setAttribute('height', '8');
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const path = document.createElementNS(SVG, 'path');
  // a triangle 4 wide, 7 high, plus a 1-pixel bar at the outer side
  const tri = dir === 'left' ? 'M6 0.5 L2 4 L6 7.5 Z' : 'M2 0.5 L6 4 L2 7.5 Z';
  const stop = !bar ? '' : dir === 'left' ? ' M0.5 0.5 H1.5 V7.5 H0.5 Z' : ' M6.5 0.5 H7.5 V7.5 H6.5 Z';
  path.setAttribute('d', tri + stop);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

export function dataBar(c: Ctx): Renderer {
  let root: HTMLElement, caption: HTMLElement;
  const btn = (nav: string, dir: 'left' | 'right', bar: boolean): HTMLElement =>
    h('div', { class: 'vb-data-btn', dataset: { nav } }, arrow(dir, bar));
  return {
    build() {
      caption = h('div', { class: 'vb-data-caption' });
      root = h('div', { class: 'vb-data' },
        btn('first', 'left', true), btn('previous', 'left', false), caption, btn('next', 'right', false), btn('last', 'right', true));
      c.el.replaceChildren(root);
      if (c.mode !== 'run') return;
      c.setInput(root);
      root.addEventListener('click', e => {
        const b = (e.target as Element).closest<HTMLElement>('.vb-data-btn');
        if (b && root.getAttribute('aria-disabled') !== 'true') c.fire('vbuseraction', { nav: b.dataset.nav });
      });
    },
    patch(k) {
      if (k === null || k.has('Caption')) caption.textContent = c.str('Caption');
      if (k === null || k.has('BackColor')) caption.style.backgroundColor = c.color('BackColor');
    },
    bg: () => null,
  };
}

/**
 * DataGrid: column headers, a record selector column (> the current record, a pencil while it is edited, * the new-record row)
 * and the cells of `GridRows` (see run/data/dataGrid.ts). Run mode dispatches `vbuseraction` with verb 'cell' { row, col } (a click,
 * the arrow keys; col -1 for the selector), 'edit' / 'add' { row, col, text } (a cell edited in place: double-click, F2, Enter or
 * typing), 'delete' { row } (Delete on a selected row) and 'head' { col }.
 */
export function dataGrid(c: Ctx): Renderer {
  let root: HTMLElement;
  let editing: { row: number; col: number; input: HTMLInputElement; original: string } | null = null;
  let selectedRow: number | null = null;
  const run = c.mode === 'run';
  const cols = (): string[][] => {
    const l = c.list('GridCols').map(splitFields);
    return l.length || run ? l : [['', '1215', '3', '0'], ['', '1215', '3', '0']];   // the designer shows two empty columns
  };
  const rows = (): string[][] => c.list('GridRows').map(splitFields);
  const align = (a: string, text: string): string => (a === '0' ? 'left' : a === '1' ? 'right' : a === '2' ? 'center' : text !== '' && !isNaN(Number(text)) ? 'right' : 'left');

  function paint(): void {
    if (editing) return;   // painted again when the edit ends
    const cs = cols(), rs = rows(), cur = run ? c.num('GridRow') : -1, curCol = c.num('GridCol'), mode = c.str('GridEdit');
    const sel = c.bool('RecordSelectors'), addRow = c.bool('AllowAddNew');
    const table = h('table', { class: 'dg-table' });
    const width = (w: string) => `${Math.max(0, twipsToPx(Number(w) || 0))}px`;
    table.append(h('colgroup', {}, ...(sel ? [h('col', { style: { width: '14px' } })] : []), ...cs.map(col => h('col', { style: { width: width(col[1]) } }))));
    if (c.bool('ColumnHeaders')) {
      table.append(h('tr', { class: 'dg-head' }, ...(sel ? [h('th', { class: 'dg-sel' })] : []),
        ...cs.map((col, i) => h('th', { dataset: { c: String(i) } }, col[0] ?? ''))));
    }
    const line = (r: number, cells: string[], isNew: boolean): HTMLElement => {
      const mark = r === cur ? (mode !== '' ? '✎' : '▶') : isNew ? '*' : '';
      const tr = h('tr', { class: `${r === cur ? 'cur' : ''}${r === selectedRow ? ' picked' : ''}`.trim(), dataset: { r: String(r) } });
      if (sel) tr.append(h('td', { class: 'dg-sel', dataset: { r: String(r), sel: '1' } }, mark));
      cs.forEach((col, i) => {
        const t = cells[i] ?? '';
        tr.append(h('td', { class: r === cur && i === curCol ? 'dg-cell' : '', dataset: { r: String(r), c: String(i), ...(isNew ? { add: '1' } : {}) }, style: { textAlign: align(col[2] ?? '3', t) } }, t));
      });
      return tr;
    };
    rs.forEach((cells, r) => table.append(line(r, cells, false)));
    if (addRow) table.append(line(rs.length, [], true));
    const caption = c.str('Caption');
    root.replaceChildren(...(caption ? [h('div', { class: 'dg-caption' }, caption)] : []), table);
  }

  function move(row: number, col: number): void {
    c.props.GridRow = row;
    c.props.GridCol = col;
    paint();
    c.fire('vbuseraction', { verb: 'cell', row, col });
  }

  function startEdit(row: number, col: number, initial?: string): void {
    const cs = cols(), n = rows().length;
    if (!run || editing || col < 0 || col >= cs.length || root.getAttribute('aria-disabled') === 'true') return;
    const isNew = row === n;
    if (isNew ? !c.bool('AllowAddNew') : !c.bool('AllowUpdate') || row < 0 || row > n) return;
    if (cs[col][3] === '1') return;   // Locked
    const td = root.querySelector<HTMLElement>(`td[data-r="${row}"][data-c="${col}"]`);
    if (!td) return;
    const original = isNew ? '' : rows()[row]?.[col] ?? '';
    const input = h('input', { type: 'text', class: 'dg-editor', spellcheck: false, autocomplete: 'off' }) as HTMLInputElement;
    input.value = initial ?? original;
    td.replaceChildren(input);
    editing = { row, col, input, original };
    input.focus();
    if (initial === undefined) input.select();
    const end = (commit: boolean) => {
      if (!editing || editing.input !== input) return;
      const e = editing;
      editing = null;
      if (commit && input.value !== e.original) {
        c.fire('vbuseraction', { verb: isNew ? 'add' : 'edit', row: e.row, col: e.col, text: input.value });
      }
      paint();
      root.focus();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); end(true); }
      else if (e.key === 'Escape') { e.preventDefault(); end(false); }
    });
    input.addEventListener('blur', () => end(true));
  }

  return {
    build() {
      root = h('div', { class: 'vb-dg', tabindex: '0' });
      c.el.replaceChildren(root);
      c.setInput(root);
      if (!run) return;
      root.addEventListener('click', e => {
        if (editing) return;
        const t = (e.target as Element).closest<HTMLElement>('td, th');
        if (!t || !root.contains(t) || root.getAttribute('aria-disabled') === 'true') return;
        if (t.tagName === 'TH') { if (t.dataset.c !== undefined) c.fire('vbuseraction', { verb: 'head', col: Number(t.dataset.c) }); return; }
        const row = Number(t.dataset.r);
        if (t.dataset.sel) { selectedRow = row; move(row, c.num('GridCol')); return; }
        selectedRow = null;
        if (t.dataset.add) { startEdit(row, Number(t.dataset.c)); return; }
        move(row, Number(t.dataset.c));
      });
      root.addEventListener('dblclick', e => {
        const t = (e.target as Element).closest<HTMLElement>('td[data-c]');
        if (t && root.contains(t)) startEdit(Number(t.dataset.r), Number(t.dataset.c));
      });
      root.addEventListener('keydown', e => {
        if (editing || root.getAttribute('aria-disabled') === 'true') return;
        const row = c.num('GridRow'), col = c.num('GridCol'), n = rows().length, nc = cols().length;
        const go = (r: number, k: number) => { e.preventDefault(); selectedRow = null; move(Math.max(0, Math.min(r, n - 1)), Math.max(0, Math.min(k, nc - 1))); };
        switch (e.key) {
          case 'ArrowDown': go(row + 1, col); return;
          case 'ArrowUp': go(row - 1, col); return;
          case 'ArrowLeft': go(row, col - 1); return;
          case 'ArrowRight': go(row, col + 1); return;
          case 'F2': case 'Enter': e.preventDefault(); startEdit(row, col); return;
          case 'Delete':
            if (selectedRow !== null && c.bool('AllowDelete')) { e.preventDefault(); c.fire('vbuseraction', { verb: 'delete', row: selectedRow }); selectedRow = null; }
            return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && row >= 0) { e.preventDefault(); startEdit(row, col, e.key); }
      });
    },
    patch(k) {
      if (k === null || ['GridCols', 'GridRows', 'GridRow', 'GridCol', 'GridEdit', 'ColumnHeaders', 'RecordSelectors', 'AllowAddNew', 'Caption'].some(n => k.has(n))) paint();
      if (k === null || k.has('BorderStyle')) c.el.classList.toggle('vb-bordered', c.num('BorderStyle') === 1);
    },
    bg: () => null,
  };
}
