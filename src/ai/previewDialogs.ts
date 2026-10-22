// Win98 "AI Suggestion" dialogs (code part).
import { h } from '../ui98/dom';
import { showDialog98 } from '../ui98/dialogs';
import { diffLines } from './diff';

const KIND_LABEL = { replaced: 'Replace', added: 'Add', body: 'Replace body of', declarations: 'Add declarations' } as const;
const CELL = 'margin:0;padding:0 3px;white-space:pre;font:13px "Courier New",monospace;min-height:15px;';

/** Before/After view of a code change. Resolves true on OK, false on Cancel. */
export async function showCodePreview(doc: Document, before: string, after: string,
  changes: { name: string; kind: 'replaced' | 'added' | 'body' | 'declarations' }[]): Promise<boolean> {
  const left = h('div', { class: 'ai-before', style: 'min-width:0' });
  const right = h('div', { class: 'ai-after', style: 'min-width:0' });
  const cell = (text: string, bg: string, cls = '') => h('div', { class: cls, style: `${CELL}background:${bg}` }, text);
  for (const d of diffLines(before.split('\n'), after.split('\n'))) {
    if (d.kind === 'same') { left.append(cell(d.text, '#fff')); right.append(cell(d.text, '#fff')); }
    else if (d.kind === 'del') { left.append(cell(d.text, '#ffc0c0', 'del')); right.append(cell('', '#e8e8e8')); }
    else { left.append(cell('', '#e8e8e8')); right.append(cell(d.text, '#c0ffc0', 'add')); }
  }
  const col = (title: string, body: HTMLElement) => h('div', { style: 'display:flex;flex-direction:column;min-width:0' },
    h('div', { style: 'font-weight:bold;padding-bottom:2px' }, title),
    h('div', { class: 'ai-pane', style: 'background:#fff;box-shadow:inset -1px -1px #fff,inset 1px 1px #808080,inset -2px -2px #dfdfdf,inset 2px 2px #0a0a0a;padding:2px;overflow:auto;max-height:320px;width:340px' }, body));
  const list = h('ul', { class: 'ai-changes', style: 'margin:8px 0 0;padding-left:18px' },
    ...changes.map(c => h('li', {}, `${KIND_LABEL[c.kind]} ${c.name}`)));
  const content = h('div', {}, h('div', { style: 'display:flex;gap:8px' }, col('Before', left), col('After', right)),
    h('div', { style: 'margin-top:8px' }, 'Changes:'), list);
  const v = await showDialog98(doc, {
    title: 'AI Suggestion', content,
    buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
  });
  return v === 'ok';
}
