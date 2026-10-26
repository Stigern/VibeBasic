// Win98 "AI Suggestion" dialogs (code part).
import { h } from '../ui98/dom';
import { showDialog98 } from '../ui98/dialogs';
import { diffLines } from './diff';
import { formMetrics, renderFormSurface } from '../controls/render';
import type { Asset, FormDef } from '../model/types';

const KIND_LABEL = { replaced: 'Replace', added: 'Add', body: 'Replace body of', selection: 'Replace selection in', declarations: 'Add declarations' } as const;
const metricsLine = (metrics?: string): HTMLElement[] => metrics ? [h('div', { class: 'ai-metrics', style: 'color:#808080;margin-bottom:4px' }, metrics)] : [];
const CELL = 'margin:0;padding:0 3px;white-space:pre;font:13px "Courier New",monospace;min-height:15px;';
interface PreviewContext { explanation?: string; imageWarnings?: string[] }
const contextLines = (context?: PreviewContext): HTMLElement[] => [
  ...(context?.explanation ? [h('div', { class: 'ai-explanation', style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:auto;margin-bottom:8px' }, context.explanation)] : []),
  ...(context?.imageWarnings ?? []).map(text => h('div', { class: 'ai-image-warning', style: 'color:#800000;margin-bottom:6px;overflow-wrap:anywhere' }, text)),
];

/**
 * Problems that remain after the check-and-fix round and stop the code from compiling: a red heading and the problems, and
 * Cancel becomes the default button (OK still applies the proposal).
 */
const errorLines = (errors: string[]): HTMLElement[] => errors.length ? [
  h('div', { class: 'ai-warning ai-error', style: 'color:#c00000;font-weight:bold;margin-top:6px' }, 'This code does not compile; OK applies it anyway:'),
  ...errors.map(t => h('div', { class: 'ai-warning ai-error', style: 'color:#c00000;margin-top:2px' }, t)),
] : [];
/** OK and Cancel, with Cancel the default when the proposal has errors. */
const okCancel = (errors: string[]) => [{ label: 'OK', value: 'ok', default: !errors.length }, { label: 'Cancel', value: 'cancel', cancel: true, default: errors.length > 0 }];

/** What the user chose in a preview: OK, Cancel, or Change... with the wish typed in. */
export type PreviewResult = 'ok' | 'cancel' | { change: string };

/** "What should be changed?" box. Resolves the trimmed text, or null on Cancel / empty text. */
async function askChange(doc: Document): Promise<string | null> {
  const box = h('input', { type: 'text', class: 'ai-change', style: 'width:360px', 'data-autofocus': '' });
  const content = h('div', {}, h('div', { style: 'margin-bottom:4px' }, 'What should be changed?'), box);
  const v = await showDialog98(doc, {
    title: 'AI Suggestion', content,
    buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
  });
  const text = box.value.trim();
  return v === 'ok' && text ? text : null;
}

/** Shows the dialog again until it ends in something other than a cancelled Change... box. */
async function previewLoop(doc: Document, show: () => Promise<string>): Promise<PreviewResult> {
  for (;;) {
    const v = await show();
    if (v !== 'change') return v === 'ok' ? 'ok' : 'cancel';
    const change = await askChange(doc);
    if (change !== null) return { change };
  }
}

/** Before/After view of a code change. `canChange` false hides Change... (informational views). */
export async function showCodePreview(doc: Document, before: string, after: string,
  changes: { name: string; kind: keyof typeof KIND_LABEL }[], warnings: string[] = [], metrics?: string, canChange = true, errors: string[] = [], context?: PreviewContext): Promise<PreviewResult> {
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
  const content = h('div', {}, ...metricsLine(metrics), ...contextLines(context), h('div', { style: 'display:flex;gap:8px' }, col('Before', left), col('After', right)),
    h('div', { style: 'margin-top:8px' }, 'Changes:'), list,
    ...errorLines(errors), ...warnings.map(t => h('div', { class: 'ai-warning', style: 'color:#808080;margin-top:4px' }, t)));
  return previewLoop(doc, () => showDialog98(doc, {
    title: 'AI Suggestion', content,
    buttons: [...okCancel(errors), ...(canChange ? [{ label: 'Change...', value: 'change' }] : [])],
  }));
}

type CodeChange = Parameters<typeof showCodePreview>[3][number];

/**
 * Form preview: the list of changes (warnings in grey) beside a read-only rendering of the result, at most 320 px wide.
 * With `code`, the "Code..." button shows the proposed code change (informational; its OK/Cancel just close it).
 */
export async function showFormPreview(doc: Document, after: FormDef, lines: string[], warnings: string[],
  assets: Record<string, Asset> = {}, code?: { before: string; after: string; changes: CodeChange[] }, metrics?: string, errors: string[] = [], context?: PreviewContext): Promise<PreviewResult> {
  const surface = renderFormSurface(after, 'design', ref => {
    const a = assets[ref.asset];
    return a ? `data:${a.mime};base64,${a.dataBase64}` : null;
  });
  const m = formMetrics(after.props);
  const scale = Math.min(1, 320 / Math.max(1, m.outerWidth));
  surface.el.style.transform = `scale(${scale})`;
  surface.el.style.transformOrigin = 'top left';
  surface.el.style.pointerEvents = 'none';
  const frame = h('div', { class: 'ai-form-preview', style: `position:relative;overflow:hidden;width:${Math.ceil(m.outerWidth * scale)}px;height:${Math.ceil(m.outerHeight * scale)}px` }, surface.el);
  const left = h('div', { class: 'ai-ops', style: 'width:260px;max-height:320px;overflow:auto;background:#fff;padding:4px;box-shadow:inset -1px -1px #fff,inset 1px 1px #808080,inset -2px -2px #dfdfdf,inset 2px 2px #0a0a0a' },
    ...(lines.length ? lines : ['(no changes)']).map(t => h('div', { class: 'ai-op' }, t)),
    ...errorLines(errors), ...warnings.map(t => h('div', { class: 'ai-warning', style: 'color:#808080;margin-top:4px' }, t)));
  const content = h('div', {}, ...metricsLine(metrics), ...contextLines(context), h('div', { style: 'display:flex;gap:8px;align-items:flex-start' }, left, frame));
  return previewLoop(doc, async () => {
    for (;;) {
      const v = await showDialog98(doc, {
        title: 'AI Suggestion', content,
        buttons: [...okCancel(errors), { label: 'Code...', value: 'code', disabled: !code }, { label: 'Change...', value: 'change' }],
      });
      if (v !== 'code' || !code) return v;
      await showCodePreview(doc, code.before, code.after, code.changes, [], undefined, false);
    }
  });
}
