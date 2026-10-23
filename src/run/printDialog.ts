// CommonDialog.ShowPrinter: a Win98 Print dialog (the macOS print panel cannot be shown without printing). The printer (from
// Printers, with its port as "Where"), the print range (All, or Pages from / to within Min..Max when Max is set), the number of
// copies and the orientation.

import { showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import type { PrinterDialogRequest, PrinterDialogResult } from './printing';

let seq = 0;

export async function printerDialog98(doc: Document, r: PrinterDialogRequest): Promise<PrinterDialogResult | null> {
  const id = `vb-pd-${++seq}`;
  const names = r.printers.map(p => p.name);
  const select = h('select', { style: 'width:220px', 'data-autofocus': '' },
    ...(names.length ? names : ['(no printer)']).map(n => h('option', { value: n, selected: n === r.device }, n.replace(/_/g, ' '))));
  const where = h('span', {}, '');
  const showWhere = () => { where.textContent = r.printers.find(p => p.name === select.value)?.port ?? ''; };
  select.addEventListener('change', showWhere);
  showWhere();
  const radio = (name: string, label: string, on: boolean) => {
    const box = h('input', { type: 'radio', name: `${id}-${name}`, id: `${id}-${name}-${label}`, checked: on });
    return { box, el: h('div', {}, box, h('label', { for: `${id}-${name}-${label}` }, label)) };
  };
  const num = (v: number, w = 40) => h('input', { type: 'number', min: '0', step: '1', style: `width:${w}px`, value: String(v) });
  const all = radio('range', 'All', true), pages = radio('range', 'Pages', false);
  const from = num(r.fromPage), to = num(r.toPage);
  if (r.max <= 0) for (const e of [pages.box, from, to]) e.disabled = true;
  for (const e of [from, to]) e.addEventListener('focus', () => { pages.box.checked = true; });
  const copies = num(Math.max(1, r.copies), 50);
  copies.min = '1';
  const portrait = radio('orient', 'Portrait', r.orientation !== 2), landscape = radio('orient', 'Landscape', r.orientation === 2);
  const row = 'display:flex;gap:6px;align-items:center;margin:2px 0';
  const content = h('div', { style: 'display:flex;flex-direction:column;gap:6px;min-width:360px' },
    h('fieldset', {}, h('legend', {}, 'Printer'),
      h('div', { style: row }, h('span', { style: 'width:44px' }, 'Name:'), select),
      h('div', { style: row }, h('span', { style: 'width:44px' }, 'Where:'), where)),
    h('div', { style: 'display:flex;gap:6px' },
      h('fieldset', { style: 'flex:1' }, h('legend', {}, 'Print range'), all.el,
        h('div', { style: row }, pages.el, 'from:', from, 'to:', to)),
      h('fieldset', { style: 'flex:1' }, h('legend', {}, 'Copies'),
        h('div', { style: row }, 'Number of copies:', copies))),
    h('fieldset', {}, h('legend', {}, 'Orientation'), h('div', { style: 'display:flex;gap:16px' }, portrait.el, landscape.el)));
  const v = await showDialog98(doc, { title: r.title, content, buttons: [
    { label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }] });
  if (v !== 'ok') return null;
  const int = (e: HTMLInputElement, d: number) => { const n = Math.round(Number(e.value)); return Number.isFinite(n) && n >= 0 ? n : d; };
  const clamp = (n: number) => (r.max > 0 ? Math.min(Math.max(n, r.min), r.max) : n);
  return {
    device: names.length ? select.value : r.device, copies: Math.max(1, int(copies, r.copies)), orientation: landscape.box.checked ? 2 : 1,
    pageNums: pages.box.checked, fromPage: clamp(int(from, r.fromPage)), toPage: clamp(int(to, r.toPage)),
  };
}
