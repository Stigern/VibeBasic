// Tools > Ask AI...: prompt dialog, waiting dialog (cancelable), then code mode or form mode with a preview.
// Nothing is applied unless the reply was understood and the user pressed OK in the preview.
import type { Backend } from '../backend/backend';
import { showOptions } from '../ide/optionsDialog';
import type { CodeWindow } from '../ide/codeWindow';
import type { IdeState } from '../ide/ideState';
import { listProcedures } from '../model/procedures';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { applyCodeProposal, extractCode } from './codeMode';
import { buildCodeRequest, buildFormRequest } from './context';
import { NOT_UNDERSTOOD, applyFormOpsToClone, describeOps, formOpsToCommand, parseFormOps } from './formMode';
import { showCodePreview, showFormPreview } from './previewDialogs';
import { loadAiSettings } from './settings';

const VB_EXCLAMATION = 48;
const TITLE = 'VibeBasic';

const warn = (doc: Document, prompt: string) => messageBox98(doc, { prompt, title: TITLE, buttons: VB_EXCLAMATION });

/** "The AI answer could not be understood." with OK and Details... (the whole reply in a read-only box). */
export async function showNotUnderstood(doc: Document, raw: string): Promise<void> {
  for (;;) {
    const v = await showDialog98(doc, {
      title: TITLE, content: h('div', { class: 'dlg98-text' }, NOT_UNDERSTOOD),
      buttons: [{ label: 'OK', value: 'ok', default: true, cancel: true }, { label: 'Details...', value: 'details' }],
    });
    if (v !== 'details') return;
    const box = h('textarea', { class: 'ai-details', readOnly: true, rows: '14', cols: '70', style: 'font:12px "Courier New",monospace', 'data-autofocus': '' });
    box.value = raw;
    await showDialog98(doc, { title: 'AI Answer', content: box, buttons: [{ label: 'OK', value: 'ok', default: true, cancel: true }] });
  }
}

async function promptDialog(doc: Document, title: string): Promise<string | null> {
  const box = h('textarea', { class: 'ai-prompt', rows: '6', cols: '60', 'data-autofocus': '' });
  // Enter inserts a line break (the dialog would otherwise press OK); Ctrl+Enter reaches the dialog and presses OK.
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const a = box.selectionStart ?? box.value.length, b = box.selectionEnd ?? a;
    box.value = `${box.value.slice(0, a)}\n${box.value.slice(b)}`;
    box.selectionStart = box.selectionEnd = a + 1;
  });
  const content = h('div', {}, h('div', { style: 'margin-bottom:4px' }, 'What should the AI do?'), box);
  const v = await showDialog98(doc, {
    title, content,
    buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
  });
  const text = box.value.trim();
  return v === 'ok' && text ? text : null;
}

type Waited = { kind: 'reply'; text: string } | { kind: 'error'; message: string } | { kind: 'cancel' };

/** Waiting dialog with a back-and-forth progress bar. Cancel closes it; a reply arriving afterwards is discarded. */
async function waitForReply(doc: Document, model: string, request: Promise<string>): Promise<Waited> {
  const block = h('div', { style: 'position:absolute;top:1px;bottom:1px;left:0;width:40px;background:#000080' });
  const bar = h('div', { class: 'ai-progress', style: 'position:relative;height:16px;margin-top:8px;overflow:hidden;box-shadow:inset -1px -1px #fff,inset 1px 1px #808080' }, block);
  const content = h('div', { style: 'min-width:260px' }, h('div', {}, `Waiting for ${model}...`), bar);
  let pos = 0, dir = 1;
  const timer = setInterval(() => {
    const max = Math.max(0, bar.clientWidth - 40);
    pos += dir * 6;
    if (pos >= max) { pos = max; dir = -1; } else if (pos <= 0) { pos = 0; dir = 1; }
    block.style.left = `${pos}px`;
  }, 40);
  const answered = request.then<Waited, Waited>(text => ({ kind: 'reply', text }), e => ({ kind: 'error', message: e instanceof Error ? e.message : String(e) }));
  const cancelled = showDialog98(doc, { title: TITLE, content, buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }] })
    .then<Waited>(() => ({ kind: 'cancel' }));
  try {
    const res = await Promise.race([answered, cancelled]);
    if (res.kind !== 'cancel') content.closest('.dlg98-overlay')?.dispatchEvent(new Event('dlg98-abort'));
    return res;
  } finally { clearInterval(timer); }
}

export async function askAi(ide: IdeState, backend: Backend, ui: { codeWindowFor(itemId: string): CodeWindow | null }, doc: Document = document): Promise<void> {
  if (ide.mode !== 'design') return;
  const view = ide.activeView;
  const itemId = view.kind === 'code' ? view.itemId : view.kind === 'designer' ? view.formId : null;
  const item = itemId ? ide.project.forms.find(f => f.id === itemId) ?? ide.project.modules.find(m => m.id === itemId) : undefined;
  const codeWin = view.kind === 'code' && itemId ? ui.codeWindowFor(itemId) : null;
  if (!itemId || !item || (view.kind === 'code' && !codeWin)) { await warn(doc, 'Open a form or a code window first.'); return; }

  const settings = await loadAiSettings(backend);
  if (!settings.model.trim()) {
    await warn(doc, 'Set up the AI server first in Tools > Options > AI.');
    await showOptions(ide, backend, doc, 'AI');
    return;
  }

  const project = ide.project;
  const codeMode = view.kind === 'code';
  const prompt = await promptDialog(doc, `Ask AI - ${item.name} (${codeMode ? 'Code' : 'Form'})`);
  if (prompt === null) return;

  let request: Promise<string>;
  try {
    const messages = codeMode
      ? buildCodeRequest(project, itemId, codeWin!.getCursorLine(), prompt)
      : buildFormRequest(project, itemId, prompt);
    request = backend.aiChat(settings.baseUrl, settings.apiKey, settings.model, messages);
  } catch (e) { request = Promise.reject(e); }
  const res = await waitForReply(doc, settings.model, request);
  if (res.kind === 'cancel') return;
  if (res.kind === 'error') { await warn(doc, res.message); return; }
  if (ide.project !== project) return;   // a different project was opened meanwhile

  if (codeMode) {
    const win = codeWin!;
    const code = extractCode(res.text);
    const before = win.getSource();
    const proc = listProcedures(before).find(p => win.getCursorLine() >= p.line && win.getCursorLine() <= p.endLine)?.name ?? null;
    const applied = code === null ? null : applyCodeProposal(before, code, proc);
    if (!applied) { await showNotUnderstood(doc, res.text); return; }
    if (!await showCodePreview(doc, before.replace(/\r\n?/g, '\n'), applied.source, applied.changes)) return;
    win.applyChange(0, win.getSource().length, applied.source);
    return;
  }

  const form = project.forms.find(f => f.id === itemId);
  if (!form) return;
  const parsed = parseFormOps(res.text, form);
  if (!parsed.ok) { await showNotUnderstood(doc, parsed.raw); return; }
  if (!await showFormPreview(doc, applyFormOpsToClone(form, parsed), describeOps(parsed), parsed.warnings, project.assets)) return;
  try { ide.stack.execute(formOpsToCommand(ide.project, itemId, parsed, 'AI changes')); }
  catch (e) { await warn(doc, e instanceof Error ? e.message : String(e)); }
}
